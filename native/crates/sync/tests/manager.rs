//! Ports of `sync-manager`, `merge-failed-notice`, `adopt-real-db` and `sync-rollback`.

mod common;

use lizmeter_core::{CreateTodoInput, ListTodosInput, UpdateTodoInput};
use lizmeter_db::data_location::{DataLocation, DB_FILE_NAME};
use lizmeter_db::{is_sync_enabled, set_sync_enabled, Database, DbError};
use lizmeter_sync::merge_engine::ApplyResult;
use lizmeter_sync::oplog::{get_oplog_file_path, get_sync_devices_dir, read_oplog_entries, OplogEntry, OPLOG_SUFFIX};
use lizmeter_sync::pending_action::{
    clear_pending_sync_action, consume_pending_sync_action, write_pending_sync_action, PendingSyncAction,
};
use lizmeter_sync::snapshot::{write_snapshot_if_due, RETENTION_DAYS};
use lizmeter_sync::sync_manager::{
    requires_adopt_confirmation, requires_unsynced_db_confirmation, Notifier, SyncManager,
};
use lizmeter_sync::{SyncError, SyncWriter};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Sink(Mutex<Vec<(String, String)>>);

impl Notifier for Sink {
    fn notify(&self, title: &str, body: &str) {
        self.0.lock().unwrap().push((title.into(), body.into()));
    }
}

fn new(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

struct Rig {
    _root: tempfile::TempDir,
    root_path: PathBuf,
    user_data: PathBuf,
    shared: PathBuf,
    db: Arc<Mutex<Database>>,
    writer: SyncWriter,
    sink: Arc<Sink>,
    manager: Arc<SyncManager>,
}

fn rig_with_db_path(db_path: Option<PathBuf>) -> Rig {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().to_path_buf();
    let user_data = root_path.join("userData-a");
    let shared = root_path.join("shared");
    std::fs::create_dir_all(&user_data).unwrap();
    std::fs::create_dir_all(&shared).unwrap();
    let writer = SyncWriter::new(&shared, &user_data).unwrap();
    let db = Arc::new(Mutex::new(Database::open_with_sync(":memory:", Box::new(writer.clone())).unwrap()));
    let sink = Arc::new(Sink::default());
    set_sync_enabled(db.lock().unwrap().conn(), true).unwrap();
    let manager = SyncManager::new(db.clone(), writer.clone(), user_data.clone(), db_path, sink.clone());
    Rig { _root: root, root_path, user_data, shared, db, writer, sink, manager }
}

fn rig() -> Rig {
    rig_with_db_path(None)
}

/// A device that has real data but never turned sync on.
fn rig_sync_off() -> Rig {
    let r = rig();
    set_sync_enabled(r.db.lock().unwrap().conn(), false).unwrap();
    r
}

fn peer_oplog(dir: &Path, uuid_digit: char) {
    let peers = get_sync_devices_dir(dir);
    std::fs::create_dir_all(&peers).unwrap();
    let name = format!("{}{OPLOG_SUFFIX}", uuid_digit.to_string().repeat(8) + "-1111-1111-1111-111111111111");
    std::fs::write(peers.join(name), "").unwrap();
}

// --- decide_pending_sync_action ---

#[test]
fn an_ordinary_relocate_has_no_pending_action() {
    let r = rig();
    assert_eq!(r.manager.decide_pending_sync_action(&r.shared).unwrap(), None);
}

#[test]
fn real_data_without_sync_decides_enable() {
    let r = rig_sync_off();
    r.db.lock().unwrap().create_todo(&new("existing work")).unwrap();
    assert_eq!(r.manager.decide_pending_sync_action(&r.shared).unwrap(), Some(PendingSyncAction::Enable));
}

#[test]
fn a_target_with_a_peers_oplog_decides_adopt_even_when_local_data_exists() {
    // FR-017: adoption always wins.
    let r = rig();
    r.db.lock().unwrap().create_todo(&new("local work that will be archived, not merged")).unwrap();
    peer_oplog(&r.shared, '2');
    assert_eq!(
        r.manager.decide_pending_sync_action(&r.shared).unwrap(),
        Some(PendingSyncAction::Adopt { target_dir: r.shared.clone() })
    );
}

#[test]
fn adopt_requires_confirmation_until_confirmed() {
    let adopt = PendingSyncAction::Adopt { target_dir: PathBuf::from("x") };
    assert!(requires_adopt_confirmation(Some(&adopt), false));
    assert!(!requires_adopt_confirmation(Some(&adopt), true));
    assert!(!requires_adopt_confirmation(Some(&PendingSyncAction::Enable), false));
    assert!(!requires_adopt_confirmation(None, false));
}

#[test]
fn enabling_into_a_folder_with_a_real_db_requires_confirmation() {
    let r = rig_sync_off();
    r.db.lock().unwrap().create_todo(&new("local work")).unwrap();
    std::fs::write(r.shared.join(DB_FILE_NAME), "not a real sqlite file, just needs to exist").unwrap();

    let pending = r.manager.decide_pending_sync_action(&r.shared).unwrap();
    assert_eq!(pending, Some(PendingSyncAction::Enable));
    assert!(requires_unsynced_db_confirmation(pending.as_ref(), &r.shared, false));
    assert!(!requires_unsynced_db_confirmation(pending.as_ref(), &r.shared, true));
}

#[test]
fn enabling_into_an_empty_folder_needs_no_confirmation() {
    let r = rig_sync_off();
    r.db.lock().unwrap().create_todo(&new("local work")).unwrap();
    let pending = r.manager.decide_pending_sync_action(&r.shared).unwrap();
    assert!(!requires_unsynced_db_confirmation(pending.as_ref(), &r.shared, false));
}

#[test]
fn an_adopt_never_asks_the_unsynced_db_question_and_a_plain_relocate_never_does() {
    let r = rig();
    peer_oplog(&r.shared, '3');
    std::fs::write(r.shared.join(DB_FILE_NAME), "x").unwrap();
    let pending = r.manager.decide_pending_sync_action(&r.shared).unwrap();
    assert!(matches!(pending, Some(PendingSyncAction::Adopt { .. })));
    assert!(!requires_unsynced_db_confirmation(pending.as_ref(), &r.shared, false));
    assert!(!requires_unsynced_db_confirmation(None, &r.shared, false));
}

#[test]
fn the_pending_action_marker_is_consumed_once() {
    let dir = tempfile::tempdir().unwrap();
    write_pending_sync_action(dir.path(), &PendingSyncAction::Adopt { target_dir: PathBuf::from("/shared") }).unwrap();
    assert_eq!(
        consume_pending_sync_action(dir.path()),
        Some(PendingSyncAction::Adopt { target_dir: PathBuf::from("/shared") })
    );
    assert_eq!(consume_pending_sync_action(dir.path()), None);

    write_pending_sync_action(dir.path(), &PendingSyncAction::Enable).unwrap();
    clear_pending_sync_action(dir.path());
    assert_eq!(consume_pending_sync_action(dir.path()), None);

    std::fs::write(dir.path().join("pending-sync-action.json"), "{ broken").unwrap();
    assert_eq!(consume_pending_sync_action(dir.path()), None);
    assert!(!dir.path().join("pending-sync-action.json").exists(), "an unreadable marker is still deleted");
}

// --- apply_pending_sync_action_after_init ---

#[test]
fn enable_migrates_identity_turns_sync_on_and_publishes_existing_rows() {
    let r = rig();
    set_sync_enabled(r.db.lock().unwrap().conn(), false).unwrap();
    r.db.lock().unwrap().create_todo(&new("publish me")).unwrap();

    r.manager.apply_pending_sync_action_after_init(Some(&PendingSyncAction::Enable)).unwrap();

    assert!(is_sync_enabled(r.db.lock().unwrap().conn()).unwrap());
    let entries = read_oplog_entries(&get_oplog_file_path(&r.shared, r.writer.device_id())).unwrap().entries;
    assert!(entries.iter().any(|e| matches!(e, OplogEntry::Upsert(u) if u.table == "todos")));
}

#[test]
fn adopt_registers_a_device_rebuilds_from_the_shared_oplog_and_turns_sync_on() {
    let a = rig();
    set_sync_enabled(a.db.lock().unwrap().conn(), false).unwrap();
    a.db.lock().unwrap().create_todo(&new("from device A")).unwrap();
    a.manager.apply_pending_sync_action_after_init(Some(&PendingSyncAction::Enable)).unwrap();

    let b_target = a.root_path.join("shared-target");
    let src = get_sync_devices_dir(&a.shared);
    let dst = get_sync_devices_dir(&b_target);
    std::fs::create_dir_all(&dst).unwrap();
    for e in std::fs::read_dir(&src).unwrap().flatten() {
        std::fs::copy(e.path(), dst.join(e.file_name())).unwrap();
    }

    let user_data_b = a.root_path.join("userData-b");
    std::fs::create_dir_all(&user_data_b).unwrap();
    let writer_b = SyncWriter::new(&b_target, &user_data_b).unwrap();
    let db_b = Arc::new(Mutex::new(Database::open_in_memory().unwrap()));
    let manager_b = SyncManager::new(db_b.clone(), writer_b, user_data_b, None, Arc::new(Sink::default()));

    manager_b
        .apply_pending_sync_action_after_init(Some(&PendingSyncAction::Adopt { target_dir: b_target.clone() }))
        .unwrap();

    let db_b = db_b.lock().unwrap();
    assert!(is_sync_enabled(db_b.conn()).unwrap());
    assert!(db_b.list_todos(&ListTodosInput::default()).unwrap().iter().any(|t| t.title == "from device A"));
    let status_devices: i64 = db_b.conn().query_row("SELECT COUNT(*) FROM sync_devices", [], |r| r.get(0)).unwrap();
    assert_eq!(status_devices, 1);
}

#[test]
fn adopting_on_a_device_that_used_lizmeter_standalone_backs_up_its_own_database_first() {
    // B-2: the device's own real database must never be silently opened and wiped.
    let root = tempfile::tempdir().unwrap();
    let user_data_b = root.path().join("userData-b");
    let shared = root.path().join("shared");
    std::fs::create_dir_all(&user_data_b).unwrap();
    std::fs::create_dir_all(&shared).unwrap();

    let loc = DataLocation::new(&user_data_b);
    let db_path = loc.get_db_path();
    {
        let db = Database::open(&db_path).unwrap();
        db.create_todo(&new("device B's own pre-existing standalone todo")).unwrap();
        db.close().unwrap();
    }
    let original = std::fs::read(&db_path).unwrap();

    peer_oplog(&shared, 'a');
    std::fs::write(user_data_b.join("data-location.json"), format!("{}\n", serde_json::json!({ "dataDir": shared }))).unwrap();
    loc.invalidate_data_dir_cache();

    loc.mark_device_as_adopted().unwrap();
    let backup = loc.backup_existing_private_db_before_adopt().unwrap().unwrap();
    assert!(backup.to_string_lossy().contains(".pre-adopt-") && backup.to_string_lossy().ends_with(".bak"));
    assert!(!db_path.exists());
    assert_eq!(std::fs::read(&backup).unwrap(), original);

    assert_eq!(loc.get_db_dir(), user_data_b);
    let db = Database::open(loc.get_db_path()).unwrap();
    assert!(!db
        .list_todos(&ListTodosInput::default())
        .unwrap()
        .iter()
        .any(|t| t.title == "device B's own pre-existing standalone todo"));

    let writer = SyncWriter::new(loc.get_data_dir(), &user_data_b).unwrap();
    let db = Arc::new(Mutex::new(db));
    let manager = SyncManager::new(db.clone(), writer, user_data_b.clone(), Some(loc.get_db_path()), Arc::new(Sink::default()));
    manager.apply_pending_sync_action_after_init(Some(&PendingSyncAction::Adopt { target_dir: shared })).unwrap();

    let db = db.lock().unwrap();
    assert!(is_sync_enabled(db.conn()).unwrap());
    assert_eq!(std::fs::read(&backup).unwrap(), original);
    let number: String =
        db.conn().query_row("SELECT value FROM settings WHERE key = 'sync.deviceNumber'", [], |r| r.get(0)).unwrap();
    assert_ne!(number.parse::<i64>().unwrap(), 0);
}

// --- run_merge_pass_safely ---

#[test]
fn a_failed_pre_rebuild_backup_halts_with_its_own_notice_instead_of_a_silent_warning() {
    // M-006. A directory standing where the database file should be makes the backup copy fail.
    let broken_db_path = tempfile::tempdir().unwrap();
    let r = rig_with_db_path(Some(broken_db_path.path().to_path_buf()));
    {
        let db = r.db.lock().unwrap();
        write_snapshot_if_due(db.conn(), &r.shared, r.writer.device_id(), lizmeter_sync::hlc::now_ms()).unwrap();
        let day = 24 * 60 * 60 * 1000;
        let stale = lizmeter_sync_iso(lizmeter_sync::hlc::now_ms() - RETENTION_DAYS * day - day);
        db.conn().execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync.lastSyncedAt', ?)", [stale]).unwrap();
    }

    r.manager.run_merge_pass_safely();

    let status = r.manager.get_sync_status().unwrap();
    assert!(status.halted.unwrap().reason.contains("could not write the pre-rebuild backup"));
    let notices = r.manager.list_notices(false).unwrap();
    assert!(notices
        .iter()
        .any(|n| n.kind == "stale-machine-rebuild" && n.message.contains("safety backup could not be written")));
}

fn lizmeter_sync_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[test]
fn a_generic_merge_failure_halts_once_dedupes_repeats_and_recovers_on_success() {
    let r = rig();
    let failure = "SQLite3 can only bind numbers, strings, bigints, buffers, and null";
    r.manager.set_merge_pass_for_testing(Some(Box::new(move |_| Err(SyncError::Message(failure.to_string())))));

    r.manager.run_merge_pass_safely();

    assert_eq!(r.manager.get_sync_status().unwrap().halted.unwrap().reason, failure);
    let failed = |m: &SyncManager| -> Vec<_> {
        m.list_notices(false).unwrap().into_iter().filter(|n| n.kind == "merge-failed").collect()
    };
    let notices = failed(&r.manager);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].detail.as_deref(), Some(failure));
    let sent = r.sink.0.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, failure);

    r.manager.run_merge_pass_safely();
    r.manager.run_merge_pass_safely();
    assert_eq!(failed(&r.manager).len(), 1);
    assert_eq!(r.sink.0.lock().unwrap().len(), 1);

    r.manager.set_merge_pass_for_testing(Some(Box::new(|_| Ok(ApplyResult::default()))));
    r.manager.run_merge_pass_safely();
    assert!(r.manager.get_sync_status().unwrap().halted.is_none());
}

#[test]
fn a_pass_with_discarded_edits_sends_one_notification_and_reports_todos_changed() {
    let r = rig();
    r.manager.set_merge_pass_for_testing(Some(Box::new(|_| {
        Ok(ApplyResult { applied: 3, skipped_already_applied: 0, notices: 2 })
    })));
    let changed = Arc::new(Mutex::new(0));
    let c = changed.clone();
    r.manager.set_todos_changed_callback(Arc::new(move || *c.lock().unwrap() += 1));

    r.manager.run_merge_pass_safely();

    assert_eq!(*changed.lock().unwrap(), 1);
    let sent = r.sink.0.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, "2 edits were discarded during sync. Check Settings for details.");
    assert!(r.manager.get_sync_status().unwrap().last_synced_at.is_some());
}

#[test]
fn a_pass_does_nothing_while_sync_is_off() {
    let r = rig();
    set_sync_enabled(r.db.lock().unwrap().conn(), false).unwrap();
    r.manager.set_merge_pass_for_testing(Some(Box::new(|_| panic!("must not run"))));
    r.manager.run_merge_pass_safely();
    assert!(!r.manager.get_sync_status().unwrap().enabled);
}

#[test]
fn a_running_manager_merges_a_peers_write_without_a_manual_pass() {
    // The watcher: an event in the shared folder triggers a pass, the periodic timer covers a missed event.
    let a = rig();
    let user_data_b = a.root_path.join("userData-b");
    std::fs::create_dir_all(&user_data_b).unwrap();
    let writer_b = SyncWriter::new(&a.shared, &user_data_b).unwrap();
    let db_b = Database::open_with_sync(":memory:", Box::new(writer_b)).unwrap();
    set_sync_enabled(db_b.conn(), true).unwrap();

    a.manager.start_with_interval(std::time::Duration::from_millis(300)).unwrap();
    db_b.create_tag(&lizmeter_core::CreateTagInput { name: "from-b".into(), color: "#7aa2f7".into() }).unwrap();

    let mut seen = false;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        let n: i64 = a.db.lock().unwrap().conn().query_row("SELECT COUNT(*) FROM tags WHERE name = 'from-b'", [], |r| r.get(0)).unwrap();
        if n == 1 {
            seen = true;
            break;
        }
    }
    a.manager.stop();
    assert!(seen, "the manager never merged the peer's tag");
}

#[test]
fn disabling_sync_stops_the_watcher_and_clears_the_flag() {
    let a = rig();
    a.manager.start_with_interval(std::time::Duration::from_millis(200)).unwrap();
    a.manager.disable_sync().unwrap();
    assert!(!is_sync_enabled(a.db.lock().unwrap().conn()).unwrap());
    let _ = &a.user_data;
}

// --- B-4: a rolled-back local write never publishes ---

fn own_todo_upserts(r: &Rig) -> usize {
    read_oplog_entries(&get_oplog_file_path(&r.shared, r.writer.device_id()))
        .unwrap()
        .entries
        .iter()
        .filter(|e| matches!(e, OplogEntry::Upsert(u) if u.table == "todos"))
        .count()
}

#[test]
fn a_create_with_an_unknown_label_fails_and_leaves_no_oplog_entry() {
    let r = rig();
    let err = r.db.lock().unwrap().create_todo(&CreateTodoInput { label_ids: Some(vec![999_999]), ..new("Doomed create") });
    assert!(matches!(err, Err(DbError::Message(_)) | Err(DbError::Sqlite(_))));
    assert_eq!(own_todo_upserts(&r), 0);
}

#[test]
fn a_later_create_is_unaffected_by_a_failed_one() {
    let r = rig();
    let db = r.db.lock().unwrap();
    assert!(db.create_todo(&CreateTodoInput { label_ids: Some(vec![999_999]), ..new("Doomed create") }).is_err());
    let ok = db.create_todo(&new("Real todo")).unwrap();
    drop(db);
    assert!(ok.id > 0);
    assert_eq!(own_todo_upserts(&r), 1);
}

#[test]
fn an_update_with_an_unknown_label_publishes_nothing_new() {
    let r = rig();
    let db = r.db.lock().unwrap();
    let created = db.create_todo(&new("Existing todo")).unwrap();
    drop(db);
    let before = own_todo_upserts(&r);
    let db = r.db.lock().unwrap();
    assert!(db
        .update_todo(&UpdateTodoInput {
            id: created.id,
            title: Some("Changed".into()),
            label_ids: Some(vec![999_999]),
            ..Default::default()
        })
        .is_err());
    drop(db);
    assert_eq!(own_todo_upserts(&r), before);
}

#[test]
fn a_device_with_sync_off_publishes_nothing_at_quit() {
    let r = rig();
    let blocker = r.shared.join("sync");
    let _ = std::fs::remove_dir_all(&blocker);
    std::fs::write(&blocker, "not a folder").unwrap();
    r.db.lock().unwrap().create_todo(&new("queued")).unwrap();
    let queued: i64 = r.db.lock().unwrap().conn().query_row("SELECT COUNT(*) FROM sync_outbox", [], |x| x.get(0)).unwrap();
    assert!(queued > 0);

    set_sync_enabled(r.db.lock().unwrap().conn(), false).unwrap();
    std::fs::remove_file(&blocker).unwrap();
    r.manager.flush_outbox();

    let left: i64 = r.db.lock().unwrap().conn().query_row("SELECT COUNT(*) FROM sync_outbox", [], |x| x.get(0)).unwrap();
    assert_eq!(left, queued);
    assert!(!get_sync_devices_dir(&r.shared).exists());
}

#[test]
fn a_device_with_sync_on_publishes_queued_lines_at_quit() {
    let r = rig();
    let blocker = r.shared.join("sync");
    let _ = std::fs::remove_dir_all(&blocker);
    std::fs::write(&blocker, "not a folder").unwrap();
    r.db.lock().unwrap().create_todo(&new("queued")).unwrap();
    std::fs::remove_file(&blocker).unwrap();

    r.manager.flush_outbox();

    let left: i64 = r.db.lock().unwrap().conn().query_row("SELECT COUNT(*) FROM sync_outbox", [], |x| x.get(0)).unwrap();
    assert_eq!(left, 0);
}
