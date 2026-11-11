//! The write path queues oplog lines in `sync_outbox` inside the row's own transaction and appends
//! them to the shared file only after the commit. Port of `sync-outbox.test.ts`: each test names the
//! failure it guards against.

mod common;

use common::{count, Device, Harness};
use lizmeter_core::{AssignTagInput, CreateTagInput, CreateTodoInput, ListTodosInput, SaveSessionInput, TimerType};
use lizmeter_db::set_sync_enabled;
use lizmeter_sync::migration::enable_sync_on_existing_machine;
use lizmeter_sync::notices::list_sync_notices;
use lizmeter_sync::SyncWriter;
use std::path::PathBuf;

fn tag(name: &str) -> CreateTagInput {
    CreateTagInput { name: name.into(), color: "#7aa2f7".into() }
}

fn todo(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

fn oplog_lines(h: &Harness, d: &Device) -> Vec<String> {
    match std::fs::read_to_string(h.oplog_path(d)) {
        Ok(text) => text.split('\n').filter(|l| !l.is_empty()).map(String::from).collect(),
        Err(_) => vec![],
    }
}

fn outbox_count(d: &Device) -> i64 {
    count(&d.db, "SELECT COUNT(*) FROM sync_outbox")
}

fn pending_notices(d: &Device) -> Vec<String> {
    list_sync_notices(d.db.conn(), false)
        .unwrap()
        .into_iter()
        .filter(|n| n.kind == "publish-pending")
        .map(|n| n.message)
        .collect()
}

/// A regular file where the shared `sync` folder belongs: every publish attempt fails until it is removed.
fn block_shared_folder(h: &Harness) -> PathBuf {
    let blocker = h.shared.join("sync");
    let _ = std::fs::remove_dir_all(&blocker);
    std::fs::write(&blocker, "not a folder").unwrap();
    blocker
}

fn unblock(blocker: PathBuf) {
    std::fs::remove_file(blocker).unwrap();
}

fn tag_names(d: &Device) -> Vec<String> {
    d.db.list_tags().unwrap().into_iter().map(|t| t.name).collect()
}

fn titles(d: &Device) -> Vec<String> {
    let mut t: Vec<String> =
        d.db.list_todos(&ListTodosInput::default()).unwrap().into_iter().map(|t| t.title).collect();
    t.sort();
    t
}

#[test]
fn a_failed_write_leaves_no_public_line() {
    let h = Harness::new();
    h.a.db
        .conn()
        .execute_batch(
            "CREATE TRIGGER fail_clock BEFORE INSERT ON sync_field_clocks BEGIN SELECT RAISE(ABORT, 'boom'); END",
        )
        .unwrap();

    let err = h.a.db.create_tag(&tag("ghost")).unwrap_err();

    assert!(err.to_string().contains("boom"));
    assert!(oplog_lines(&h, &h.a).is_empty());
    assert_eq!(outbox_count(&h.a), 0);
    assert!(tag_names(&h.a).is_empty());
}

#[test]
fn a_delete_is_published_even_when_the_folder_is_unreachable_at_the_time() {
    let h = Harness::new();
    h.a.db.create_tag(&tag("doomed")).unwrap();
    h.sync(&h.b);
    assert_eq!(tag_names(&h.b), vec!["doomed"]);

    let blocker = block_shared_folder(&h);
    let id = h.a.db.list_tags().unwrap()[0].id;
    h.a.db.delete_tag(id).unwrap();
    assert!(tag_names(&h.a).is_empty());

    unblock(blocker);
    h.a.db.flush_outbox();
    h.sync(&h.b);

    assert!(tag_names(&h.b).is_empty());
}

#[test]
fn an_unreachable_folder_keeps_the_edit_and_shows_a_notice() {
    let h = Harness::new();
    let blocker = block_shared_folder(&h);

    h.a.db.create_todo(&todo("first")).unwrap();
    h.a.db.create_todo(&todo("second")).unwrap();

    assert_eq!(titles(&h.a), vec!["first", "second"]);
    let waiting = outbox_count(&h.a);
    assert!(waiting >= 2);
    assert_eq!(pending_notices(&h.a), vec![format!("{waiting} changes waiting to publish")]);

    unblock(blocker);
    h.a.db.flush_outbox();

    assert_eq!(outbox_count(&h.a), 0);
    assert!(pending_notices(&h.a).is_empty());
    let lines = oplog_lines(&h, &h.a);
    assert_eq!(lines.len() as i64, waiting);
    let published: Vec<String> = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["fields"]["title"]["value"].as_str().map(String::from))
        .collect();
    assert_eq!(published, vec!["first", "second"]);

    h.sync(&h.b);
    assert_eq!(titles(&h.b), vec!["first", "second"]);
}

#[test]
fn a_dismissed_notice_stays_dismissed_while_the_folder_stays_unreachable() {
    let h = Harness::new();
    let _blocker = block_shared_folder(&h);
    h.a.db.create_tag(&tag("later")).unwrap();
    h.a.db.conn().execute("UPDATE sync_notices SET dismissed = 1 WHERE kind = 'publish-pending'", []).unwrap();

    h.a.db.create_tag(&tag("again")).unwrap();

    assert!(pending_notices(&h.a).is_empty());
    let message: String = common::query_one(
        &h.a.db,
        "SELECT message FROM sync_notices WHERE kind = 'publish-pending'",
    );
    assert_eq!(message, "2 changes waiting to publish");
}

#[test]
fn a_line_published_twice_is_applied_once() {
    let h = Harness::new();
    let session = h
        .a
        .db
        .save_session(&SaveSessionInput {
            title: "focus".into(),
            timer_type: TimerType::Work,
            planned_duration_seconds: 1500,
            actual_duration_seconds: 1500,
            issue_number: None,
            issue_title: None,
            issue_url: None,
            issue_provider: None,
            issue_id: None,
        })
        .unwrap();
    let t = h.a.db.create_tag(&tag("deep")).unwrap();
    h.a.db.assign_tag(&AssignTagInput { session_id: session.id.clone(), tag_id: t.id }).unwrap();
    let once = oplog_lines(&h, &h.a);
    assert!(!once.is_empty());

    // The crash: the lines are in the file, and the outbox still holds them.
    for line in &once {
        h.a.db
            .conn()
            .execute("INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)", rusqlite::params![line, "2026-01-01T00:00:00.000Z"])
            .unwrap();
    }
    h.a.db.flush_outbox();
    let mut twice = once.clone();
    twice.extend(once.clone());
    assert_eq!(oplog_lines(&h, &h.a), twice);

    h.sync(&h.b);
    h.sync(&h.b);
    assert_eq!(tag_names(&h.b), vec!["deep"]);
    assert_eq!(count(&h.b.db, "SELECT COUNT(*) FROM sync_applied_ops"), once.len() as i64);
}

fn seed_unsynced_device(h: &Harness) {
    set_sync_enabled(h.a.db.conn(), false).unwrap();
    h.a.db.create_todo(&todo("one")).unwrap();
    h.a.db.create_todo(&todo("two")).unwrap();
    h.a.db.create_tag(&tag("tag-one")).unwrap();
}

#[test]
fn enabling_sync_turns_the_flag_on_and_queues_every_row_in_one_transaction_or_does_neither() {
    let h = Harness::new();
    seed_unsynced_device(&h);
    let writer = SyncWriter::with_device_id(&h.shared, &h.a.device_id);
    h.a.db
        .conn()
        .execute_batch(
            "CREATE TRIGGER fail_late BEFORE INSERT ON sync_field_clocks \
             WHEN (SELECT COUNT(*) FROM sync_field_clocks) >= 4 BEGIN SELECT RAISE(ABORT, 'crash'); END",
        )
        .unwrap();

    let err = enable_sync_on_existing_machine(h.a.db.conn(), None, &h.shared, &writer).unwrap_err();

    assert!(err.to_string().contains("crash"));
    assert!(!lizmeter_db::is_sync_enabled(h.a.db.conn()).unwrap());
    assert!(oplog_lines(&h, &h.a).is_empty());
    assert_eq!(outbox_count(&h.a), 0);

    h.a.db.conn().execute_batch("DROP TRIGGER fail_late").unwrap();
    enable_sync_on_existing_machine(h.a.db.conn(), None, &h.shared, &writer).unwrap();
    h.sync(&h.b);
    assert_eq!(titles(&h.b), vec!["one", "two"]);
    assert_eq!(tag_names(&h.b), vec!["tag-one"]);
}

#[test]
fn enabling_sync_publishes_a_complete_outbox_at_the_next_flush_when_the_folder_was_unreachable() {
    let h = Harness::new();
    seed_unsynced_device(&h);
    let writer = SyncWriter::with_device_id(&h.shared, &h.a.device_id);
    let blocker = block_shared_folder(&h);
    enable_sync_on_existing_machine(h.a.db.conn(), None, &h.shared, &writer).unwrap();
    assert!(outbox_count(&h.a) > 0);

    unblock(blocker);
    h.a.db.flush_outbox();
    h.sync(&h.b);

    assert_eq!(titles(&h.b), vec!["one", "two"]);
}

#[test]
fn a_torn_last_line_is_healed_so_new_entries_stay_readable() {
    let h = Harness::new();
    let file = h.oplog_path(&h.a);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "{\"v\":1,\"op\":\"upsert\",\"torn").unwrap();

    h.a.db.create_tag(&tag("after-tear")).unwrap();

    let lines = oplog_lines(&h, &h.a);
    assert_eq!(lines[0], "{\"v\":1,\"op\":\"upsert\",\"torn");
    for line in &lines[1..] {
        serde_json::from_str::<serde_json::Value>(line).unwrap();
    }
    h.sync(&h.b);
    assert_eq!(tag_names(&h.b), vec!["after-tear"]);
}

#[test]
fn lines_wait_until_the_outermost_transaction_commits() {
    let h = Harness::new();
    h.a.db.conn().execute_batch("BEGIN").unwrap();
    h.a.db.create_tag(&tag("inner")).unwrap();
    assert!(oplog_lines(&h, &h.a).is_empty());
    assert!(outbox_count(&h.a) > 0);
    h.a.db.conn().execute_batch("COMMIT").unwrap();
    h.a.db.flush_outbox();

    assert!(!oplog_lines(&h, &h.a).is_empty());
    assert_eq!(outbox_count(&h.a), 0);
}

#[test]
fn a_rolled_back_outer_transaction_takes_the_queued_lines_with_it() {
    let h = Harness::new();
    h.a.db.conn().execute_batch("BEGIN").unwrap();
    h.a.db.create_tag(&tag("inner")).unwrap();
    h.a.db.conn().execute_batch("ROLLBACK").unwrap();
    h.a.db.flush_outbox();

    assert!(oplog_lines(&h, &h.a).is_empty());
    assert_eq!(outbox_count(&h.a), 0);
    assert!(tag_names(&h.a).is_empty());
}

#[test]
fn clearing_completed_todos_publishes_every_delete_only_with_the_committed_clear() {
    let h = Harness::new();
    let done = h.a.db.list_todo_states().unwrap().into_iter().find(|s| s.is_completed).unwrap().id;
    for name in ["a", "b"] {
        h.a.db.create_todo(&CreateTodoInput { title: name.into(), state_id: Some(done), ..Default::default() }).unwrap();
    }
    h.sync(&h.b);
    assert_eq!(titles(&h.b), vec!["a", "b"]);

    let blocker = block_shared_folder(&h);
    assert_eq!(h.a.db.clear_completed_todos().unwrap().count, 2);
    unblock(blocker);
    h.a.db.flush_outbox();
    h.sync(&h.b);

    assert!(titles(&h.b).is_empty());
}
