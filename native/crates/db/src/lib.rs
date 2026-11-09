//! SQLite layer: a port of `electron/main/database.ts`.
//!
//! The schema text and every idempotent migration run in the same order as the Electron build, so
//! the native app opens today's `lizmeter.db` unchanged (see `tests/schema_equality.rs`).

pub mod attachment_url;
pub mod data_location;
mod error;
mod music;
mod sessions;
mod settings;
mod sync_hook;
mod tags;
mod todo_attachments;
mod todo_meta;
mod todos;
pub mod util;

pub use error::{DbError, Result};
pub use music::{InternalTrackRecord, TrackUpsert};
pub use sync_hook::{
    attachment_row_key, ensure_uuid, is_sync_enabled, set_sync_enabled, Fields, LinkOp, NoSync, SyncHook,
    SYNC_ENABLED_KEY, SYNC_UUID_TABLES,
};
pub use todo_attachments::CreateTodoAttachmentInput;
pub use todos::ClearCompletedTodosResult;

use lizmeter_core::DEFAULT_TODO_COLOR;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// The exact `CREATE TABLE` / `CREATE INDEX` text from `database.ts`, kept verbatim: SQLite stores
/// the statement text in `sqlite_master`, so equality with Electron's dump needs identical bytes.
const SCHEMA_SQL: &str = include_str!("schema.sql");

/// One open LizMeter database. Mirrors the module-level `db` handle in `database.ts`.
pub struct Database {
    conn: Connection,
    sync: Box<dyn SyncHook>,
}

impl Database {
    /// `initDatabase(path)`. Pass `":memory:"` for an in-memory database.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_sync(path, Box::new(NoSync))
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::open(":memory:")
    }

    pub fn open_with_sync(path: impl AsRef<Path>, sync: Box<dyn SyncHook>) -> Result<Self> {
        let conn = Connection::open(path.as_ref())?;
        let db = Database { conn, sync };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> Result<()> {
        let conn = &self.conn;
        // Must be per-connection, before WAL.
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;

        conn.execute_batch(SCHEMA_SQL)?;

        let cols = column_names(conn, "sessions")?;
        if !cols.iter().any(|c| c == "issue_number") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN issue_number INTEGER")?;
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN issue_title TEXT")?;
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN issue_url TEXT")?;
        }
        if !cols.iter().any(|c| c == "issue_provider") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN issue_provider TEXT")?;
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN issue_id TEXT")?;
        }
        if !cols.iter().any(|c| c == "worklog_status") {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN worklog_status TEXT NOT NULL DEFAULT 'not_logged'")?;
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN worklog_id TEXT")?;
        }

        // Must run before seed/migrate: every synced table's `uuid` column has to exist before any
        // row (seeded, migrated or user-created) is written, or the row cannot converge in a merge.
        self.migrate_sync_columns()?;
        self.seed_todo_states()?;
        self.migrate_todos_to_states()?;
        Ok(())
    }

    /// The underlying connection, for the sync engine and tests.
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Replaces the sync hook (the sync engine installs its own once it is running).
    pub fn set_sync_hook(&mut self, sync: Box<dyn SyncHook>) {
        self.sync = sync;
    }

    pub(crate) fn sync(&self) -> &dyn SyncHook {
        self.sync.as_ref()
    }

    /// `closeDatabase()`.
    pub fn close(self) -> Result<()> {
        self.conn.close().map_err(|(_, e)| DbError::Sqlite(e))
    }

    /// Re-runs the todos-to-states migration (tests build a pre-states table first).
    pub fn migrate_todos_to_states_now(&self) -> Result<()> {
        self.migrate_todos_to_states()
    }

    /// Re-runs the sync-column migration (tests rebuild a pre-uuid shape first).
    pub fn migrate_sync_columns_now(&self) -> Result<()> {
        self.migrate_sync_columns()
    }

    fn migrate_sync_columns(&self) -> Result<()> {
        let conn = &self.conn;
        for table in SYNC_UUID_TABLES {
            if !column_names(conn, table)?.iter().any(|c| c == "uuid") {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN uuid TEXT"))?;
            }
            conn.execute_batch(&format!(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_uuid ON {table}(uuid) WHERE uuid IS NOT NULL"
            ))?;
        }

        for table in ["todo_states", "todo_projects"] {
            if !column_names(conn, table)?.iter().any(|c| c == "sync_order") {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN sync_order TEXT"))?;
            }
        }

        // The number the creating device originally issued for a todo. Immutable; existing rows
        // claim the number they already hold.
        if !column_names(conn, "todos")?.iter().any(|c| c == "claimed_id") {
            conn.execute_batch("ALTER TABLE todos ADD COLUMN claimed_id INTEGER")?;
            conn.execute_batch("UPDATE todos SET claimed_id = id WHERE claimed_id IS NULL")?;
        }
        Ok(())
    }

    /// Seeds the default states into an empty table, then makes sure the table is usable.
    /// Seeding only-when-empty matters: doing it on every boot would resurrect deleted states.
    fn seed_todo_states(&self) -> Result<()> {
        let conn = &self.conn;
        let count: i64 = conn.query_row("SELECT COUNT(*) AS count FROM todo_states", [], |r| r.get(0))?;
        if count == 0 {
            let created_at = util::now_iso();
            let tx = conn.unchecked_transaction()?;
            {
                let mut insert = tx.prepare(
                    "INSERT INTO todo_states (label, color, position, is_completed, is_default, created_at, uuid) VALUES (?, ?, ?, ?, ?, ?, ?)",
                )?;
                for (index, (label, color, completed, default)) in SEED_TODO_STATES.iter().enumerate() {
                    insert.execute(rusqlite::params![
                        label,
                        color,
                        index as i64,
                        i64::from(*completed),
                        i64::from(*default),
                        created_at,
                        util::new_uuid(),
                    ])?;
                }
            }
            tx.commit()?;
        }
        self.repair_todo_state_flags()
    }

    /// Guarantees exactly one completed and exactly one default state, so a hand-edited or
    /// interrupted database can still boot.
    fn repair_todo_state_flags(&self) -> Result<()> {
        let conn = &self.conn;
        let mut stmt = conn.prepare("SELECT id, is_completed, is_default FROM todo_states ORDER BY position ASC")?;
        let states: Vec<(i64, i64, i64)> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        if states.is_empty() {
            return Ok(());
        }

        let tx = conn.unchecked_transaction()?;
        let completed: Vec<_> = states.iter().filter(|s| s.1 == 1).collect();
        if completed.is_empty() {
            tx.execute("UPDATE todo_states SET is_completed = 1 WHERE id = ?", [states[states.len() - 1].0])?;
        } else if completed.len() > 1 {
            tx.execute("UPDATE todo_states SET is_completed = 0 WHERE id != ?", [completed[0].0])?;
        }

        let defaults: Vec<_> = states.iter().filter(|s| s.2 == 1).collect();
        if defaults.is_empty() {
            tx.execute("UPDATE todo_states SET is_default = 1 WHERE id = ?", [states[0].0])?;
        } else if defaults.len() > 1 {
            tx.execute("UPDATE todo_states SET is_default = 0 WHERE id != ?", [defaults[0].0])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Brings an older todos table up to date: adds every column the current schema declares,
    /// moves each row onto a state, then removes the old `done` column.
    fn migrate_todos_to_states(&self) -> Result<()> {
        let conn = &self.conn;
        let columns = column_names(conn, "todos")?;
        let has = |name: &str| columns.iter().any(|c| c == name);

        if !has("state_id") {
            conn.execute_batch("ALTER TABLE todos ADD COLUMN state_id INTEGER REFERENCES todo_states(id)")?;
        }
        if !has("project_id") {
            conn.execute_batch(
                "ALTER TABLE todos ADD COLUMN project_id INTEGER REFERENCES todo_projects(id) ON DELETE SET NULL",
            )?;
        }
        if !has("milestone") {
            conn.execute_batch("ALTER TABLE todos ADD COLUMN milestone TEXT")?;
        }
        if !has("priority") {
            conn.execute_batch("ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")?;
        }
        if !has("start_date") {
            conn.execute_batch("ALTER TABLE todos ADD COLUMN start_date TEXT")?;
        }
        if !has("due_date") {
            conn.execute_batch("ALTER TABLE todos ADD COLUMN due_date TEXT")?;
        }
        if !has("parent_id") {
            conn.execute_batch(
                "ALTER TABLE todos ADD COLUMN parent_id INTEGER REFERENCES todos(id) ON DELETE SET NULL",
            )?;
        }

        // Safe now that every column above exists, on both a fresh and an upgraded database.
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_todos_state_id ON todos(state_id)")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id)")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date)")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id)")?;

        self.migrate_project_text_to_rows(&columns)?;

        let completed_id = self.completed_state_id()?;
        let default_id = self.default_state_id()?;

        if has("done") {
            conn.execute("UPDATE todos SET state_id = ? WHERE state_id IS NULL AND done = 1", [completed_id])?;
            conn.execute("UPDATE todos SET state_id = ? WHERE state_id IS NULL AND done = 0", [default_id])?;
        }

        // Any row still without a state lands on the default.
        conn.execute("UPDATE todos SET state_id = ? WHERE state_id IS NULL", [default_id])?;

        // SQLite refuses DROP COLUMN on an indexed column, so the index goes first.
        if has("done") {
            conn.execute_batch("DROP INDEX IF EXISTS idx_todos_done")?;
            conn.execute_batch("ALTER TABLE todos DROP COLUMN done")?;
        }
        Ok(())
    }

    /// Promotes the old free-text `todos.project` column to rows in `todo_projects`, matched
    /// case-insensitively, then drops the column. `columns` is the pre-migration column list.
    fn migrate_project_text_to_rows(&self, columns: &[String]) -> Result<()> {
        if !columns.iter().any(|c| c == "project") {
            return Ok(());
        }
        let conn = &self.conn;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT TRIM(project) AS name FROM todos WHERE project IS NOT NULL AND TRIM(project) != ''",
        )?;
        let names: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        drop(stmt);

        let tx = conn.unchecked_transaction()?;
        let next: i64 =
            tx.query_row("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects", [], |r| r.get(0))?;
        let mut position = next;

        for name in names {
            let mut id: Option<i64> = tx
                .query_row("SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE", [&name], |r| r.get(0))
                .optional()?;
            if id.is_none() {
                tx.execute(
                    "INSERT INTO todo_projects (name, color, position, created_at, uuid) VALUES (?, ?, ?, ?, ?)",
                    rusqlite::params![name, DEFAULT_TODO_COLOR, position, util::now_iso(), util::new_uuid()],
                )?;
                position += 1;
                id = Some(tx.query_row(
                    "SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE",
                    [&name],
                    |r| r.get(0),
                )?);
            }
            tx.execute(
                "UPDATE todos SET project_id = ? WHERE project_id IS NULL AND project = ? COLLATE NOCASE",
                rusqlite::params![id, name],
            )?;
        }

        // SQLite refuses DROP COLUMN while an index still names the column, so the index goes first.
        tx.execute_batch("DROP INDEX IF EXISTS idx_todos_project")?;
        tx.execute_batch("ALTER TABLE todos DROP COLUMN project")?;
        tx.commit()?;
        Ok(())
    }

    /// The state new todos land in. Stable across label renames.
    pub(crate) fn default_state_id(&self) -> Result<i64> {
        let row: Option<i64> = self
            .conn
            .query_row("SELECT id FROM todo_states WHERE is_default = 1 ORDER BY position ASC LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(id) = row {
            return Ok(id);
        }
        // Fall back to the first state so a hand-edited database cannot wedge the app.
        let first: Option<i64> = self
            .conn
            .query_row("SELECT id FROM todo_states ORDER BY position ASC LIMIT 1", [], |r| r.get(0))
            .optional()?;
        first.ok_or_else(|| DbError::Message("No todo states exist".into()))
    }

    /// The state that means "finished". Completion always resolves through this, never a label.
    pub(crate) fn completed_state_id(&self) -> Result<i64> {
        let row: Option<i64> = self
            .conn
            .query_row("SELECT id FROM todo_states WHERE is_completed = 1 ORDER BY position ASC LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;
        row.ok_or_else(|| DbError::Message("No state is marked as completed".into()))
    }
}

/// The states a fresh install starts with: label, colour, is_completed, is_default.
const SEED_TODO_STATES: [(&str, &str, bool, bool); 6] = [
    ("Backlog", "#565f89", false, false),
    ("Todo", "#7aa2f7", false, true),
    ("Processing", "#e0af68", false, false),
    ("Testing", "#bb9af7", false, false),
    ("Done", "#9ece6a", true, false),
    ("Deprecated", "#f7768e", false, false),
];

pub(crate) fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// Placeholders for an `IN (...)` list: `?, ?, ?`.
pub(crate) fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

pub(crate) fn optional_row<T>(r: rusqlite::Result<T>) -> Result<Option<T>> {
    Ok(r.optional()?)
}
