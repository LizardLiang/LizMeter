//! Named pipe server for external integrations (`electron/main/pipe-server.ts`).
//!
//! Two protocols share one pipe:
//!   1. Legacy Neovim activity: `{ project, file }`, fire-and-forget, no reply.
//!   2. Typed commands: `{ id, type, ... }`, replied to on the same connection as
//!      `{ id, ok: true, result }` or `{ id, ok: false, error }`.
//!
//! Every write goes through [`Services::with_db`], the path the UI uses, so a command reaches the
//! same database handle, sync hook and single-writer guard, and is refused once the data folder
//! has been moved (`retired`).

use crate::attachments::collect_attachment_blobs;
use crate::Services;
use lizmeter_core::{
    CreateTodoInput, CreateTodoLabelInput, CreateTodoProjectInput, CreateTodoStateInput, ListTodosInput, Todo,
    TodoFilter, TodoSource, UpdateTodoInput, UpdateTodoLabelInput, UpdateTodoProjectInput, UpdateTodoStateInput,
};
use lizmeter_db::util::{js_len, js_trim};
use lizmeter_db::Database;
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
mod server;
#[cfg(windows)]
pub use server::PipeServer;

/// A todo may carry up to 32 000 characters of markdown notes. At roughly 64 000 characters a note
/// that long could overflow this buffer once JSON escaping is applied and the write would fail
/// silently, so the ceiling is 262 144 characters (UTF-16 units, as in the Electron build).
pub const MAX_BUFFER_SIZE: usize = 262_144;

/// How much of a malformed line to keep in the log.
const MALFORMED_LINE_LOG_LENGTH: usize = 200;

/// An unfiltered `todo.list` can run into the thousands of rows, which blows past an MCP client's
/// tool-result token cap; 50 keeps a typical page well under that cap.
const DEFAULT_TODO_LIST_LIMIT: i64 = 50;

/// The pipe path: `LIZMETER_PIPE_PATH` when set and non-empty, else the production default.
pub fn pipe_path() -> String {
    match std::env::var("LIZMETER_PIPE_PATH") {
        Ok(p) if !p.is_empty() => p,
        _ => default_pipe_path().to_string(),
    }
}

pub fn default_pipe_path() -> &'static str {
    if cfg!(windows) {
        "\\\\.\\pipe\\lizmeter"
    } else {
        "/tmp/lizmeter.sock"
    }
}

type Res<T> = std::result::Result<T, String>;

fn msg<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// `JSON.stringify` of a request id echoed back: whole numbers print without a fraction.
fn json_id(v: &Value) -> String {
    if let Value::Number(n) = v {
        if n.is_f64() {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 {
                    return format!("{}", f as i128);
                }
            }
        }
    }
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// `Number.isInteger` for a parsed JSON value.
fn js_int(v: &Value) -> Option<i64> {
    let Value::Number(n) = v else { return None };
    if let Some(i) = n.as_i64() {
        return Some(i);
    }
    let f = n.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0).then_some(f as i64)
}

// --- The protocol ---

/// The shared state of one pipe server: the services every command writes through, the count of
/// malformed lines, and a counter the UI polls to refresh after an out-of-band write.
pub struct Protocol {
    svc: Arc<Services>,
    malformed: AtomicU64,
    changes: Arc<AtomicU64>,
    warnings: Mutex<Vec<String>>,
}

impl Protocol {
    pub fn new(svc: Arc<Services>) -> Arc<Protocol> {
        Arc::new(Protocol {
            svc,
            malformed: AtomicU64::new(0),
            changes: Arc::new(AtomicU64::new(0)),
            warnings: Mutex::new(Vec::new()),
        })
    }

    /// Bumped after every command that wrote (`todo:changed` in the Electron build).
    pub fn change_counter(&self) -> Arc<AtomicU64> {
        self.changes.clone()
    }

    /// The last `[pipe]` warnings, oldest first (capped at 100).
    pub fn warnings(&self) -> Vec<String> {
        self.warnings.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn warn(&self, text: String) {
        eprintln!("{text}");
        let mut w = self.warnings.lock().unwrap_or_else(|e| e.into_inner());
        if w.len() == 100 {
            w.remove(0);
        }
        w.push(text);
    }

    /// Handles one newline-delimited message and, for typed commands carrying an id, hands the
    /// reply line to `reply`.
    pub fn process_line(&self, line: &str, reply: &mut dyn FnMut(&str)) {
        let payload: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // A failed parse has no id to key a reply to: the wire stays silent. Still counted
                // and logged so a run of bad input is visible here.
                let n = self.malformed.fetch_add(1, Ordering::SeqCst) + 1;
                let preview = if js_len(line) > MALFORMED_LINE_LOG_LENGTH {
                    format!("{}...", lizmeter_db::util::js_truncate(line, MALFORMED_LINE_LOG_LENGTH))
                } else {
                    line.to_string()
                };
                self.warn(format!("[pipe] Discarding malformed JSON (#{n}): {preview}"));
                return;
            }
        };
        let Value::Object(data) = &payload else { return };

        // No string 'type' means the legacy Neovim shape.
        let Some(Value::String(kind)) = data.get("type") else {
            self.handle_nvim_activity(data);
            return;
        };

        let id = data.get("id");
        let outcome = match self.svc.with_db(|db| Ok(dispatch(db, &self.svc.data_dir(), kind, data))) {
            Ok(r) => r,
            Err(e) => Err(e.to_string()),
        };
        // A write command that fails part-way (the row is gone, the blob sweep failed) still
        // changed what the screen shows, so any non-read command bumps the counter.
        if !matches!(kind.as_str(), "ping" | "todo.states" | "todo.projects" | "todo.labels" | "todo.list") {
            self.changes.fetch_add(1, Ordering::SeqCst);
        }
        match outcome {
            Ok((result, _)) => {
                if let Some(id) = id {
                    reply(&format!("{{\"id\":{},\"ok\":true,\"result\":{}}}\n", json_id(id), result));
                }
            }
            Err(message) => {
                // Logged unconditionally: an id-less failing command would otherwise be invisible.
                self.warn(format!("[pipe] Rejected command '{kind}': {message}"));
                if let Some(id) = id {
                    reply(&format!("{{\"id\":{},\"ok\":false,\"error\":{}}}\n", json_id(id), js_str(&message)));
                }
            }
        }
    }

    fn handle_nvim_activity(&self, data: &serde_json::Map<String, Value>) {
        let (Some(Value::String(project)), Some(Value::String(file))) = (data.get("project"), data.get("file")) else {
            return;
        };
        let (project, file) = (js_trim(project), js_trim(file));
        if project.is_empty() || file.is_empty() || js_len(project) > 1000 || js_len(file) > 1000 {
            return;
        }
        // A database error is silently discarded, as before.
        let _ = self.svc.with_db(|db| {
            // Skip when the same (project, file) was recorded within the last 60 seconds.
            if db.is_duplicate_nvim_activity(project, file)? {
                return Ok(());
            }
            Ok(db.insert_nvim_activity(project, file)?)
        });
    }
}

// --- One connection ---

/// What a connection writes to: a real pipe handle, or a test stand-in.
pub trait Wire {
    fn write(&mut self, text: &str);
    /// Closes the connection cleanly (the peer still reads what was written).
    fn end(&mut self);
    fn writable(&self) -> bool;
}

/// The per-connection buffer and overflow state.
#[derive(Default)]
pub struct Connection {
    buffer: String,
    /// The tail of a multi-byte character split across two reads.
    pending: Vec<u8>,
    /// Set once the connection has overflowed: nothing further is parsed or dispatched.
    terminated: bool,
}

impl Connection {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_terminated(&self) -> bool {
        self.terminated
    }

    /// One read from the peer.
    pub fn on_data(&mut self, proto: &Protocol, chunk: &[u8], wire: &mut dyn Wire) {
        if self.terminated {
            return;
        }
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let split = match std::str::from_utf8(&bytes) {
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            _ => bytes.len(),
        };
        self.pending = bytes.split_off(split);
        let incoming = String::from_utf8_lossy(&bytes).into_owned();

        // Guard against oversized payloads before the chunk joins the buffer.
        if js_len(&self.buffer) + js_len(&incoming) > MAX_BUFFER_SIZE {
            let reply = format!(
                "{{\"id\":null,\"ok\":false,\"error\":\"Message exceeds the {MAX_BUFFER_SIZE}-character limit\"}}\n"
            );
            self.terminated = true;
            wire.write(&reply);
            wire.end();
            self.buffer.clear();
            self.pending.clear();
            return;
        }

        self.buffer.push_str(&incoming);
        let Some(last_newline) = self.buffer.rfind('\n') else { return };
        let rest = self.buffer.split_off(last_newline + 1);
        let complete = std::mem::replace(&mut self.buffer, rest);
        for line in complete.split('\n') {
            let trimmed = js_trim(line);
            if trimmed.is_empty() {
                continue;
            }
            proto.process_line(trimmed, &mut |text| wire.write(text));
        }
    }

    /// The peer closed its side: process what is still buffered. The reply is written only while
    /// the connection is still writable; the side effect happens either way.
    pub fn on_end(&mut self, proto: &Protocol, wire: &mut dyn Wire) {
        let trimmed = js_trim(&self.buffer).to_string();
        if trimmed.is_empty() {
            return;
        }
        proto.process_line(&trimmed, &mut |text| {
            if wire.writable() {
                wire.write(text);
            }
        });
    }
}

// --- Command dispatch ---

/// Runs one typed command on the open database. Returns the result JSON and whether a write may
/// have happened (the UI refreshes on it).
fn dispatch(db: &Database, data_dir: &Path, kind: &str, data: &serde_json::Map<String, Value>) -> Res<(String, bool)> {
    let mut wrote = true;
    let result = match kind {
        "ping" => {
            wrote = false;
            "{\"pong\":true}".to_string()
        }
        "todo.states" => {
            wrote = false;
            format!("{{\"states\":{}}}", to_json(&db.list_todo_states().map_err(msg)?)?)
        }
        "todo.projects" => {
            wrote = false;
            format!("{{\"projects\":{}}}", to_json(&db.list_todo_projects().map_err(msg)?)?)
        }
        "todo.labels" => {
            wrote = false;
            format!("{{\"labels\":{}}}", to_json(&db.list_todo_labels().map_err(msg)?)?)
        }
        "todo.add" => todo_add(db, data)?,
        "todo.update" => todo_update(db, data)?,
        "todo.list" => {
            wrote = false;
            todo_list(db, data)?
        }
        "todo.complete" => {
            let id = require_todo_id(db, data, "todo.complete")?;
            // Resolved through the is_completed flag, never a label, so renaming "Done" is safe.
            let completed = db.list_todo_states().map_err(msg)?.into_iter().find(|s| s.is_completed);
            let Some(completed) = completed else { return Err("No state is marked as completed".into()) };
            let todo = db.update_todo(&UpdateTodoInput { id, state_id: Some(completed.id), ..Default::default() }).map_err(msg)?;
            format!("{{\"todo\":{}}}", to_json(&todo)?)
        }
        "todo.clear-completed" => {
            let swept = db.clear_completed_todos().map_err(msg)?;
            collect_attachment_blobs(db, data_dir, &swept.deleted_shas).map_err(msg)?;
            format!("{{\"removed\":{}}}", swept.count)
        }
        "todo.delete" => todo_delete(db, data_dir, data)?,
        "todo.project.create" => {
            let project = db
                .create_todo_project(&CreateTodoProjectInput {
                    name: require_name(data.get("name"), "name")?,
                    color: optional_color(data.get("color"))?,
                })
                .map_err(msg)?;
            format!("{{\"project\":{}}}", to_json(&project)?)
        }
        "todo.project.rename" => {
            let existing = project_by_name(db, data.get("name"))?;
            let new_name = require_name(data.get("newName"), "newName")?;
            let project =
                db.update_todo_project(&UpdateTodoProjectInput { id: existing.id, name: Some(new_name), color: None }).map_err(msg)?;
            format!("{{\"project\":{}}}", to_json(&project)?)
        }
        "todo.project.delete" => {
            let existing = project_by_name(db, data.get("name"))?;
            let in_use = db.list_todos(&ListTodosInput { project_id: Some(existing.id), ..Default::default() }).map_err(msg)?.len();
            require_force(in_use, "Project", &existing.name, data.get("force"))?;
            let detached = db.delete_todo_project(existing.id).map_err(msg)?;
            format!("{{\"name\":{},\"detached\":{detached}}}", js_str(&existing.name))
        }
        "todo.label.create" => {
            let name = require_name(data.get("name"), "name")?;
            // get-or-create, matching the in-app picker; report which one happened.
            let existed = db.find_todo_label_by_name(&name).map_err(msg)?.is_some();
            let label = db
                .create_todo_label(&CreateTodoLabelInput { name, color: optional_color(data.get("color"))? })
                .map_err(msg)?;
            format!("{{\"label\":{},\"created\":{}}}", to_json(&label)?, !existed)
        }
        "todo.label.rename" => {
            let existing = label_by_name(db, data.get("name"))?;
            let new_name = require_name(data.get("newName"), "newName")?;
            let label = db.update_todo_label(&UpdateTodoLabelInput { id: existing.id, name: Some(new_name), color: None }).map_err(msg)?;
            format!("{{\"label\":{}}}", to_json(&label)?)
        }
        "todo.label.delete" => {
            let existing = label_by_name(db, data.get("name"))?;
            let in_use = db.list_todos(&ListTodosInput { label_id: Some(existing.id), ..Default::default() }).map_err(msg)?.len();
            require_force(in_use, "Label", &existing.name, data.get("force"))?;
            let detached = db.delete_todo_label(existing.id).map_err(msg)?;
            format!("{{\"name\":{},\"detached\":{detached}}}", js_str(&existing.name))
        }
        "todo.state.create" => {
            // New states land non-default and non-completed: which state new todos fall into and
            // which one means finished are workflow decisions the user makes in the app.
            let state = db
                .create_todo_state(&CreateTodoStateInput {
                    label: require_name(data.get("name"), "name")?,
                    color: optional_color(data.get("color"))?,
                })
                .map_err(msg)?;
            format!("{{\"state\":{}}}", to_json(&state)?)
        }
        "todo.state.rename" => {
            let existing = state_by_name(db, data.get("name"), "name")?;
            let new_name = require_name(data.get("newName"), "newName")?;
            let state = db
                .update_todo_state(&UpdateTodoStateInput { id: existing.id, label: Some(new_name), ..Default::default() })
                .map_err(msg)?;
            format!("{{\"state\":{}}}", to_json(&state)?)
        }
        "todo.state.delete" => {
            let existing = state_by_name(db, data.get("name"), "name")?;
            // No force flag: todos are moved rather than stripped, so naming the destination is
            // the safeguard. `delete_todo_state` separately refuses the default and completed state.
            let reassign = match data.get("reassignTo") {
                None | Some(Value::Null) => {
                    return Err(format!(
                        "Deleting state '{}' needs 'reassignTo': the state every todo sitting in it moves to.",
                        existing.label
                    ))
                }
                Some(v) => v,
            };
            let target = state_by_name(db, Some(reassign), "reassignTo")?;
            let moved = db.delete_todo_state(existing.id, target.id).map_err(msg)?;
            format!(
                "{{\"name\":{},\"reassignedTo\":{},\"moved\":{moved}}}",
                js_str(&existing.label),
                js_str(&target.label)
            )
        }
        other => return Err(format!("Unknown command type: {other}")),
    };
    Ok((result, wrote))
}

fn to_json<T: serde::Serialize>(v: &T) -> Res<String> {
    serde_json::to_string(v).map_err(msg)
}

/// A todo as the reply carries it: its fields, then its permanent uuid so a caller can prove on a
/// later write that the number it addresses still means the same todo.
fn todo_with_uuid(db: &Database, todo: &Todo) -> Res<String> {
    let mut text = to_json(todo)?;
    let uuid = db.todo_uuid(todo.id).map_err(msg)?;
    text.pop(); // the closing brace
    text.push_str(&format!(",\"uuid\":{}}}", uuid.as_deref().map_or("null".to_string(), js_str)));
    Ok(text)
}

fn todo_add(db: &Database, data: &serde_json::Map<String, Value>) -> Res<String> {
    // Field coercion runs in the same order as the Electron handler, so a request with two bad
    // fields reports the same one first.
    let notes = optional_string(data.get("notes"), "notes")?.flatten();
    let state_id = resolve_state_label(db, data.get("state"))?;
    let project_id = resolve_project_name(db, data.get("project"))?.flatten();
    let label_ids = resolve_label_names(db, data.get("labels"), "labels")?;
    let milestone = optional_string(data.get("milestone"), "milestone")?.flatten();
    let priority = optional_number(data.get("priority"), "priority")?.flatten();
    let start_date = optional_string(data.get("startDate"), "startDate")?.flatten();
    let due_date = optional_string(data.get("dueDate"), "dueDate")?.flatten();
    let parent_id = optional_number(data.get("parentId"), "parentId")?.flatten();
    let source_label = match data.get("agent") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err("Todo source label must be a string or null".into()),
    };
    // A missing or non-string title reaches the same validation the Electron database layer runs.
    let title = match data.get("title") {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let todo = db
        .create_todo(&CreateTodoInput {
            title,
            notes,
            state_id,
            project_id,
            label_ids,
            milestone,
            priority,
            start_date,
            due_date,
            // Anything arriving over the pipe is by definition not typed by the user.
            source: Some(TodoSource::Ai),
            source_label,
            parent_id,
        })
        .map_err(msg)?;
    Ok(format!("{{\"todo\":{}}}", to_json(&todo)?))
}

fn todo_update(db: &Database, data: &serde_json::Map<String, Value>) -> Res<String> {
    let id = require_todo_id(db, data, "todo.update")?;
    let title = match data.get("title") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => Some(String::new()),
    };
    let notes = optional_string(data.get("notes"), "notes")?;
    let state_id = resolve_state_label(db, data.get("state"))?;
    let project_id = resolve_project_name(db, data.get("project"))?;
    let label_ids = resolve_label_names(db, data.get("labels"), "labels")?;
    let milestone = optional_string(data.get("milestone"), "milestone")?;
    let priority = optional_number(data.get("priority"), "priority")?.flatten();
    let start_date = optional_string(data.get("startDate"), "startDate")?;
    let due_date = optional_string(data.get("dueDate"), "dueDate")?;
    let parent_id = optional_number(data.get("parentId"), "parentId")?;
    let todo = db
        .update_todo(&UpdateTodoInput { id, title, notes, state_id, project_id, label_ids, milestone, priority, start_date, due_date, parent_id })
        .map_err(msg)?;
    Ok(format!("{{\"todo\":{}}}", to_json(&todo)?))
}

fn todo_list(db: &Database, data: &serde_json::Map<String, Value>) -> Res<String> {
    // 'todoId' (not 'id': that is the envelope's correlation field) fetches exactly one todo and
    // short-circuits every other field, limit and offset included.
    if let Some(todo_id) = data.get("todoId") {
        let Some(todo_id) = js_int(todo_id) else { return Err("'todoId' must be an integer".into()) };
        let todos = db.list_todos(&ListTodosInput { id: Some(todo_id), ..Default::default() }).map_err(msg)?;
        if todos.is_empty() {
            return Err(format!("No todo #{todo_id}."));
        }
        let items = todos.iter().map(|t| todo_with_uuid(db, t)).collect::<Res<Vec<_>>>()?;
        return Ok(format!("{{\"todos\":[{}],\"total\":1}}", items.join(",")));
    }

    let filter = match data.get("filter") {
        Some(Value::String(s)) => match s.as_str() {
            "active" => TodoFilter::Active,
            "done" => TodoFilter::Done,
            "ai" => TodoFilter::Ai,
            _ => TodoFilter::All,
        },
        _ => TodoFilter::All,
    };
    let project_id = resolve_project_name(db, data.get("project"))?.flatten();
    let label_wrapped = data.get("label").map(|v| Value::Array(vec![v.clone()]));
    let label_id = resolve_label_names(db, label_wrapped.as_ref(), "label")?.and_then(|ids| ids.first().copied());
    let state_id = resolve_state_label(db, data.get("state"))?;
    let parent_id = optional_number(data.get("parentId"), "parentId")?.flatten();
    let limit = match data.get("limit") {
        None => DEFAULT_TODO_LIST_LIMIT,
        Some(v) => match js_int(v) {
            Some(n) if n >= 1 => n,
            _ => return Err("'limit' must be a positive integer".into()),
        },
    };
    let offset = match data.get("offset") {
        None => 0,
        Some(v) => match js_int(v) {
            Some(n) if n >= 0 => n,
            _ => return Err("'offset' must be a non-negative integer".into()),
        },
    };

    let input = ListTodosInput { filter: Some(filter), project_id, label_id, state_id, parent_id, ..Default::default() };
    let total = db.count_todos(&input).map_err(msg)?;
    let todos = db.list_todos(&ListTodosInput { limit: Some(limit), offset: Some(offset), ..input }).map_err(msg)?;
    let items = todos.iter().map(|t| todo_with_uuid(db, t)).collect::<Res<Vec<_>>>()?;
    Ok(format!("{{\"todos\":[{}],\"total\":{total}}}", items.join(",")))
}

fn todo_delete(db: &Database, data_dir: &Path, data: &serde_json::Map<String, Value>) -> Res<String> {
    let id = require_todo_id(db, data, "todo.delete")?;
    let existing = db.list_todos(&ListTodosInput { id: Some(id), ..Default::default() }).map_err(msg)?;
    let Some(todo) = existing.first() else { return Err(format!("No todo #{id}.")) };

    // Case-sensitive, untrimmed match against the real title. The message must not echo that
    // title: doing so would turn a failed delete into a way to read a title the caller lacks.
    match data.get("confirmTitle") {
        Some(Value::String(t)) if *t == todo.title => {}
        _ => {
            return Err(format!(
                "todo.delete: 'confirmTitle' did not match todo #{id}'s title. Read it with todo_list first."
            ))
        }
    }

    // Read before the delete: `delete_todo` lifts children to the top level without counting them.
    let children_lifted = todo.child_count;
    let shas = db.delete_todo(id).map_err(msg)?;
    collect_attachment_blobs(db, data_dir, &shas).map_err(msg)?;
    Ok(format!("{{\"id\":{id},\"title\":{},\"childrenLifted\":{children_lifted}}}", js_str(&todo.title)))
}

// --- Field readers ---

/// `'todoId'`, not `'id'`: `'id'` is the envelope's correlation field.
fn require_todo_id(db: &Database, data: &serde_json::Map<String, Value>, command: &str) -> Res<i64> {
    let Some(id) = data.get("todoId").and_then(js_int) else {
        return Err(format!("{command} requires an integer 'todoId'"));
    };
    // Refuses a write whose caller addresses a number that no longer means what it did when the
    // caller listed it. `expectUuid` is optional; when supplied and not matching, nothing is written.
    if let Some(Value::String(expected)) = data.get("expectUuid") {
        if !expected.is_empty() {
            let actual = db.todo_uuid(id).map_err(msg)?;
            if actual.as_deref() != Some(expected.as_str()) {
                return Err(format!(
                    "{command}: todo #{id} is not the todo you listed (it was renumbered by a sync). List the todos again and retry with the current number."
                ));
            }
        }
    }
    Ok(id)
}

/// Absent is `None` (leave alone), explicit null is `Some(None)` (clear).
fn optional_string(v: Option<&Value>, field: &str) -> Res<Option<Option<String>>> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(_) => Err(format!("'{field}' must be a string or null")),
    }
}

/// Anything but an integer is rejected rather than coerced, so a typo cannot silently unlink.
fn optional_number(v: Option<&Value>, field: &str) -> Res<Option<Option<i64>>> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => match js_int(v) {
            Some(n) => Ok(Some(Some(n))),
            None => Err(format!("'{field}' must be an integer or null")),
        },
    }
}

fn valid_list(names: Vec<String>) -> String {
    names.join(", ")
}

/// State labels are user-editable, so a miss lists the valid ones: one round trip teaches the vocabulary.
fn resolve_state_label(db: &Database, v: Option<&Value>) -> Res<Option<i64>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !js_trim(s).is_empty() => {
            if let Some(state) = db.find_todo_state_by_label(s).map_err(msg)? {
                return Ok(Some(state.id));
            }
            let valid = valid_list(db.list_todo_states().map_err(msg)?.into_iter().map(|s| s.label).collect());
            Err(format!("Unknown state '{}'. Valid states: {valid}", js_trim(s)))
        }
        Some(_) => Err("'state' must be a non-empty string".into()),
    }
}

/// Unknown names are rejected rather than created: an agent typo must not fragment the user's
/// projects. `None` is an absent field, `Some(None)` an explicit null.
fn resolve_project_name(db: &Database, v: Option<&Value>) -> Res<Option<Option<i64>>> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if !js_trim(s).is_empty() => {
            if let Some(p) = db.find_todo_project_by_name(s).map_err(msg)? {
                return Ok(Some(Some(p.id)));
            }
            let valid = valid_list(db.list_todo_projects().map_err(msg)?.into_iter().map(|p| p.name).collect());
            Err(if valid.is_empty() {
                format!("Unknown project '{}'. No projects exist yet -- create one before assigning it.", js_trim(s))
            } else {
                format!("Unknown project '{}'. Valid projects: {valid}", js_trim(s))
            })
        }
        Some(_) => Err("'project' must be a non-empty string or null".into()),
    }
}

fn resolve_label_names(db: &Database, v: Option<&Value>, field: &str) -> Res<Option<Vec<i64>>> {
    let list = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(a)) => a,
        Some(_) => return Err(format!("'{field}' must be an array of label names")),
    };
    let mut ids = Vec::new();
    for entry in list {
        let Value::String(name) = entry else { return Err(format!("'{field}' must contain non-empty strings")) };
        if js_trim(name).is_empty() {
            return Err(format!("'{field}' must contain non-empty strings"));
        }
        match db.find_todo_label_by_name(name).map_err(msg)? {
            Some(label) => ids.push(label.id),
            None => {
                let valid = valid_list(db.list_todo_labels().map_err(msg)?.into_iter().map(|l| l.name).collect());
                return Err(if valid.is_empty() {
                    format!("Unknown label '{}'. No labels exist yet -- create one before attaching it.", js_trim(name))
                } else {
                    format!("Unknown label '{}'. Valid labels: {valid}", js_trim(name))
                });
            }
        }
    }
    Ok(Some(ids))
}

// --- Taxonomy writes ---
//
// Projects, labels and states are the vocabulary every other todo command resolves against. Reads
// stay permissive. Writes are keyed by name, report what they touched, and refuse to strip todos
// without an explicit go-ahead.

fn require_name(v: Option<&Value>, field: &str) -> Res<String> {
    match v {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Ok(js_trim(s).to_string()),
        _ => Err(format!("'{field}' is required and must be a non-empty string")),
    }
}

/// Absent means "let the database pick its default".
fn optional_color(v: Option<&Value>) -> Res<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err("'color' must be a string".into()),
    }
}

/// Deleting a project or a label silently rewrites every todo holding it and the agent cannot
/// undo that, so a detaching delete needs `force: true`.
fn require_force(in_use: usize, kind: &str, name: &str, force: Option<&Value>) -> Res<()> {
    if in_use == 0 || matches!(force, Some(Value::Bool(true))) {
        return Ok(());
    }
    let todos = if in_use == 1 { "1 todo".to_string() } else { format!("{in_use} todos") };
    Err(format!(
        "{kind} '{name}' is still on {todos}. Deleting it removes it from {}. Pass force: true to go ahead.",
        if in_use == 1 { "that todo" } else { "those todos" }
    ))
}

fn project_by_name(db: &Database, v: Option<&Value>) -> Res<lizmeter_core::TodoProject> {
    let wanted = require_name(v, "name")?;
    if let Some(p) = db.find_todo_project_by_name(&wanted).map_err(msg)? {
        return Ok(p);
    }
    let valid = valid_list(db.list_todo_projects().map_err(msg)?.into_iter().map(|p| p.name).collect());
    Err(if valid.is_empty() {
        format!("Unknown project '{wanted}'. No projects exist yet.")
    } else {
        format!("Unknown project '{wanted}'. Valid projects: {valid}")
    })
}

fn label_by_name(db: &Database, v: Option<&Value>) -> Res<lizmeter_core::TodoLabel> {
    let wanted = require_name(v, "name")?;
    if let Some(l) = db.find_todo_label_by_name(&wanted).map_err(msg)? {
        return Ok(l);
    }
    let valid = valid_list(db.list_todo_labels().map_err(msg)?.into_iter().map(|l| l.name).collect());
    Err(if valid.is_empty() {
        format!("Unknown label '{wanted}'. No labels exist yet.")
    } else {
        format!("Unknown label '{wanted}'. Valid labels: {valid}")
    })
}

fn state_by_name(db: &Database, v: Option<&Value>, field: &str) -> Res<lizmeter_core::TodoState> {
    let wanted = require_name(v, field)?;
    if let Some(s) = db.find_todo_state_by_label(&wanted).map_err(msg)? {
        return Ok(s);
    }
    let valid = valid_list(db.list_todo_states().map_err(msg)?.into_iter().map(|s| s.label).collect());
    Err(format!("Unknown state '{wanted}'. Valid states: {valid}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lizmeter_db::data_location::DataLocation;
    use std::sync::atomic::Ordering;

    #[test]
    fn a_retired_service_refuses_commands_and_drops_legacy_lines() {
        std::env::set_var("LIZMETER_YT_DLP_API_URL", "http://127.0.0.1:9/yt-dlp");
        std::env::set_var("LIZMETER_FFMPEG_API_URL", "http://127.0.0.1:9/ffmpeg");
        let tmp = tempfile::tempdir().unwrap();
        let host = Arc::new(crate::os::RecordingHost::default());
        let (svc, _) = Services::open(DataLocation::new(tmp.path()), host, tmp.path().join("projects")).unwrap();
        let proto = Protocol::new(svc.clone());

        svc.retired.store(true, Ordering::SeqCst);
        let mut replies = Vec::new();
        proto.process_line(r#"{"id":1,"type":"todo.add","title":"late"}"#, &mut |t| replies.push(t.to_string()));
        proto.process_line(r#"{"project":"P","file":"f.rs"}"#, &mut |t| replies.push(t.to_string()));
        assert_eq!(
            replies,
            vec!["{\"id\":1,\"ok\":false,\"error\":\"LizMeter is restarting to use the new data folder\"}\n".to_string()]
        );
        assert_eq!(proto.change_counter().load(Ordering::SeqCst), 1); // a refused write still asks the screen to reload

        svc.retired.store(false, Ordering::SeqCst);
        assert!(svc.list_todos(&Default::default()).unwrap().is_empty());
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(svc.list_nvim_activity_by_date(&today).unwrap().records.is_empty());
    }
}
