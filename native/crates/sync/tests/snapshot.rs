//! Port of `snapshot.test.ts`.

mod common;

use common::*;
use lizmeter_core::{
    ClaudeCodeIdlePeriod, ClaudeCodeSessionData, CreateTodoInput, CreateTodoProjectInput, ListTodosInput,
    SaveSessionWithTrackingInput, TimerType, UpdateTodoInput,
};
use lizmeter_db::{CreateTodoAttachmentInput, Database};
use lizmeter_sync::oplog::read_oplog_entries;
use lizmeter_sync::snapshot::{
    backup_before_rebuild, is_stale, mark_synced_now, rebuild_from_snapshot, write_snapshot_if_due, RETENTION_DAYS,
};
use std::fs;

const ONE_DAY_MS: i64 = 24 * 60 * 60 * 1000;
const RETENTION_MS: i64 = RETENTION_DAYS * ONE_DAY_MS;
const T0: i64 = 1_000_000_000_000;

fn new(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

fn now() -> i64 {
    lizmeter_sync::hlc::now_ms()
}

fn snapshot_files(h: &Harness) -> Vec<std::path::PathBuf> {
    fs::read_dir(h.devices_dir())
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(".snapshot.json"))
        .collect()
}

fn write_snapshot(h: &Harness, d: &Device, at: i64) -> bool {
    write_snapshot_if_due(d.db.conn(), &h.shared, &d.device_id, at).unwrap()
}

fn rebuild(h: &Harness, d: &Device, at: i64) -> bool {
    rebuild_from_snapshot(d.db.conn(), &h.shared, &d.device_id, None, at).unwrap()
}

#[test]
fn a_snapshot_holds_every_row_and_is_not_rewritten_the_same_day() {
    let h = Harness::new();
    h.a.db.create_todo(&new("keep me")).unwrap();
    h.a.db.create_todo_project(&CreateTodoProjectInput { name: "Alpha".into(), color: None }).unwrap();

    let t = now();
    assert!(write_snapshot(&h, &h.a, t));
    let files = snapshot_files(&h);
    assert_eq!(files.len(), 1);
    let snap: serde_json::Value = serde_json::from_str(&fs::read_to_string(&files[0]).unwrap()).unwrap();
    assert!(!snap["entries"].as_array().unwrap().is_empty());

    assert!(!write_snapshot(&h, &h.a, t + 60_000));
    assert!(write_snapshot(&h, &h.a, t + ONE_DAY_MS + 1));
}

#[test]
fn the_snapshot_trims_this_devices_own_oplog_to_the_retention_window() {
    let h = Harness::new();
    h.a.db.create_todo(&new("old entry")).unwrap();
    let path = h.oplog_path(&h.a);
    let entries = read_oplog_entries(&path).unwrap().entries;
    assert!(!entries.is_empty());

    let aged: Vec<String> = entries
        .into_iter()
        .map(|e| {
            let mut v = e.to_value();
            v["hlc"]["physicalMs"] = serde_json::json!(T0 - RETENTION_MS - ONE_DAY_MS);
            v.to_string()
        })
        .collect();
    fs::write(&path, aged.join("\n") + "\n").unwrap();

    write_snapshot(&h, &h.a, T0);

    assert_eq!(read_oplog_entries(&path).unwrap().entries.len(), 0);
}

fn age_tombstones(d: &Device) {
    d.db.conn()
        .execute("UPDATE sync_tombstones SET hlc_physical_ms = ?", [T0 - RETENTION_MS - ONE_DAY_MS])
        .unwrap();
}

#[test]
fn an_aged_tombstone_is_pruned_when_a_snapshot_is_written() {
    let h = Harness::new();
    let created = h.a.db.create_todo(&new("will be deleted")).unwrap();
    h.a.db.delete_todo(created.id).unwrap();
    age_tombstones(&h.a);
    assert!(count(&h.a.db, "SELECT COUNT(*) FROM sync_tombstones") > 0);

    write_snapshot(&h, &h.a, T0);

    assert_eq!(count(&h.a.db, "SELECT COUNT(*) FROM sync_tombstones"), 0);
}

#[test]
fn an_aged_tombstone_is_left_out_of_the_snapshots_own_entries() {
    let h = Harness::new();
    let created = h.a.db.create_todo(&new("will be deleted")).unwrap();
    h.a.db.delete_todo(created.id).unwrap();
    age_tombstones(&h.a);

    write_snapshot(&h, &h.a, T0);

    let snap: serde_json::Value = serde_json::from_str(&fs::read_to_string(&snapshot_files(&h)[0]).unwrap()).unwrap();
    assert!(!snap["entries"].as_array().unwrap().iter().any(|e| e["op"] == "delete"));
}

#[test]
fn staleness_starts_after_the_retention_window() {
    let h = Harness::new();
    mark_synced_now(h.a.db.conn(), T0).unwrap();
    assert!(!is_stale(h.a.db.conn(), T0 + ONE_DAY_MS).unwrap());
    assert!(is_stale(h.a.db.conn(), T0 + RETENTION_MS + ONE_DAY_MS).unwrap());
}

#[test]
fn a_machine_that_never_synced_is_not_stale() {
    let h = Harness::new();
    assert!(!is_stale(h.b.db.conn(), now()).unwrap());
}

fn todo_titles(db: &Database) -> Vec<String> {
    db.list_todos(&ListTodosInput::default()).unwrap().into_iter().map(|t| t.title).collect()
}

#[test]
fn a_stale_machine_rebuilds_from_the_latest_snapshot_and_writes_a_notice() {
    let h = Harness::new();
    h.a.db.create_todo(&new("from the snapshot")).unwrap();
    let t = now();
    write_snapshot(&h, &h.a, t);

    assert!(rebuild(&h, &h.b, t + 1000));

    assert!(todo_titles(&h.b.db).contains(&"from the snapshot".to_string()));
    assert_eq!(count(&h.b.db, "SELECT COUNT(*) FROM sync_notices WHERE kind = 'stale-machine-rebuild'"), 1);
}

fn set_parent(db: &Database, id: i64, parent: i64) {
    db.update_todo(&UpdateTodoInput { id, parent_id: Some(Some(parent)), ..Default::default() }).unwrap();
}

fn parent_of(db: &Database, title: &str) -> Option<i64> {
    db.list_todos(&ListTodosInput::default()).unwrap().into_iter().find(|t| t.title == title).unwrap().parent_id
}

fn id_of(db: &Database, title: &str) -> i64 {
    db.list_todos(&ListTodosInput::default()).unwrap().into_iter().find(|t| t.title == title).unwrap().id
}

#[test]
fn a_subtask_keeps_its_parent_link_when_the_parent_todo_has_a_higher_number() {
    // Snapshot entries share one HLC, so they apply in table row order: a child numbered below its
    // parent used to be applied before its parent existed, and nothing re-read the snapshot.
    let h = Harness::new();
    let grandchild = h.a.db.create_todo(&new("grandchild")).unwrap();
    let child = h.a.db.create_todo(&new("child")).unwrap();
    let parent = h.a.db.create_todo(&new("parent")).unwrap();
    set_parent(&h.a.db, grandchild.id, child.id);
    set_parent(&h.a.db, child.id, parent.id);
    assert!(parent.id > child.id);
    let t = now();
    write_snapshot(&h, &h.a, t);

    assert!(rebuild(&h, &h.b, t + 1000));

    assert_eq!(parent_of(&h.b.db, "child"), Some(id_of(&h.b.db, "parent")));
    assert_eq!(parent_of(&h.b.db, "grandchild"), Some(id_of(&h.b.db, "child")));
    assert_eq!(parent_of(&h.b.db, "parent"), None);
}

#[test]
fn a_fresh_machine_adopting_a_snapshot_keeps_a_subtask_parent_link() {
    let h = Harness::new();
    let child = h.a.db.create_todo(&new("adopt child")).unwrap();
    let parent = h.a.db.create_todo(&new("adopt parent")).unwrap();
    set_parent(&h.a.db, child.id, parent.id);
    let t = now();
    write_snapshot(&h, &h.a, t);

    rebuild(&h, &h.b, t + 1000);

    let adopted = parent_of(&h.b.db, "adopt child");
    assert_eq!(adopted, Some(id_of(&h.b.db, "adopt parent")));
    assert!(adopted.is_some());
}

#[test]
fn a_rebuild_with_no_snapshot_anywhere_changes_nothing() {
    let h = Harness::new();
    h.b.db.create_todo(&new("mine")).unwrap();
    assert!(!rebuild(&h, &h.b, now()));
    assert_eq!(todo_titles(&h.b.db), vec!["mine"]);
}

#[test]
fn project_names_and_ordering_survive_a_rebuild() {
    let h = Harness::new();
    h.a.db.create_todo_project(&CreateTodoProjectInput { name: "Alpha".into(), color: None }).unwrap();
    h.a.db.create_todo_project(&CreateTodoProjectInput { name: "Beta".into(), color: None }).unwrap();
    let t = now();
    write_snapshot(&h, &h.a, t);

    rebuild(&h, &h.b, t + 1000);

    let mut names: Vec<String> = h.b.db.list_todo_projects().unwrap().into_iter().map(|p| p.name).collect();
    names.sort();
    assert_eq!(names, vec!["Alpha", "Beta"]);
}

#[test]
fn a_machine_with_its_own_todos_rebuilds_without_violating_the_state_foreign_key() {
    // R2-B3: a bare DELETE FROM todo_states fails on any machine with todos.
    let h = Harness::new();
    h.b.db.create_todo(&new("device B's own pre-rebuild todo")).unwrap();
    let created = h.a.db.create_todo(&new("from the snapshot")).unwrap();
    let t = now();
    write_snapshot(&h, &h.a, t);

    assert!(rebuild(&h, &h.b, t + 1000));

    let on_b = h.b.db.list_todos(&ListTodosInput::default()).unwrap();
    assert!(!on_b.iter().any(|x| x.title == "device B's own pre-rebuild todo"));
    assert_eq!(on_b.iter().find(|x| x.id == created.id).unwrap().title, "from the snapshot");
}

#[test]
fn claude_code_activity_is_relinked_to_a_session_that_survives_the_rebuild() {
    // H3-B1: DELETE FROM sessions cascades into the machine-local activity tables.
    let h = Harness::new();
    let session = h
        .b
        .db
        .save_session_with_tracking(&SaveSessionWithTrackingInput {
            title: "session with claude code activity".into(),
            timer_type: TimerType::Work,
            planned_duration_seconds: 1500,
            actual_duration_seconds: 1500,
            issue_number: None,
            issue_title: None,
            issue_url: None,
            issue_provider: None,
            issue_id: None,
            claude_code_sessions: Some(vec![ClaudeCodeSessionData {
                cc_session_uuid: "cc-uuid-1".into(),
                file_edit_count: 3,
                total_idle_seconds: 60,
                idle_period_count: 1,
                first_activity_at: Some("2026-01-01T00:00:00.000Z".into()),
                last_activity_at: Some("2026-01-01T00:10:00.000Z".into()),
                files_edited: vec!["a.ts".into()],
                idle_periods: vec![ClaudeCodeIdlePeriod {
                    start_at: "2026-01-01T00:05:00.000Z".into(),
                    end_at: "2026-01-01T00:06:00.000Z".into(),
                    duration_seconds: 60,
                }],
            }]),
        })
        .unwrap();

    h.sync(&h.a);
    let t = now();
    write_snapshot(&h, &h.a, t);

    assert!(rebuild(&h, &h.b, t + 1000));

    let sessions: i64 = h
        .b
        .db
        .conn()
        .query_row("SELECT COUNT(*) FROM claude_code_sessions WHERE session_id = ?", [&session.id], |r| r.get(0))
        .unwrap();
    assert_eq!(sessions, 1);
    let (uuid, edits): (String, i64) = h
        .b
        .db
        .conn()
        .query_row(
            "SELECT cc_session_uuid, file_edit_count FROM claude_code_sessions WHERE session_id = ?",
            [&session.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((uuid.as_str(), edits), ("cc-uuid-1", 3));
    let idle: i64 = query_one(&h.b.db, "SELECT duration_seconds FROM claude_code_idle_periods");
    assert_eq!(idle, 60);
}

#[test]
fn attachments_are_rebuilt_from_the_snapshot_instead_of_lost_to_the_cascade() {
    let h = Harness::new();
    let created = h.a.db.create_todo(&new("has an attachment")).unwrap();
    h.a.db
        .create_todo_attachment(&CreateTodoAttachmentInput {
            todo_id: created.id,
            sha256: "a".repeat(64),
            file_name: "screenshot.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 1234,
            kind: None,
        })
        .unwrap();
    let t = now();
    write_snapshot(&h, &h.a, t);

    assert!(rebuild(&h, &h.b, t + 1000));

    let on_b = h.b.db.list_todos(&ListTodosInput::default()).unwrap().into_iter().find(|x| x.id == created.id).unwrap();
    let attachments = h.b.db.list_todo_attachments(on_b.id).unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].file_name, "screenshot.png");
    assert_eq!(attachments[0].sha256, "a".repeat(64));
}

#[test]
fn the_pre_rebuild_backup_carries_the_wal_so_uncheckpointed_rows_survive() {
    // The -wal sibling must travel with the db file or a WAL-mode backup loses recent writes.
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("lizmeter.db");
    let live = rusqlite::Connection::open(&db_path).unwrap();
    let _mode: String = live.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).unwrap();
    live.execute_batch("PRAGMA wal_autocheckpoint = 0; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('recent', 'only in the wal')").unwrap();
    assert!(dir.path().join("lizmeter.db-wal").metadata().unwrap().len() > 0);

    let backup = backup_before_rebuild(Some(&db_path)).unwrap().unwrap();

    let name = backup.to_string_lossy().into_owned();
    assert!(name.contains(".pre-rebuild-") && name.ends_with(".bak"), "{name}");
    let restored = rusqlite::Connection::open(&backup).unwrap();
    let recent: String = restored.query_row("SELECT value FROM settings WHERE key = 'recent'", [], |r| r.get(0)).unwrap();
    assert_eq!(recent, "only in the wal");
    drop(live);
}

#[test]
fn a_backup_of_nothing_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    assert!(backup_before_rebuild(Some(std::path::Path::new(":memory:"))).unwrap().is_none());
    assert!(backup_before_rebuild(None).unwrap().is_none());
    assert!(backup_before_rebuild(Some(&dir.path().join("does-not-exist.db"))).unwrap().is_none());
}

#[test]
fn the_backup_is_marked_freshly_synced_so_restoring_it_does_not_re_trigger_the_rebuild() {
    // H3-B1: without this, a restored backup carries the stale lastSyncedAt and loops.
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("lizmeter.db");
    let stale = chrono::DateTime::from_timestamp_millis(now() - RETENTION_MS - ONE_DAY_MS)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        conn.execute("INSERT INTO settings (key, value) VALUES ('sync.lastSyncedAt', ?)", [&stale]).unwrap();
    }

    let backup = backup_before_rebuild(Some(&db_path)).unwrap().unwrap();

    let restored = rusqlite::Connection::open(&backup).unwrap();
    let value: String =
        restored.query_row("SELECT value FROM settings WHERE key = 'sync.lastSyncedAt'", [], |r| r.get(0)).unwrap();
    assert_ne!(value, stale);
    let age = now() - chrono::DateTime::parse_from_rfc3339(&value).unwrap().timestamp_millis();
    assert!(age < ONE_DAY_MS);
}

#[test]
fn the_trim_keeps_every_line_it_cannot_judge_byte_for_byte() {
    let h = Harness::new();
    h.a.db.create_todo(&new("good")).unwrap();
    let path = h.oplog_path(&h.a);
    let good = read_oplog_entries(&path).unwrap().entries[0].clone();
    let at = |ms: i64| {
        let mut v = good.to_value();
        v["hlc"]["physicalMs"] = serde_json::json!(ms);
        v
    };
    let old = at(T0 - RETENTION_MS - ONE_DAY_MS).to_string();
    // A Node-written lone surrogate escape serde_json alone refuses, recent.
    let surrogate = at(T0).to_string().replacen("good", r"a\ud83d", 1);
    assert!(surrogate.contains(r"\ud83d"));
    // A newer schema version and a torn line, both recent or unparsable, with CRLF and spacing kept.
    let future = at(T0).to_string().replacen("\"v\":1", "\"v\":2", 1);
    let torn = r#"{"v":1,"opId":"x","hlc":{"physicalMs":"#;
    let recent = format!("  {}\r", at(T0));
    let body = [old.as_str(), surrogate.as_str(), future.as_str(), recent.as_str(), torn].join("\n") + "\n";
    fs::write(&path, &body).unwrap();

    write_snapshot(&h, &h.a, T0);

    let after = fs::read_to_string(&path).unwrap();
    let want = [surrogate.as_str(), future.as_str(), recent.as_str(), torn].join("\n") + "\n";
    assert_eq!(after, want, "only the aged line is gone; nothing else is re-serialized");
}
