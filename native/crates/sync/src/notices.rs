//! The user-visible automatic-resolution log (`notices.ts`).

use crate::Result;
use lizmeter_core::{SyncNotice, SyncNoticeKind};
use rusqlite::{params, Connection, OptionalExtension};

pub fn add_sync_notice(conn: &Connection, kind: SyncNoticeKind, message: &str, detail: Option<&str>) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_notices (kind, message, detail, created_at) VALUES (?, ?, ?, ?)",
        params![kind.as_str(), message, detail, lizmeter_db::util::now_iso()],
    )?;
    Ok(())
}

/// Raises, or refreshes in place, the single "changes waiting to publish" notice. A dismissed
/// notice stays dismissed.
pub fn set_publish_pending_notice(conn: &Connection, count: usize, detail: Option<&str>) -> Result<()> {
    let message = format!("{count} change{} waiting to publish", if count == 1 { "" } else { "s" });
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM sync_notices WHERE kind = 'publish-pending' LIMIT 1", [], |r| r.get(0))
        .optional()?;
    match existing {
        Some(id) => {
            conn.execute("UPDATE sync_notices SET message = ?, detail = ? WHERE id = ?", params![message, detail, id])?;
            Ok(())
        }
        None => add_sync_notice(conn, SyncNoticeKind::PublishPending, &message, detail),
    }
}

pub fn clear_publish_pending_notice(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM sync_notices WHERE kind = 'publish-pending'", [])?;
    Ok(())
}

pub fn list_sync_notices(conn: &Connection, include_dismissed: bool) -> Result<Vec<SyncNotice>> {
    let sql = if include_dismissed {
        "SELECT id, kind, message, detail, created_at, dismissed FROM sync_notices ORDER BY created_at DESC"
    } else {
        "SELECT id, kind, message, detail, created_at, dismissed FROM sync_notices WHERE dismissed = 0 ORDER BY created_at DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SyncNotice {
                id: r.get(0)?,
                kind: r.get(1)?,
                message: r.get(2)?,
                detail: r.get(3)?,
                created_at: r.get(4)?,
                dismissed: r.get::<_, i64>(5)? == 1,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn dismiss_sync_notice(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("UPDATE sync_notices SET dismissed = 1 WHERE id = ?", [id])?;
    Ok(())
}
