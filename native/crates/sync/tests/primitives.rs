//! Ports of the `hlc`, `lexorank`, `row-codec`, `hydration-guard`, `stray-files` and
//! `device-identity` suites under `electron/main/sync/__tests__/`.

mod common;

use lizmeter_db::Database;
use lizmeter_sync::device_identity::{
    advance_todo_id_watermark, allocate_next_todo_id, get_device_id, get_or_assign_device_number, register_device,
};
use lizmeter_sync::hlc::{compare_hlc, receive_at, tick_at, Hlc, MAX_CLOCK_DRIFT_MS};
use lizmeter_sync::hydration_guard::{check_read_length, read_file_guarded};
use lizmeter_sync::lexorank::{generate_ordered_keys, initial_key, key_between};
use lizmeter_sync::oplog::get_sync_devices_dir;
use lizmeter_sync::stray_files::scan_for_stray_files;
use lizmeter_sync::SyncError;
use std::cmp::Ordering;

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

fn h(p: i64, c: i64, d: i64) -> Hlc {
    Hlc { physical_ms: p, counter: c, device_number: d }
}

// --- hlc ---

#[test]
fn tick_advances_physical_ms_and_resets_the_counter() {
    let db = db();
    let a = tick_at(db.conn(), 0, 1000).unwrap();
    let b = tick_at(db.conn(), 0, 2000).unwrap();
    assert_eq!(a.physical_ms, 1000);
    assert_eq!(b.physical_ms, 2000);
    assert_eq!(b.counter, 0);
}

#[test]
fn tick_bumps_the_counter_inside_one_millisecond() {
    let db = db();
    let a = tick_at(db.conn(), 0, 5000).unwrap();
    let b = tick_at(db.conn(), 0, 5000).unwrap();
    assert_eq!((a.physical_ms, b.physical_ms), (5000, 5000));
    assert_eq!(b.counter, a.counter + 1);
}

#[test]
fn tick_never_regresses_when_the_wall_clock_runs_backward() {
    let db = db();
    let a = tick_at(db.conn(), 0, 9000).unwrap();
    let b = tick_at(db.conn(), 0, 1000).unwrap();
    assert_eq!(b.physical_ms, 9000);
    assert_eq!(b.counter, a.counter + 1);
}

#[test]
fn tick_persists_across_a_restart() {
    let db = db();
    tick_at(db.conn(), 0, 4000).unwrap();
    assert_eq!(tick_at(db.conn(), 0, 100).unwrap().physical_ms, 4000);
}

#[test]
fn compare_hlc_orders_physical_then_counter_then_device() {
    assert_eq!(compare_hlc(&h(1, 0, 0), &h(2, 0, 0)), Ordering::Less);
    assert_eq!(compare_hlc(&h(5, 1, 0), &h(5, 2, 0)), Ordering::Less);
    assert_eq!(compare_hlc(&h(5, 1, 1), &h(5, 1, 2)), Ordering::Less);
    assert_eq!(compare_hlc(&h(5, 1, 1), &h(5, 1, 1)), Ordering::Equal);
}

#[test]
fn receive_merges_a_remote_clock_ahead_of_the_local_one() {
    let db = db();
    tick_at(db.conn(), 0, 1000).unwrap();
    let r = receive_at(db.conn(), 0, h(5000, 3, 1), 1000).unwrap();
    assert!(!r.clamped);
    assert_eq!((r.hlc.physical_ms, r.hlc.counter), (5000, 4));
}

#[test]
fn receive_clamps_a_remote_clock_implausibly_far_ahead() {
    let db = db();
    let now = 1_000_000;
    let far = now + MAX_CLOCK_DRIFT_MS + 60_000;
    let r = receive_at(db.conn(), 0, h(far, 0, 1), now).unwrap();
    assert!(r.clamped);
    assert_eq!(r.hlc.physical_ms, now + MAX_CLOCK_DRIFT_MS);
    assert!(r.hlc.physical_ms < far);
}

#[test]
fn receive_does_not_clamp_inside_the_tolerance() {
    let db = db();
    let now = 1_000_000;
    let r = receive_at(db.conn(), 0, h(now + MAX_CLOCK_DRIFT_MS - 1000, 0, 1), now).unwrap();
    assert!(!r.clamped);
}

// --- lexorank ---

#[test]
fn key_between_returns_a_value_between_unbounded_ends() {
    let first = initial_key().unwrap();
    let before = key_between(None, Some(&first)).unwrap();
    let after = key_between(Some(&first), None).unwrap();
    assert!(before < first);
    assert!(first < after);
}

#[test]
fn key_between_rejects_a_lower_bound_that_does_not_sort_first() {
    assert!(key_between(Some("b"), Some("a")).is_err());
    assert!(key_between(Some("a"), Some("a")).is_err());
}

#[test]
fn key_between_never_exhausts_precision_across_300_inserts_at_one_spot() {
    let mut lo = "a".to_string();
    let hi = "b";
    for _ in 0..300 {
        let mid = key_between(Some(&lo), Some(hi)).unwrap();
        assert!(mid.as_str() > lo.as_str());
        assert!(mid.as_str() < hi);
        lo = mid;
    }
}

#[test]
fn key_between_keeps_200_sequential_appends_increasing() {
    let mut keys = vec![key_between(None, None).unwrap()];
    for _ in 0..200 {
        let next = key_between(keys.last().map(String::as_str), None).unwrap();
        keys.push(next);
    }
    assert!(keys.windows(2).all(|w| w[1] > w[0]));
}

#[test]
fn generate_ordered_keys_gives_n_distinct_increasing_keys() {
    let keys = generate_ordered_keys(50).unwrap();
    assert_eq!(keys.len(), 50);
    assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), 50);
    assert!(keys.windows(2).all(|w| w[1] > w[0]));
    assert!(generate_ordered_keys(0).unwrap().is_empty());
}

// --- hydration guard ---

#[test]
fn guarded_read_returns_the_full_bytes_of_a_hydrated_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("peer.oplog.jsonl");
    std::fs::write(&path, "the full file").unwrap();
    assert_eq!(read_file_guarded(&path).unwrap(), b"the full file");
}

#[test]
fn a_read_shorter_than_the_reported_size_is_not_fully_hydrated() {
    // The reported symptom: a 258 KB file that reads back as 24 KB behind a cloud placeholder.
    let path = std::path::Path::new("peer.oplog.jsonl");
    let err = check_read_length(path, 258_000, vec![0u8; 24_000]).unwrap_err();
    match err {
        SyncError::NotFullyHydrated { expected, actual, .. } => assert_eq!((expected, actual), (258_000, 24_000)),
        other => panic!("wrong error: {other:?}"),
    }
    assert!(check_read_length(path, 258_000, vec![0u8; 24_000]).unwrap_err().to_string().contains("not fully downloaded"));
}

#[test]
fn a_missing_file_is_an_io_error_not_a_hydration_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let err = read_file_guarded(&dir.path().join("does-not-exist.jsonl")).unwrap_err();
    assert!(matches!(err, SyncError::Io(_)));
}

// --- stray files ---

fn stray_notices(db: &Database) -> Vec<Option<String>> {
    let mut stmt = db.conn().prepare("SELECT detail FROM sync_notices WHERE kind = 'stray-file'").unwrap();
    stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
}

#[test]
fn a_conflicted_copy_rename_raises_a_stray_file_notice() {
    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("shared");
    let dir = get_sync_devices_dir(&shared);
    std::fs::create_dir_all(&dir).unwrap();
    let db = db();
    let stray = "11111111-1111-1111-1111-111111111111.oplog (Conflicted Copy 2026-08-28).jsonl";
    std::fs::write(dir.join(stray), "").unwrap();

    scan_for_stray_files(db.conn(), &shared).unwrap();

    assert_eq!(stray_notices(&db), vec![Some(stray.to_string())]);
}

#[test]
fn a_real_devices_own_files_never_raise_a_notice() {
    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("shared");
    let dir = get_sync_devices_dir(&shared);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("22222222-2222-2222-2222-222222222222.oplog.jsonl"), "").unwrap();
    std::fs::write(dir.join("22222222-2222-2222-2222-222222222222.snapshot.json"), "{}").unwrap();
    let db = db();

    scan_for_stray_files(db.conn(), &shared).unwrap();

    assert!(stray_notices(&db).is_empty());
}

#[test]
fn the_same_stray_name_is_reported_once_across_rescans() {
    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("shared");
    let dir = get_sync_devices_dir(&shared);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("definitely-not-a-uuid.oplog.jsonl"), "").unwrap();
    let db = db();

    scan_for_stray_files(db.conn(), &shared).unwrap();
    scan_for_stray_files(db.conn(), &shared).unwrap();

    assert_eq!(stray_notices(&db).len(), 1);
}

#[test]
fn a_missing_sync_folder_is_a_no_op() {
    let root = tempfile::tempdir().unwrap();
    let db = db();
    scan_for_stray_files(db.conn(), &root.path().join("nowhere")).unwrap();
    assert!(stray_notices(&db).is_empty());
}

// --- device identity ---

fn insert_todos(db: &Database, count: usize) {
    let state: i64 = db.conn().query_row("SELECT id FROM todo_states LIMIT 1", [], |r| r.get(0)).unwrap();
    for i in 0..count {
        db.conn()
            .execute(
                "INSERT INTO todos (title, state_id, created_at) VALUES (?, ?, ?)",
                rusqlite::params![format!("todo {i}"), state, lizmeter_db::util::now_iso()],
            )
            .unwrap();
    }
}

#[test]
fn device_id_is_minted_once_and_persisted_next_to_the_data_location_pointer() {
    let root = tempfile::tempdir().unwrap();
    let first = get_device_id(root.path()).unwrap();
    let second = get_device_id(root.path()).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.len(), 36);
    assert!(root.path().join("device-identity.json").exists());
}

#[test]
fn an_unreadable_identity_file_is_replaced_with_a_fresh_identity() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("device-identity.json"), "{ not json").unwrap();
    let id = get_device_id(root.path()).unwrap();
    assert_eq!(id.len(), 36);
    assert_eq!(get_device_id(root.path()).unwrap(), id);
}

#[test]
fn device_zero_goes_to_the_device_that_finds_a_virgin_shared_folder_regardless_of_local_data() {
    let root = tempfile::tempdir().unwrap();
    let db = db();
    insert_todos(&db, 1);
    assert_eq!(get_or_assign_device_number(db.conn(), Some(root.path())).unwrap(), 0);
}

#[test]
fn a_device_with_local_data_draws_a_random_number_once_a_peer_has_published() {
    // B-2: the old "local row count" heuristic would return 0 and collide with the peer in block 0.
    let root = tempfile::tempdir().unwrap();
    let db = db();
    insert_todos(&db, 5);
    let peers = get_sync_devices_dir(root.path());
    std::fs::create_dir_all(&peers).unwrap();
    std::fs::write(peers.join("11111111-1111-1111-1111-111111111111.oplog.jsonl"), "").unwrap();
    assert_ne!(get_or_assign_device_number(db.conn(), Some(root.path())).unwrap(), 0);
}

#[test]
fn omitting_the_data_dir_never_assumes_zero() {
    let db = db();
    assert!(get_or_assign_device_number(db.conn(), None).unwrap() > 0);
}

#[test]
fn the_device_number_is_stable_across_calls() {
    let root = tempfile::tempdir().unwrap();
    let db = db();
    let first = get_or_assign_device_number(db.conn(), Some(root.path())).unwrap();
    assert_eq!(get_or_assign_device_number(db.conn(), Some(root.path())).unwrap(), first);
}

#[test]
fn a_drawn_number_never_collides_with_a_registered_device() {
    let db = db();
    register_device(db.conn(), "peer-device", 123_456).unwrap();
    assert_ne!(get_or_assign_device_number(db.conn(), None).unwrap(), 123_456);
}

#[test]
fn allocation_continues_where_existing_ids_left_off() {
    let db = db();
    insert_todos(&db, 5);
    let max: i64 = db.conn().query_row("SELECT MAX(id) FROM todos", [], |r| r.get(0)).unwrap();
    assert_eq!(allocate_next_todo_id(db.conn()).unwrap(), max + 1);
}

#[test]
fn allocation_is_monotonic() {
    let db = db();
    let first = allocate_next_todo_id(db.conn()).unwrap();
    assert_eq!(allocate_next_todo_id(db.conn()).unwrap(), first + 1);
    assert_eq!(allocate_next_todo_id(db.conn()).unwrap(), first + 2);
}

#[test]
fn allocation_is_small_whatever_device_number_was_drawn() {
    let db = db();
    register_device(db.conn(), "some-other-device", 7).unwrap();
    db.conn().execute("INSERT INTO settings (key, value) VALUES ('sync.deviceNumber', '7')", []).unwrap();
    assert!(allocate_next_todo_id(db.conn()).unwrap() < 10_000);
}

#[test]
fn a_deleted_todos_number_is_not_reused() {
    let db = db();
    insert_todos(&db, 3);
    let first = allocate_next_todo_id(db.conn()).unwrap();
    db.conn().execute("DELETE FROM todos", []).unwrap();
    assert_eq!(allocate_next_todo_id(db.conn()).unwrap(), first + 1);
}

#[test]
fn the_watermark_moves_past_a_peers_highest_id_and_never_backwards() {
    let db = db();
    advance_todo_id_watermark(db.conn(), 73).unwrap();
    advance_todo_id_watermark(db.conn(), 5).unwrap();
    assert_eq!(allocate_next_todo_id(db.conn()).unwrap(), 74);
}

#[test]
fn a_meaningless_watermark_value_is_ignored() {
    let db = db();
    advance_todo_id_watermark(db.conn(), 0).unwrap();
    assert_eq!(allocate_next_todo_id(db.conn()).unwrap(), 1);
}

#[test]
fn peer_clock_values_at_the_integer_limits_never_overflow() {
    let db = db();
    tick_at(db.conn(), 0, 1000).unwrap();
    let r = receive_at(db.conn(), 0, h(i64::MAX, i64::MAX, 1), -5).unwrap();
    assert!(r.clamped);
    let again = receive_at(db.conn(), 0, h(i64::MIN, i64::MAX, 1), i64::MAX).unwrap();
    assert!(!again.clamped);
    let third = tick_at(db.conn(), 0, 0).unwrap();
    assert!(third.counter >= 0);
}
