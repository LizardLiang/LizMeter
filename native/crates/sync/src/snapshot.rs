//! Retention, compaction and stale-machine rebuild (`snapshot.ts`; FR-018, FR-019).
//!
//! Every device writes its own daily snapshot of the fully merged state it holds, then trims its own
//! oplog file to the retention window. A device offline longer than that window does not trust its
//! stale local history: it discards it and rebuilds from the most recent snapshot among all devices,
//! then replays anything newer. A snapshot is a list of the same entry shapes the live oplog uses,
//! so a rebuild is "feed these into `apply_oplog_entries`": no parallel apply path.

use crate::device_identity::get_or_assign_device_number;
use crate::hlc::{tick, Hlc};
use crate::hydration_guard::read_file_guarded;
use crate::merge_engine::apply_oplog_entries;
use crate::notices::add_sync_notice;
use crate::oplog::{
    attachment_row_key, build_delete_entry, build_link_entry, build_upsert_entry, get_snapshot_file_path,
    get_sync_devices_dir, is_plausible_entry, read_oplog_entries, FieldChange, FieldMap, LinkKind, OplogEntry,
    CURRENT_OPLOG_VERSION, OPLOG_SUFFIX, SNAPSHOT_SUFFIX,
};
use crate::row_codec::{all_columns_for, encode_row_fields, query_rows, RowMap};
use crate::{in_transaction, read_setting, write_setting, Result, SyncError};
use lizmeter_core::SyncNoticeKind;
use lizmeter_db::data_location::{backup_db_with_siblings, BackupMode};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// Order matters: every snapshot entry shares one HLC, so the stable HLC sort in the merge engine
// falls back to this order among them. States and projects must apply before todos, since a todo's
// `state_uuid`/`project_uuid` only resolve to a row that already exists.
const SNAPSHOT_ROW_TABLES: [&str; 6] = ["todo_states", "todo_projects", "todo_labels", "tags", "todos", "sessions"];

/// History and tombstones older than this are compacted away (FR-018).
pub const RETENTION_DAYS: i64 = 90;
const RETENTION_MS: i64 = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const LAST_SNAPSHOT_AT_KEY: &str = "sync.lastSnapshotAt";
const LAST_SYNCED_AT_KEY: &str = "sync.lastSyncedAt";

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// `Date.parse`: `None` is NaN, and every comparison against it is false.
fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// Records that a sync pass completed successfully just now. Read back by the stale-rejoin check.
pub fn mark_synced_now(conn: &Connection, now: i64) -> Result<()> {
    write_setting(conn, LAST_SYNCED_AT_KEY, &iso(now))
}

/// The persisted "last synced" timestamp, surviving a restart.
pub fn get_last_synced_at(conn: &Connection) -> Result<Option<String>> {
    read_setting(conn, LAST_SYNCED_AT_KEY)
}

fn scalar_fields(row: &RowMap, skip: &[&str], hlc: Hlc) -> FieldMap {
    FieldMap::with_hlc(row.iter().filter(|(k, _)| !skip.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())), hlc)
}

/// The full contents of this device's own snapshot: one upsert per row across every synced table,
/// one delete per tombstone still inside the retention window (original HLC preserved, since
/// delete-wins never depends on relative timing), and one link per join-table row.
pub fn build_snapshot_entries(conn: &Connection, now: i64) -> Result<Vec<OplogEntry>> {
    let device_number = get_or_assign_device_number(conn, None)?;
    let snapshot_hlc = tick(conn, device_number)?;
    let mut entries: Vec<OplogEntry> = Vec::new();
    let cutoff = now - RETENTION_MS;

    for table in SNAPSHOT_ROW_TABLES {
        if table == "sessions" {
            for row in query_rows(conn, "SELECT * FROM sessions", [])? {
                let id = row.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                entries.push(build_upsert_entry(snapshot_hlc, "sessions", &id, scalar_fields(&row, &["id"], snapshot_hlc)));
            }
            continue;
        }

        let columns = all_columns_for(conn, table)?;
        for row in query_rows(conn, &format!("SELECT * FROM {table}"), [])? {
            let Some(row_uuid) = row.get("uuid").and_then(Value::as_str).filter(|u| !u.is_empty()) else {
                continue;
            };
            let encoded = encode_row_fields(conn, table, &row, &columns)?;
            let mut fields = FieldMap::with_hlc(encoded, snapshot_hlc);
            if table == "todos" {
                fields.0.push((
                    "id".to_string(),
                    FieldChange { value: row.get("id").cloned().unwrap_or(Value::Null), hlc: snapshot_hlc },
                ));
            }
            entries.push(build_upsert_entry(snapshot_hlc, table, row_uuid, fields));
        }
    }

    // todo_attachments is a synced table: without its own entries here a rebuild silently loses every
    // still-attached file's row (the blob survives unreferenced; only the row pointing at it is gone).
    for row in query_rows(
        conn,
        "SELECT t.uuid AS todo_uuid, a.sha256, a.file_name, a.mime_type, a.size_bytes, a.kind
         FROM todo_attachments a
         INNER JOIN todos t ON t.id = a.todo_id
         WHERE t.uuid IS NOT NULL",
        [],
    )? {
        let text = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
        let key = attachment_row_key(
            row.get("todo_uuid").and_then(Value::as_str).unwrap_or_default(),
            row.get("sha256").and_then(Value::as_str).unwrap_or_default(),
        );
        let fields = FieldMap::with_hlc(
            [
                ("file_name", text("file_name")),
                ("mime_type", text("mime_type")),
                ("size_bytes", text("size_bytes")),
                ("kind", text("kind")),
            ],
            snapshot_hlc,
        );
        entries.push(build_upsert_entry(snapshot_hlc, "todo_attachments", &key, fields));
    }

    for row in query_rows(
        conn,
        "SELECT table_name, row_uuid, hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_tombstones WHERE hlc_physical_ms >= ?",
        [cutoff],
    )? {
        let num = |k: &str| row.get(k).and_then(Value::as_i64).unwrap_or(0);
        let hlc = Hlc { physical_ms: num("hlc_physical_ms"), counter: num("hlc_counter"), device_number: num("hlc_device_number") };
        entries.push(build_delete_entry(
            hlc,
            row.get("table_name").and_then(Value::as_str).unwrap_or_default(),
            row.get("row_uuid").and_then(Value::as_str).unwrap_or_default(),
        ));
    }

    for row in query_rows(
        conn,
        "SELECT t.uuid AS todo_uuid, l.uuid AS label_uuid
         FROM todo_label_links k
         INNER JOIN todos t ON t.id = k.todo_id
         INNER JOIN todo_labels l ON l.id = k.label_id",
        [],
    )? {
        entries.push(build_link_entry(
            snapshot_hlc,
            "todo_label_links",
            LinkKind::Link,
            row.get("todo_uuid").and_then(Value::as_str).unwrap_or_default(),
            row.get("label_uuid").and_then(Value::as_str).unwrap_or_default(),
        ));
    }

    for row in query_rows(
        conn,
        "SELECT st.session_id AS session_id, t.uuid AS tag_uuid
         FROM session_tags st
         INNER JOIN tags t ON t.id = st.tag_id",
        [],
    )? {
        entries.push(build_link_entry(
            snapshot_hlc,
            "session_tags",
            LinkKind::Link,
            row.get("session_id").and_then(Value::as_str).unwrap_or_default(),
            row.get("tag_uuid").and_then(Value::as_str).unwrap_or_default(),
        ));
    }

    Ok(entries)
}

/// Writes this device's snapshot file and trims its own oplog to the retention window, at most once
/// per calendar day. Never touches a peer's file.
pub fn write_snapshot_if_due(conn: &Connection, data_dir: &Path, device_id: &str, now: i64) -> Result<bool> {
    if let Some(last) = read_setting(conn, LAST_SNAPSHOT_AT_KEY)? {
        if parse_ms(&last).is_some_and(|l| now - l < DAY_MS) {
            return Ok(false);
        }
    }

    let entries = build_snapshot_entries(conn, now)?;
    let snapshot = json!({
        "v": CURRENT_OPLOG_VERSION,
        "deviceId": device_id,
        "createdAt": iso(now),
        "entries": entries.iter().map(OplogEntry::to_value).collect::<Vec<_>>(),
    });

    std::fs::create_dir_all(get_sync_devices_dir(data_dir))?;
    atomic_write_file(&get_snapshot_file_path(data_dir, device_id), &format!("{snapshot}\n"))?;

    trim_own_oplog(data_dir, device_id, now)?;
    // Prune this device's own tombstone table on the same cadence, with the cutoff the snapshot just
    // applied. Otherwise the table (and every future snapshot embedding it) grows without bound.
    prune_old_tombstones(conn, now)?;
    write_setting(conn, LAST_SNAPSHOT_AT_KEY, &iso(now))?;
    Ok(true)
}

/// Deletes tombstones older than the retention window (H-002). Never ages out `sync_field_clocks`:
/// it has no death timestamp, and pruning it would delete a live row's high-water mark.
fn prune_old_tombstones(conn: &Connection, now: i64) -> Result<()> {
    conn.execute("DELETE FROM sync_tombstones WHERE hlc_physical_ms < ?", [now - RETENTION_MS])?;
    Ok(())
}

/// Rewrites this device's own oplog file to entries newer than the retention window (FR-018).
fn trim_own_oplog(data_dir: &Path, device_id: &str, now: i64) -> Result<()> {
    let path = get_sync_devices_dir(data_dir).join(format!("{device_id}{OPLOG_SUFFIX}"));
    if !path.exists() {
        return Ok(());
    }
    let read = read_oplog_entries(&path)?;
    let cutoff = now - RETENTION_MS;
    let kept: Vec<&OplogEntry> = read.entries.iter().filter(|e| e.hlc().physical_ms >= cutoff).collect();
    if kept.len() == read.entries.len() {
        return Ok(()); // nothing to trim
    }
    let lines = kept.iter().map(|e| e.to_line()).collect::<Vec<_>>().join("\n");
    atomic_write_file(&path, &if kept.is_empty() { String::new() } else { format!("{lines}\n") })
}

/// Writes through a temp file in the same directory plus a rename, so a crash mid-write leaves the
/// file as either the old complete contents or the new complete contents, never a partial write.
fn atomic_write_file(path: &Path, data: &str) -> Result<()> {
    let ms = crate::hlc::now_ms();
    let temp = PathBuf::from(format!("{}.tmp-{}-{ms}", path.display(), std::process::id()));
    std::fs::write(&temp, data)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

struct SnapshotFile {
    device_id: String,
    created_at: String,
    entries: Vec<OplogEntry>,
}

/// Reads a peer's (or this device's own) snapshot file under the hydration guard, then filters
/// `entries` through the same plausibility gate a live oplog line passes (B-1): a snapshot is just as
/// much untrusted peer-authored content as an oplog file.
fn read_snapshot_file(path: &Path) -> Result<Option<SnapshotFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = read_file_guarded(path)?;
    let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(None);
    };
    let Some(raw_entries) = parsed.get("entries").and_then(Value::as_array) else {
        return Ok(None);
    };
    let entries = raw_entries
        .iter()
        .filter(|e| is_plausible_entry(e))
        .filter_map(OplogEntry::from_value)
        .collect();
    Ok(Some(SnapshotFile {
        device_id: parsed.get("deviceId").and_then(Value::as_str).unwrap_or_default().to_string(),
        created_at: parsed.get("createdAt").and_then(Value::as_str).unwrap_or_default().to_string(),
        entries,
    }))
}

/// The most recently created snapshot among every device that has ever published one.
fn find_most_recent_snapshot(data_dir: &Path) -> Result<Option<SnapshotFile>> {
    let dir = get_sync_devices_dir(data_dir);
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Ok(None);
    };
    let mut names: Vec<String> = read_dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();

    let mut best: Option<SnapshotFile> = None;
    for name in names {
        if !name.ends_with(SNAPSHOT_SUFFIX) {
            continue;
        }
        let Some(snapshot) = read_snapshot_file(&dir.join(&name))? else {
            continue;
        };
        let newer = match &best {
            None => true,
            Some(b) => match (parse_ms(&snapshot.created_at), parse_ms(&b.created_at)) {
                (Some(a), Some(b)) => a > b,
                _ => false,
            },
        };
        if newer {
            best = Some(snapshot);
        }
    }
    Ok(best)
}

/// True when this device's last successful sync was longer ago than the retention window: its own
/// unsynced history may already be compacted away on every peer, and replaying it as new work would
/// risk resurrecting something legitimately deleted.
pub fn is_stale(conn: &Connection, now: i64) -> Result<bool> {
    let Some(last) = read_setting(conn, LAST_SYNCED_AT_KEY)? else {
        return Ok(false); // never synced yet: new, not stale
    };
    Ok(parse_ms(&last).is_some_and(|l| now - l > RETENTION_MS))
}

/// Without this, restoring a `.pre-rebuild-*.bak` over the live database is a trap: the backup
/// carries the stale `sync.lastSyncedAt` that made `is_stale` true, so the next merge pass would wipe
/// the restored data again. Marking the copy "synced now" lets a restored copy resume ordinary
/// merging. A failure here never blocks the backup from existing.
fn mark_backup_as_restorable(backup_path: &Path) {
    if let Ok(conn) = Connection::open(backup_path) {
        let _ = write_setting(&conn, LAST_SYNCED_AT_KEY, &iso(crate::hlc::now_ms()));
        let _ = conn.close();
    }
}

/// Timestamped backup before [`rebuild_from_snapshot`]'s destructive wipe: copies the db plus its
/// `-wal`/`-shm` siblings, then marks the copy restorable. `None` for an in-memory or absent
/// database. A copy failure is [`SyncError::RebuildBackupFailed`], raised before the wipe opens, so
/// the destructive step never starts without a recoverable backup.
pub fn backup_before_rebuild(db_path: Option<&Path>) -> Result<Option<PathBuf>> {
    let Some(db_path) = db_path else {
        return Ok(None);
    };
    let backup = backup_db_with_siblings(db_path, "rebuild", BackupMode::Copy)
        .map_err(|e| SyncError::RebuildBackupFailed(e.to_string()))?;
    if let Some(b) = &backup {
        mark_backup_as_restorable(b);
    }
    Ok(backup)
}

struct PreservedActivity {
    sessions: Vec<RowMap>,
    idle_periods: Vec<RowMap>,
}

/// `claude_code_sessions` and `claude_code_idle_periods` are machine-local: sync never reads or
/// writes them. But `DELETE FROM sessions` cascades into both, so a bare wipe would destroy them.
/// Read before the wipe, re-inserted afterwards for every session id that survives.
fn preserve_claude_code_activity(conn: &Connection) -> Result<PreservedActivity> {
    Ok(PreservedActivity {
        sessions: query_rows(conn, "SELECT * FROM claude_code_sessions", [])?,
        idle_periods: query_rows(conn, "SELECT * FROM claude_code_idle_periods", [])?,
    })
}

fn exact_sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn insert_row(conn: &Connection, table: &str, row: &RowMap) -> Result<()> {
    let columns: Vec<&String> = row.keys().collect();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        columns.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", "),
        columns.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
    );
    let values: Vec<SqlValue> = columns.iter().map(|c| exact_sql_value(&row[c.as_str()])).collect();
    conn.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(())
}

/// Re-inserts the preserved rows whose parent session survived. Returns how many
/// `claude_code_sessions` rows could not be restored, so the rebuild notice can name that loss.
fn restore_claude_code_activity(conn: &Connection, preserved: &PreservedActivity) -> Result<usize> {
    if preserved.sessions.is_empty() {
        return Ok(0);
    }
    let mut stmt = conn.prepare("SELECT id FROM sessions")?;
    let surviving_ids: std::collections::HashSet<String> =
        stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let surviving: Vec<&RowMap> = preserved
        .sessions
        .iter()
        .filter(|r| r.get("session_id").and_then(Value::as_str).is_some_and(|s| surviving_ids.contains(s)))
        .collect();
    let surviving_cc_ids: std::collections::HashSet<&str> =
        surviving.iter().filter_map(|r| r.get("id").and_then(Value::as_str)).collect();

    in_transaction(conn, || {
        for row in &surviving {
            insert_row(conn, "claude_code_sessions", row)?;
        }
        for row in &preserved.idle_periods {
            let keep = row.get("cc_session_id").and_then(Value::as_str).is_some_and(|s| surviving_cc_ids.contains(s));
            if keep {
                insert_row(conn, "claude_code_idle_periods", row)?;
            }
        }
        Ok(())
    })?;

    Ok(preserved.sessions.len() - surviving.len())
}

/// FR-019: discards this device's working state for every synced table and rebuilds from the most
/// recent snapshot among all devices, then replays every oplog entry newer than that snapshot. Writes
/// a notice. Returns `false` (a no-op) when no snapshot exists anywhere: nothing to rebuild from, so
/// local state stays untouched.
pub fn rebuild_from_snapshot(
    conn: &Connection,
    data_dir: &Path,
    own_device_id: &str,
    db_path: Option<&Path>,
    now: i64,
) -> Result<bool> {
    let Some(snapshot) = find_most_recent_snapshot(data_dir)? else {
        return Ok(false);
    };

    let backup_path = backup_before_rebuild(db_path)?;
    let preserved = preserve_claude_code_activity(conn)?;

    in_transaction(conn, || {
        // todos.state_id references todo_states(id) with no ON DELETE action and foreign_keys = ON,
        // so a bare DELETE FROM todo_states fails on any machine with todos and rolls the wipe back.
        // Both tables are wiped in this same transaction, so nulling the reference first is safe.
        conn.execute_batch("UPDATE todos SET state_id = NULL")?;
        for table in SNAPSHOT_ROW_TABLES {
            conn.execute_batch(&format!("DELETE FROM {table}"))?;
        }
        conn.execute_batch("DELETE FROM todo_label_links")?;
        conn.execute_batch("DELETE FROM session_tags")?;
        conn.execute_batch("DELETE FROM sync_field_clocks")?;
        conn.execute_batch("DELETE FROM sync_tombstones")?;
        conn.execute_batch("DELETE FROM sync_id_aliases")?;
        conn.execute_batch("DELETE FROM sync_applied_ops")?;
        Ok(())
    })?;

    apply_oplog_entries(conn, &snapshot.entries)?;

    let dir = get_sync_devices_dir(data_dir);
    let mut newer: Vec<OplogEntry> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&dir) {
        let mut names: Vec<String> = read_dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        let snapshot_ms = parse_ms(&snapshot.created_at);
        for name in names {
            let Some(device_id) = name.strip_suffix(OPLOG_SUFFIX) else {
                continue;
            };
            if device_id == own_device_id {
                continue;
            }
            for entry in read_oplog_entries(&dir.join(&name))?.entries {
                if snapshot_ms.is_some_and(|s| s <= entry.hlc().physical_ms) {
                    newer.push(entry);
                }
            }
        }
    }
    apply_oplog_entries(conn, &newer)?;

    let dropped = restore_claude_code_activity(conn, &preserved)?;

    mark_synced_now(conn, now)?;
    let mut detail = format!("snapshot from {} created {}", snapshot.device_id, snapshot.created_at);
    if let Some(b) = &backup_path {
        detail.push_str(&format!("; pre-rebuild backup at {}", b.display()));
    }
    if dropped > 0 {
        detail.push_str(&format!(
            "; {dropped} local Claude Code session record(s) could not be restored (their parent session did not survive the rebuild)"
        ));
    }
    add_sync_notice(
        conn,
        SyncNoticeKind::StaleMachineRebuild,
        "This machine was offline for more than 90 days, so it rebuilt from the latest snapshot instead of replaying its own stale history.",
        Some(&detail),
    )?;
    Ok(true)
}
