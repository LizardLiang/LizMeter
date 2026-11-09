//! Ports of `migration-fixture` and `renumber-migration`.

mod common;

use common::*;
use lizmeter_core::{
    CreateTagInput, CreateTodoInput, CreateTodoLabelInput, CreateTodoProjectInput, CreateTodoStateInput,
    ListTodosInput, SaveSessionInput, TimerType,
};
use lizmeter_db::{is_sync_enabled, Database};
use lizmeter_sync::device_identity::LEGACY_TODO_ID_BLOCK_STRIDE;
use lizmeter_sync::migration::{
    backup_before_sync_migration, count_block_allocated_todos, enable_sync_on_existing_machine,
    renumber_block_allocated_todo_ids,
};
use lizmeter_sync::oplog::{get_sync_devices_dir, read_oplog_entries, OplogEntry};
use lizmeter_sync::SyncWriter;
use std::fs;
use std::path::Path;

fn new(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

/// Rebuilds the pre-sync shape: no `uuid` column (and no unique index on it) anywhere.
fn make_legacy_pre_sync_schema(db: &Database) {
    for table in ["todos", "tags", "todo_labels", "todo_states", "todo_projects"] {
        db.conn().execute_batch(&format!("DROP INDEX IF EXISTS idx_{table}_uuid")).unwrap();
        db.conn().execute_batch(&format!("ALTER TABLE {table} DROP COLUMN uuid")).unwrap();
    }
}

fn writer(shared: &Path) -> SyncWriter {
    SyncWriter::with_device_id(shared, "99999999-9999-9999-9999-999999999999")
}

#[test]
fn the_pre_sync_backup_copies_the_db_and_its_wal_sibling() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("lizmeter.db");
    fs::write(&db_path, "pretend sqlite bytes").unwrap();
    fs::write(dir.path().join("lizmeter.db-wal"), "pretend wal bytes").unwrap();

    let backup = backup_before_sync_migration(Some(&db_path)).unwrap().unwrap();

    let name = backup.to_string_lossy().into_owned();
    assert!(name.contains(".pre-sync-") && name.ends_with(".bak"), "{name}");
    assert_eq!(fs::read_to_string(&backup).unwrap(), "pretend sqlite bytes");
    assert_eq!(fs::read_to_string(format!("{name}-wal")).unwrap(), "pretend wal bytes");
    assert!(!Path::new(&format!("{name}-shm")).exists());
}

#[test]
fn a_backup_of_nothing_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    assert!(backup_before_sync_migration(Some(Path::new(":memory:"))).unwrap().is_none());
    assert!(backup_before_sync_migration(Some(&dir.path().join("does-not-exist.db"))).unwrap().is_none());
    assert!(backup_before_sync_migration(None).unwrap().is_none());
}

#[test]
fn enabling_sync_backfills_uuids_without_touching_any_existing_todo_id() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open_in_memory().unwrap();
    let project = db.create_todo_project(&CreateTodoProjectInput { name: "LizMeter".into(), color: None }).unwrap();
    let state = db.create_todo_state(&CreateTodoStateInput { label: "In Review".into(), color: None }).unwrap();
    let label = db.create_todo_label(&CreateTodoLabelInput { name: "bug".into(), color: None }).unwrap();
    db.create_tag(&CreateTagInput { name: "focus".into(), color: "#7aa2f7".into() }).unwrap();
    db.save_session(&SaveSessionInput {
        title: "Focus session".into(),
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
    let first = db.create_todo(&CreateTodoInput { project_id: Some(project.id), ..new("#1") }).unwrap();
    let second =
        db.create_todo(&CreateTodoInput { state_id: Some(state.id), label_ids: Some(vec![label.id]), ..new("#2") })
            .unwrap();
    let mut existing = [first.id, second.id];
    existing.sort();

    make_legacy_pre_sync_schema(&db);
    db.migrate_sync_columns_now().unwrap();

    let result = enable_sync_on_existing_machine(db.conn(), None, root.path(), &writer(root.path())).unwrap();
    assert!(result.backup_path.is_none());
    assert_eq!(result.device_number, 0, "this machine already has data: FR-016's legacy machine");

    let todos = db.list_todos(&ListTodosInput::default()).unwrap();
    let mut after: Vec<i64> = todos.iter().map(|t| t.id).collect();
    after.sort();
    assert_eq!(after, existing);
    assert_eq!(todos.iter().find(|t| t.title == "#1").unwrap().project.as_ref().unwrap().name, "LizMeter");
    assert_eq!(todos.iter().find(|t| t.title == "#2").unwrap().state.label, "In Review");
    assert_eq!(
        todos.iter().find(|t| t.title == "#2").unwrap().labels.iter().map(|l| l.name.clone()).collect::<Vec<_>>(),
        vec!["bug"]
    );
    for table in ["todos", "tags", "todo_labels", "todo_states", "todo_projects"] {
        assert_eq!(count(&db, &format!("SELECT COUNT(*) FROM {table} WHERE uuid IS NULL")), 0, "{table}");
    }
}

#[test]
fn enabling_sync_publishes_every_existing_row_for_a_second_machine() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open_in_memory().unwrap();
    db.create_todo(&new("already here before sync existed")).unwrap();
    make_legacy_pre_sync_schema(&db);
    db.migrate_sync_columns_now().unwrap();

    enable_sync_on_existing_machine(db.conn(), None, root.path(), &writer(root.path())).unwrap();

    assert!(is_sync_enabled(db.conn()).unwrap());
    let dir = get_sync_devices_dir(root.path());
    let files: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".oplog.jsonl"))
        .collect();
    assert_eq!(files.len(), 1);
    let entries = read_oplog_entries(&files[0].path()).unwrap().entries;
    assert!(entries.iter().any(|e| matches!(e, OplogEntry::Upsert(u)
        if u.table == "todos" && u.fields.get("title").is_some_and(|c| c.value == "already here before sync existed"))));
    let published_todo = entries
        .iter()
        .find_map(|e| match e {
            OplogEntry::Upsert(u) if u.table == "todos" => Some(u),
            _ => None,
        })
        .unwrap();
    assert!(published_todo.fields.get("id").is_some(), "a todo's number is published");
    assert!(published_todo.fields.get("state_uuid").is_some(), "foreign keys travel as uuids");
}

#[test]
fn the_migration_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open_in_memory().unwrap();
    db.create_todo(&new("only todo")).unwrap();
    make_legacy_pre_sync_schema(&db);

    db.migrate_sync_columns_now().unwrap();
    db.migrate_sync_columns_now().unwrap();
    assert_eq!(count(&db, "SELECT COUNT(*) FROM todos"), 1);

    let w = writer(root.path());
    let before = enable_sync_on_existing_machine(db.conn(), None, root.path(), &w).unwrap();
    let uuid1: String = query_one(&db, "SELECT uuid FROM todos LIMIT 1");
    let after = enable_sync_on_existing_machine(db.conn(), None, root.path(), &w).unwrap();
    let uuid2: String = query_one(&db, "SELECT uuid FROM todos LIMIT 1");
    assert_eq!(uuid1, uuid2);
    assert_eq!(before.device_number, after.device_number);
}

// --- renumber ---

const STRIDE: i64 = LEGACY_TODO_ID_BLOCK_STRIDE;

fn insert_todo(db: &Database, id: i64, title: &str, created_at: &str) {
    let state: i64 = db.conn().query_row("SELECT id FROM todo_states LIMIT 1", [], |r| r.get(0)).unwrap();
    db.conn()
        .execute(
            "INSERT INTO todos (id, claimed_id, title, state_id, created_at, uuid) VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![id, id, title, state, created_at, format!("uuid-{id}")],
        )
        .unwrap();
}

fn id_of(db: &Database, title: &str) -> i64 {
    db.list_todos(&ListTodosInput::default()).unwrap().into_iter().find(|t| t.title == title).unwrap().id
}

fn renumber(db: &Database) -> Vec<(i64, i64)> {
    renumber_block_allocated_todo_ids(db.conn(), &writer(Path::new("unused")), None).unwrap().renumbered
}

#[test]
fn block_allocated_ids_are_appended_after_the_highest_untouched_one_in_creation_order() {
    let db = Database::open_in_memory().unwrap();
    insert_todo(&db, 1, "first", "2026-01-01T00:00:00.000Z");
    insert_todo(&db, 120, "highest normal", "2026-01-02T00:00:00.000Z");
    insert_todo(&db, 7 * STRIDE + 2, "big second", "2026-03-02T00:00:00.000Z");
    insert_todo(&db, 7 * STRIDE + 1, "big first", "2026-03-01T00:00:00.000Z");
    insert_todo(&db, 9 * STRIDE + 5, "big third", "2026-03-03T00:00:00.000Z");

    let moved = renumber(&db);

    assert_eq!(moved.iter().map(|m| m.1).collect::<Vec<_>>(), vec![121, 122, 123]);
    assert_eq!(id_of(&db, "big first"), 121);
    assert_eq!(id_of(&db, "big second"), 122);
    assert_eq!(id_of(&db, "big third"), 123);
}

#[test]
fn every_id_below_the_stride_stays_put() {
    let db = Database::open_in_memory().unwrap();
    insert_todo(&db, 1, "one", "2026-01-01T00:00:00.000Z");
    insert_todo(&db, 2, "two", "2026-01-02T00:00:00.000Z");
    insert_todo(&db, 50, "fifty", "2026-01-03T00:00:00.000Z");
    insert_todo(&db, 7 * STRIDE + 1, "big", "2026-03-01T00:00:00.000Z");

    renumber(&db);

    assert_eq!((id_of(&db, "one"), id_of(&db, "two"), id_of(&db, "fifty"), id_of(&db, "big")), (1, 2, 50, 51));
}

#[test]
fn a_second_run_does_nothing() {
    let db = Database::open_in_memory().unwrap();
    insert_todo(&db, 10, "normal", "2026-01-01T00:00:00.000Z");
    insert_todo(&db, 7 * STRIDE + 1, "big", "2026-03-01T00:00:00.000Z");
    renumber(&db);
    let after_first: Vec<_> = db.list_todos(&ListTodosInput::default()).unwrap().iter().map(|t| (t.id, t.title.clone())).collect();

    assert!(renumber(&db).is_empty());
    let after_second: Vec<_> = db.list_todos(&ListTodosInput::default()).unwrap().iter().map(|t| (t.id, t.title.clone())).collect();
    assert_eq!(after_first, after_second);
}

#[test]
fn nothing_block_allocated_means_nothing_happens() {
    let db = Database::open_in_memory().unwrap();
    insert_todo(&db, 1, "only", "2026-01-01T00:00:00.000Z");
    assert_eq!(count_block_allocated_todos(db.conn()).unwrap(), 0);
    assert!(renumber(&db).is_empty());
}

#[test]
fn sub_todo_label_and_attachment_references_follow_the_renumber() {
    let db = Database::open_in_memory().unwrap();
    let big = 7 * STRIDE + 1;
    insert_todo(&db, 5, "parent", "2026-01-01T00:00:00.000Z");
    insert_todo(&db, big, "child with references", "2026-03-01T00:00:00.000Z");
    let c = db.conn();
    c.execute("UPDATE todos SET parent_id = 5 WHERE id = ?", [big]).unwrap();
    c.execute("INSERT INTO todo_labels (name, color, created_at, uuid) VALUES ('L', '#fff', '2026-01-01T00:00:00.000Z', 'lu')", []).unwrap();
    let label_id: i64 = c.query_row("SELECT id FROM todo_labels WHERE uuid = 'lu'", [], |r| r.get(0)).unwrap();
    c.execute("INSERT INTO todo_label_links (todo_id, label_id) VALUES (?, ?)", [big, label_id]).unwrap();
    c.execute(
        "INSERT INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at)
         VALUES (?, 'abc', 'f.png', 'image/png', 1, 'file', '2026-03-01T00:00:00.000Z')",
        [big],
    )
    .unwrap();

    let new_id = renumber(&db)[0].1;

    let child = db.list_todos(&ListTodosInput::default()).unwrap().into_iter().find(|t| t.title == "child with references").unwrap();
    assert_eq!(child.id, new_id);
    assert_eq!(child.parent_id, Some(5));
    assert_eq!(count(&db, &format!("SELECT COUNT(*) FROM todo_label_links WHERE todo_id = {new_id}")), 1);
    assert_eq!(count(&db, &format!("SELECT COUNT(*) FROM todo_attachments WHERE todo_id = {new_id}")), 1);
}

#[test]
fn a_notice_lists_what_moved() {
    let db = Database::open_in_memory().unwrap();
    insert_todo(&db, 3, "normal", "2026-01-01T00:00:00.000Z");
    insert_todo(&db, 7 * STRIDE + 1, "big", "2026-03-01T00:00:00.000Z");
    renumber(&db);
    let detail: String = query_one(&db, "SELECT detail FROM sync_notices WHERE kind = 'todo-id-reassigned'");
    assert!(detail.contains("-> #4"), "{detail}");
    assert_eq!(count(&db, "SELECT COUNT(*) FROM sync_notices WHERE kind = 'todo-id-reassigned'"), 1);
}
