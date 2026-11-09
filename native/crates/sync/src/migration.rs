//! The one-time steps that turn an existing populated database into a synced device, and the initial
//! publication of its existing rows (`migration.ts`; FR-015, FR-016).

use crate::device_identity::{get_or_assign_device_number, register_device, LEGACY_TODO_ID_BLOCK_STRIDE};
use crate::merge_engine::move_todo_row_id;
use crate::notices::add_sync_notice;
use crate::row_codec::{all_columns_for, encode_row_fields, query_rows};
use crate::sync_writer::SyncWriter;
use crate::{in_transaction, Result};
use lizmeter_core::SyncNoticeKind;
use lizmeter_db::data_location::{backup_db_with_siblings, BackupMode};
use lizmeter_db::{set_sync_enabled, util::new_uuid};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::{Path, PathBuf};

const SYNC_ROW_TABLES: [&str; 5] = ["todos", "tags", "todo_labels", "todo_states", "todo_projects"];

/// Timestamped backup before the one-way step. `None`, doing nothing, for an in-memory database or a
/// path that does not exist.
pub fn backup_before_sync_migration(db_path: Option<&Path>) -> Result<Option<PathBuf>> {
    match db_path {
        None => Ok(None),
        Some(p) => Ok(backup_db_with_siblings(p, "sync", BackupMode::Copy)?),
    }
}

/// Adds a uuid to every row of every synced table that predates the column.
pub fn backfill_uuids(conn: &Connection) -> Result<()> {
    for table in SYNC_ROW_TABLES {
        let mut stmt = conn.prepare(&format!("SELECT id FROM {table} WHERE uuid IS NULL"))?;
        let ids: Vec<i64> = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        if ids.is_empty() {
            continue;
        }
        in_transaction(conn, || {
            for id in &ids {
                conn.execute(&format!("UPDATE {table} SET uuid = ? WHERE id = ?"), params![new_uuid(), id])?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncMigrationResult {
    pub backup_path: Option<PathBuf>,
    pub device_number: i64,
}

/// Runs once, when the user first turns sync on over existing data. Takes a backup, backfills every
/// missing uuid, and registers this machine's device number: 0 when this device originates the shared
/// folder (decided from the folder's own contents, not from whether this database has data).
pub fn run_sync_migration(
    conn: &Connection,
    db_path: Option<&Path>,
    data_dir: &Path,
    writer: &SyncWriter,
) -> Result<SyncMigrationResult> {
    let backup_path = backup_before_sync_migration(db_path)?;
    backfill_uuids(conn)?;
    let device_number = get_or_assign_device_number(conn, Some(data_dir))?;
    register_device(conn, writer.device_id(), device_number)?;
    Ok(SyncMigrationResult { backup_path, device_number })
}

/// Publishes every existing row across the synced tables as one initial upsert entry each.
pub fn publish_existing_data(conn: &Connection, writer: &SyncWriter) -> Result<()> {
    for table in SYNC_ROW_TABLES {
        let columns = all_columns_for(conn, table)?;
        for row in query_rows(conn, &format!("SELECT * FROM {table}"), [])? {
            let Some(row_uuid) = row.get("uuid").and_then(Value::as_str).filter(|u| !u.is_empty()) else {
                continue;
            };
            let mut fields = encode_row_fields(conn, table, &row, &columns)?;
            // A todo's numeric id is globally meaningful, so it is published like any other field.
            // Every other synced table's local id is device-specific and stays behind.
            if table == "todos" {
                fields.push(("id".to_string(), row.get("id").cloned().unwrap_or(Value::Null)));
            }
            writer.upsert(conn, table, row_uuid, &fields)?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenumberResult {
    pub backup_path: Option<PathBuf>,
    pub renumbered: Vec<(i64, i64)>,
}

/// How many todos still carry a number the retired block scheme handed out.
pub fn count_block_allocated_todos(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT COUNT(*) AS count FROM todos WHERE id >= ?", [LEGACY_TODO_ID_BLOCK_STRIDE], |r| {
        r.get(0)
    })?)
}

/// The one-time fold of block-allocated ids into the dense run (user-initiated).
///
/// A todo below the legacy stride came from the machine that originated the shared folder and may
/// already be written into a note, so those never move. Only the unusable 15-digit ids are reassigned,
/// taking the next numbers after the highest untouched one, in creation order. The new number is
/// written to `claimed_id` as well as `id` and published, so the peer adopts the same assignment
/// through the ordinary derivation path. Idempotent.
pub fn renumber_block_allocated_todo_ids(
    conn: &Connection,
    writer: &SyncWriter,
    db_path: Option<&Path>,
) -> Result<RenumberResult> {
    let mut stmt =
        conn.prepare("SELECT id, uuid FROM todos WHERE id >= ? ORDER BY created_at ASC, uuid ASC, id ASC")?;
    let legacy: Vec<(i64, Option<String>)> = stmt
        .query_map([LEGACY_TODO_ID_BLOCK_STRIDE], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);
    if legacy.is_empty() {
        return Ok(RenumberResult { backup_path: None, renumbered: Vec::new() });
    }

    let backup_path = match db_path {
        Some(p) => backup_db_with_siblings(p, "renumber", BackupMode::Copy)?,
        None => None,
    };

    let max_id: i64 = conn.query_row(
        "SELECT COALESCE(MAX(id), 0) AS maxId FROM todos WHERE id < ?",
        [LEGACY_TODO_ID_BLOCK_STRIDE],
        |r| r.get(0),
    )?;

    let mut renumbered: Vec<(i64, i64)> = Vec::new();
    in_transaction(conn, || {
        let mut next = max_id + 1;
        for (id, uuid) in &legacy {
            // No two-phase dance: every target sits below the stride and above the highest number
            // already in use there, so it cannot be occupied.
            move_todo_row_id(conn, *id, next)?;
            conn.execute("UPDATE todos SET claimed_id = ? WHERE id = ?", params![next, next])?;
            if let Some(u) = uuid {
                writer.upsert(conn, "todos", u, &[("claimed_id".to_string(), Value::from(next))])?;
            }
            renumbered.push((*id, next));
            next += 1;
        }
        add_sync_notice(
            conn,
            SyncNoticeKind::TodoIdReassigned,
            &format!("{} todo(s) were renumbered into the normal sequence.", renumbered.len()),
            Some(&renumbered.iter().map(|(f, t)| format!("#{f} -> #{t}")).collect::<Vec<_>>().join(", ")),
        )
    })?;

    Ok(RenumberResult { backup_path, renumbered })
}

/// Turns sync on for the first time on this already-populated machine: migrates identity, flips the
/// enabled flag, then publishes the existing rows so peers have something to merge. `data_dir` is the
/// shared folder this machine publishes into; its live database already sits in private storage.
pub fn enable_sync_on_existing_machine(
    conn: &Connection,
    db_path: Option<&Path>,
    data_dir: &Path,
    writer: &SyncWriter,
) -> Result<SyncMigrationResult> {
    let result = run_sync_migration(conn, db_path, data_dir, writer)?;
    set_sync_enabled(conn, true)?;
    publish_existing_data(conn, writer)?;
    Ok(result)
}
