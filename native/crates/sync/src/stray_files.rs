//! FR-032: reports any file in the shared sync folder that this app did not write, most notably a
//! cloud-drive "conflicted copy" (`stray-files.ts`). Reported, never deleted or touched.

use crate::notices::add_sync_notice;
use crate::oplog::{get_sync_devices_dir, OPLOG_SUFFIX, SNAPSHOT_SUFFIX};
use crate::Result;
use lizmeter_core::SyncNoticeKind;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

fn is_expected_name(name: &str) -> bool {
    if let Some(stem) = name.strip_suffix(OPLOG_SUFFIX) {
        return is_uuid(stem);
    }
    if let Some(stem) = name.strip_suffix(SNAPSHOT_SUFFIX) {
        return is_uuid(stem);
    }
    false
}

/// True once a stray-file notice already exists for this filename, dismissed or not. The scan runs
/// on every merge pass, so without this one conflicted-copy file would raise a notice every time.
fn already_noticed(conn: &Connection, name: &str) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row("SELECT 1 FROM sync_notices WHERE kind = 'stray-file' AND detail = ?", [name], |r| r.get(0))
        .optional()?;
    Ok(found.is_some())
}

/// Raises one `stray-file` notice per unrecognised name in `<data_dir>/sync/devices/`, the first
/// time it is seen.
pub fn scan_for_stray_files(conn: &Connection, data_dir: &Path) -> Result<()> {
    let dir = get_sync_devices_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for name in names {
        if is_expected_name(&name) || already_noticed(conn, &name)? {
            continue;
        }
        add_sync_notice(
            conn,
            SyncNoticeKind::StrayFile,
            "An unexpected file was found in the sync folder. It was left in place -- check whether your cloud drive created a conflicted copy.",
            Some(&name),
        )?;
    }
    Ok(())
}
