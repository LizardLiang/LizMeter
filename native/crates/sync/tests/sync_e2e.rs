//! Ports of `sync-e2e`, `todo-id-sync`, `merge-boolean-field-e2e`, `merge-pass-observability` and
//! `deferred-fk` from `electron/main/sync/__tests__/`, on the two-device harness.

mod common;

use common::*;
use lizmeter_core::{
    CreateTodoInput, CreateTodoLabelInput, CreateTodoProjectInput, ListTodosInput, Todo, UpdateTodoInput,
};
use lizmeter_db::Database;
use lizmeter_sync::device_identity::get_or_assign_device_number;
use lizmeter_sync::hlc::{tick, Hlc};
use lizmeter_sync::merge_engine::{apply_oplog_entries, reconcile_todo_ids};
use lizmeter_sync::merge_pass::run_merge_pass;
use lizmeter_sync::oplog::{
    append_oplog_entry, build_upsert_entry, get_sync_devices_dir, FieldMap, OplogEntry,
};
use serde_json::json;

fn new(title: &str) -> CreateTodoInput {
    CreateTodoInput { title: title.into(), ..Default::default() }
}

fn todos(db: &Database) -> Vec<Todo> {
    db.list_todos(&ListTodosInput::default()).unwrap()
}

fn find(db: &Database, title: &str) -> Option<Todo> {
    todos(db).into_iter().find(|t| t.title == title)
}

fn id_titles(db: &Database) -> Vec<String> {
    let mut v: Vec<String> = todos(db).iter().map(|t| format!("{}:{}", t.id, t.title)).collect();
    v.sort();
    v
}

fn upd(id: i64) -> UpdateTodoInput {
    UpdateTodoInput { id, ..Default::default() }
}

// --- FR-008 / FR-007 / FR-010 / FR-011 ---

#[test]
fn concurrent_edits_to_different_fields_both_survive() {
    let h = Harness::new();
    let created = h.a.db.create_todo(&new("Ship the release")).unwrap();
    h.sync(&h.b);

    h.a.db.update_todo(&UpdateTodoInput { title: Some("Ship the release NOW".into()), ..upd(created.id) }).unwrap();
    h.b.db.update_todo(&UpdateTodoInput { due_date: Some(Some("2026-09-01".into())), ..upd(created.id) }).unwrap();

    h.sync(&h.b);
    h.sync(&h.a);

    for dev in [&h.a, &h.b] {
        let t = find(&dev.db, "Ship the release NOW").expect("title merged");
        assert_eq!(t.due_date.as_deref(), Some("2026-09-01"));
    }
}

#[test]
fn delete_wins_over_a_concurrent_edit_and_the_discard_is_visible() {
    let h = Harness::new();
    let created = h.a.db.create_todo(&new("Doomed todo")).unwrap();
    h.sync(&h.b);

    h.a.db.delete_todo(created.id).unwrap();
    h.b.db.update_todo(&UpdateTodoInput { title: Some("I did not know it was deleted".into()), ..upd(created.id) }).unwrap();

    h.sync(&h.b);
    h.sync(&h.a);

    assert!(todos(&h.a.db).iter().all(|t| t.id != created.id));
    assert!(todos(&h.b.db).iter().all(|t| t.id != created.id));
    assert!(count(&h.a.db, "SELECT COUNT(*) FROM sync_notices WHERE kind = 'discard-after-delete'") > 0);
}

#[test]
fn same_named_labels_converge_to_one_record_on_both_machines() {
    let h = Harness::new();
    h.a.db.create_todo_label(&CreateTodoLabelInput { name: "bug".into(), color: Some("#f7768e".into()) }).unwrap();
    h.b.db.create_todo_label(&CreateTodoLabelInput { name: "bug".into(), color: Some("#9ece6a".into()) }).unwrap();

    h.sync(&h.a);
    h.sync(&h.b);
    h.sync(&h.a);

    for dev in [&h.a, &h.b] {
        let n = dev.db.list_todo_labels().unwrap().iter().filter(|l| l.name.to_lowercase() == "bug").count();
        assert_eq!(n, 1);
    }
}

#[test]
fn a_project_reorder_propagates() {
    let h = Harness::new();
    let p1 = h.a.db.create_todo_project(&CreateTodoProjectInput { name: "Alpha".into(), color: None }).unwrap();
    let p2 = h.a.db.create_todo_project(&CreateTodoProjectInput { name: "Beta".into(), color: None }).unwrap();
    h.sync(&h.b);

    h.a.db.reorder_todo_projects(&[p2.id, p1.id]).unwrap();
    h.sync(&h.b);

    let on_b = h.b.db.list_todo_projects().unwrap();
    let beta = on_b.iter().find(|p| p.name == "Beta").unwrap();
    let alpha = on_b.iter().find(|p| p.name == "Alpha").unwrap();
    assert!(beta.position < alpha.position);
}

// --- B-1, B-5, FR-020 ---

#[test]
fn an_unknown_field_name_is_skipped_not_injected_and_never_fatal() {
    let h = Harness::new();
    let created = h.a.db.create_todo(&new("Original title")).unwrap();
    h.sync(&h.b);
    let row_uuid = uuid_of(&h.a.db, "todos", created.id);

    let hlc = json!({ "physicalMs": lizmeter_sync::hlc::now_ms(), "counter": 0, "deviceNumber": 1 });
    append_raw(
        &h.oplog_path(&h.a),
        &[json!({
            "v": 1, "opId": "malicious-field-entry", "hlc": hlc, "table": "todos", "op": "upsert", "rowUuid": row_uuid,
            "fields": {
                "title": { "value": "Legit concurrent title", "hlc": hlc },
                "notes = 'pwned', title": { "value": "malicious", "hlc": hlc },
            },
        })],
    );

    run_merge_pass(h.b.db.conn(), &h.shared, &h.b.device_id).unwrap();

    let on_b = todos(&h.b.db).into_iter().find(|t| t.id == created.id).unwrap();
    assert_eq!(on_b.title, "Legit concurrent title");
    assert_eq!(on_b.notes, None);
}

#[test]
fn an_entry_whose_dependency_has_not_arrived_is_retried_not_lost() {
    let h = Harness::new();
    let label = h.a.db.create_todo_label(&CreateTodoLabelInput { name: "urgent".into(), color: None }).unwrap();
    h.sync(&h.b);
    let label_uuid = uuid_of(&h.a.db, "todo_labels", label.id);
    let todo_uuid = "11111111-1111-1111-1111-111111111111";

    // The link's own todo arrives only in a LATER pass, so one batch cannot resolve the link: it must
    // stay unmarked and be reconsidered on the next pass.
    let link_line = json!({ "v": 1, "opId": "early-link", "hlc": { "physicalMs": 1000, "counter": 0, "deviceNumber": 1 },
                            "table": "todo_label_links", "op": "link",
                            "fields": { "fromUuid": todo_uuid, "toUuid": label_uuid } });
    let todo_line = json!({ "v": 1, "opId": "late-todo-upsert", "hlc": { "physicalMs": 2000, "counter": 0, "deviceNumber": 1 },
                            "table": "todos", "op": "upsert", "rowUuid": todo_uuid,
                            "fields": { "title": { "value": "Arrived after its own link",
                                                   "hlc": { "physicalMs": 2000, "counter": 0, "deviceNumber": 1 } } } });
    append_raw(&h.oplog_path(&h.a), &[link_line]);

    let linked = |db: &Database| -> bool {
        query_opt::<i64>(
            db,
            "SELECT 1 FROM todo_label_links k INNER JOIN todos t ON t.id = k.todo_id WHERE t.uuid = ?",
            [todo_uuid],
        )
        .is_some()
    };
    let applied = |db: &Database| -> bool {
        query_opt::<i64>(db, "SELECT 1 FROM sync_applied_ops WHERE op_id = 'early-link'", []).is_some()
    };

    h.sync(&h.b);
    assert!(!applied(&h.b.db));
    assert!(!linked(&h.b.db));

    append_raw(&h.oplog_path(&h.a), &[todo_line]);
    h.sync(&h.b);
    assert!(find(&h.b.db, "Arrived after its own link").is_some());
    assert!(linked(&h.b.db));
    assert!(applied(&h.b.db));
}

fn raw_line(op_id: &str, physical_ms: i64, extra: serde_json::Value) -> serde_json::Value {
    let mut v = json!({ "v": 1, "opId": op_id, "hlc": { "physicalMs": physical_ms, "counter": 0, "deviceNumber": 1 } });
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    v
}

fn label_link_exists(db: &Database, todo_uuid: &str) -> bool {
    query_opt::<i64>(
        db,
        "SELECT 1 FROM todo_label_links k INNER JOIN todos t ON t.id = k.todo_id WHERE t.uuid = ?",
        [todo_uuid],
    )
    .is_some()
}

#[test]
fn a_label_link_that_sorts_before_its_todo_in_the_same_batch_resolves_within_that_pass() {
    let h = Harness::new();
    let label = h.a.db.create_todo_label(&CreateTodoLabelInput { name: "same-batch".into(), color: None }).unwrap();
    h.sync(&h.b);
    let label_uuid = uuid_of(&h.a.db, "todo_labels", label.id);
    let todo_uuid = "22222222-2222-2222-2222-222222222222";
    append_raw(
        &h.oplog_path(&h.a),
        &[
            raw_line("same-batch-link", 1000, json!({ "table": "todo_label_links", "op": "link",
                     "fields": { "fromUuid": todo_uuid, "toUuid": label_uuid } })),
            raw_line("same-batch-todo", 2000, json!({ "table": "todos", "op": "upsert", "rowUuid": todo_uuid,
                     "fields": { "title": { "value": "same batch",
                                            "hlc": { "physicalMs": 2000, "counter": 0, "deviceNumber": 1 } } } })),
        ],
    );

    h.sync(&h.b);

    assert!(label_link_exists(&h.b.db, todo_uuid));
    assert!(query_opt::<i64>(&h.b.db, "SELECT 1 FROM sync_applied_ops WHERE op_id = 'same-batch-link'", []).is_some());
}

#[test]
fn a_deferred_link_is_not_replayed_over_a_later_unlink_of_the_same_pair_in_the_same_batch() {
    let h = Harness::new();
    let label = h.a.db.create_todo_label(&CreateTodoLabelInput { name: "unlinked".into(), color: None }).unwrap();
    h.sync(&h.b);
    let label_uuid = uuid_of(&h.a.db, "todo_labels", label.id);
    let todo_uuid = "33333333-3333-3333-3333-333333333333";
    append_raw(
        &h.oplog_path(&h.a),
        &[
            raw_line("lk-link", 1000, json!({ "table": "todo_label_links", "op": "link",
                     "fields": { "fromUuid": todo_uuid, "toUuid": label_uuid } })),
            raw_line("lk-todo", 2000, json!({ "table": "todos", "op": "upsert", "rowUuid": todo_uuid,
                     "fields": { "title": { "value": "link then unlink",
                                            "hlc": { "physicalMs": 2000, "counter": 0, "deviceNumber": 1 } } } })),
            raw_line("lk-unlink", 3000, json!({ "table": "todo_label_links", "op": "unlink",
                     "fields": { "fromUuid": todo_uuid, "toUuid": label_uuid } })),
        ],
    );

    h.sync(&h.b);

    assert!(!label_link_exists(&h.b.db, todo_uuid));
}

#[test]
fn a_future_schema_version_is_skipped_not_fatal() {
    let h = Harness::new();
    let t1 = h.a.db.create_todo(&new("Known-good entry")).unwrap();
    let hlc = json!({ "physicalMs": lizmeter_sync::hlc::now_ms(), "counter": 0, "deviceNumber": 1 });
    append_raw(
        &h.oplog_path(&h.a),
        &[json!({ "v": 999, "opId": "future-entry", "hlc": hlc, "table": "todos", "op": "upsert",
                  "rowUuid": "unknown-row", "fields": { "title": { "value": "from the future", "hlc": hlc } } })],
    );

    h.sync(&h.b);

    assert_eq!(todos(&h.b.db).into_iter().find(|t| t.id == t1.id).unwrap().title, "Known-good entry");
}

#[test]
fn two_offline_machines_converge_on_one_number_each_without_coordinating() {
    let h = Harness::new();
    assert_eq!(get_or_assign_device_number(h.a.db.conn(), Some(&h.shared)).unwrap(), 0);
    let a_first = h.a.db.create_todo(&new("A's first todo")).unwrap();
    h.sync(&h.b);
    let b_number = get_or_assign_device_number(h.b.db.conn(), Some(&h.shared)).unwrap();
    assert_ne!(b_number, 0);

    let a_ids: Vec<i64> = (0..5).map(|i| h.a.db.create_todo(&new(&format!("A todo {i}"))).unwrap().id).collect();
    let b_ids: Vec<i64> = (0..5).map(|i| h.b.db.create_todo(&new(&format!("B todo {i}"))).unwrap().id).collect();
    assert!(a_ids.iter().any(|id| b_ids.contains(id)), "offline machines claim overlapping numbers");
    assert!(a_ids.iter().chain(&b_ids).all(|id| *id < 10_000));

    h.sync(&h.b);
    h.sync(&h.a);
    h.sync(&h.b);

    let ids_on_a: Vec<i64> = todos(&h.a.db).iter().map(|t| t.id).collect();
    assert_eq!(ids_on_a.iter().collect::<std::collections::HashSet<_>>().len(), ids_on_a.len());

    let mut titles: Vec<String> = todos(&h.a.db).iter().map(|t| t.title.clone()).collect();
    titles.sort();
    let mut expected: Vec<String> = vec!["A's first todo".into()];
    expected.extend((0..5).map(|i| format!("A todo {i}")));
    expected.extend((0..5).map(|i| format!("B todo {i}")));
    expected.sort();
    assert_eq!(titles, expected);
    assert_eq!(a_first.title, "A's first todo");
    assert_eq!(id_titles(&h.a.db), id_titles(&h.b.db));
}

// --- dense sequential allocation / collision resolution ---

#[test]
fn ids_on_a_synced_machine_are_small_and_sequential() {
    let h = Harness::new();
    let first = h.a.db.create_todo(&new("One")).unwrap();
    let second = h.a.db.create_todo(&new("Two")).unwrap();
    let third = h.a.db.create_todo(&new("Three")).unwrap();
    assert!(first.id < 10_000);
    assert_eq!(second.id, first.id + 1);
    assert_eq!(third.id, second.id + 1);
    assert!(h.b.db.create_todo(&new("From B")).unwrap().id < 10_000);
}

#[test]
fn both_machines_creating_while_apart_converge_on_one_id_per_todo() {
    let h = Harness::new();
    h.a.db.create_todo(&new("Made on A")).unwrap();
    h.b.db.create_todo(&new("Made on B")).unwrap();

    for dev in [&h.a, &h.b, &h.a, &h.b] {
        h.sync(dev);
    }

    assert_eq!(id_titles(&h.a.db), id_titles(&h.b.db));
    let mut titles: Vec<String> = todos(&h.a.db).iter().map(|t| t.title.clone()).collect();
    titles.sort();
    assert_eq!(titles, vec!["Made on A", "Made on B"]);
    assert!(todos(&h.a.db).iter().all(|t| t.id < 10_000));
}

#[test]
fn the_merge_commits_rather_than_throwing_when_an_incoming_id_is_taken() {
    let h = Harness::new();
    h.a.db.create_todo(&new("Made on A")).unwrap();
    h.b.db.create_todo(&new("Made on B")).unwrap();
    let result = h.sync(&h.a);
    assert!(result.applied > 0);
    assert_eq!(todos(&h.a.db).len(), 2);
}

#[test]
fn a_whole_batch_of_collisions_after_a_long_offline_window_loses_none() {
    let h = Harness::new();
    for i in 0..6 {
        h.a.db.create_todo(&new(&format!("A-{i}"))).unwrap();
    }
    for i in 0..5 {
        h.b.db.create_todo(&new(&format!("B-{i}"))).unwrap();
    }
    for dev in [&h.a, &h.b, &h.a, &h.b] {
        h.sync(dev);
    }
    assert_eq!(todos(&h.a.db).len(), 11);
    assert_eq!(todos(&h.b.db).len(), 11);
    assert_eq!(id_titles(&h.a.db), id_titles(&h.b.db));
}

#[test]
fn convergence_is_stable_not_just_eventual() {
    let h = Harness::new();
    for i in 0..6 {
        h.a.db.create_todo(&new(&format!("A-{i}"))).unwrap();
    }
    for i in 0..5 {
        h.b.db.create_todo(&new(&format!("B-{i}"))).unwrap();
    }
    h.sync(&h.a);
    h.sync(&h.b);
    h.sync(&h.a);
    let settled = id_titles(&h.a.db);
    assert_eq!(settled, id_titles(&h.b.db));

    for _ in 0..4 {
        h.sync(&h.a);
        h.sync(&h.b);
    }
    assert_eq!(id_titles(&h.a.db), settled);
    assert_eq!(id_titles(&h.b.db), settled);
}

#[test]
fn an_uncontested_todos_number_never_moves() {
    let h = Harness::new();
    let only = h.a.db.create_todo(&new("Uncontested")).unwrap();
    for _ in 0..5 {
        h.sync(&h.b);
        h.sync(&h.a);
    }
    assert_eq!(find(&h.a.db, "Uncontested").unwrap().id, only.id);
}

#[test]
fn the_watermark_advances_on_merge() {
    let h = Harness::new();
    for i in 0..4 {
        h.a.db.create_todo(&new(&format!("A-{i}"))).unwrap();
    }
    h.sync(&h.b);
    let highest = todos(&h.b.db).iter().map(|t| t.id).max().unwrap();
    assert!(h.b.db.create_todo(&new("B after catching up")).unwrap().id > highest);
}

#[test]
fn parent_references_follow_a_todo_across_an_id_bump() {
    let h = Harness::new();
    let parent = h.b.db.create_todo(&new("Parent on B")).unwrap();
    h.b.db.create_todo(&CreateTodoInput { parent_id: Some(parent.id), ..new("Child on B") }).unwrap();
    for i in 0..3 {
        h.a.db.create_todo(&new(&format!("A-{i}"))).unwrap();
    }
    for dev in [&h.a, &h.b, &h.a, &h.b] {
        h.sync(dev);
    }
    for dev in [&h.a, &h.b] {
        let child = find(&dev.db, "Child on B").unwrap();
        let parent = find(&dev.db, "Parent on B").unwrap();
        assert_eq!(child.parent_id, Some(parent.id));
    }
}

#[test]
fn a_reassignment_is_reported_on_the_machine_whose_todo_moved() {
    let h = Harness::new();
    h.a.db.create_todo(&new("Made on A")).unwrap();
    let on_b = h.b.db.create_todo(&new("Made on B")).unwrap();

    h.sync(&h.b);

    let detail: String = query_one(
        &h.b.db,
        "SELECT detail FROM sync_notices WHERE kind = 'todo-id-reassigned' ORDER BY id LIMIT 1",
    );
    assert!(detail.contains(&format!("old id {}", on_b.id)));
}

#[test]
fn nothing_is_reported_where_nothing_the_user_saw_changed() {
    let h = Harness::new();
    h.a.db.create_todo(&new("Made on A")).unwrap();
    h.b.db.create_todo(&new("Made on B")).unwrap();
    h.sync(&h.a);
    assert_eq!(count(&h.a.db, "SELECT COUNT(*) FROM sync_notices WHERE kind = 'todo-id-reassigned'"), 0);
}

#[test]
fn a_deleted_todos_number_is_not_handed_to_a_new_todo() {
    let h = Harness::new();
    let first = h.a.db.create_todo(&new("Doomed")).unwrap();
    h.a.db.delete_todo(first.id).unwrap();
    assert!(h.a.db.create_todo(&new("Successor")).unwrap().id > first.id);
}

// --- raw boolean field values from a peer on an older build ---

#[test]
fn a_peer_published_raw_boolean_merges_without_a_bind_type_crash() {
    let h = Harness::new();
    let row_uuid = "11111111-2222-3333-4444-555555555555";
    let device_number = get_or_assign_device_number(h.a.db.conn(), None).unwrap();
    let hlc = tick(h.a.db.conn(), device_number).unwrap();
    let created_at = chrono_iso(hlc.physical_ms);
    let entry = build_upsert_entry(
        hlc,
        "todo_states",
        row_uuid,
        FieldMap::with_hlc(
            [
                ("label", json!("Staged")),
                ("color", json!("#7aa2f7")),
                ("is_completed", json!(false)),
                ("is_default", json!(false)),
                ("created_at", json!(created_at)),
            ],
            hlc,
        ),
    );
    append_oplog_entry(&h.shared, &h.a.device_id, &entry).unwrap();

    h.sync(&h.b);

    let staged = h.b.db.list_todo_states().unwrap().into_iter().find(|s| s.label == "Staged").unwrap();
    assert!(!staged.is_completed);
    assert!(!staged.is_default);
}

fn chrono_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

#[test]
fn a_raw_true_binds_as_one_in_the_row() {
    let h = Harness::new();
    let state = h.a.db.create_todo_state(&lizmeter_core::CreateTodoStateInput {
        label: "Verified".into(),
        color: Some("#9ece6a".into()),
    })
    .unwrap();
    let uuid = uuid_of(&h.a.db, "todo_states", state.id);
    let device_number = get_or_assign_device_number(h.a.db.conn(), None).unwrap();
    let hlc = tick(h.a.db.conn(), device_number).unwrap();
    let entry = build_upsert_entry(hlc, "todo_states", &uuid, FieldMap::with_hlc([("is_completed", json!(true))], hlc));

    apply_oplog_entries(h.a.db.conn(), &[entry]).unwrap();

    let stored: i64 =
        query_one(&h.a.db, &format!("SELECT is_completed FROM todo_states WHERE id = {}", state.id));
    assert_eq!(stored, 1);
}

// --- skipped-entry observability ---

#[test]
fn each_distinct_skipped_count_is_reported_once_without_halting() {
    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("shared");
    let dir = get_sync_devices_dir(&shared);
    std::fs::create_dir_all(&dir).unwrap();
    let peer = dir.join("11111111-1111-1111-1111-111111111111.oplog.jsonl");
    let db = Database::open_in_memory().unwrap();
    let me = "22222222-2222-2222-2222-222222222222";

    std::fs::write(
        &peer,
        format!(
            "not json\n{}",
            json!({ "v": 2, "opId": "future-entry", "hlc": { "physicalMs": 1, "counter": 0, "deviceNumber": 1 },
                    "table": "todos", "rowUuid": "future-row", "op": "delete" })
        ),
    )
    .unwrap();

    run_merge_pass(db.conn(), &shared, me).unwrap();
    let rows = |db: &Database| -> Vec<(String, String)> {
        let mut stmt = db
            .conn()
            .prepare("SELECT message, detail FROM sync_notices WHERE kind = 'oplog-entry-skipped' ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(
        rows(&db),
        vec![(
            "2 entries in a peer sync log were skipped because this version of LizMeter could not read them."
                .to_string(),
            "11111111-1111-1111-1111-111111111111.oplog.jsonl: 2 skipped".to_string(),
        )]
    );

    run_merge_pass(db.conn(), &shared, me).unwrap();
    assert_eq!(rows(&db).len(), 1);

    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(&peer).unwrap().write_all(b"\nstill not json").unwrap();
    run_merge_pass(db.conn(), &shared, me).unwrap();

    let all = rows(&db);
    assert_eq!(all.len(), 2);
    assert_eq!(
        all[1],
        (
            "3 entries in a peer sync log were skipped because this version of LizMeter could not read them."
                .to_string(),
            "11111111-1111-1111-1111-111111111111.oplog.jsonl: 3 skipped".to_string(),
        )
    );
}

// --- deferred foreign keys ---

#[test]
fn foreign_keys_are_enforced() {
    let db = Database::open_in_memory().unwrap();
    let on: i64 = db.conn().query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(on, 1);
}

#[test]
fn an_id_move_that_orphans_a_child_is_rejected_unless_deferred_together() {
    let db = Database::open_in_memory().unwrap();
    let c = db.conn();
    c.execute_batch(
        "CREATE TABLE probe_parent (id INTEGER PRIMARY KEY);
         CREATE TABLE probe_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES probe_parent(id));
         INSERT INTO probe_parent (id) VALUES (1);
         INSERT INTO probe_child (id, parent_id) VALUES (10, 1);",
    )
    .unwrap();
    assert!(c.execute("UPDATE probe_parent SET id = 2 WHERE id = 1", []).is_err());

    c.execute_batch("BEGIN").unwrap();
    c.pragma_update(None, "defer_foreign_keys", "ON").unwrap();
    c.execute("UPDATE probe_parent SET id = 77 WHERE id = 1", []).unwrap();
    c.execute("UPDATE probe_child SET parent_id = 77 WHERE parent_id = 1", []).unwrap();
    c.execute_batch("COMMIT").unwrap();
    let parent: i64 = c.query_row("SELECT parent_id FROM probe_child WHERE id = 10", [], |r| r.get(0)).unwrap();
    assert_eq!(parent, 77);

    c.execute_batch("BEGIN").unwrap();
    c.pragma_update(None, "defer_foreign_keys", "ON").unwrap();
    c.execute("UPDATE probe_parent SET id = 5 WHERE id = 77", []).unwrap();
    assert!(c.execute_batch("COMMIT").is_err(), "a genuinely inconsistent state still fails the commit");
    c.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn a_swap_of_two_claimed_numbers_completes_through_the_negative_phase() {
    // Port of the real-driver check in scripts/real-better-sqlite3-harness.ts.
    let db = Database::open_in_memory().unwrap();
    let c = db.conn();
    c.execute(
        "INSERT INTO todos (id, title, source, created_at, uuid, claimed_id) VALUES (1, 'Move to two', 'user', '2026-01-01T00:00:00.000Z', 'real-swap-a', 2)",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO todos (id, title, source, created_at, uuid, claimed_id) VALUES (2, 'Move to one', 'user', '2026-01-02T00:00:00.000Z', 'real-swap-b', 1)",
        [],
    )
    .unwrap();

    c.execute_batch("BEGIN").unwrap();
    assert_eq!(reconcile_todo_ids(c).unwrap(), 2);
    c.execute_batch("COMMIT").unwrap();

    let a: i64 = c.query_row("SELECT id FROM todos WHERE uuid = 'real-swap-a'", [], |r| r.get(0)).unwrap();
    let b: i64 = c.query_row("SELECT id FROM todos WHERE uuid = 'real-swap-b'", [], |r| r.get(0)).unwrap();
    assert_eq!((a, b), (2, 1));
    assert_eq!(count(&db, "SELECT COUNT(*) FROM todos WHERE id < 0"), 0);
}

#[test]
fn applied_entries_are_idempotent_by_op_id() {
    let h = Harness::new();
    h.a.db.create_tag(&lizmeter_core::CreateTagInput { name: "once".into(), color: "#7aa2f7".into() }).unwrap();
    let first = h.sync(&h.b);
    let second = h.sync(&h.b);
    assert!(first.applied > 0);
    assert_eq!(second.applied, 0);
    assert!(second.skipped_already_applied > 0);
}

#[test]
fn an_entry_round_trips_between_to_line_and_the_reader() {
    let hlc = Hlc { physical_ms: 5, counter: 1, device_number: 2 };
    let entry = build_upsert_entry(hlc, "todos", "u", FieldMap::with_hlc([("title", json!("x"))], hlc));
    let v: serde_json::Value = serde_json::from_str(&entry.to_line()).unwrap();
    assert_eq!(OplogEntry::from_value(&v).unwrap(), entry);
}

#[test]
fn a_pass_that_fails_midway_rolls_back_every_entry_and_marks_nothing_applied() {
    // The merge is one transaction: an entry that cannot bind (an object where a scalar belongs) must
    // not leave the entries before it applied, or a retry would double-apply them.
    let h = Harness::new();
    let good = build_upsert_entry(
        Hlc { physical_ms: 1000, counter: 0, device_number: 1 },
        "tags",
        "tag-good",
        FieldMap::with_hlc([("name", json!("good")), ("created_at", json!("2026-01-01T00:00:00.000Z"))], Hlc { physical_ms: 1000, counter: 0, device_number: 1 }),
    );
    let bad_hlc = Hlc { physical_ms: 2000, counter: 0, device_number: 1 };
    let bad = build_upsert_entry(
        bad_hlc,
        "tags",
        "tag-good",
        FieldMap::with_hlc([("color", json!({ "not": "a scalar" }))], bad_hlc),
    );

    assert!(apply_oplog_entries(h.a.db.conn(), &[good, bad]).is_err());

    assert_eq!(count(&h.a.db, "SELECT COUNT(*) FROM tags WHERE uuid = 'tag-good'"), 0);
    assert_eq!(count(&h.a.db, "SELECT COUNT(*) FROM sync_applied_ops"), 0);
    assert!(h.a.db.conn().is_autocommit());
}

// --- Drag-reorder positions (todo list drop, state and project lists) ---

/// `generateOrderedKeys(3)` from `electron/main/sync/lexorank.ts`, evaluated with bun.
const TS_ORDERED_KEYS_3: [&str; 3] = ["i", "r", "v"];

#[test]
fn a_reorder_stores_the_lexorank_keys_the_ts_code_generates_in_list_order() {
    let h = Harness::new();
    let mk = |n: &str| h.a.db.create_todo_project(&CreateTodoProjectInput { name: n.into(), color: None }).unwrap();
    let (p1, p2, p3) = (mk("Alpha"), mk("Beta"), mk("Gamma"));
    assert_eq!(h.a.db.list_todo_projects().unwrap().len(), 3);

    h.a.db.reorder_todo_projects(&[p3.id, p1.id, p2.id]).unwrap();

    let key_of = |id: i64| -> String {
        h.a.db.conn().query_row("SELECT sync_order FROM todo_projects WHERE id = ?", [id], |r| r.get(0)).unwrap()
    };
    assert_eq!([key_of(p3.id), key_of(p1.id), key_of(p2.id)], TS_ORDERED_KEYS_3.map(String::from));
    let names: Vec<String> = h.a.db.list_todo_projects().unwrap().into_iter().map(|p| p.name).collect();
    assert_eq!(names, ["Gamma", "Alpha", "Beta"]);

    h.sync(&h.b);
    let on_b: Vec<String> = h.b.db.list_todo_projects().unwrap().into_iter().map(|p| p.name).collect();
    assert_eq!(on_b, ["Gamma", "Alpha", "Beta"]);
}
