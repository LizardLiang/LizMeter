//! Port of `todo-states-database.test.ts` and `todo-projects-labels-database.test.ts`, plus the
//! legacy-column migrations the TypeScript suite could not exercise (`done`, pre-uuid, flag repair).

use lizmeter_core::{
    CreateTodoInput, CreateTodoLabelInput, CreateTodoProjectInput, CreateTodoStateInput, ListTodosInput, TodoFilter,
    UpdateTodoInput, UpdateTodoLabelInput, UpdateTodoProjectInput, UpdateTodoStateInput,
};
use lizmeter_db::Database;

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

fn todo(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

fn state(db: &Database, label: &str) -> lizmeter_core::TodoState {
    db.find_todo_state_by_label(label).unwrap().unwrap()
}

fn labels(db: &Database) -> Vec<String> {
    db.list_todo_states().unwrap().into_iter().map(|s| s.label).collect()
}

fn err(r: lizmeter_db::Result<impl std::fmt::Debug>) -> String {
    r.unwrap_err().to_string()
}

fn proj(db: &Database, name: &str) -> lizmeter_core::TodoProject {
    db.create_todo_project(&CreateTodoProjectInput { name: name.into(), color: None }).unwrap()
}

fn label(db: &Database, name: &str) -> lizmeter_core::TodoLabel {
    db.create_todo_label(&CreateTodoLabelInput { name: name.into(), color: None }).unwrap()
}

fn all_todos(db: &Database) -> Vec<lizmeter_core::Todo> {
    db.list_todos(&ListTodosInput::default()).unwrap()
}

// --- seeding ---

#[test]
fn seeds_six_default_states_with_one_default_and_one_completed() {
    let db = db();
    assert_eq!(labels(&db), ["Backlog", "Todo", "Processing", "Testing", "Done", "Deprecated"]);
    let states = db.list_todo_states().unwrap();
    let flagged = |f: fn(&lizmeter_core::TodoState) -> bool| {
        states.iter().filter(|s| f(s)).map(|s| s.label.clone()).collect::<Vec<_>>()
    };
    assert_eq!(flagged(|s| s.is_default), ["Todo"]);
    assert_eq!(flagged(|s| s.is_completed), ["Done"]);
    assert_eq!(states.iter().map(|s| s.position).collect::<Vec<_>>(), [0, 1, 2, 3, 4, 5]);
}

#[test]
fn does_not_reseed_a_deleted_state() {
    let db = db();
    db.delete_todo_state(state(&db, "Testing").id, state(&db, "Backlog").id).unwrap();
    db.migrate_todos_to_states_now().unwrap();
    assert!(!labels(&db).contains(&"Testing".to_string()));
}

#[test]
fn find_state_matches_case_insensitively_and_trims() {
    let db = db();
    assert_eq!(state(&db, "done").label, "Done");
    assert_eq!(state(&db, "PROCESSING").label, "Processing");
    assert_eq!(state(&db, "  Todo  ").label, "Todo");
    assert!(db.find_todo_state_by_label("Nope").unwrap().is_none());
}

// --- create / update / delete / reorder state ---

#[test]
fn create_state_appends_and_has_no_roles() {
    let db = db();
    let created = db.create_todo_state(&CreateTodoStateInput { label: "Blocked".into(), color: None }).unwrap();
    assert_eq!(created.position, 6);
    assert!(!created.is_default && !created.is_completed);
    assert_eq!(labels(&db).last().unwrap(), "Blocked");
    assert!(state(&db, "Done").is_completed && state(&db, "Todo").is_default);
}

#[test]
fn create_state_validation() {
    let db = db();
    let new = |l: &str, c: Option<&str>| db.create_todo_state(&CreateTodoStateInput { label: l.into(), color: c.map(String::from) });
    assert!(err(new("done", None)).contains("already exists"));
    assert!(new("   ", None).is_err());
    assert!(err(new("Blocked", Some("#123456"))).contains("Invalid state color"));
}

#[test]
fn update_state_rename_keeps_completion_working() {
    let db = db();
    let done = state(&db, "Done");
    let renamed = db.update_todo_state(&UpdateTodoStateInput { id: done.id, label: Some("Shipped".into()), ..Default::default() }).unwrap();
    assert_eq!((renamed.label.as_str(), renamed.is_completed, renamed.position), ("Shipped", true, done.position));
    let t = db.create_todo(&CreateTodoInput { state_id: Some(done.id), ..todo("x") }).unwrap();
    assert!(t.state.is_completed && t.completed_at.is_some());
    assert_eq!(db.list_todos(&ListTodosInput { filter: Some(TodoFilter::Done), ..Default::default() }).unwrap().len(), 1);
}

#[test]
fn update_state_roles_move_rather_than_duplicate() {
    let db = db();
    let backlog = state(&db, "Backlog");
    db.update_todo_state(&UpdateTodoStateInput { id: backlog.id, is_default: Some(true), ..Default::default() }).unwrap();
    let defaults: Vec<_> = db.list_todo_states().unwrap().into_iter().filter(|s| s.is_default).map(|s| s.label).collect();
    assert_eq!(defaults, ["Backlog"]);

    let deprecated = state(&db, "Deprecated");
    db.update_todo_state(&UpdateTodoStateInput { id: deprecated.id, is_completed: Some(true), ..Default::default() }).unwrap();
    let completed: Vec<_> = db.list_todo_states().unwrap().into_iter().filter(|s| s.is_completed).map(|s| s.label).collect();
    assert_eq!(completed, ["Deprecated"]);
    assert!(!state(&db, "Done").is_completed);
}

#[test]
fn update_state_refuses_vacant_roles_and_clashes() {
    let db = db();
    let done = state(&db, "Done");
    let u = |id, f: &dyn Fn(&mut UpdateTodoStateInput)| {
        let mut i = UpdateTodoStateInput { id, ..Default::default() };
        f(&mut i);
        db.update_todo_state(&i)
    };
    assert!(err(u(done.id, &|i| i.is_completed = Some(false))).to_lowercase().contains("at least one state"));
    assert!(err(u(state(&db, "Todo").id, &|i| i.is_default = Some(false))).to_lowercase().contains("another state"));
    assert!(err(u(state(&db, "Backlog").id, &|i| i.label = Some("Testing".into()))).contains("already exists"));
    assert_eq!(u(state(&db, "Backlog").id, &|i| i.label = Some("BACKLOG".into())).unwrap().label, "BACKLOG");
}

#[test]
fn delete_state_moves_todos_and_keeps_positions_contiguous() {
    let db = db();
    let (testing, backlog) = (state(&db, "Testing"), state(&db, "Backlog"));
    for (t, s) in [("a", testing.id), ("b", testing.id), ("c", backlog.id)] {
        db.create_todo(&CreateTodoInput { state_id: Some(s), ..todo(t) }).unwrap();
    }
    assert_eq!(db.delete_todo_state(testing.id, backlog.id).unwrap(), 2);
    let todos = all_todos(&db);
    assert_eq!(todos.len(), 3);
    assert!(todos.iter().all(|t| t.state.label == "Backlog"));
    assert_eq!(db.list_todo_states().unwrap().iter().map(|s| s.position).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
}

#[test]
fn delete_state_guards() {
    let db = db();
    let backlog = state(&db, "Backlog");
    assert!(err(db.delete_todo_state(state(&db, "Todo").id, backlog.id)).to_lowercase().contains("default"));
    assert!(err(db.delete_todo_state(state(&db, "Done").id, backlog.id)).to_lowercase().contains("completed"));
    let testing = state(&db, "Testing");
    assert!(err(db.delete_todo_state(testing.id, testing.id)).contains("being deleted"));
    assert!(err(db.delete_todo_state(testing.id, 9999)).contains("not found"));
    // Roles stay filled after deleting around them.
    db.delete_todo_state(state(&db, "Processing").id, backlog.id).unwrap();
    let states = db.list_todo_states().unwrap();
    assert_eq!(states.iter().filter(|s| s.is_completed).count(), 1);
    assert_eq!(states.iter().filter(|s| s.is_default).count(), 1);
}

#[test]
fn reorder_states() {
    let db = db();
    let mut ids: Vec<i64> = db.list_todo_states().unwrap().iter().map(|s| s.id).collect();
    ids.reverse();
    let order: Vec<_> = db.reorder_todo_states(&ids).unwrap().into_iter().map(|s| s.label).collect();
    assert_eq!(order, ["Deprecated", "Done", "Testing", "Processing", "Todo", "Backlog"]);

    let db = self::db();
    let done = state(&db, "Done");
    let r = db.reorder_todo_states(&[done.id]).unwrap();
    assert_eq!(r[0].label, "Done");
    assert_eq!(r.iter().map(|s| s.position).collect::<Vec<_>>(), [0, 1, 2, 3, 4, 5]);
    assert!(err(db.reorder_todo_states(&[9999])).contains("not found"));
}

// --- migration idempotency / priority ---

#[test]
fn migration_is_idempotent_and_preserves_state_and_priority() {
    let db = db();
    let a = db.create_todo(&todo("a")).unwrap();
    let t = db.create_todo(&CreateTodoInput { state_id: Some(state(&db, "Testing").id), priority: Some(1), ..todo("b") }).unwrap();
    db.migrate_todos_to_states_now().unwrap();
    db.migrate_todos_to_states_now().unwrap();
    let todos = all_todos(&db);
    assert_eq!(todos.len(), 2);
    assert_eq!(todos.iter().find(|x| x.id == a.id).unwrap().state.label, "Todo");
    assert_eq!(todos.iter().find(|x| x.id == a.id).unwrap().priority, 0);
    let b = todos.iter().find(|x| x.id == t.id).unwrap();
    assert_eq!((b.state.label.as_str(), b.priority), ("Testing", 1));
}

// --- projects ---

#[test]
fn project_create_find_rename_delete_reorder() {
    let db = db();
    let (a, b) = (proj(&db, "LizMeter"), proj(&db, "Vital"));
    assert_eq!((a.color.as_str(), a.position, b.position), ("#7aa2f7", 0, 1));
    assert_eq!(proj(&db, "  Padded  ").name, "Padded");
    assert!(err(db.create_todo_project(&CreateTodoProjectInput { name: "lizmeter".into(), color: None })).contains("already exists"));
    assert!(err(db.create_todo_project(&CreateTodoProjectInput { name: "x".into(), color: Some("#123456".into()) })).contains("Invalid project color"));
    assert_eq!(db.find_todo_project_by_name("lizmeter").unwrap().unwrap().id, a.id);
    assert!(db.find_todo_project_by_name("nope").unwrap().is_none());

    let t = db.create_todo(&CreateTodoInput { project_id: Some(a.id), ..todo("x") }).unwrap();
    db.update_todo_project(&UpdateTodoProjectInput { id: a.id, name: Some("Liz Meter".into()), ..Default::default() }).unwrap();
    assert_eq!(all_todos(&db).into_iter().find(|x| x.id == t.id).unwrap().project.unwrap().name, "Liz Meter");
    assert!(err(db.update_todo_project(&UpdateTodoProjectInput { id: b.id, name: Some("liz meter".into()), ..Default::default() })).contains("already exists"));
}

#[test]
fn deleting_a_project_keeps_todos_and_positions() {
    let db = db();
    let a = proj(&db, "a");
    proj(&db, "b");
    proj(&db, "c");
    db.create_todo(&CreateTodoInput { project_id: Some(a.id), ..todo("t1") }).unwrap();
    db.create_todo(&CreateTodoInput { project_id: Some(a.id), ..todo("t2") }).unwrap();
    assert_eq!(db.delete_todo_project(a.id).unwrap(), 2);
    let todos = all_todos(&db);
    assert_eq!(todos.len(), 2);
    assert!(todos.iter().all(|t| t.project.is_none()));
    assert_eq!(db.list_todo_projects().unwrap().iter().map(|p| p.position).collect::<Vec<_>>(), [0, 1]);
    assert!(err(db.delete_todo_project(9999)).contains("not found"));
}

#[test]
fn reorder_projects() {
    let db = db();
    let (a, b, c) = (proj(&db, "a"), proj(&db, "b"), proj(&db, "c"));
    db.reorder_todo_projects(&[c.id, a.id, b.id]).unwrap();
    assert_eq!(db.list_todo_projects().unwrap().into_iter().map(|p| p.name).collect::<Vec<_>>(), ["c", "a", "b"]);
}

// --- labels ---

#[test]
fn label_get_or_create_and_ordering() {
    let db = db();
    let first = label(&db, "bug");
    assert_eq!(label(&db, "BUG").id, first.id);
    assert_eq!(db.list_todo_labels().unwrap().len(), 1);
    label(&db, "ui");
    label(&db, "chore");
    let names: Vec<_> = db.list_todo_labels().unwrap().into_iter().map(|l| l.name).collect();
    assert_eq!(names, ["bug", "chore", "ui"]);
    assert_eq!(db.find_todo_label_by_name("BUG").unwrap().unwrap().id, first.id);
    assert!(db.find_todo_label_by_name("nope").unwrap().is_none());
}

#[test]
fn label_attach_replace_and_leave_alone() {
    let db = db();
    let (ui, bug) = (label(&db, "ui"), label(&db, "bug"));
    let t = db.create_todo(&CreateTodoInput { label_ids: Some(vec![ui.id, bug.id]), ..todo("x") }).unwrap();
    assert_eq!(t.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["bug", "ui"]);

    let upd = |labels: Option<Vec<i64>>, title: Option<&str>| {
        db.update_todo(&UpdateTodoInput { id: t.id, label_ids: labels, title: title.map(String::from), ..Default::default() }).unwrap()
    };
    assert_eq!(upd(Some(vec![ui.id]), None).labels.iter().map(|l| l.name.clone()).collect::<Vec<_>>(), ["ui"]);
    assert!(upd(Some(vec![]), None).labels.is_empty());
    upd(Some(vec![bug.id]), None);
    assert_eq!(upd(None, Some("y")).labels.len(), 1);
}

#[test]
fn repeated_label_id_links_once_and_unknown_id_writes_nothing() {
    let db = db();
    let bug = label(&db, "bug");
    let t = db.create_todo(&CreateTodoInput { label_ids: Some(vec![bug.id, bug.id]), ..todo("x") }).unwrap();
    assert_eq!(t.labels.len(), 1);
    let e = err(db.update_todo(&UpdateTodoInput { id: t.id, label_ids: Some(vec![bug.id, 9999]), ..Default::default() }));
    assert!(e.contains("not found"));
    let after = all_todos(&db).into_iter().find(|x| x.id == t.id).unwrap();
    assert_eq!(after.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["bug"]);
    // A bad label on create leaves no phantom todo behind.
    let before = all_todos(&db).len();
    assert!(db.create_todo(&CreateTodoInput { label_ids: Some(vec![9999]), ..todo("ghost") }).is_err());
    assert_eq!(all_todos(&db).len(), before);
}

#[test]
fn label_rename_delete_and_todo_delete_cleanup() {
    let db = db();
    let bug = label(&db, "bug");
    let a = db.create_todo(&CreateTodoInput { label_ids: Some(vec![bug.id]), ..todo("a") }).unwrap();
    db.create_todo(&CreateTodoInput { label_ids: Some(vec![bug.id]), ..todo("b") }).unwrap();
    db.update_todo_label(&UpdateTodoLabelInput { id: bug.id, name: Some("defect".into()), ..Default::default() }).unwrap();
    assert!(all_todos(&db).iter().all(|t| t.labels[0].name == "defect"));

    db.delete_todo(a.id).unwrap();
    let count: i64 = db.conn().query_row("SELECT COUNT(*) FROM todo_label_links WHERE todo_id = ?", [a.id], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);

    assert_eq!(db.delete_todo_label(bug.id).unwrap(), 1);
    assert_eq!(all_todos(&db).len(), 1);
    assert!(all_todos(&db).iter().all(|t| t.labels.is_empty()));
    assert!(err(db.delete_todo_label(9999)).contains("not found"));
}

// --- legacy project text column migration ---

fn make_legacy_project_column(db: &Database) {
    let c = db.conn();
    c.execute_batch("DROP INDEX IF EXISTS idx_todos_project_id").unwrap();
    c.execute_batch("ALTER TABLE todos DROP COLUMN project_id").unwrap();
    c.execute_batch("ALTER TABLE todos ADD COLUMN project TEXT").unwrap();
    c.execute_batch("CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project)").unwrap();
}

fn set_legacy_project(db: &Database, id: i64, project: Option<&str>) {
    db.conn().execute("UPDATE todos SET project = ? WHERE id = ?", rusqlite::params![project, id]).unwrap();
}

fn columns(db: &Database, table: &str) -> Vec<String> {
    let mut stmt = db.conn().prepare(&format!("PRAGMA table_info({table})")).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
}

#[test]
fn legacy_project_text_becomes_rows() {
    let db = db();
    let a = db.create_todo(&todo("a")).unwrap();
    let b = db.create_todo(&todo("b")).unwrap();
    make_legacy_project_column(&db);
    set_legacy_project(&db, a.id, Some("LizMeter"));
    set_legacy_project(&db, b.id, Some("Vital"));
    db.migrate_todos_to_states_now().unwrap();
    let mut names: Vec<_> = db.list_todo_projects().unwrap().into_iter().map(|p| p.name).collect();
    names.sort();
    assert_eq!(names, ["LizMeter", "Vital"]);
    let by: std::collections::HashMap<_, _> = all_todos(&db).into_iter().map(|t| (t.title, t.project.map(|p| p.name))).collect();
    assert_eq!(by["a"].as_deref(), Some("LizMeter"));
    assert_eq!(by["b"].as_deref(), Some("Vital"));
    let cols = columns(&db, "todos");
    assert!(cols.contains(&"project_id".to_string()) && !cols.contains(&"project".to_string()));
}

#[test]
fn legacy_project_text_collapses_case_trims_and_skips_blank() {
    let db = db();
    let (a, b, c) = (db.create_todo(&todo("a")).unwrap(), db.create_todo(&todo("b")).unwrap(), db.create_todo(&todo("c")).unwrap());
    make_legacy_project_column(&db);
    set_legacy_project(&db, a.id, Some("LizMeter"));
    set_legacy_project(&db, b.id, Some("lizmeter"));
    set_legacy_project(&db, c.id, Some("   "));
    db.migrate_todos_to_states_now().unwrap();
    assert_eq!(db.list_todo_projects().unwrap().len(), 1);
    let todos = all_todos(&db);
    assert!(todos.iter().filter(|t| t.title != "c").all(|t| t.project.is_some()));
    let padded = self::db();
    let p = padded.create_todo(&todo("p")).unwrap();
    make_legacy_project_column(&padded);
    set_legacy_project(&padded, p.id, Some("  LizMeter  "));
    padded.migrate_todos_to_states_now().unwrap();
    assert_eq!(padded.list_todo_projects().unwrap().into_iter().map(|x| x.name).collect::<Vec<_>>(), ["LizMeter"]);
    assert!(todos.iter().find(|t| t.title == "c").unwrap().project.is_none());
    // Running again is a no-op.
    db.migrate_todos_to_states_now().unwrap();
    assert_eq!(db.list_todo_projects().unwrap().len(), 1);
}

// --- migrations the TypeScript suite could not exercise ---

#[test]
fn legacy_done_column_backfills_states() {
    let db = db();
    let open = db.create_todo(&todo("open")).unwrap();
    let finished = db.create_todo(&todo("finished")).unwrap();
    let c = db.conn();
    c.execute_batch("ALTER TABLE todos ADD COLUMN done INTEGER NOT NULL DEFAULT 0").unwrap();
    c.execute_batch("CREATE INDEX idx_todos_done ON todos(done)").unwrap();
    c.execute("UPDATE todos SET done = 1, state_id = NULL WHERE id = ?", [finished.id]).unwrap();
    c.execute("UPDATE todos SET state_id = NULL WHERE id = ?", [open.id]).unwrap();
    c.execute_batch("PRAGMA foreign_keys = OFF").unwrap();

    db.migrate_todos_to_states_now().unwrap();

    let todos = all_todos(&db);
    assert_eq!(todos.iter().find(|t| t.id == open.id).unwrap().state.label, "Todo");
    assert_eq!(todos.iter().find(|t| t.id == finished.id).unwrap().state.label, "Done");
    assert!(!columns(&db, "todos").contains(&"done".to_string()));
}

#[test]
fn state_flags_are_repaired_on_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lizmeter.db");
    {
        let db = Database::open(&path).unwrap();
        db.conn().execute("UPDATE todo_states SET is_completed = 0, is_default = 0", []).unwrap();
    }
    let db = Database::open(&path).unwrap();
    let states = db.list_todo_states().unwrap();
    // No completed state: the last one takes the role. No default: the first one does.
    assert_eq!(states.iter().filter(|s| s.is_completed).map(|s| s.label.as_str()).collect::<Vec<_>>(), ["Deprecated"]);
    assert_eq!(states.iter().filter(|s| s.is_default).map(|s| s.label.as_str()).collect::<Vec<_>>(), ["Backlog"]);
    drop(db);

    {
        let db = Database::open(&path).unwrap();
        db.conn().execute("UPDATE todo_states SET is_completed = 1, is_default = 1", []).unwrap();
    }
    let db = Database::open(&path).unwrap();
    let states = db.list_todo_states().unwrap();
    assert_eq!(states.iter().filter(|s| s.is_completed).count(), 1);
    assert_eq!(states.iter().filter(|s| s.is_default).count(), 1);
    assert!(states[0].is_completed && states[0].is_default);
}

#[test]
fn pre_sync_database_gains_uuid_columns_and_claimed_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.db");
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', timer_type TEXT NOT NULL,
               planned_duration_seconds INTEGER NOT NULL, actual_duration_seconds INTEGER NOT NULL, completed_at TEXT NOT NULL);
             CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT, done INTEGER NOT NULL DEFAULT 0,
               project TEXT, source TEXT NOT NULL DEFAULT 'user', source_label TEXT, created_at TEXT NOT NULL, completed_at TEXT);
             CREATE INDEX idx_todos_done ON todos(done);
             INSERT INTO todos (id, title, done, project, created_at) VALUES (7, 'old open', 0, 'Alpha', '2026-01-01T00:00:00.000Z');
             INSERT INTO todos (id, title, done, project, created_at) VALUES (9, 'old done', 1, NULL, '2026-01-02T00:00:00.000Z');",
        )
        .unwrap();
    }
    let db = Database::open(&path).unwrap();
    let todos = all_todos(&db);
    assert_eq!(todos.len(), 2);
    let open = todos.iter().find(|t| t.id == 7).unwrap();
    assert_eq!((open.state.label.as_str(), open.project.as_ref().map(|p| p.name.as_str())), ("Todo", Some("Alpha")));
    assert_eq!(todos.iter().find(|t| t.id == 9).unwrap().state.label, "Done");
    let claimed: Vec<(i64, i64)> = {
        let mut s = db.conn().prepare("SELECT id, claimed_id FROM todos ORDER BY id").unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(claimed, [(7, 7), (9, 9)]);
    for table in ["todos", "tags", "todo_labels", "todo_states", "todo_projects"] {
        assert!(columns(&db, table).contains(&"uuid".to_string()), "{table} lacks uuid");
    }
    assert!(columns(&db, "todo_states").contains(&"sync_order".to_string()));
    assert!(columns(&db, "sessions").contains(&"worklog_status".to_string()));
}
