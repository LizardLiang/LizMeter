//! The local write-path hook (`sync-writer.ts`): after a synced table's local write commits, these
//! append one oplog entry describing what changed.
//!
//! Every method is a no-op while `settings['sync.enabled']` is not `"true"`, so a database that
//! never syncs behaves as it did before the feature: no oplog files, no device-number surprises,
//! no change to how todo ids are assigned.

use crate::device_identity::{allocate_next_todo_id, get_device_id, get_or_assign_device_number};
use crate::hlc::{tick, Hlc};
use crate::lexorank::generate_ordered_keys;
use crate::notices::{clear_publish_pending_notice, set_publish_pending_notice};
use crate::oplog::{
    build_delete_entry, build_link_entry, build_upsert_entry, get_oplog_file_path, get_sync_devices_dir, FieldMap,
    LinkKind, OplogEntry,
};
use crate::Result;
use lizmeter_db::{ensure_uuid, is_sync_enabled, Fields, LinkOp, SyncHook};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Publishes this device's writes into the shared folder.
#[derive(Debug, Clone)]
pub struct SyncWriter {
    data_dir: PathBuf,
    device_id: String,
}

impl SyncWriter {
    /// `data_dir` is the shared sync folder; `user_data_dir` holds `device-identity.json`.
    pub fn new(data_dir: impl Into<PathBuf>, user_data_dir: &Path) -> Result<Self> {
        Ok(SyncWriter { data_dir: data_dir.into(), device_id: get_device_id(user_data_dir)? })
    }

    pub fn with_device_id(data_dir: impl Into<PathBuf>, device_id: impl Into<String>) -> Self {
        SyncWriter { data_dir: data_dir.into(), device_id: device_id.into() }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Queues one oplog line in the local `sync_outbox`. The insert joins the caller's open
    /// transaction, so the line exists if and only if the row change it describes committed.
    /// `flush_outbox` appends queued lines to the shared file after the commit.
    fn enqueue(&self, conn: &Connection, entry: &OplogEntry) -> Result<()> {
        conn.execute(
            "INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)",
            params![entry.to_line(), lizmeter_db::util::now_iso()],
        )?;
        Ok(())
    }

    /// Appends every queued line to this device's oplog file in one write, then removes the queue
    /// rows. Never fails the caller: a failed append keeps the rows and raises one "publish pending"
    /// notice with the count; a later flush retries. A crash between the append and the delete
    /// re-sends the same lines later, which peers ignore by `opId`.
    pub fn flush_outbox(&self, conn: &Connection) {
        self.flush_outbox_with_writer(conn, |file, bytes| file.write_all(bytes));
    }

    /// `flush_outbox` with the final write supplied by the caller, so a test can make the write
    /// fail partway.
    #[doc(hidden)]
    pub fn flush_outbox_with_writer(
        &self,
        conn: &Connection,
        write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
    ) {
        if let Err(err) = self.try_flush(conn, write) {
            eprintln!("[sync] outbox flush failed: {err}");
        }
    }

    fn try_flush(
        &self,
        conn: &Connection,
        write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
    ) -> Result<()> {
        let mut stmt = conn.prepare("SELECT seq, line FROM sync_outbox ORDER BY seq")?;
        let rows: Vec<(i64, String)> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let Some(last_seq) = rows.last().map(|r| r.0) else {
            clear_publish_pending_notice(conn)?;
            return Ok(());
        };

        if let Err(err) = self.append_lines(&rows, write) {
            set_publish_pending_notice(conn, rows.len(), Some(&err.to_string()))?;
            return Ok(());
        }
        conn.execute("DELETE FROM sync_outbox WHERE seq <= ?", [last_seq])?;
        clear_publish_pending_notice(conn)?;
        Ok(())
    }

    /// Appends the lines. A failed write is cut back to the file's length before the append, so no
    /// torn fragment stays mid-file when the rows are sent again.
    fn append_lines(
        &self,
        rows: &[(i64, String)],
        write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
    ) -> std::io::Result<()> {
        std::fs::create_dir_all(get_sync_devices_dir(&self.data_dir))?;
        let path = get_oplog_file_path(&self.data_dir, &self.device_id);
        let length_before = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut text: String = rows.iter().map(|(_, line)| format!("{line}\n")).collect();
        if ends_with_partial_line(&path) {
            text.insert(0, '\n');
        }
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        let written = write(&mut file, text.as_bytes());
        drop(file);
        if written.is_err() {
            undo_partial_append(&path, length_before);
        }
        written
    }

    fn current_hlc(&self, conn: &Connection) -> Result<Hlc> {
        let device_number = get_or_assign_device_number(conn, None)?;
        tick(conn, device_number)
    }

    /// Queues an upsert entry naming only the fields that changed. No-op when sync is off.
    pub fn upsert(&self, conn: &Connection, table: &str, row_uuid: &str, fields: &[(String, Value)]) -> Result<()> {
        if !is_sync_enabled(conn)? || fields.is_empty() {
            return Ok(());
        }
        let hlc = self.current_hlc(conn)?;
        let changes = FieldMap::with_hlc(fields.iter().cloned(), hlc);
        self.enqueue(conn, &build_upsert_entry(hlc, table, row_uuid, changes))?;

        // A local write competes with a remote one for the same field just as much as two remote
        // writes do, so it needs the same high-water mark the merge engine reads. The merge engine
        // never writes a clock for `id` (ids are derived by `reconcile_todo_ids`), so the clock
        // recorded here for a todo's `id` is never read; it is kept for row parity with the TS writer.
        let mut set_clock = conn.prepare_cached(
            "INSERT OR REPLACE INTO sync_field_clocks
               (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number)
             VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        for (field, _) in fields {
            set_clock.execute(params![table, row_uuid, field, hlc.physical_ms, hlc.counter, hlc.device_number])?;
        }
        Ok(())
    }

    /// Queues a tombstone and records it locally so this device's own delete always wins. No-op when sync is off.
    pub fn delete(&self, conn: &Connection, table: &str, row_uuid: &str) -> Result<()> {
        if !is_sync_enabled(conn)? {
            return Ok(());
        }
        let hlc = self.current_hlc(conn)?;
        self.enqueue(conn, &build_delete_entry(hlc, table, row_uuid))?;
        conn.execute(
            "INSERT OR REPLACE INTO sync_tombstones
               (table_name, row_uuid, deleted_at, hlc_physical_ms, hlc_counter, hlc_device_number)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                table,
                row_uuid,
                lizmeter_db::util::now_iso(),
                hlc.physical_ms,
                hlc.counter,
                hlc.device_number
            ],
        )?;
        // Mirrors the merge engine's own cleanup: a deleted row's field clocks guard nothing.
        conn.execute("DELETE FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ?", params![table, row_uuid])?;
        Ok(())
    }

    /// Queues a link/unlink entry for a join table. No-op when sync is off.
    pub fn link(&self, conn: &Connection, table: &str, op: LinkKind, from_uuid: &str, to_uuid: &str) -> Result<()> {
        if !is_sync_enabled(conn)? {
            return Ok(());
        }
        let hlc = self.current_hlc(conn)?;
        self.enqueue(conn, &build_link_entry(hlc, table, op, from_uuid, to_uuid))
    }

    /// Gives a freshly reordered list a new set of `sync_order` values and records each as an
    /// upsert. No-op when sync is off, so `position` stays the only ordering column until then.
    pub fn reorder(&self, conn: &Connection, table: &str, ordered_ids: &[i64]) -> Result<()> {
        if !is_sync_enabled(conn)? || ordered_ids.is_empty() {
            return Ok(());
        }
        let keys = generate_ordered_keys(ordered_ids.len())?;
        for (id, key) in ordered_ids.iter().zip(keys) {
            conn.execute(&format!("UPDATE {table} SET sync_order = ? WHERE id = ?"), params![key, id])?;
            let existing: Option<Option<String>> = conn
                .query_row(&format!("SELECT uuid FROM {table} WHERE id = ?"), [id], |r| r.get(0))
                .optional()?;
            let row_uuid = match existing.flatten() {
                Some(u) => u,
                None => ensure_uuid(conn, table, *id)?,
            };
            self.upsert(conn, table, &row_uuid, &[("sync_order".to_string(), Value::String(key))])?;
        }
        Ok(())
    }
}

/// Cuts the file back to `length_before` after a failed append.
fn undo_partial_append(path: &Path, length_before: u64) {
    let cut = std::fs::OpenOptions::new().write(true).open(path).and_then(|f| {
        if f.metadata()?.len() > length_before {
            f.set_len(length_before)?;
        }
        Ok(())
    });
    if let Err(err) = cut {
        eprintln!("[sync] could not cut a failed append from the oplog: {err}");
    }
}

/// True when the file is non-empty and its last byte is not a newline (a torn last line).
fn ends_with_partial_line(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let Ok(size) = file.metadata().map(|m| m.len()) else { return false };
    if size == 0 {
        return false;
    }
    let mut last = [0u8; 1];
    file.seek(SeekFrom::Start(size - 1))
        .and_then(|_| file.read_exact(&mut last))
        .map(|_| last[0] != b'\n')
        .unwrap_or(false)
}

impl SyncHook for SyncWriter {
    fn allocate_todo_id(&self, conn: &Connection) -> lizmeter_db::Result<Option<i64>> {
        if !is_sync_enabled(conn)? {
            return Ok(None);
        }
        Ok(Some(allocate_next_todo_id(conn)?))
    }

    fn record_upsert(&self, conn: &Connection, table: &str, row_uuid: &str, fields: &Fields) -> lizmeter_db::Result<()> {
        let owned: Vec<(String, Value)> = fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        Ok(self.upsert(conn, table, row_uuid, &owned)?)
    }

    fn record_delete(&self, conn: &Connection, table: &str, row_uuid: &str) -> lizmeter_db::Result<()> {
        Ok(self.delete(conn, table, row_uuid)?)
    }

    fn record_link(
        &self,
        conn: &Connection,
        table: &str,
        op: LinkOp,
        from_uuid: &str,
        to_uuid: &str,
    ) -> lizmeter_db::Result<()> {
        let kind = match op {
            LinkOp::Link => LinkKind::Link,
            LinkOp::Unlink => LinkKind::Unlink,
        };
        Ok(self.link(conn, table, kind, from_uuid, to_uuid)?)
    }

    fn record_reorder(&self, conn: &Connection, table: &str, ordered_ids: &[i64]) -> lizmeter_db::Result<()> {
        Ok(self.reorder(conn, table, ordered_ids)?)
    }

    fn flush_outbox(&self, conn: &Connection) {
        if is_sync_enabled(conn).unwrap_or(false) {
            SyncWriter::flush_outbox(self, conn);
        }
    }
}
