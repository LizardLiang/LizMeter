//! lizmeter-sync: the multi-writer sync engine, a port of `electron/main/sync/`.
//!
//! File names, the oplog entry format and retention match the TypeScript engine, so a Rust device
//! and an Electron device can share one sync folder during the switch-over. The TS engine and this
//! one are held row-equal by `native/tools/sync-equivalence/`.

pub mod device_identity;
mod error;
pub mod hlc;
pub mod hydration_guard;
pub mod lexorank;
pub mod merge_engine;
pub mod merge_pass;
pub mod migration;
pub mod notices;
pub mod oplog;
pub mod pending_action;
pub mod row_codec;
pub mod snapshot;
pub mod stray_files;
pub mod sync_manager;
pub mod sync_writer;
pub mod watcher;

pub use error::{Result, SyncError};
pub use sync_writer::SyncWriter;

/// `Number.parseInt(s, 10)` followed by `Number.isInteger`: the leading integer, or `None` for NaN.
pub(crate) fn js_parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

pub(crate) fn read_setting(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional()?)
}

pub(crate) fn write_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", rusqlite::params![key, value])?;
    Ok(())
}

/// better-sqlite3's `db.transaction(fn)`: `BEGIN` when no transaction is open, a savepoint when one
/// is. Rolls back when `f` fails, so a failed merge leaves the database untouched.
pub(crate) fn in_transaction<T>(conn: &rusqlite::Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let nested = !conn.is_autocommit();
    let savepoint = "lizmeter_sync_sp";
    conn.execute_batch(if nested { "SAVEPOINT lizmeter_sync_sp" } else { "BEGIN" })?;
    match f() {
        Ok(value) => {
            let end = if nested { format!("RELEASE {savepoint}") } else { "COMMIT".to_string() };
            if let Err(e) = conn.execute_batch(&end) {
                // A deferred foreign key violation fails COMMIT and leaves the transaction open.
                let undo = if nested { format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}") } else { "ROLLBACK".to_string() };
                let _ = conn.execute_batch(&undo);
                return Err(e.into());
            }
            Ok(value)
        }
        Err(e) => {
            let undo = if nested { format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}") } else { "ROLLBACK".to_string() };
            let _ = conn.execute_batch(&undo);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{in_transaction, js_parse_int};
    use crate::SyncError;

    fn conn() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE t (n INTEGER)").unwrap();
        c
    }

    fn rows(c: &rusqlite::Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_failed_transaction_leaves_nothing_behind() {
        let c = conn();
        let r: crate::Result<()> = in_transaction(&c, || {
            c.execute("INSERT INTO t VALUES (1)", [])?;
            Err(SyncError::Message("boom".into()))
        });
        assert!(r.is_err());
        assert_eq!(rows(&c), 0);
        assert!(c.is_autocommit());
    }

    #[test]
    fn inside_an_open_transaction_it_becomes_a_savepoint_that_rolls_back_alone() {
        let c = conn();
        c.execute_batch("BEGIN").unwrap();
        c.execute("INSERT INTO t VALUES (1)", []).unwrap();
        let inner: crate::Result<()> = in_transaction(&c, || {
            c.execute("INSERT INTO t VALUES (2)", [])?;
            Err(SyncError::Message("inner fails".into()))
        });
        assert!(inner.is_err());
        in_transaction(&c, || Ok(c.execute("INSERT INTO t VALUES (3)", [])?)).unwrap();
        assert!(!c.is_autocommit(), "the caller's transaction stays open");
        c.execute_batch("COMMIT").unwrap();
        assert_eq!(rows(&c), 2, "row 1 and row 3 survive, row 2 was rolled back");
    }

    #[test]
    fn parse_int_matches_js() {
        assert_eq!(js_parse_int("12abc"), Some(12));
        assert_eq!(js_parse_int(" -7"), Some(-7));
        assert_eq!(js_parse_int(""), None);
        assert_eq!(js_parse_int("abc"), None);
    }
}
