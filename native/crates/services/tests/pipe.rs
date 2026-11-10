//! Port of `electron/main/__tests__/pipe-server.test.ts`, plus real-pipe tests that never touch
//! the default pipe: every server here listens on a unique `lizmeter-test-*` path.

mod common;

use common::{rig, Rig};
use lizmeter_core::*;
use lizmeter_services::pipe::{Connection, Protocol, Wire, MAX_BUFFER_SIZE};
use serde_json::{json, Value};
use std::sync::Arc;

struct Harness {
    rig: Rig,
    proto: Arc<Protocol>,
}

fn harness() -> Harness {
    let rig = rig();
    let proto = Protocol::new(rig.svc.clone());
    Harness { rig, proto }
}

impl Harness {
    /// Runs one line through the protocol and returns the parsed reply, if any.
    fn send(&self, message: Value) -> Option<Value> {
        let mut replies: Vec<String> = Vec::new();
        self.proto.process_line(&message.to_string(), &mut |t| replies.push(t.to_string()));
        replies.first().map(|r| serde_json::from_str(r).unwrap())
    }

    fn todos(&self) -> Vec<Todo> {
        self.rig.svc.list_todos(&ListTodosInput::default()).unwrap()
    }

    fn add(&self, fields: Value) -> i64 {
        let mut msg = json!({ "id": 99, "type": "todo.add", "title": "x" });
        for (k, v) in fields.as_object().unwrap() {
            msg[k] = v.clone();
        }
        self.send(msg).unwrap()["result"]["todo"]["id"].as_i64().unwrap()
    }

    fn project(&self, name: &str) -> TodoProject {
        self.rig.svc.create_todo_project(&CreateTodoProjectInput { name: name.into(), color: None }).unwrap()
    }

    fn label(&self, name: &str) -> TodoLabel {
        self.rig.svc.create_todo_label(&CreateTodoLabelInput { name: name.into(), color: None }).unwrap()
    }
}

fn error(reply: &Option<Value>) -> String {
    reply.as_ref().unwrap()["error"].as_str().unwrap_or("").to_string()
}

fn ok(reply: &Option<Value>) -> bool {
    reply.as_ref().unwrap()["ok"].as_bool().unwrap()
}

/// A connection stand-in for driving `Connection` without a pipe.
#[derive(Default)]
struct FakeWire {
    written: Vec<String>,
    ended: bool,
    writable: bool,
}

impl FakeWire {
    fn new() -> Self {
        FakeWire { writable: true, ..Default::default() }
    }
}

impl Wire for FakeWire {
    fn write(&mut self, text: &str) {
        if self.writable {
            self.written.push(text.to_string());
        }
    }
    fn end(&mut self) {
        self.ended = true;
        self.writable = false;
    }
    fn writable(&self) -> bool {
        self.writable
    }
}

// --- Legacy Neovim payloads ---

#[test]
fn legacy_payload_records_activity_and_sends_no_reply() {
    let h = harness();
    assert!(h.send(json!({ "project": "LizMeter", "file": "src/app.ts" })).is_none());
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert_eq!(h.rig.svc.list_nvim_activity_by_date(&today).unwrap().records.len(), 1);
}

#[test]
fn invalid_legacy_payload_is_ignored_without_a_reply() {
    let h = harness();
    assert!(h.send(json!({ "project": "", "file": "" })).is_none());
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert_eq!(h.rig.svc.list_nvim_activity_by_date(&today).unwrap().records.len(), 0);
}

#[test]
fn legacy_duplicate_within_a_minute_is_skipped() {
    let h = harness();
    h.send(json!({ "project": "P", "file": "f.rs" }));
    h.send(json!({ "project": " P ", "file": "f.rs" }));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert_eq!(h.rig.svc.list_nvim_activity_by_date(&today).unwrap().records.len(), 1);
}

#[test]
fn legacy_payload_is_not_a_command() {
    let h = harness();
    h.send(json!({ "project": "LizMeter", "file": "src/app.ts" }));
    assert_eq!(h.todos().len(), 0);
}

// --- Malformed input ---

fn raw(h: &Harness, line: &str) -> Vec<String> {
    let mut replies = Vec::new();
    h.proto.process_line(line, &mut |t| replies.push(t.to_string()));
    replies
}

#[test]
fn malformed_json_scalars_and_null_are_discarded_silently() {
    let h = harness();
    assert!(raw(&h, "{not json").is_empty());
    assert!(raw(&h, "42").is_empty());
    assert!(raw(&h, "null").is_empty());
}

#[test]
fn malformed_json_is_counted_and_logged() {
    let h = harness();
    raw(&h, "{not valid json");
    let warnings = h.proto.warnings();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].starts_with("[pipe] Discarding malformed JSON (#1): "));
    raw(&h, "{again");
    assert!(h.proto.warnings()[1].contains("(#2)"));
}

#[test]
fn long_malformed_payload_is_truncated_in_the_log() {
    let h = harness();
    let junk = format!("{{{}", "x".repeat(5000));
    raw(&h, &junk);
    let logged = h.proto.warnings().pop().unwrap();
    assert!(logged.len() < junk.len());
    assert!(logged.ends_with("..."));
}

// --- Reply framing ---

#[test]
fn reply_echoes_the_id_and_ends_with_a_newline() {
    let h = harness();
    let replies = raw(&h, r#"{"id":77,"type":"ping"}"#);
    assert_eq!(replies, vec!["{\"id\":77,\"ok\":true,\"result\":{\"pong\":true}}\n".to_string()]);
}

#[test]
fn id_forms_are_echoed_like_json_stringify() {
    let h = harness();
    assert_eq!(raw(&h, r#"{"id":1.0,"type":"ping"}"#)[0], "{\"id\":1,\"ok\":true,\"result\":{\"pong\":true}}\n");
    assert_eq!(raw(&h, r#"{"id":"a","type":"ping"}"#)[0], "{\"id\":\"a\",\"ok\":true,\"result\":{\"pong\":true}}\n");
    assert_eq!(raw(&h, r#"{"id":null,"type":"ping"}"#)[0], "{\"id\":null,\"ok\":true,\"result\":{\"pong\":true}}\n");
}

#[test]
fn no_reply_for_a_command_without_an_id() {
    let h = harness();
    assert!(h.send(json!({ "type": "ping" })).is_none());
}

#[test]
fn unknown_command_is_a_failed_reply_and_is_logged() {
    let h = harness();
    let reply = h.send(json!({ "id": 2, "type": "todo.explode" }));
    assert!(!ok(&reply));
    assert_eq!(error(&reply), "Unknown command type: todo.explode");
    assert!(h.proto.warnings().iter().any(|w| w.starts_with("[pipe]") && w.contains("todo.explode")));
}

#[test]
fn rejected_command_without_an_id_is_still_logged() {
    let h = harness();
    assert!(h.send(json!({ "type": "todo.explode" })).is_none());
    assert!(h.proto.warnings().iter().any(|w| w.starts_with("[pipe]") && w.contains("todo.explode")));
}

// --- todo.add ---

#[test]
fn add_creates_a_todo_tagged_ai_with_agent_and_notes() {
    let h = harness();
    let reply = h.send(json!({ "id": 1, "type": "todo.add", "title": "From the agent", "agent": "claude-code", "notes": "some detail" }));
    assert!(ok(&reply));
    assert_eq!(reply.unwrap()["result"]["todo"]["title"], "From the agent");
    let todos = h.todos();
    assert_eq!(todos.len(), 1);
    assert_eq!(todos[0].source, TodoSource::Ai);
    assert_eq!(todos[0].source_label.as_deref(), Some("claude-code"));
    assert_eq!(todos[0].notes.as_deref(), Some("some detail"));
}

#[test]
fn add_without_a_title_fails_and_writes_nothing() {
    let h = harness();
    let reply = h.send(json!({ "id": 1, "type": "todo.add" }));
    assert!(!ok(&reply));
    assert_eq!(error(&reply), "Todo title must be a non-empty string");
    assert_eq!(h.todos().len(), 0);
}

#[test]
fn a_write_counts_as_a_change_and_a_read_does_not() {
    let h = harness();
    let counter = h.proto.change_counter();
    h.send(json!({ "id": 1, "type": "todo.list" }));
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 0);
    h.send(json!({ "id": 2, "type": "todo.add", "title": "a" }));
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
    // A write that fails may still have changed the screen, so it counts too.
    h.send(json!({ "id": 3, "type": "todo.add" }));
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 2);
}

// --- Stale-write guard ---

#[test]
fn list_hands_out_each_todos_uuid() {
    let h = harness();
    h.send(json!({ "id": 1, "type": "todo.add", "title": "a" }));
    let reply = h.send(json!({ "id": 2, "type": "todo.list" })).unwrap();
    let uuid = reply["result"]["todos"][0]["uuid"].as_str().unwrap();
    assert!(!uuid.is_empty());
}

#[test]
fn matching_identity_is_accepted_and_a_stale_one_refused() {
    let h = harness();
    let id = h.add(json!({ "title": "a" }));
    let listed = h.send(json!({ "id": 2, "type": "todo.list" })).unwrap();
    let uuid = listed["result"]["todos"][0]["uuid"].as_str().unwrap().to_string();

    let good = h.send(json!({ "id": 3, "type": "todo.update", "todoId": id, "expectUuid": uuid, "title": "b" }));
    assert_eq!(good.unwrap()["result"]["todo"]["title"], "b");

    let stale = h.send(json!({ "id": 4, "type": "todo.update", "todoId": id, "expectUuid": "00000000-0000-0000-0000-000000000000", "title": "no" }));
    assert!(error(&stale).contains("renumbered"));
    assert_eq!(h.todos()[0].title, "b");

    let stale_complete = h.send(json!({ "id": 5, "type": "todo.complete", "todoId": id, "expectUuid": "00000000-0000-0000-0000-000000000000" }));
    assert!(error(&stale_complete).contains("renumbered"));
}

#[test]
fn a_caller_with_no_identity_keeps_working() {
    let h = harness();
    let id = h.add(json!({ "title": "a" }));
    let reply = h.send(json!({ "id": 2, "type": "todo.update", "todoId": id, "title": "b" }));
    assert_eq!(reply.unwrap()["result"]["todo"]["title"], "b");
}

// --- todo.list ---

#[test]
fn list_returns_all_honours_a_filter_and_falls_back_for_a_bogus_one() {
    let h = harness();
    h.send(json!({ "id": 1, "type": "todo.add", "title": "a" }));
    let b = h.add(json!({ "title": "b" }));
    h.send(json!({ "id": 3, "type": "todo.complete", "todoId": b }));

    let all = h.send(json!({ "id": 4, "type": "todo.list" })).unwrap();
    assert_eq!(all["result"]["todos"].as_array().unwrap().len(), 2);

    let active = h.send(json!({ "id": 5, "type": "todo.list", "filter": "active" })).unwrap();
    let titles: Vec<_> = active["result"]["todos"].as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap()).collect();
    assert_eq!(titles, vec!["a"]);

    let bogus = h.send(json!({ "id": 6, "type": "todo.list", "filter": "bogus" })).unwrap();
    assert_eq!(bogus["ok"], true);
    assert_eq!(bogus["result"]["todos"].as_array().unwrap().len(), 2);
}

// --- todo.complete / clear-completed ---

#[test]
fn complete_marks_done_and_rejects_bad_ids() {
    let h = harness();
    let id = h.add(json!({ "title": "finish me" }));
    assert!(ok(&h.send(json!({ "id": 2, "type": "todo.complete", "todoId": id }))));
    assert!(h.todos()[0].state.is_completed);

    let bad = h.send(json!({ "id": 1, "type": "todo.complete", "todoId": "abc" }));
    assert!(error(&bad).contains("integer 'todoId'"));
    let missing = h.send(json!({ "id": 1, "type": "todo.complete", "todoId": 9999 }));
    assert!(error(&missing).contains("not found"));
}

#[test]
fn clear_completed_removes_and_reports_the_count() {
    let h = harness();
    let a = h.add(json!({ "title": "a" }));
    h.add(json!({ "title": "b" }));
    h.send(json!({ "id": 3, "type": "todo.complete", "todoId": a }));
    let reply = h.send(json!({ "id": 4, "type": "todo.clear-completed" })).unwrap();
    assert_eq!(reply["result"], json!({ "removed": 1 }));
    assert_eq!(h.todos().len(), 1);
}

// --- Extended fields ---

#[test]
fn add_stores_project_milestone_and_dates_and_resolves_names_case_insensitively() {
    let h = harness();
    h.project("LizMeter");
    h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "project": "lizmeter", "milestone": "v1.14", "startDate": "2026-08-25", "dueDate": "2026-08-30" }));
    let t = &h.todos()[0];
    assert_eq!(t.project.as_ref().unwrap().name, "LizMeter");
    assert_eq!(t.milestone.as_deref(), Some("v1.14"));
    assert_eq!(t.start_date.as_deref(), Some("2026-08-25"));
    assert_eq!(t.due_date.as_deref(), Some("2026-08-30"));
}

#[test]
fn add_rejects_unknown_project_with_the_valid_list_or_says_none_exist() {
    let h = harness();
    let none = h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "project": "Nope" }));
    assert!(error(&none).contains("No projects exist yet"));
    h.project("LizMeter");
    let some = h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "project": "Nope" }));
    assert!(error(&some).contains("Valid projects: LizMeter"));
    assert_eq!(h.todos().len(), 0);
}

#[test]
fn add_attaches_labels_by_name_and_rejects_unknown_ones() {
    let h = harness();
    h.label("bug");
    h.label("ui");
    h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "labels": ["ui", "BUG"] }));
    let names: Vec<_> = h.todos()[0].labels.iter().map(|l| l.name.clone()).collect();
    assert_eq!(names, vec!["bug", "ui"]);
    let bad = h.send(json!({ "id": 2, "type": "todo.add", "title": "x", "labels": ["nope"] }));
    assert!(error(&bad).contains("Valid labels: bug, ui"));
}

#[test]
fn add_state_resolution() {
    let h = harness();
    h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "state": "processing" }));
    assert_eq!(h.todos()[0].state.label, "Processing");
    h.send(json!({ "id": 2, "type": "todo.add", "title": "y" }));
    assert!(h.todos().iter().any(|t| t.title == "y" && t.state.label == "Todo"));

    let bad = h.send(json!({ "id": 3, "type": "todo.add", "title": "z", "state": "inprogress" }));
    let message = error(&bad);
    assert!(message.contains("Unknown state 'inprogress'"));
    assert!(message.contains("Backlog") && message.contains("Deprecated"));
    assert_eq!(h.todos().len(), 2);
}

#[test]
fn add_rejects_malformed_and_reversed_dates() {
    let h = harness();
    let bad = h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "dueDate": "30-08-2026" }));
    assert!(error(&bad).contains("YYYY-MM-DD"));
    let reversed = h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "startDate": "2026-08-30", "dueDate": "2026-08-25" }));
    assert!(error(&reversed).contains("must not be after"));
}

#[test]
fn add_field_type_errors_use_the_electron_wording() {
    let h = harness();
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "notes": 5 }))), "'notes' must be a string or null");
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "priority": 1.5 }))), "'priority' must be an integer or null");
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "state": "  " }))), "'state' must be a non-empty string");
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "labels": "bug" }))), "'labels' must be an array of label names");
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "labels": [""] }))), "'labels' must contain non-empty strings");
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.add", "title": "x", "project": 3 }))), "'project' must be a non-empty string or null");
}

// --- todo.update ---

#[test]
fn update_changes_only_the_fields_passed_and_clears_with_null() {
    let h = harness();
    h.project("LizMeter");
    let id = h.add(json!({ "title": "original" }));
    h.send(json!({ "id": 2, "type": "todo.update", "todoId": id, "project": "LizMeter" }));
    assert_eq!(h.todos()[0].title, "original");
    assert_eq!(h.todos()[0].project.as_ref().unwrap().name, "LizMeter");
    h.send(json!({ "id": 3, "type": "todo.update", "todoId": id, "project": null }));
    assert!(h.todos()[0].project.is_none());
}

#[test]
fn update_moves_states_replaces_labels_and_stamps_completion() {
    let h = harness();
    h.label("bug");
    h.label("ui");
    let id = h.add(json!({ "title": "original" }));
    assert!(ok(&h.send(json!({ "id": 2, "type": "todo.update", "todoId": id, "state": "Testing" }))));
    assert_eq!(h.todos()[0].state.label, "Testing");

    h.send(json!({ "id": 3, "type": "todo.update", "todoId": id, "labels": ["bug"] }));
    h.send(json!({ "id": 4, "type": "todo.update", "todoId": id, "labels": ["ui"] }));
    let names: Vec<_> = h.todos()[0].labels.iter().map(|l| l.name.clone()).collect();
    assert_eq!(names, vec!["ui"]);

    h.send(json!({ "id": 5, "type": "todo.update", "todoId": id, "state": "Done" }));
    assert!(h.todos()[0].state.is_completed);
    assert!(h.todos()[0].completed_at.is_some());
    h.send(json!({ "id": 6, "type": "todo.update", "todoId": id, "state": "Todo" }));
    assert!(h.todos()[0].completed_at.is_none());
}

#[test]
fn update_requires_an_integer_todo_id_and_reports_an_unknown_todo() {
    let h = harness();
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.update", "todoId": "abc", "title": "x" }))).contains("integer 'todoId'"));
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.update", "todoId": 9999, "title": "x" }))).contains("not found"));
}

// --- todo.list filters, paging, by id ---

#[test]
fn list_filters_by_project_label_and_state() {
    let h = harness();
    h.project("LizMeter");
    h.project("Other");
    h.label("bug");
    h.send(json!({ "id": 1, "type": "todo.add", "title": "a", "project": "LizMeter", "state": "Testing", "labels": ["bug"] }));
    h.send(json!({ "id": 2, "type": "todo.add", "title": "b", "project": "Other" }));
    let titles = |q: Value| -> Vec<String> {
        let r = h.send(q).unwrap();
        r["result"]["todos"].as_array().unwrap().iter().map(|t| t["title"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(titles(json!({ "id": 3, "type": "todo.list", "project": "LizMeter" })), vec!["a"]);
    assert_eq!(titles(json!({ "id": 3, "type": "todo.list", "label": "bug" })), vec!["a"]);
    assert_eq!(titles(json!({ "id": 3, "type": "todo.list", "state": "Testing" })), vec!["a"]);
    assert!(error(&h.send(json!({ "id": 3, "type": "todo.list", "project": "nope" }))).contains("Valid projects:"));
    assert!(error(&h.send(json!({ "id": 3, "type": "todo.list", "state": "nope" }))).contains("Valid states:"));
}

#[test]
fn complete_keys_off_the_flag_not_the_label() {
    let h = harness();
    let id = h.add(json!({ "title": "finish me" }));
    h.send(json!({ "id": 2, "type": "todo.state.rename", "name": "Done", "newName": "Shipped" }));
    assert!(ok(&h.send(json!({ "id": 3, "type": "todo.complete", "todoId": id }))));
    assert!(h.todos()[0].state.is_completed);
}

fn ids_of(reply: &Option<Value>) -> Vec<i64> {
    reply.as_ref().unwrap()["result"]["todos"].as_array().unwrap().iter().map(|t| t["id"].as_i64().unwrap()).collect()
}

#[test]
fn paging_caps_at_50_honours_limit_offset_and_survives_full_ties() {
    let h = harness();
    for i in 0..55 {
        h.send(json!({ "id": 1000 + i, "type": "todo.add", "title": format!("t{i}") }));
    }
    let r = h.send(json!({ "id": 1, "type": "todo.list" })).unwrap();
    assert_eq!(r["result"]["todos"].as_array().unwrap().len(), 50);
    assert_eq!(r["result"]["total"], 55);

    let full = ids_of(&h.send(json!({ "id": 2, "type": "todo.list", "limit": 100 })));
    let page = h.send(json!({ "id": 3, "type": "todo.list", "limit": 4, "offset": 4 }));
    assert_eq!(ids_of(&page), full[4..8].to_vec());

    // Every sort key before the id tiebreaker ties.
    h.rig.svc.with_db(|db| Ok(db.conn().execute_batch("UPDATE todos SET created_at = '2026-01-01T00:00:00.000Z'").unwrap())).unwrap();
    let full = ids_of(&h.send(json!({ "id": 4, "type": "todo.list", "limit": 100 })));
    let mut sorted = full.clone();
    sorted.sort();
    assert_eq!(full, sorted);
    let mut paged = Vec::new();
    for offset in (0..55).step_by(5) {
        paged.extend(ids_of(&h.send(json!({ "id": 5, "type": "todo.list", "limit": 5, "offset": offset }))));
    }
    assert_eq!(paged, full);
}

#[test]
fn paging_rejects_bad_limit_and_offset() {
    let h = harness();
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.list", "limit": "lots" }))).contains("'limit'"));
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.list", "limit": 0 }))).contains("'limit'"));
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.list", "offset": -1 }))).contains("'offset'"));
}

#[test]
fn list_by_id_returns_one_ignores_other_filters_and_names_a_missing_todo() {
    let h = harness();
    h.project("LizMeter");
    h.send(json!({ "id": 1, "type": "todo.add", "title": "a" }));
    let b = h.add(json!({ "title": "b" }));
    let one = h.send(json!({ "id": 3, "type": "todo.list", "todoId": b, "project": "LizMeter" })).unwrap();
    assert_eq!(one["ok"], true);
    assert_eq!(one["result"]["todos"].as_array().unwrap().len(), 1);
    assert_eq!(one["result"]["todos"][0]["title"], "b");
    assert_eq!(one["result"]["total"], 1);
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.list", "todoId": 9999 }))), "No todo #9999.");
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.list", "todoId": "x" }))), "'todoId' must be an integer");
}

// --- Taxonomy ---

#[test]
fn project_create_rename_delete() {
    let h = harness();
    assert!(ok(&h.send(json!({ "id": 1, "type": "todo.project.create", "name": "LizMeter" }))));
    assert_eq!(h.rig.svc.list_todo_projects().unwrap().len(), 1);
    assert!(ok(&h.send(json!({ "id": 2, "type": "todo.add", "title": "x", "project": "lizmeter" }))));

    let dup = h.send(json!({ "id": 1, "type": "todo.project.create", "name": "lizmeter" }));
    assert!(error(&dup).contains("already exists"));
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.project.create", "name": "  " }))).contains("'name' is required"));
    assert!(!ok(&h.send(json!({ "id": 1, "type": "todo.project.create", "name": "P2", "color": "#123456" }))));
    assert_eq!(h.rig.svc.list_todo_projects().unwrap().len(), 1);

    assert!(ok(&h.send(json!({ "id": 3, "type": "todo.project.rename", "name": "lizmeter", "newName": "New" }))));
    assert_eq!(h.todos()[0].project.as_ref().unwrap().name, "New");
    assert!(error(&h.send(json!({ "id": 3, "type": "todo.project.rename", "name": "Nope", "newName": "N" }))).contains("Valid projects: New"));
    assert!(error(&h.send(json!({ "id": 3, "type": "todo.project.rename", "name": "New" }))).contains("'newName' is required"));

    let refused = h.send(json!({ "id": 4, "type": "todo.project.delete", "name": "New" }));
    assert!(error(&refused).contains("still on 1 todo."));
    let done = h.send(json!({ "id": 5, "type": "todo.project.delete", "name": "New", "force": true })).unwrap();
    assert_eq!(done["result"], json!({ "name": "New", "detached": 1 }));
    assert_eq!(h.todos().len(), 1);
    assert!(h.todos()[0].project.is_none());

    h.project("Unused");
    let free = h.send(json!({ "id": 6, "type": "todo.project.delete", "name": "Unused" })).unwrap();
    assert_eq!(free["result"], json!({ "name": "Unused", "detached": 0 }));
}

#[test]
fn project_delete_counts_several_todos() {
    let h = harness();
    h.project("LizMeter");
    h.add(json!({ "project": "LizMeter" }));
    h.add(json!({ "project": "LizMeter" }));
    let refused = h.send(json!({ "id": 1, "type": "todo.project.delete", "name": "LizMeter" }));
    assert!(error(&refused).contains("still on 2 todos"));
    assert_eq!(h.rig.svc.list_todo_projects().unwrap().len(), 1);
}

#[test]
fn label_create_rename_delete() {
    let h = harness();
    let created = h.send(json!({ "id": 1, "type": "todo.label.create", "name": "bug" })).unwrap();
    assert_eq!(created["result"]["created"], true);
    let again = h.send(json!({ "id": 1, "type": "todo.label.create", "name": "BUG" })).unwrap();
    assert_eq!(again["ok"], true);
    assert_eq!(again["result"]["created"], false);
    assert_eq!(h.rig.svc.list_todo_labels().unwrap().len(), 1);

    h.add(json!({ "labels": ["bug"] }));
    assert!(ok(&h.send(json!({ "id": 2, "type": "todo.label.rename", "name": "bug", "newName": "defect" }))));
    assert_eq!(h.todos()[0].labels[0].name, "defect");
    assert!(error(&h.send(json!({ "id": 2, "type": "todo.label.rename", "name": "nope", "newName": "x" }))).contains("Valid labels: defect"));

    assert!(error(&h.send(json!({ "id": 3, "type": "todo.label.delete", "name": "defect" }))).contains("still on 1 todo."));
    let done = h.send(json!({ "id": 4, "type": "todo.label.delete", "name": "defect", "force": true })).unwrap();
    assert_eq!(done["result"], json!({ "name": "defect", "detached": 1 }));
    assert!(h.rig.svc.list_todo_labels().unwrap().is_empty());
    assert!(h.todos()[0].labels.is_empty());
}

#[test]
fn state_create_rename_delete() {
    let h = harness();
    assert!(ok(&h.send(json!({ "id": 1, "type": "todo.state.create", "name": "Blocked" }))));
    let states = h.rig.svc.list_todo_states().unwrap();
    let blocked = states.iter().find(|s| s.label == "Blocked").unwrap();
    assert!(!blocked.is_default && !blocked.is_completed);
    assert_eq!(states.iter().find(|s| s.is_default).unwrap().label, "Todo");
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.state.create", "name": "todo" }))).contains("already exists"));

    assert!(ok(&h.send(json!({ "id": 2, "type": "todo.state.rename", "name": "Done", "newName": "Shipped" }))));
    assert!(h.rig.svc.list_todo_states().unwrap().iter().find(|s| s.label == "Shipped").unwrap().is_completed);
    assert!(error(&h.send(json!({ "id": 2, "type": "todo.state.rename", "name": "Nope", "newName": "x" }))).contains("Valid states: "));

    let needs = h.send(json!({ "id": 3, "type": "todo.state.delete", "name": "Backlog" }));
    assert!(error(&needs).contains("needs 'reassignTo'"));
    h.add(json!({ "state": "Backlog" }));
    h.add(json!({ "state": "Backlog" }));
    let moved = h.send(json!({ "id": 4, "type": "todo.state.delete", "name": "backlog", "reassignTo": "processing" })).unwrap();
    assert_eq!(moved["result"], json!({ "name": "Backlog", "reassignedTo": "Processing", "moved": 2 }));
    assert!(h.todos().iter().all(|t| t.state.label == "Processing"));

    assert!(error(&h.send(json!({ "id": 5, "type": "todo.state.delete", "name": "Todo", "reassignTo": "Processing" }))).contains("default"));
    assert!(error(&h.send(json!({ "id": 5, "type": "todo.state.delete", "name": "Shipped", "reassignTo": "Processing" }))).contains("completed"));
    let unknown = h.send(json!({ "id": 5, "type": "todo.state.delete", "name": "Testing", "reassignTo": "Nope" }));
    assert!(error(&unknown).contains("Unknown state 'Nope'"));
    assert!(h.rig.svc.list_todo_states().unwrap().iter().any(|s| s.label == "Testing"));
}

#[test]
fn read_commands_list_the_taxonomy() {
    let h = harness();
    h.project("P");
    h.label("L");
    let states = h.send(json!({ "id": 1, "type": "todo.states" })).unwrap();
    assert!(states["result"]["states"].as_array().unwrap().len() >= 5);
    assert_eq!(h.send(json!({ "id": 2, "type": "todo.projects" })).unwrap()["result"]["projects"][0]["name"], "P");
    assert_eq!(h.send(json!({ "id": 3, "type": "todo.labels" })).unwrap()["result"]["labels"][0]["name"], "L");
}

// --- todo.delete ---

#[test]
fn delete_needs_an_exact_title_and_never_echoes_it() {
    let h = harness();
    let id = h.add(json!({ "title": "Exact Title" }));
    let wrong = h.send(json!({ "id": 2, "type": "todo.delete", "todoId": id, "confirmTitle": "wrong" }));
    assert!(!ok(&wrong));
    assert!(!error(&wrong).contains("Exact Title"));
    assert!(!ok(&h.send(json!({ "id": 2, "type": "todo.delete", "todoId": id, "confirmTitle": "exact title" }))));
    assert!(!ok(&h.send(json!({ "id": 3, "type": "todo.delete", "todoId": id, "confirmTitle": "Exact Title " }))));
    assert_eq!(h.todos().len(), 1);

    let done = h.send(json!({ "id": 4, "type": "todo.delete", "todoId": id, "confirmTitle": "Exact Title" })).unwrap();
    assert_eq!(done["result"], json!({ "id": id, "title": "Exact Title", "childrenLifted": 0 }));
    assert!(h.todos().is_empty());
}

#[test]
fn delete_lifts_children_and_collects_the_attachment_blob() {
    let h = harness();
    let parent = h.add(json!({ "title": "parent" }));
    h.send(json!({ "id": 2, "type": "todo.add", "title": "child a", "parentId": parent }));
    h.send(json!({ "id": 3, "type": "todo.add", "title": "child b", "parentId": parent }));
    let attachment = h
        .rig
        .svc
        .add_attachment_buffer(&AddTodoAttachmentBufferInput { todo_id: parent, data: b"blob bytes".to_vec(), file_name: "shot.png".into(), mime_type: "image/png".into() })
        .unwrap();
    let dir = h.rig.svc.data_dir();
    let blob = lizmeter_services::attachments::attachment_path_for(&dir, &attachment.sha256, "png").unwrap();
    assert!(blob.exists());

    let reply = h.send(json!({ "id": 4, "type": "todo.delete", "todoId": parent, "confirmTitle": "parent" })).unwrap();
    assert_eq!(reply["result"]["childrenLifted"], 2);
    let survivors = h.todos();
    assert_eq!(survivors.len(), 2);
    assert!(survivors.iter().all(|t| t.parent_id.is_none()));
    assert!(!blob.exists());
}

#[test]
fn delete_rejects_bad_ids_and_stale_identity() {
    let h = harness();
    assert!(error(&h.send(json!({ "id": 1, "type": "todo.delete", "todoId": "abc", "confirmTitle": "x" }))).contains("integer 'todoId'"));
    assert_eq!(error(&h.send(json!({ "id": 1, "type": "todo.delete", "todoId": 9999, "confirmTitle": "x" }))), "No todo #9999.");
    let id = h.add(json!({ "title": "a" }));
    let stale = h.send(json!({ "id": 2, "type": "todo.delete", "todoId": id, "confirmTitle": "a", "expectUuid": "00000000-0000-0000-0000-000000000000" }));
    assert!(error(&stale).contains("renumbered"));
    assert_eq!(h.todos().len(), 1);
}

// --- Connection: buffer overflow and end of stream ---

fn oversized() -> Vec<u8> {
    vec![b'x'; MAX_BUFFER_SIZE + 1]
}

#[test]
fn oversized_chunk_gets_the_limit_reply_and_a_clean_close() {
    let h = harness();
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    conn.on_data(&h.proto, &oversized(), &mut wire);
    assert_eq!(wire.written.len(), 1);
    let reply: Value = serde_json::from_str(&wire.written[0]).unwrap();
    assert_eq!(reply, json!({ "id": null, "ok": false, "error": "Message exceeds the 262144-character limit" }));
    assert!(wire.written[0].ends_with('\n'));
    assert!(wire.ended);
}

#[test]
fn the_limit_counts_characters_not_bytes_and_accumulates_across_chunks() {
    let h = harness();
    // 100 000 two-byte characters are 200 000 bytes but under the limit.
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    conn.on_data(&h.proto, "é".repeat(100_000).as_bytes(), &mut wire);
    assert!(wire.written.is_empty());
    // 200 000 characters buffered is still under the limit; the third chunk tips it over.
    conn.on_data(&h.proto, "é".repeat(100_000).as_bytes(), &mut wire);
    conn.on_data(&h.proto, "é".repeat(100_000).as_bytes(), &mut wire);
    assert_eq!(wire.written.len(), 1);
    assert!(wire.ended);
}

#[test]
fn overflow_discards_the_buffered_fragment() {
    let h = harness();
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    conn.on_data(&h.proto, br#"{"id":1,"type":"todo.add","title":"orphan"#, &mut wire);
    conn.on_data(&h.proto, &oversized(), &mut wire);
    let before = h.proto.warnings().len();
    conn.on_end(&h.proto, &mut wire);
    assert_eq!(h.proto.warnings().len(), before);
    assert!(h.todos().is_empty());
}

#[test]
fn nothing_is_dispatched_after_an_overflow() {
    let h = harness();
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    conn.on_data(&h.proto, &oversized(), &mut wire);
    conn.on_data(&h.proto, format!("{}\n", json!({ "id": 2, "type": "todo.add", "title": "sneaked in" })).as_bytes(), &mut wire);
    assert!(h.todos().is_empty());
}

#[test]
fn a_message_split_across_reads_and_a_split_character_are_reassembled() {
    let h = harness();
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    let line = format!("{}\n", json!({ "id": 1, "type": "todo.add", "title": "naïve é" }));
    let bytes = line.as_bytes();
    let cut = line.find('é').unwrap() + 1; // inside the two-byte character
    conn.on_data(&h.proto, &bytes[..cut], &mut wire);
    assert!(wire.written.is_empty());
    conn.on_data(&h.proto, &bytes[cut..], &mut wire);
    assert_eq!(wire.written.len(), 1);
    assert_eq!(h.todos()[0].title, "naïve é");
}

#[test]
fn several_messages_in_one_read_each_get_a_reply_in_order() {
    let h = harness();
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    conn.on_data(&h.proto, b"{\"id\":1,\"type\":\"ping\"}\n\n  \n{\"id\":2,\"type\":\"ping\"}\r\n", &mut wire);
    assert_eq!(wire.written.len(), 2);
    assert!(wire.written[0].starts_with("{\"id\":1,"));
    assert!(wire.written[1].starts_with("{\"id\":2,"));
}

#[test]
fn end_of_stream_replies_while_writable_and_applies_side_effects_either_way() {
    let h = harness();
    let mut conn = Connection::new();
    let mut wire = FakeWire::new();
    conn.on_data(&h.proto, br#"{"id":1,"type":"ping"}"#, &mut wire);
    conn.on_end(&h.proto, &mut wire);
    assert_eq!(wire.written.len(), 1);
    assert_eq!(serde_json::from_str::<Value>(&wire.written[0]).unwrap()["ok"], true);

    let mut conn = Connection::new();
    let mut gone = FakeWire::new();
    conn.on_data(&h.proto, br#"{"id":1,"type":"todo.add","title":"trailing"}"#, &mut gone);
    gone.writable = false;
    conn.on_end(&h.proto, &mut gone);
    assert_eq!(h.todos()[0].title, "trailing");
    assert!(gone.written.is_empty());
}

// --- A real named pipe, on a private test path ---

#[cfg(windows)]
mod real_pipe {
    use super::*;
    use lizmeter_services::pipe::PipeServer;
    use std::fs::OpenOptions;
    use std::io::{BufRead, BufReader, Write};

    fn test_path(tag: &str) -> String {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        format!("\\\\.\\pipe\\lizmeter-test-{tag}-{}-{nanos}", std::process::id())
    }

    /// Like a Node client: when every instance is busy, wait and retry (`ERROR_PIPE_BUSY`).
    fn connect(path: &str) -> std::fs::File {
        for _ in 0..200 {
            match OpenOptions::new().read(true).write(true).open(path) {
                Ok(f) => return f,
                Err(e) if e.raw_os_error() == Some(231) => std::thread::sleep(std::time::Duration::from_millis(25)),
                Err(e) => panic!("connect {path}: {e}"),
            }
        }
        panic!("connect {path}: pipe stayed busy");
    }

    /// One request, one reply line, on a fresh connection (the MCP server's pattern).
    fn request(path: &str, message: &Value) -> Value {
        let mut file = connect(path);
        file.write_all(format!("{message}\n").as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(file).read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn requests_round_trip_and_legacy_lines_get_no_reply() {
        let rig = rig();
        let path = test_path("rt");
        let mut server = PipeServer::start_at(rig.svc.clone(), &path).unwrap();

        let added = request(&path, &json!({ "id": 1, "type": "todo.add", "title": "over the pipe" }));
        assert_eq!(added["ok"], true);
        assert_eq!(rig.svc.list_todos(&ListTodosInput::default()).unwrap()[0].title, "over the pipe");

        // Two requests on one connection, then the legacy shape, then a third request: the legacy
        // line produces no reply, so the next line read is the third request's.
        let mut file = connect(&path);
        file.write_all(b"{\"id\":2,\"type\":\"ping\"}\n{\"project\":\"P\",\"file\":\"a.rs\"}\n{\"id\":3,\"type\":\"ping\"}\n").unwrap();
        let mut reader = BufReader::new(file);
        let mut first = String::new();
        let mut second = String::new();
        reader.read_line(&mut first).unwrap();
        reader.read_line(&mut second).unwrap();
        assert!(first.starts_with("{\"id\":2,"));
        assert!(second.starts_with("{\"id\":3,"));
        drop(reader);

        let counter = server.change_counter();
        assert!(counter.load(std::sync::atomic::Ordering::SeqCst) >= 1);
        server.stop();
    }

    #[test]
    fn many_clients_at_once_all_get_answers() {
        let rig = rig();
        let path = test_path("many");
        let _server = PipeServer::start_at(rig.svc.clone(), &path).unwrap();
        let handles: Vec<_> = (0..12)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || request(&path, &json!({ "id": i, "type": "todo.add", "title": format!("t{i}") })))
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap()["ok"], true);
        }
        assert_eq!(rig.svc.list_todos(&ListTodosInput::default()).unwrap().len(), 12);
    }

    #[test]
    fn an_owned_path_is_refused_not_hijacked() {
        let rig = rig();
        let path = test_path("owned");
        let first = PipeServer::start_at(rig.svc.clone(), &path).unwrap();

        let second = match PipeServer::start_at(rig.svc.clone(), &path) {
            Ok(_) => panic!("a second server took over an owned pipe"),
            Err(e) => e,
        };
        assert!(second.contains("EADDRINUSE"), "{second}");
        assert!(second.contains(&path));

        // The first owner still answers, and a failed start leaves nothing behind that could
        // swallow its clients.
        assert_eq!(request(&path, &json!({ "id": 1, "type": "ping" }))["ok"], true);
        drop(first);
    }

    #[test]
    fn an_oversized_message_gets_the_limit_reply_then_the_connection_closes() {
        let rig = rig();
        let path = test_path("big");
        let _server = PipeServer::start_at(rig.svc.clone(), &path).unwrap();
        let mut file = connect(&path);
        let _ = file.write_all(&vec![b'x'; MAX_BUFFER_SIZE + 1]);
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["id"], Value::Null);
        assert_eq!(reply["ok"], false);
        assert!(reply["error"].as_str().unwrap().contains("262144"));
        let mut rest = String::new();
        assert_eq!(reader.read_line(&mut rest).unwrap_or(0), 0);
    }

    #[test]
    fn a_client_that_closes_without_a_newline_still_has_its_message_applied() {
        let rig = rig();
        let path = test_path("end");
        let _server = PipeServer::start_at(rig.svc.clone(), &path).unwrap();
        {
            let mut file = connect(&path);
            file.write_all(br#"{"id":1,"type":"todo.add","title":"trailing"}"#).unwrap();
        }
        for _ in 0..50 {
            if !rig.svc.list_todos(&ListTodosInput::default()).unwrap().is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        assert_eq!(rig.svc.list_todos(&ListTodosInput::default()).unwrap()[0].title, "trailing");
    }

    #[test]
    fn a_stopped_server_frees_the_path() {
        let rig = rig();
        let path = test_path("stop");
        let mut server = PipeServer::start_at(rig.svc.clone(), &path).unwrap();
        server.stop();
        drop(server);
        let again = PipeServer::start_at(rig.svc.clone(), &path);
        assert!(again.is_ok());
    }
}
