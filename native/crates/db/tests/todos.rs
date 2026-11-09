//! Port of `electron/main/__tests__/todos-database.test.ts`.

use lizmeter_core::{
    CreateTodoInput, CreateTodoLabelInput, CreateTodoProjectInput, ListTodosInput, Todo, TodoFilter, TodoSource,
    UpdateTodoInput, NOTES_MAX_LENGTH,
};
use lizmeter_db::Database;

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

fn new(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

fn upd(id: i64) -> UpdateTodoInput {
    UpdateTodoInput { id, ..Default::default() }
}

fn done_id(db: &Database) -> i64 {
    db.find_todo_state_by_label("Done").unwrap().unwrap().id
}

fn complete(db: &Database, id: i64) -> Todo {
    db.update_todo(&UpdateTodoInput { state_id: Some(done_id(db)), ..upd(id) }).unwrap()
}

fn titles(todos: Vec<Todo>) -> Vec<String> {
    todos.into_iter().map(|t| t.title).collect()
}

fn list(db: &Database, input: ListTodosInput) -> Vec<Todo> {
    db.list_todos(&input).unwrap()
}

fn err(r: lizmeter_db::Result<impl std::fmt::Debug>) -> String {
    r.unwrap_err().to_string()
}

// --- createTodo ---

#[test]
fn creates_a_todo_with_user_defaults() {
    let db = db();
    let todo = db.create_todo(&new("Write the spec")).unwrap();
    assert_eq!(todo.title, "Write the spec");
    assert_eq!(todo.notes, None);
    assert!(!todo.state.is_completed);
    assert_eq!(todo.source, TodoSource::User);
    assert_eq!(todo.state.label, "Todo");
    assert_eq!(todo.source_label, None);
    assert_eq!(todo.completed_at, None);
    assert!(!todo.created_at.is_empty());
}

#[test]
fn trims_title_and_normalises_blank_notes() {
    let db = db();
    assert_eq!(db.create_todo(&new("   padded   ")).unwrap().title, "padded");
    let with_notes = |n: Option<&str>| db.create_todo(&CreateTodoInput { notes: n.map(String::from), ..new("a") }).unwrap().notes;
    assert_eq!(with_notes(Some("  detail  ")).as_deref(), Some("detail"));
    assert_eq!(with_notes(Some("   ")), None);
    assert_eq!(with_notes(None), None);
}

#[test]
fn ai_source_keeps_its_label_user_source_drops_it() {
    let db = db();
    let ai = db
        .create_todo(&CreateTodoInput {
            source: Some(TodoSource::Ai),
            source_label: Some("claude-code".into()),
            ..new("From the agent")
        })
        .unwrap();
    assert_eq!((ai.source, ai.source_label.as_deref()), (TodoSource::Ai, Some("claude-code")));
    let user = db
        .create_todo(&CreateTodoInput {
            source: Some(TodoSource::User),
            source_label: Some("claude-code".into()),
            ..new("Mine")
        })
        .unwrap();
    assert_eq!(user.source_label, None);
}

#[test]
fn unrecognised_source_is_rejected_at_the_typed_boundary() {
    // TS falls back to 'user'; the typed API cannot carry an unknown source, so the
    // deserialisation boundary is where "robot" stops.
    let r = serde_json::from_value::<CreateTodoInput>(serde_json::json!({"title":"x","source":"robot"}));
    assert!(r.is_err());
    let ok = serde_json::from_value::<CreateTodoInput>(serde_json::json!({"title":"x"})).unwrap();
    assert_eq!(db().create_todo(&ok).unwrap().source, TodoSource::User);
}

#[test]
fn title_and_notes_validation() {
    let db = db();
    assert!(db.create_todo(&new("")).is_err());
    assert!(db.create_todo(&new("   ")).is_err());
    assert!(err(db.create_todo(&new(&"x".repeat(501)))).contains("500 characters or fewer"));
    let long = CreateTodoInput { notes: Some("x".repeat(NOTES_MAX_LENGTH + 1)), ..new("ok") };
    assert!(err(db.create_todo(&long)).contains(&format!("{NOTES_MAX_LENGTH} characters or fewer")));
    let at_cap = CreateTodoInput { notes: Some("x".repeat(NOTES_MAX_LENGTH)), ..new("ok") };
    assert_eq!(db.create_todo(&at_cap).unwrap().notes.unwrap().len(), NOTES_MAX_LENGTH);
}

#[test]
fn over_long_source_label_is_truncated_not_rejected() {
    let t = db()
        .create_todo(&CreateTodoInput { source: Some(TodoSource::Ai), source_label: Some("a".repeat(200)), ..new("x") })
        .unwrap();
    assert_eq!(t.source_label.unwrap().len(), 64);
}

// --- listTodos ---

#[test]
fn list_is_empty_and_orders_open_before_completed() {
    let db = db();
    assert!(list(&db, ListTodosInput::default()).is_empty());
    let first = db.create_todo(&new("first")).unwrap();
    db.create_todo(&new("second")).unwrap();
    complete(&db, first.id);
    assert_eq!(titles(list(&db, ListTodosInput::default())), ["second", "first"]);
}

#[test]
fn list_filters() {
    let db = db();
    let done = db.create_todo(&new("done one")).unwrap();
    db.create_todo(&new("open one")).unwrap();
    db.create_todo(&CreateTodoInput {
        source: Some(TodoSource::Ai),
        source_label: Some("claude-code".into()),
        ..new("theirs")
    })
    .unwrap();
    complete(&db, done.id);
    let f = |filter| titles(list(&db, ListTodosInput { filter: Some(filter), ..Default::default() }));
    let mut active = f(TodoFilter::Active);
    active.sort();
    assert_eq!(active, ["open one", "theirs"]);
    assert_eq!(f(TodoFilter::Done), ["done one"]);
    assert_eq!(f(TodoFilter::Ai), ["theirs"]);
}

// --- updateTodo ---

#[test]
fn completion_stamps_and_clears_completed_at() {
    let db = db();
    let todo = db.create_todo(&new("finish me")).unwrap();
    let done = complete(&db, todo.id);
    assert!(done.state.is_completed);
    assert!(done.completed_at.is_some());

    let todo_state = db.find_todo_state_by_label("Todo").unwrap().unwrap().id;
    let reopened = db.update_todo(&UpdateTodoInput { state_id: Some(todo_state), ..upd(todo.id) }).unwrap();
    assert!(!reopened.state.is_completed);
    assert_eq!(reopened.completed_at, None);
}

#[test]
fn editing_a_done_todo_keeps_the_original_completed_at() {
    let db = db();
    let todo = db.create_todo(&new("edit me")).unwrap();
    let done = complete(&db, todo.id);
    let edited = db.update_todo(&UpdateTodoInput { title: Some("edited".into()), ..upd(todo.id) }).unwrap();
    assert_eq!(edited.title, "edited");
    assert!(edited.state.is_completed);
    assert_eq!(edited.completed_at, done.completed_at);
}

#[test]
fn update_leaves_omitted_fields_and_source_alone() {
    let db = db();
    let todo = db.create_todo(&CreateTodoInput { notes: Some("my notes".into()), ..new("keep") }).unwrap();
    let updated = complete(&db, todo.id);
    assert_eq!((updated.title.as_str(), updated.notes.as_deref()), ("keep", Some("my notes")));

    let ai = db
        .create_todo(&CreateTodoInput {
            source: Some(TodoSource::Ai),
            source_label: Some("claude-code".into()),
            ..new("ai one")
        })
        .unwrap();
    let renamed = db.update_todo(&UpdateTodoInput { title: Some("renamed".into()), ..upd(ai.id) }).unwrap();
    assert_eq!((renamed.source, renamed.source_label.as_deref()), (TodoSource::Ai, Some("claude-code")));
}

#[test]
fn update_errors() {
    let db = db();
    assert!(err(db.update_todo(&UpdateTodoInput { state_id: Some(done_id(&db)), ..upd(9999) })).contains("not found"));
    let todo = db.create_todo(&new("valid")).unwrap();
    assert!(db.update_todo(&UpdateTodoInput { title: Some("  ".into()), ..upd(todo.id) }).is_err());

    let capped = db.create_todo(&CreateTodoInput { notes: Some("short".into()), ..new("capped") }).unwrap();
    let e = err(db.update_todo(&UpdateTodoInput { notes: Some(Some("x".repeat(NOTES_MAX_LENGTH + 1))), ..upd(capped.id) }));
    assert!(e.contains(&format!("{NOTES_MAX_LENGTH} characters or fewer")));
    let stored = list(&db, ListTodosInput::default()).into_iter().find(|t| t.id == capped.id).unwrap();
    assert_eq!(stored.notes.as_deref(), Some("short"));

    let ok = db.update_todo(&UpdateTodoInput { notes: Some(Some("x".repeat(NOTES_MAX_LENGTH))), ..upd(capped.id) }).unwrap();
    assert_eq!(ok.notes.unwrap().len(), NOTES_MAX_LENGTH);
}

// --- delete / clearCompleted ---

#[test]
fn delete_removes_and_is_noop_for_unknown() {
    let db = db();
    let t = db.create_todo(&new("delete me")).unwrap();
    db.delete_todo(t.id).unwrap();
    assert!(list(&db, ListTodosInput::default()).is_empty());
    db.create_todo(&new("keep me")).unwrap();
    db.delete_todo(9999).unwrap();
    assert_eq!(list(&db, ListTodosInput::default()).len(), 1);
}

#[test]
fn clear_completed_removes_only_completed() {
    let db = db();
    let (a, b) = (db.create_todo(&new("a")).unwrap(), db.create_todo(&new("b")).unwrap());
    db.create_todo(&new("c")).unwrap();
    complete(&db, a.id);
    complete(&db, b.id);
    assert_eq!(db.clear_completed_todos().unwrap().count, 2);
    assert_eq!(titles(list(&db, ListTodosInput::default())), ["c"]);

    let fresh = self::db();
    fresh.create_todo(&new("open")).unwrap();
    let r = fresh.clear_completed_todos().unwrap();
    assert_eq!((r.count, r.deleted_shas), (0, vec![]));
}

// --- project, milestone, dates ---

#[test]
fn stores_project_milestone_and_dates() {
    let db = db();
    let project = db.create_todo_project(&CreateTodoProjectInput { name: "  LizMeter  ".into(), color: None }).unwrap();
    let todo = db
        .create_todo(&CreateTodoInput {
            project_id: Some(project.id),
            milestone: Some(" v1.14 ".into()),
            start_date: Some("2026-08-25".into()),
            due_date: Some("2026-08-30".into()),
            ..new("x")
        })
        .unwrap();
    assert_eq!(todo.project.unwrap().name, "LizMeter");
    assert_eq!(todo.milestone.as_deref(), Some("v1.14"));
    assert_eq!((todo.start_date.as_deref(), todo.due_date.as_deref()), (Some("2026-08-25"), Some("2026-08-30")));

    let blank = db.create_todo(&CreateTodoInput { milestone: Some("".into()), ..new("x") }).unwrap();
    assert_eq!((blank.project, blank.milestone), (None, None));
}

#[test]
fn date_and_project_validation() {
    let db = db();
    let due = |d: &str| db.create_todo(&CreateTodoInput { due_date: Some(d.into()), ..new("x") });
    assert!(err(due("Aug 30")).contains("YYYY-MM-DD"));
    assert!(due("2026-13-45").is_err());
    let order = CreateTodoInput { start_date: Some("2026-08-30".into()), due_date: Some("2026-08-25".into()), ..new("x") };
    assert!(err(db.create_todo(&order)).contains("must not be after"));
    assert!(err(db.create_todo_project(&CreateTodoProjectInput { name: "p".repeat(61), color: None })).contains("60 characters"));
    assert!(err(db.create_todo(&CreateTodoInput { project_id: Some(9999), ..new("x") })).contains("not found"));
}

#[test]
fn project_three_way_update() {
    let db = db();
    let project = db.create_todo_project(&CreateTodoProjectInput { name: "LizMeter".into(), color: None }).unwrap();
    let todo = db.create_todo(&CreateTodoInput { project_id: Some(project.id), ..new("x") }).unwrap();
    assert_eq!(db.update_todo(&UpdateTodoInput { project_id: Some(None), ..upd(todo.id) }).unwrap().project, None);

    let todo = db.create_todo(&CreateTodoInput { project_id: Some(project.id), ..new("y") }).unwrap();
    let kept = db.update_todo(&UpdateTodoInput { title: Some("z".into()), ..upd(todo.id) }).unwrap();
    assert_eq!(kept.project.unwrap().id, project.id);
}

// --- ordering / filtering ---

#[test]
fn dated_todos_come_first_soonest_first_and_completed_sink() {
    let db = db();
    db.create_todo(&new("undated")).unwrap();
    db.create_todo(&CreateTodoInput { due_date: Some("2026-09-10".into()), ..new("later") }).unwrap();
    db.create_todo(&CreateTodoInput { due_date: Some("2026-09-01".into()), ..new("sooner") }).unwrap();
    assert_eq!(titles(list(&db, ListTodosInput::default())), ["sooner", "later", "undated"]);

    let fresh = self::db();
    let urgent = fresh.create_todo(&CreateTodoInput { due_date: Some("2026-01-01".into()), ..new("urgent but done") }).unwrap();
    fresh.create_todo(&new("open")).unwrap();
    complete(&fresh, urgent.id);
    assert_eq!(titles(list(&fresh, ListTodosInput::default())), ["open", "urgent but done"]);
}

#[test]
fn filters_by_project_state_label_and_combinations() {
    let db = db();
    let liz = db.create_todo_project(&CreateTodoProjectInput { name: "LizMeter".into(), color: None }).unwrap();
    let other = db.create_todo_project(&CreateTodoProjectInput { name: "Other".into(), color: None }).unwrap();
    let a = db.create_todo(&CreateTodoInput { project_id: Some(liz.id), ..new("a") }).unwrap();
    db.create_todo(&CreateTodoInput { project_id: Some(liz.id), ..new("b") }).unwrap();
    db.create_todo(&CreateTodoInput { project_id: Some(other.id), ..new("c") }).unwrap();
    let of = |input| titles(list(&db, input));
    assert_eq!(of(ListTodosInput { project_id: Some(other.id), ..Default::default() }), ["c"]);

    complete(&db, a.id);
    assert_eq!(
        of(ListTodosInput { filter: Some(TodoFilter::Active), project_id: Some(liz.id), ..Default::default() }),
        ["b"]
    );

    let testing = db.find_todo_state_by_label("Testing").unwrap().unwrap();
    db.create_todo(&CreateTodoInput { state_id: Some(testing.id), ..new("t") }).unwrap();
    assert_eq!(of(ListTodosInput { state_id: Some(testing.id), ..Default::default() }), ["t"]);
}

#[test]
fn label_filter_returns_each_todo_once() {
    let db = db();
    let bug = db.create_todo_label(&CreateTodoLabelInput { name: "bug".into(), color: None }).unwrap();
    let ui = db.create_todo_label(&CreateTodoLabelInput { name: "ui".into(), color: None }).unwrap();
    db.create_todo(&CreateTodoInput { label_ids: Some(vec![bug.id, ui.id]), ..new("a") }).unwrap();
    db.create_todo(&new("b")).unwrap();
    assert_eq!(list(&db, ListTodosInput { label_id: Some(bug.id), ..Default::default() }).len(), 1);
    assert_eq!(list(&db, ListTodosInput::default()).len(), 2);
    let a = list(&db, ListTodosInput { label_id: Some(ui.id), ..Default::default() }).remove(0);
    assert_eq!(a.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), ["bug", "ui"]);
}

#[test]
fn projects_and_milestones_for_autocomplete() {
    let db = db();
    db.create_todo_project(&CreateTodoProjectInput { name: "LizMeter".into(), color: None }).unwrap();
    for (t, m) in [("a", Some("v1.14")), ("b", Some("v1.15")), ("c", None)] {
        db.create_todo(&CreateTodoInput { milestone: m.map(String::from), ..new(t) }).unwrap();
    }
    assert_eq!(db.list_todo_projects().unwrap().into_iter().map(|p| p.name).collect::<Vec<_>>(), ["LizMeter"]);
    assert_eq!(db.list_todo_milestones().unwrap(), ["v1.14", "v1.15"]);

    let fresh = self::db();
    fresh.create_todo(&new("a")).unwrap();
    assert!(fresh.list_todo_projects().unwrap().is_empty());
    assert!(fresh.list_todo_milestones().unwrap().is_empty());
}

// --- nesting ---

fn child_of(db: &Database, title: &str, parent: i64) -> Todo {
    db.create_todo(&CreateTodoInput { parent_id: Some(parent), ..new(title) }).unwrap()
}

#[test]
fn top_level_and_child_links() {
    let db = db();
    let root = db.create_todo(&new("root")).unwrap();
    assert_eq!((root.parent_id, root.parent_title.clone(), root.child_count), (None, None, 0));
    let child = child_of(&db, "Write the migration", root.id);
    assert_eq!((child.parent_id, child.parent_title.as_deref()), (Some(root.id), Some("root")));
}

#[test]
fn counts_direct_children_and_completed_children() {
    let db = db();
    let root = db.create_todo(&new("root")).unwrap();
    let mid = child_of(&db, "mid", root.id);
    child_of(&db, "leaf", mid.id);
    let by = |id| list(&db, ListTodosInput::default()).into_iter().find(|t| t.id == id).unwrap();
    assert_eq!((by(root.id).child_count, by(mid.id).child_count), (1, 1));

    let second = child_of(&db, "second", root.id);
    complete(&db, second.id);
    let r = by(root.id);
    assert_eq!((r.child_count, r.completed_child_count), (2, 1));

    let only = self::db();
    let p = only.create_todo(&new("root")).unwrap();
    child_of(&only, "only", p.id);
    assert_eq!(only.list_todos(&ListTodosInput::default()).unwrap().into_iter().find(|t| t.id == p.id).unwrap().completed_child_count, 0);
}

#[test]
fn reparenting_and_lifting() {
    let db = db();
    assert!(err(db.create_todo(&CreateTodoInput { parent_id: Some(9999), ..new("orphan") })).to_lowercase().contains("not found"));
    let first = db.create_todo(&new("first")).unwrap();
    let second = db.create_todo(&new("second")).unwrap();
    let child = child_of(&db, "child", first.id);

    let moved = db.update_todo(&UpdateTodoInput { parent_id: Some(Some(second.id)), ..upd(child.id) }).unwrap();
    assert_eq!((moved.parent_id, moved.parent_title.as_deref()), (Some(second.id), Some("second")));
    let kept = db.update_todo(&UpdateTodoInput { title: Some("renamed".into()), ..upd(child.id) }).unwrap();
    assert_eq!(kept.parent_id, Some(second.id));
    let lifted = db.update_todo(&UpdateTodoInput { parent_id: Some(None), ..upd(child.id) }).unwrap();
    assert_eq!((lifted.parent_id, lifted.parent_title), (None, None));
}

#[test]
fn cycles_are_refused_at_any_depth() {
    let db = db();
    let solo = db.create_todo(&new("solo")).unwrap();
    let e = err(db.update_todo(&UpdateTodoInput { parent_id: Some(Some(solo.id)), ..upd(solo.id) }));
    assert!(e.to_lowercase().contains("own parent"));

    let a = db.create_todo(&new("a")).unwrap();
    let b = child_of(&db, "b", a.id);
    let c = child_of(&db, "c", b.id);
    let d = child_of(&db, "d", c.id);
    for deep in [b.id, d.id] {
        let e = err(db.update_todo(&UpdateTodoInput { parent_id: Some(Some(deep)), ..upd(a.id) }));
        assert!(e.to_lowercase().contains("own subtree"));
    }
    // A grandchild may move up to be a direct child.
    let moved = db.update_todo(&UpdateTodoInput { parent_id: Some(Some(a.id)), ..upd(c.id) }).unwrap();
    assert_eq!(moved.parent_id, Some(a.id));
}

#[test]
fn nesting_depth_is_unbounded() {
    let db = db();
    let mut parent = db.create_todo(&new("level 0")).unwrap().id;
    for level in 1..=8 {
        parent = child_of(&db, &format!("level {level}"), parent).id;
    }
    let deepest = list(&db, ListTodosInput::default()).into_iter().find(|t| t.title == "level 8").unwrap();
    assert_eq!(deepest.parent_title.as_deref(), Some("level 7"));
}

#[test]
fn lists_only_direct_children() {
    let db = db();
    let root = db.create_todo(&new("root")).unwrap();
    child_of(&db, "child a", root.id);
    let mid = child_of(&db, "child b", root.id);
    child_of(&db, "grandchild", mid.id);
    db.create_todo(&new("unrelated")).unwrap();
    let mut children = titles(list(&db, ListTodosInput { parent_id: Some(root.id), ..Default::default() }));
    children.sort();
    assert_eq!(children, ["child a", "child b"]);
}

#[test]
fn children_survive_parent_delete_and_clear_completed() {
    let db = db();
    let parent = db.create_todo(&new("parent")).unwrap();
    let child = child_of(&db, "child", parent.id);
    db.delete_todo(parent.id).unwrap();
    let survivors = list(&db, ListTodosInput::default());
    assert_eq!(titles(survivors.clone()), ["child"]);
    assert_eq!((survivors[0].id, survivors[0].parent_id), (child.id, None));

    let db2 = self::db();
    let parent = db2.create_todo(&new("parent")).unwrap();
    child_of(&db2, "child", parent.id);
    complete(&db2, parent.id);
    assert_eq!(db2.clear_completed_todos().unwrap().count, 1);
    let survivors = list(&db2, ListTodosInput::default());
    assert_eq!(titles(survivors.clone()), ["child"]);
    assert_eq!(survivors[0].parent_id, None);
}

#[test]
fn completing_a_parent_leaves_children_open() {
    let db = db();
    let parent = db.create_todo(&new("parent")).unwrap();
    let child = child_of(&db, "child", parent.id);
    complete(&db, parent.id);
    let open: Vec<i64> = list(&db, ListTodosInput { filter: Some(TodoFilter::Active), ..Default::default() })
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert!(open.contains(&child.id));
}

// --- priority ---

#[test]
fn priority_defaults_round_trips_and_validates() {
    let db = db();
    assert_eq!(db.create_todo(&new("x")).unwrap().priority, 0);
    for level in 0..=4 {
        assert_eq!(db.create_todo(&CreateTodoInput { priority: Some(level), ..new(&format!("p{level}")) }).unwrap().priority, level);
    }
    let todo = db.create_todo(&CreateTodoInput { priority: Some(3), ..new("x") }).unwrap();
    assert_eq!(db.update_todo(&UpdateTodoInput { priority: Some(1), ..upd(todo.id) }).unwrap().priority, 1);
    // Absent means "leave it alone", not "reset to 0".
    assert_eq!(db.update_todo(&UpdateTodoInput { title: Some("renamed".into()), ..upd(todo.id) }).unwrap().priority, 1);

    for bad in [5, -1] {
        assert!(err(db.create_todo(&CreateTodoInput { priority: Some(bad), ..new("x") })).contains("between 0 and 4"));
    }
    db.create_todo(&CreateTodoInput { priority: Some(1), ..new("urgent one") }).unwrap();
    assert_eq!(list(&db, ListTodosInput::default()).into_iter().find(|t| t.title == "urgent one").unwrap().priority, 1);
}

#[test]
fn id_lookup_ignores_other_filters_and_paging_is_stable() {
    let db = db();
    let todos: Vec<_> = (0..5).map(|i| db.create_todo(&new(&format!("t{i}"))).unwrap()).collect();
    let one = list(&db, ListTodosInput { id: Some(todos[2].id), filter: Some(TodoFilter::Done), limit: Some(0), ..Default::default() });
    assert_eq!(one.len(), 1);

    let mut seen = vec![];
    for offset in [0, 2, 4] {
        seen.extend(titles(list(&db, ListTodosInput { limit: Some(2), offset: Some(offset), ..Default::default() })));
    }
    seen.sort();
    assert_eq!(seen, ["t0", "t1", "t2", "t3", "t4"]);
    assert_eq!(db.count_todos(&ListTodosInput { limit: Some(1), ..Default::default() }).unwrap(), 5);
}
