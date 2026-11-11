//! The seam between database writes and the multi-writer sync engine.
//!
//! `database.ts` calls `recordUpsert` / `recordDelete` / `recordLink` / `recordReorder` and
//! `allocateTodoIdIfSyncEnabled` from `sync-writer.ts` after each synced write. The engine lives in
//! `lizmeter-sync` (`SyncWriter` implements [`SyncHook`]); this crate owns only the trait. [`NoSync`] is
//! the behaviour of a device that never turned sync on: every call is a no-op and AUTOINCREMENT assigns ids.

use crate::error::{DbError, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

pub const SYNC_ENABLED_KEY: &str = "sync.enabled";

/// Tables whose rows carry a `uuid` column for sync.
pub const SYNC_UUID_TABLES: [&str; 5] = ["todos", "tags", "todo_labels", "todo_states", "todo_projects"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkOp {
    Link,
    Unlink,
}

impl LinkOp {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkOp::Link => "link",
            LinkOp::Unlink => "unlink",
        }
    }
}

/// Changed fields and their new values. Order is preserved.
pub type Fields = Vec<(&'static str, Value)>;

pub trait SyncHook: Send {
    /// True for [`NoSync`]: a hook that publishes nothing. `Database` refuses to pair it with a
    /// database whose `sync.enabled` setting is `true`.
    fn is_noop(&self) -> bool {
        false
    }
    /// The explicit numeric id a synced `todos` insert must use, or `None` for AUTOINCREMENT.
    fn allocate_todo_id(&self, conn: &Connection) -> Result<Option<i64>>;
    fn record_upsert(&self, conn: &Connection, table: &str, row_uuid: &str, fields: &Fields) -> Result<()>;
    fn record_delete(&self, conn: &Connection, table: &str, row_uuid: &str) -> Result<()>;
    fn record_link(&self, conn: &Connection, table: &str, op: LinkOp, from_uuid: &str, to_uuid: &str) -> Result<()>;
    fn record_reorder(&self, conn: &Connection, table: &str, ordered_ids: &[i64]) -> Result<()>;
    /// Publishes the lines queued in `sync_outbox`. Called after an outermost commit; never fails the caller.
    fn flush_outbox(&self, _conn: &Connection) {}
}

/// Sync never turned on: nothing is published and ids come from AUTOINCREMENT.
pub struct NoSync;

impl SyncHook for NoSync {
    fn is_noop(&self) -> bool {
        true
    }
    fn allocate_todo_id(&self, _: &Connection) -> Result<Option<i64>> {
        Ok(None)
    }
    fn record_upsert(&self, _: &Connection, _: &str, _: &str, _: &Fields) -> Result<()> {
        Ok(())
    }
    fn record_delete(&self, _: &Connection, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    fn record_link(&self, _: &Connection, _: &str, _: LinkOp, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    fn record_reorder(&self, _: &Connection, _: &str, _: &[i64]) -> Result<()> {
        Ok(())
    }
}

/// `settings['sync.enabled'] === "true"`.
pub fn is_sync_enabled(conn: &Connection) -> Result<bool> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?", [SYNC_ENABLED_KEY], |r| r.get(0))
        .optional()?;
    Ok(value.as_deref() == Some("true"))
}

pub fn set_sync_enabled(conn: &Connection, enabled: bool) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        rusqlite::params![SYNC_ENABLED_KEY, if enabled { "true" } else { "false" }],
    )?;
    Ok(())
}

/// Tables `ensure_uuid` may touch. Interpolated into SQL, so it is an allowlist.
fn uuid_table(table: &str) -> Result<&'static str> {
    SYNC_UUID_TABLES
        .iter()
        .copied()
        .find(|t| *t == table)
        .ok_or_else(|| DbError::Message(format!("Table {table} has no uuid column")))
}

/// Backfills a uuid for a row that predates the column, e.g. a row from an upgraded database.
pub fn ensure_uuid(conn: &Connection, table: &str, id: i64) -> Result<String> {
    let table = uuid_table(table)?;
    let existing: Option<Option<String>> = conn
        .query_row(&format!("SELECT uuid FROM {table} WHERE id = ?"), [id], |r| r.get(0))
        .optional()?;
    if let Some(Some(uuid)) = existing {
        if !uuid.is_empty() {
            return Ok(uuid);
        }
    }
    let uuid = crate::util::new_uuid();
    conn.execute(&format!("UPDATE {table} SET uuid = ? WHERE id = ?"), rusqlite::params![uuid, id])?;
    Ok(uuid)
}

/// Joins an attachment's composite merge key into the string `row_uuid` upsert/delete entries carry.
pub fn attachment_row_key(todo_uuid: &str, sha256: &str) -> String {
    format!("{todo_uuid}:{sha256}")
}
