//! Reads every peer's oplog file from the shared folder and applies new entries to the local
//! database (`merge-pass.ts`). Called by the watcher on every filesystem event and periodic re-scan.

use crate::merge_engine::{apply_oplog_entries, ApplyResult};
use crate::notices::add_sync_notice;
use crate::oplog::{get_sync_devices_dir, read_oplog_entries, OplogEntry, OPLOG_SUFFIX};
use crate::Result;
use lizmeter_core::SyncNoticeKind;
use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

struct SkippedOplogFile {
    name: String,
    count: usize,
}

/// Persists one notice for each distinct observed set of unreadable peer entries. The same
/// append-only oplog is scanned every 30 seconds, so the lookup includes dismissed notices: an
/// unchanged peer file never creates an endless stream of duplicates.
fn report_skipped_entries(conn: &Connection, mut files: Vec<SkippedOplogFile>) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let total: usize = files.iter().map(|f| f.count).sum();
    let detail = files.iter().map(|f| format!("{}: {} skipped", f.name, f.count)).collect::<Vec<_>>().join("; ");
    let already: Option<i64> = conn
        .query_row("SELECT 1 FROM sync_notices WHERE kind = 'oplog-entry-skipped' AND detail = ?", [&detail], |r| {
            r.get(0)
        })
        .optional()?;
    if already.is_some() {
        return Ok(());
    }

    let entry_noun = if total == 1 { "entry" } else { "entries" };
    let log_noun =
        if files.len() == 1 { "a peer sync log".to_string() } else { format!("{} peer sync logs", files.len()) };
    let verb = if total == 1 { "was" } else { "were" };
    add_sync_notice(
        conn,
        SyncNoticeKind::OplogEntrySkipped,
        &format!("{total} {entry_noun} in {log_noun} {verb} skipped because this version of LizMeter could not read them."),
        Some(&detail),
    )
}

/// Reads every `*.oplog.jsonl` in the shared folder except this device's own (a device never reads
/// its own file back) and applies whatever is new. Idempotent by `opId`.
pub fn run_merge_pass(conn: &Connection, data_dir: &Path, own_device_id: &str) -> Result<ApplyResult> {
    let dir = get_sync_devices_dir(data_dir);
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Ok(ApplyResult::default());
    };
    let mut names: Vec<String> = read_dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();

    let mut entries: Vec<OplogEntry> = Vec::new();
    let mut skipped_files: Vec<SkippedOplogFile> = Vec::new();
    for name in names {
        let Some(device_id) = name.strip_suffix(OPLOG_SUFFIX) else {
            continue;
        };
        if device_id == own_device_id {
            continue;
        }
        let read = read_oplog_entries(&dir.join(&name))?;
        entries.extend(read.entries);
        if read.skipped > 0 {
            skipped_files.push(SkippedOplogFile { name, count: read.skipped });
        }
    }

    report_skipped_entries(conn, skipped_files)?;
    apply_oplog_entries(conn, &entries)
}
