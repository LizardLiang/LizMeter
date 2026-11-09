//! Applies oplog entries read from every peer's file to this device's database (`merge-engine.ts`):
//! field-level last-write-wins, delete wins, name-unique convergence, dense todo-id derivation.
//!
//! Every apply runs inside one transaction, so a merge is never observed half-applied. Blob
//! garbage collection after a delete is deliberately absent: the TS `collectAttachmentBlobs` is a
//! no-op while sync is enabled (B-3), and a merge only ever runs with sync enabled.

use crate::device_identity::{advance_todo_id_watermark, get_or_assign_device_number};
use crate::hlc::{compare_hlc, receive, Hlc};
use crate::notices::add_sync_notice;
use crate::oplog::{FieldMap, OplogEntry, UpsertEntry, LinkKind};
use crate::row_codec::{foreign_key_by_field_name, to_bind_value};
use crate::{in_transaction, Result};
use lizmeter_core::SyncNoticeKind;
use lizmeter_db::util::now_iso;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

/// The five tables that carry their own permanent `uuid` column.
const UUID_TABLES: [&str; 5] = ["todos", "tags", "todo_labels", "todo_states", "todo_projects"];

/// Tables whose rows converge on a shared name (FR-010): all four carry `UNIQUE(name COLLATE NOCASE)`.
fn name_unique_field(table: &str) -> Option<&'static str> {
    match table {
        "tags" | "todo_labels" | "todo_projects" => Some("name"),
        "todo_states" => Some("label"),
        _ => None,
    }
}

// Convergence never repoints dependent foreign keys: whichever row survives keeps its own local
// numeric id, only its `uuid` column ever moves, so every local reference stays valid.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ApplyResult {
    pub applied: usize,
    pub skipped_already_applied: usize,
    pub notices: usize,
}

struct Ctx<'a> {
    conn: &'a Connection,
    columns: RefCell<HashMap<String, HashSet<String>>>,
}

impl Ctx<'_> {
    /// True when `field` is a real column of `table` (B-1: a peer-supplied field name is about to be
    /// interpolated into SQL). Unknown fields are skipped, never fatal.
    fn is_known_column(&self, table: &str, field: &str) -> Result<bool> {
        let mut cache = self.columns.borrow_mut();
        if !cache.contains_key(table) {
            let mut stmt = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let names: HashSet<String> =
                stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<_>>()?;
            cache.insert(table.to_string(), names);
        }
        Ok(cache.get(table).is_some_and(|c| c.contains(field)))
    }
}

fn is_already_applied(conn: &Connection, op_id: &str) -> Result<bool> {
    let found: Option<i64> =
        conn.query_row("SELECT 1 FROM sync_applied_ops WHERE op_id = ?", [op_id], |r| r.get(0)).optional()?;
    Ok(found.is_some())
}

fn mark_applied(conn: &Connection, op_id: &str, hlc: &Hlc) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, applied_at) VALUES (?, ?, ?)",
        params![op_id, hlc.device_number.to_string(), now_iso()],
    )?;
    Ok(())
}

/// Follows `old_uuid -> new_uuid` chains left by name-unique convergence to the final live uuid.
fn resolve_alias(conn: &Connection, table: &str, uuid: &str) -> Result<String> {
    let mut current = uuid.to_string();
    let mut seen: HashSet<String> = HashSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Ok(current); // defensive: a cycle should never exist
        }
        let next: Option<String> = conn
            .query_row(
                "SELECT new_uuid FROM sync_id_aliases WHERE table_name = ? AND old_uuid = ?",
                params![table, current],
                |r| r.get(0),
            )
            .optional()?;
        match next {
            Some(n) => current = n,
            None => return Ok(current),
        }
    }
}

fn is_tombstoned(conn: &Connection, table: &str, row_uuid: &str) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sync_tombstones WHERE table_name = ? AND row_uuid = ?",
            params![table, row_uuid],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn local_id_by_uuid(conn: &Connection, table: &str, uuid: &str) -> Result<Option<i64>> {
    Ok(conn.query_row(&format!("SELECT id FROM {table} WHERE uuid = ?"), [uuid], |r| r.get(0)).optional()?)
}

/// Applies every entry not already recorded in `sync_applied_ops`, in HLC order, inside one
/// transaction. Safe to call repeatedly with overlapping or duplicate entries: idempotent by `opId`.
pub fn apply_oplog_entries(conn: &Connection, entries: &[OplogEntry]) -> Result<ApplyResult> {
    let mut pending: Vec<&OplogEntry> = Vec::new();
    for e in entries {
        if !is_already_applied(conn, e.op_id())? {
            pending.push(e);
        }
    }
    pending.sort_by(|a, b| compare_hlc(a.hlc(), b.hlc()));

    let device_number = get_or_assign_device_number(conn, None)?;
    let ctx = Ctx { conn, columns: RefCell::new(HashMap::new()) };
    let mut applied = 0usize;
    let mut notices = 0usize;

    in_transaction(conn, || {
        // Captured before anything is applied, so the renumbering notice can tell "this todo moved
        // under the user" apart from "this todo arrived and was placed".
        let todo_ids_before = snapshot_todo_ids(conn)?;
        let mut deferred: Vec<&OplogEntry> = Vec::new();

        for entry in &pending {
            let received = receive(conn, device_number, *entry.hlc())?;
            if received.clamped {
                let hlc = entry.hlc();
                add_sync_notice(
                    conn,
                    SyncNoticeKind::ClockDrift,
                    &format!(
                        "A change from device {} arrived with a clock far ahead of this one and was clamped",
                        hlc.device_number
                    ),
                    Some(&format!("entry {}, table {}", entry.op_id(), entry.table())),
                )?;
                notices += 1;
            }

            // B-5: mark applied only when the entry's work is done. `sync_applied_ops` is what
            // later passes filter on, so marking an entry whose real work was deferred (a link
            // whose todo has not arrived, an unresolved foreign key) would make the skip permanent.
            let outcome = apply_entry(&ctx, entry)?;
            if outcome.notice_raised {
                notices += 1;
            }
            if outcome.fully_applied {
                mark_applied(conn, entry.op_id(), entry.hlc())?;
            } else {
                deferred.push(*entry);
            }
            // Counts toward "did this pass do anything" regardless of `fully_applied`: a
            // partially applied upsert is real, visible work even though the entry is retried.
            applied += 1;
        }

        // An entry that named a row this same batch had not created yet (a subtask applied before its
        // parent, a link before its todo) is retried now that the whole batch is in. A snapshot's
        // entries share one HLC and nothing re-reads a snapshot, so without this the unresolved
        // reference is lost. Repeats until a round resolves nothing new, so a chain of any depth
        // settles whatever order its entries arrived in.
        //
        // A deferred link or unlink is dropped when a later entry in this batch touches the same
        // pair: links carry no per-field clock, so replaying the older one now would undo the newer.
        let mut latest_link_op: HashMap<(&str, &str, &str), &str> = HashMap::new();
        for entry in &pending {
            if let OplogEntry::Link(l) = entry {
                latest_link_op.insert((l.table.as_str(), l.from_uuid.as_str(), l.to_uuid.as_str()), l.op_id.as_str());
            }
        }
        let mut waiting = deferred;
        while !waiting.is_empty() {
            let mut still_waiting: Vec<&OplogEntry> = Vec::new();
            for entry in &waiting {
                if let OplogEntry::Link(l) = entry {
                    let key = (l.table.as_str(), l.from_uuid.as_str(), l.to_uuid.as_str());
                    if latest_link_op.get(&key) != Some(&l.op_id.as_str()) {
                        mark_applied(conn, entry.op_id(), entry.hlc())?;
                        continue;
                    }
                }
                let outcome = apply_entry(&ctx, entry)?;
                if outcome.notice_raised {
                    notices += 1;
                }
                if outcome.fully_applied {
                    mark_applied(conn, entry.op_id(), entry.hlc())?;
                } else {
                    still_waiting.push(*entry);
                }
            }
            if still_waiting.len() == waiting.len() {
                break;
            }
            waiting = still_waiting;
        }

        recompute_local_position_from_sync_order(conn, "todo_states")?;
        recompute_local_position_from_sync_order(conn, "todo_projects")?;

        // Derive every todo's visible id from the full set of claims, once, over the settled set.
        reconcile_todo_ids(conn)?;
        notice_user_visible_renumbering(conn, &todo_ids_before)?;

        // Take this device's counter past everything the pass learned about.
        let max_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos", [], |r| r.get(0))?;
        advance_todo_id_watermark(conn, max_id)?;
        Ok(())
    })?;

    Ok(ApplyResult { applied, skipped_already_applied: entries.len() - pending.len(), notices })
}

fn apply_entry(ctx: &Ctx<'_>, entry: &OplogEntry) -> Result<ApplyOutcome> {
    match entry {
        OplogEntry::Delete(d) => {
            apply_delete(ctx.conn, &d.table, &d.row_uuid, &d.hlc)?;
            Ok(ApplyOutcome { fully_applied: true, notice_raised: false })
        }
        OplogEntry::Upsert(u) => apply_upsert(ctx, u),
        OplogEntry::Link(l) => Ok(ApplyOutcome {
            fully_applied: apply_link(ctx.conn, &l.table, l.op, &l.from_uuid, &l.to_uuid)?,
            notice_raised: false,
        }),
    }
}

// --- Delete (FR-007) ---

fn apply_delete(conn: &Connection, table: &str, row_uuid: &str, hlc: &Hlc) -> Result<()> {
    let canonical = if table == "todo_attachments" { row_uuid.to_string() } else { resolve_alias(conn, table, row_uuid)? };

    conn.execute(
        "INSERT OR REPLACE INTO sync_tombstones
           (table_name, row_uuid, deleted_at, hlc_physical_ms, hlc_counter, hlc_device_number)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![table, canonical, now_iso(), hlc.physical_ms, hlc.counter, hlc.device_number],
    )?;
    conn.execute("DELETE FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ?", params![table, canonical])?;

    if table == "sessions" {
        conn.execute("DELETE FROM sessions WHERE id = ?", [&canonical])?;
        return Ok(());
    }
    if table == "todo_attachments" {
        let (todo_uuid, sha256) = split_attachment_key(&canonical);
        let row: Option<i64> = conn
            .query_row(
                "SELECT a.id FROM todo_attachments a INNER JOIN todos t ON t.id = a.todo_id WHERE t.uuid = ? AND a.sha256 = ?",
                params![todo_uuid, sha256],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = row {
            conn.execute("DELETE FROM todo_attachments WHERE id = ?", [id])?;
        }
        return Ok(());
    }

    let Some(local_id) = local_id_by_uuid(conn, table, &canonical)? else {
        return Ok(());
    };

    if table == "todos" {
        conn.execute("DELETE FROM todos WHERE id = ?", [local_id])?;
        return Ok(());
    }

    if table == "todo_states" {
        // Unlike `project_id` (ON DELETE SET NULL), `state_id` has no delete action, so a bare
        // DELETE would violate the foreign key while a todo still points at this state. Reassign
        // to another state first, as a local delete does.
        let fallback: Option<i64> = match conn
            .query_row(
                "SELECT id FROM todo_states WHERE id != ? AND is_default = 1 LIMIT 1",
                [local_id],
                |r| r.get(0),
            )
            .optional()?
        {
            Some(id) => Some(id),
            None => conn
                .query_row(
                    "SELECT id FROM todo_states WHERE id != ? ORDER BY position ASC LIMIT 1",
                    [local_id],
                    |r| r.get(0),
                )
                .optional()?,
        };
        conn.execute("UPDATE todos SET state_id = ? WHERE state_id = ?", params![fallback, local_id])?;
    }

    conn.execute(&format!("DELETE FROM {table} WHERE id = ?"), [local_id])?;
    Ok(())
}

/// `[key.slice(0, idx), key.slice(idx + 1)]` around the last `:`; with no `:` JS yields
/// `[key.slice(0, -1), key]`.
fn split_attachment_key(key: &str) -> (String, String) {
    match key.rfind(':') {
        Some(idx) => (key[..idx].to_string(), key[idx + 1..].to_string()),
        None => {
            let mut chars: Vec<char> = key.chars().collect();
            chars.pop();
            (chars.into_iter().collect(), key.to_string())
        }
    }
}

// --- Link / unlink ---

/// Returns whether the link/unlink actually happened. `false` (the referenced row has not arrived
/// yet) must leave the entry unmarked in `sync_applied_ops` (B-5).
fn apply_link(conn: &Connection, table: &str, op: LinkKind, from_uuid: &str, to_uuid: &str) -> Result<bool> {
    if table == "todo_label_links" {
        let todo_id = local_id_by_uuid(conn, "todos", &resolve_alias(conn, "todos", from_uuid)?)?;
        let label_id = local_id_by_uuid(conn, "todo_labels", &resolve_alias(conn, "todo_labels", to_uuid)?)?;
        let (Some(todo_id), Some(label_id)) = (todo_id, label_id) else {
            return Ok(false);
        };
        match op {
            LinkKind::Link => conn.execute(
                "INSERT OR IGNORE INTO todo_label_links (todo_id, label_id) VALUES (?, ?)",
                params![todo_id, label_id],
            )?,
            LinkKind::Unlink => conn.execute(
                "DELETE FROM todo_label_links WHERE todo_id = ? AND label_id = ?",
                params![todo_id, label_id],
            )?,
        };
        return Ok(true);
    }

    if table == "session_tags" {
        let Some(tag_id) = local_id_by_uuid(conn, "tags", &resolve_alias(conn, "tags", to_uuid)?)? else {
            return Ok(false);
        };
        let session_exists: Option<i64> =
            conn.query_row("SELECT 1 FROM sessions WHERE id = ?", [from_uuid], |r| r.get(0)).optional()?;
        if session_exists.is_none() {
            return Ok(false);
        }
        match op {
            LinkKind::Link => conn.execute(
                "INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)",
                params![from_uuid, tag_id],
            )?,
            LinkKind::Unlink => {
                conn.execute("DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?", params![from_uuid, tag_id])?
            }
        };
        return Ok(true);
    }

    Ok(true) // a link entry naming a row table: nothing to do
}

// --- Upsert (FR-008, FR-010) ---

/// `fully_applied` is false only when some part of the entry waits on something that has not
/// arrived (an unresolved foreign key): the caller leaves such an entry unmarked so a later pass
/// reconsiders it. A discard-after-delete or an already-satisfied no-op is final.
struct ApplyOutcome {
    fully_applied: bool,
    notice_raised: bool,
}

fn apply_upsert(ctx: &Ctx<'_>, entry: &UpsertEntry) -> Result<ApplyOutcome> {
    let conn = ctx.conn;
    if entry.table == "todo_attachments" {
        return apply_attachment_upsert(conn, entry);
    }
    if entry.table == "sessions" {
        return apply_session_upsert(ctx, entry);
    }

    let table = entry.table.as_str();
    debug_assert!(UUID_TABLES.contains(&table));
    let canonical = resolve_alias(conn, table, &entry.row_uuid)?;

    if is_tombstoned(conn, table, &canonical)? {
        let fields: Vec<&str> = entry.fields.iter().map(|(k, _)| k.as_str()).collect();
        add_sync_notice(
            conn,
            SyncNoticeKind::DiscardAfterDelete,
            &format!("An edit to a deleted {table} record was discarded"),
            Some(&format!(
                "row {canonical}, fields {}, from device {}",
                fields.join(", "),
                entry.hlc.device_number
            )),
        )?;
        return Ok(ApplyOutcome { fully_applied: true, notice_raised: true });
    }

    let mut local_id = local_id_by_uuid(conn, table, &canonical)?;
    let mut effective_uuid = canonical.clone();

    if local_id.is_none() {
        if let Some((id, uuid)) = converge_on_name(conn, table, &canonical, entry)? {
            local_id = Some(id);
            effective_uuid = uuid;
        } else {
            // The peer's claim on a number, not a final id: two machines working apart routinely
            // claim the same one. The row is parked on any free number here and
            // `reconcile_todo_ids` (end of the pass, over the whole set) decides what it holds.
            let claimed = if table == "todos" { incoming_claimed_id(entry) } else { None };
            let id = insert_placeholder_row(conn, table, &canonical, free_todo_id_near(conn, claimed)?)?;
            if let Some(c) = claimed {
                conn.execute("UPDATE todos SET claimed_id = ? WHERE id = ?", params![c, id])?;
            }
            local_id = Some(id);
        }
    }

    let local_id = local_id.unwrap_or_default();
    let fully_applied = apply_fields_lww(ctx, table, &effective_uuid, local_id, &entry.fields)?;
    Ok(ApplyOutcome { fully_applied, notice_raised: false })
}

fn iso_from_millis(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// Name-unique convergence (FR-010): if a row with the same normalised name exists locally under a
/// different uuid, exactly one survives. The row created earlier (by `created_at`, uuid as a final
/// tie-break so both devices pick the same winner) is canonical; the other's uuid becomes an alias.
fn converge_on_name(
    conn: &Connection,
    table: &str,
    incoming_uuid: &str,
    entry: &UpsertEntry,
) -> Result<Option<(i64, String)>> {
    let Some(name_field) = name_unique_field(table) else {
        return Ok(None);
    };
    let Some(incoming_name) = entry.fields.get(name_field).and_then(|c| c.value.as_str()) else {
        return Ok(None);
    };

    let existing: Option<(i64, Option<String>, Option<String>)> = conn
        .query_row(
            &format!("SELECT id, uuid, created_at FROM {table} WHERE {name_field} = ? COLLATE NOCASE"),
            [incoming_name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((existing_id, existing_uuid, existing_created_at)) = existing else {
        return Ok(None);
    };

    // Every row should carry a uuid from creation; this is insurance against an insert path that
    // forgets, so the row can converge instead of colliding with the incoming name a moment later.
    let existing_uuid = match existing_uuid {
        Some(u) => u,
        None => {
            let u = lizmeter_db::util::new_uuid();
            conn.execute(&format!("UPDATE {table} SET uuid = ? WHERE id = ?"), params![u, existing_id])?;
            u
        }
    };
    if existing_uuid == incoming_uuid {
        return Ok(None);
    }
    let existing_created_at = existing_created_at.unwrap_or_default();

    let incoming_created_at = match entry.fields.get("created_at").and_then(|c| c.value.as_str()) {
        Some(s) => s.to_string(),
        None => iso_from_millis(entry.hlc.physical_ms),
    };

    let incoming_is_earlier = incoming_created_at < existing_created_at
        || (incoming_created_at == existing_created_at && incoming_uuid < existing_uuid.as_str());

    if incoming_is_earlier {
        // The incoming row is the canonical one. The existing row keeps its numeric id (every
        // local reference already points at it) but its uuid moves, and the old uuid is the alias.
        conn.execute(
            "INSERT OR REPLACE INTO sync_id_aliases (table_name, old_uuid, new_uuid, created_at) VALUES (?, ?, ?, ?)",
            params![table, existing_uuid, incoming_uuid, now_iso()],
        )?;
        conn.execute(&format!("UPDATE {table} SET uuid = ? WHERE id = ?"), params![incoming_uuid, existing_id])?;
        conn.execute(
            "UPDATE sync_field_clocks SET row_uuid = ? WHERE table_name = ? AND row_uuid = ?",
            params![incoming_uuid, table, existing_uuid],
        )?;
        return Ok(Some((existing_id, incoming_uuid.to_string())));
    }

    // The existing local row is canonical; the incoming row loses and its fields apply onto the
    // survivor through the normal field-LWW path.
    conn.execute(
        "INSERT OR REPLACE INTO sync_id_aliases (table_name, old_uuid, new_uuid, created_at) VALUES (?, ?, ?, ?)",
        params![table, incoming_uuid, existing_uuid, now_iso()],
    )?;
    Ok(Some((existing_id, existing_uuid)))
}

// --- Dense todo id collision resolution ---

/// Moves a todo row from one numeric id to another, carrying every reference with it.
///
/// `foreign_keys = ON` makes the obvious `UPDATE todos SET id = ?` fail while any child row points
/// at the old id. `defer_foreign_keys` postpones the check to COMMIT, so the row and its referencing
/// sites move together inside the merge transaction. Primary-key uniqueness is not deferred, so the
/// caller must vacate the target id first.
pub fn move_todo_row_id(conn: &Connection, from_id: i64, to_id: i64) -> Result<()> {
    if from_id == to_id {
        return Ok(());
    }
    conn.pragma_update(None, "defer_foreign_keys", "ON")?;
    conn.execute("UPDATE todos SET id = ? WHERE id = ?", params![to_id, from_id])?;
    conn.execute("UPDATE todos SET parent_id = ? WHERE parent_id = ?", params![to_id, from_id])?;
    conn.execute("UPDATE todo_label_links SET todo_id = ? WHERE todo_id = ?", params![to_id, from_id])?;
    conn.execute("UPDATE todo_attachments SET todo_id = ? WHERE todo_id = ?", params![to_id, from_id])?;
    Ok(())
}

fn note_reassignment(conn: &Connection, old_id: i64, new_id: i64) -> Result<()> {
    add_sync_notice(
        conn,
        SyncNoticeKind::TodoIdReassigned,
        &format!("Todo #{old_id} was renumbered to #{new_id} because another machine had already used that number."),
        Some(&format!("old id {old_id}, new id {new_id}")),
    )
}

/// The number a peer's entry claims, tolerating the older entries that carried `id`.
fn incoming_claimed_id(entry: &UpsertEntry) -> Option<i64> {
    let as_number = |v: &Value| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64));
    if let Some(c) = entry.fields.get("claimed_id") {
        if c.value.is_number() {
            return as_number(&c.value);
        }
    }
    entry.fields.get("id").filter(|c| c.value.is_number()).and_then(|c| as_number(&c.value))
}

/// A number this row can be parked on right now: its claim when free, otherwise any unused number.
/// Nothing about this choice is load-bearing: `reconcile_todo_ids` overwrites it before commit.
fn free_todo_id_near(conn: &Connection, claimed: Option<i64>) -> Result<Option<i64>> {
    let Some(claimed) = claimed else {
        return Ok(None);
    };
    let taken: Option<i64> = conn.query_row("SELECT 1 FROM todos WHERE id = ?", [claimed], |r| r.get(0)).optional()?;
    if taken.is_none() {
        return Ok(Some(claimed));
    }
    let max_id: i64 = conn.query_row("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos", [], |r| r.get(0))?;
    Ok(Some(max_id + 1))
}

struct TodoIdRow {
    id: i64,
    claimed_id: Option<i64>,
    created_at: String,
    uuid: Option<String>,
}

/// The total order both machines sort by. Same rule `converge_on_name` uses for FR-010.
fn compare_todo_id_rows(a: &TodoIdRow, b: &TodoIdRow) -> Ordering {
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| a.uuid.as_deref().unwrap_or("").cmp(b.uuid.as_deref().unwrap_or("")))
        .then_with(|| a.id.cmp(&b.id))
}

/// Derives every todo's visible id from the full set of claims, and applies the result.
///
/// A pure function of the merged set: the earliest-created claimant of a number keeps it, and every
/// later claimant of an already-taken number is placed after the highest claim, in the same order.
/// Two machines holding the same todos compute identical assignments without exchanging a message.
/// Uncontested todos keep their number forever.
pub fn reconcile_todo_ids(conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT id, claimed_id, created_at, uuid FROM todos")?;
    let mut rows: Vec<TodoIdRow> = stmt
        .query_map([], |r| {
            Ok(TodoIdRow {
                id: r.get(0)?,
                claimed_id: r.get(1)?,
                created_at: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                uuid: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if rows.is_empty() {
        return Ok(0);
    }

    rows.sort_by(compare_todo_id_rows);
    let claim_of = |r: &TodoIdRow| r.claimed_id.unwrap_or(r.id);

    let mut taken: HashSet<i64> = HashSet::new();
    let mut desired: Vec<(i64, i64)> = Vec::new(); // current id -> id it should hold
    let mut contested: Vec<&TodoIdRow> = Vec::new();

    for row in &rows {
        let claim = claim_of(row);
        if taken.contains(&claim) {
            contested.push(row);
            continue;
        }
        taken.insert(claim);
        desired.push((row.id, claim));
    }

    let mut next = rows.iter().map(claim_of).max().unwrap_or(0).max(0) + 1;
    for row in contested {
        while taken.contains(&next) {
            next += 1;
        }
        taken.insert(next);
        desired.push((row.id, next));
        next += 1;
    }

    let moves: Vec<(i64, i64)> = desired.into_iter().filter(|(from, to)| from != to).collect();
    if moves.is_empty() {
        return Ok(0);
    }

    // Two phases via temporary negative ids: primary-key uniqueness is not deferrable, so a row
    // cannot move onto a number another row has not vacated yet. Negatives never collide with a
    // real id, which keeps the intermediate state safe however the moves permute.
    conn.pragma_update(None, "defer_foreign_keys", "ON")?;
    for (index, (from, _)) in moves.iter().enumerate() {
        move_todo_row_id(conn, *from, -(index as i64 + 1))?;
    }
    for (index, (_, to)) in moves.iter().enumerate() {
        move_todo_row_id(conn, -(index as i64 + 1), *to)?;
    }
    Ok(moves.len())
}

/// uuid to visible id, for the before/after comparison that decides what is worth telling the user.
fn snapshot_todo_ids(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT id, uuid FROM todos WHERE uuid IS NOT NULL")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(0)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Reports only the renumberings this user would notice: a todo already on screen under one number
/// and now under another. A row that arrived during this pass has no "before", so the parking slot
/// it briefly held is never mentioned.
fn notice_user_visible_renumbering(conn: &Connection, before: &[(String, i64)]) -> Result<()> {
    let after: HashMap<String, i64> = snapshot_todo_ids(conn)?.into_iter().collect();
    for (uuid, previous_id) in before {
        if let Some(current) = after.get(uuid) {
            if current != previous_id {
                note_reassignment(conn, *previous_id, *current)?;
            }
        }
    }
    Ok(())
}

fn placeholder_text(uuid: &str) -> String {
    let head: String = uuid.chars().take(8).collect();
    format!("(unnamed {head})")
}

/// Inserts a minimal row satisfying schema constraints; the field pass fills in real values right
/// after. `explicit_id` is only ever set for `todos`.
fn insert_placeholder_row(conn: &Connection, table: &str, uuid: &str, explicit_id: Option<i64>) -> Result<i64> {
    let now = now_iso();
    match table {
        "todos" => {
            let default_state: Option<i64> = conn
                .query_row("SELECT id FROM todo_states ORDER BY position ASC LIMIT 1", [], |r| r.get(0))
                .optional()?;
            if let Some(id) = explicit_id {
                conn.execute(
                    "INSERT INTO todos (id, title, state_id, source, created_at, uuid) VALUES (?, ?, ?, 'user', ?, ?)",
                    params![id, "", default_state, now, uuid],
                )?;
                return Ok(id);
            }
            conn.execute(
                "INSERT INTO todos (title, state_id, source, created_at, uuid) VALUES (?, ?, 'user', ?, ?)",
                params!["", default_state, now, uuid],
            )?;
        }
        "tags" => {
            conn.execute(
                "INSERT INTO tags (name, created_at, uuid) VALUES (?, ?, ?)",
                params![placeholder_text(uuid), now, uuid],
            )?;
        }
        "todo_labels" => {
            conn.execute(
                "INSERT INTO todo_labels (name, created_at, uuid) VALUES (?, ?, ?)",
                params![placeholder_text(uuid), now, uuid],
            )?;
        }
        "todo_states" => {
            let next: i64 = conn
                .query_row("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_states", [], |r| r.get(0))?;
            conn.execute(
                "INSERT INTO todo_states (label, position, created_at, uuid) VALUES (?, ?, ?, ?)",
                params![placeholder_text(uuid), next, now, uuid],
            )?;
        }
        "todo_projects" => {
            let next: i64 = conn
                .query_row("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects", [], |r| r.get(0))?;
            conn.execute(
                "INSERT INTO todo_projects (name, position, created_at, uuid) VALUES (?, ?, ?, ?)",
                params![placeholder_text(uuid), next, now, uuid],
            )?;
        }
        other => return Err(crate::SyncError::Message(format!("no placeholder row for table {other}"))),
    }
    Ok(conn.last_insert_rowid())
}

fn read_field_clock(conn: &Connection, table: &str, row_uuid: &str, field: &str) -> Result<Option<Hlc>> {
    Ok(conn
        .query_row(
            "SELECT hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ? AND field_name = ?",
            params![table, row_uuid, field],
            |r| Ok(Hlc { physical_ms: r.get(0)?, counter: r.get(1)?, device_number: r.get(2)? }),
        )
        .optional()?)
}

fn write_field_clock(conn: &Connection, table: &str, row_uuid: &str, field: &str, hlc: &Hlc) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sync_field_clocks
           (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![table, row_uuid, field, hlc.physical_ms, hlc.counter, hlc.device_number],
    )?;
    Ok(())
}

/// Field-level LWW (FR-008): per field, compares against the persisted high-water mark in
/// `sync_field_clocks` and applies only when the incoming value is newer. Foreign key fields resolve
/// back to a local id through the alias table; an unresolvable reference is skipped for now rather
/// than blocking the rest of the entry.
///
/// Returns `false` (B-5) when any field was skipped for that reason, so the caller leaves the entry
/// unmarked and a later pass reconsiders it. An unknown field name (B-1) is a permanent skip and
/// does not by itself make the result `false`.
fn apply_fields_lww(ctx: &Ctx<'_>, table: &str, row_uuid: &str, local_id: i64, fields: &FieldMap) -> Result<bool> {
    let conn = ctx.conn;
    let mut fully_applied = true;

    for (field_name, change) in fields.iter() {
        if let Some(existing) = read_field_clock(conn, table, row_uuid, field_name)? {
            if compare_hlc(&change.hlc, &existing) != Ordering::Greater {
                continue; // not newer: this field keeps its current value
            }
        }

        // `id` never travels as a value to write: the visible id is derived by `reconcile_todo_ids`.
        // A peer on an older build still publishes one, which is folded into the row's claim.
        if field_name == "id" {
            if table == "todos" && change.value.is_number() {
                conn.execute(
                    "UPDATE todos SET claimed_id = ? WHERE id = ? AND claimed_id IS NULL",
                    params![to_bind_value(&change.value)?, local_id],
                )?;
            }
            continue;
        }

        if let Some(fk) = foreign_key_by_field_name(table, field_name) {
            // `fk.column` comes from row_codec's static table, never from the entry.
            match &change.value {
                Value::Null => {
                    conn.execute(&format!("UPDATE {table} SET {} = NULL WHERE id = ?", fk.column), [local_id])?;
                }
                Value::String(uuid) => {
                    let alias = resolve_alias(conn, fk.ref_table, uuid)?;
                    let Some(ref_id) = local_id_by_uuid(conn, fk.ref_table, &alias)? else {
                        fully_applied = false; // referenced row not synced yet: retry on a later pass (B-5)
                        continue;
                    };
                    conn.execute(
                        &format!("UPDATE {table} SET {} = ? WHERE id = ?", fk.column),
                        params![ref_id, local_id],
                    )?;
                }
                _ => continue,
            }
        } else {
            // B-1: not a known foreign key, so the name is about to be interpolated verbatim. It
            // must be a real column first. Permanently skipped, not deferred.
            if !ctx.is_known_column(table, field_name)? {
                continue;
            }
            conn.execute(
                &format!("UPDATE {table} SET {field_name} = ? WHERE id = ?"),
                params![to_bind_value(&change.value)?, local_id],
            )?;
        }

        write_field_clock(conn, table, row_uuid, field_name, &change.hlc)?;
    }

    Ok(fully_applied)
}

fn apply_session_upsert(ctx: &Ctx<'_>, entry: &UpsertEntry) -> Result<ApplyOutcome> {
    let conn = ctx.conn;
    let session_id = entry.row_uuid.as_str();
    if is_tombstoned(conn, "sessions", session_id)? {
        add_sync_notice(
            conn,
            SyncNoticeKind::DiscardAfterDelete,
            "An edit to a deleted session was discarded",
            Some(&format!("session {session_id}")),
        )?;
        return Ok(ApplyOutcome { fully_applied: true, notice_raised: true });
    }

    let exists: Option<i64> =
        conn.query_row("SELECT 1 FROM sessions WHERE id = ?", [session_id], |r| r.get(0)).optional()?;
    if exists.is_none() {
        conn.execute(
            "INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at) VALUES (?, '', 'work', 0, 0, ?)",
            params![session_id, now_iso()],
        )?;
    }

    for (field_name, change) in entry.fields.iter() {
        if let Some(existing) = read_field_clock(conn, "sessions", session_id, field_name)? {
            if compare_hlc(&change.hlc, &existing) != Ordering::Greater {
                continue;
            }
        }
        // B-1: same guard as the generic path: the field name is interpolated verbatim.
        if !ctx.is_known_column("sessions", field_name)? {
            continue;
        }
        conn.execute(
            &format!("UPDATE sessions SET {field_name} = ? WHERE id = ?"),
            params![to_bind_value(&change.value)?, session_id],
        )?;
        write_field_clock(conn, "sessions", session_id, field_name, &change.hlc)?;
    }
    // Sessions carry no foreign keys, so there is never a deferred reference: always final.
    Ok(ApplyOutcome { fully_applied: true, notice_raised: false })
}

fn apply_attachment_upsert(conn: &Connection, entry: &UpsertEntry) -> Result<ApplyOutcome> {
    let (todo_uuid, sha256) = split_attachment_key(&entry.row_uuid);
    if is_tombstoned(conn, "todo_attachments", &entry.row_uuid)? {
        add_sync_notice(
            conn,
            SyncNoticeKind::DiscardAfterDelete,
            "An edit to a deleted attachment was discarded",
            Some(&format!("attachment {}, from device {}", entry.row_uuid, entry.hlc.device_number)),
        )?;
        return Ok(ApplyOutcome { fully_applied: true, notice_raised: true });
    }

    let Some(todo_id) = local_id_by_uuid(conn, "todos", &resolve_alias(conn, "todos", &todo_uuid)?)? else {
        // Parent todo has not synced yet: retried whenever this file is re-read (B-5).
        return Ok(ApplyOutcome { fully_applied: false, notice_raised: false });
    };

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM todo_attachments WHERE todo_id = ? AND sha256 = ?",
            params![todo_id, sha256],
            |r| r.get(0),
        )
        .optional()?;
    if existing.is_some() {
        // Content-addressed: identical bytes already recorded, nothing to update.
        return Ok(ApplyOutcome { fully_applied: true, notice_raised: false });
    }

    let text = |name: &str, default: &str| -> String {
        entry.fields.get(name).and_then(|c| c.value.as_str()).unwrap_or(default).to_string()
    };
    let file_name = text("file_name", &sha256);
    let mime_type = text("mime_type", "application/octet-stream");
    let kind = text("kind", "file");
    let size_bytes = entry.fields.get("size_bytes").filter(|c| c.value.is_number()).map(|c| &c.value);
    let size_bind = match size_bytes {
        Some(v) => to_bind_value(v)?,
        None => rusqlite::types::Value::Integer(0),
    };

    conn.execute(
        "INSERT OR IGNORE INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![todo_id, sha256, file_name, mime_type, size_bind, kind, now_iso()],
    )?;
    Ok(ApplyOutcome { fully_applied: true, notice_raised: false })
}

// --- Ordering convergence (FR-011) ---

/// After a merge brings in new `sync_order` values, sorts every row by that key and rewrites the
/// dense integer `position` column 0..N-1. Rows without a `sync_order` sort after every row that
/// has one, keeping their relative order.
pub fn recompute_local_position_from_sync_order(conn: &Connection, table: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("SELECT id, sync_order, position FROM {table} ORDER BY position ASC"))?;
    let mut rows: Vec<(i64, Option<String>, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if rows.is_empty() || rows.iter().all(|r| r.1.is_none()) {
        return Ok(()); // nothing has ever synced an order: leave local positions untouched
    }

    rows.sort_by(|a, b| match (&a.1, &b.1) {
        (None, None) => a.2.cmp(&b.2),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => x.cmp(y),
    });

    for (index, row) in rows.iter().enumerate() {
        if row.2 != index as i64 {
            conn.execute(&format!("UPDATE {table} SET position = ? WHERE id = ?"), params![index as i64, row.0])?;
        }
    }
    Ok(())
}
