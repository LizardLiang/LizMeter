//! Todos (`database.ts` todo section): validation, reads with joined state/project/labels,
//! create/update/delete, parent nesting and bulk clear.

use crate::error::{fail, Result};
use crate::sync_hook::{ensure_uuid, Fields, LinkOp};
use crate::util::{is_valid_iso_date, js_len, js_trim, js_truncate, matches_date_shape, new_uuid, now_iso};
use crate::{optional_row, Database};
use lizmeter_core::{
    CreateTodoInput, ListTodosInput, Todo, TodoFilter, TodoProject, TodoSource, TodoState, UpdateTodoInput,
    DEFAULT_TODO_COLOR, MAX_TODO_PRIORITY, NOTES_MAX_LENGTH, TODO_PRIORITY_LABELS,
};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};
use serde_json::json;
use std::collections::HashSet;

const MAX_TODO_TITLE_LENGTH: usize = 500;
const MAX_TODO_SOURCE_LABEL_LENGTH: usize = 64;
const MAX_TODO_TEXT_FIELD_LENGTH: usize = 120;

const TODO_SELECT: &str = "
  SELECT t.id, t.title, t.notes, t.project_id, t.milestone, t.priority, t.start_date, t.due_date,
         t.source, t.source_label, t.created_at, t.completed_at, t.parent_id,
         p.title AS parent_title,
         (SELECT COUNT(*) FROM todos c WHERE c.parent_id = t.id) AS child_count,
         (SELECT COUNT(*) FROM todos c
            INNER JOIN todo_states cs ON cs.id = c.state_id
            WHERE c.parent_id = t.id AND cs.is_completed = 1) AS completed_child_count,
         s.id AS state_id, s.label AS state_label, s.color AS state_color,
         s.position AS state_position, s.is_completed AS state_is_completed,
         s.is_default AS state_is_default, s.created_at AS state_created_at,
         j.name AS project_name, j.color AS project_color,
         j.position AS project_position, j.created_at AS project_created_at
  FROM todos t
  INNER JOIN todo_states s ON s.id = t.state_id
  LEFT JOIN todos p ON p.id = t.parent_id
  LEFT JOIN todo_projects j ON j.id = t.project_id";

/// A todo row before its labels are attached, plus the two fields `update_todo` needs.
struct TodoRow {
    todo: Todo,
    state_is_completed: bool,
}

fn todo_from_row(r: &Row<'_>) -> rusqlite::Result<TodoRow> {
    let project_id: Option<i64> = r.get("project_id")?;
    let project_name: Option<String> = r.get("project_name")?;
    let state_is_completed = r.get::<_, i64>("state_is_completed")? == 1;
    let source: String = r.get("source")?;
    // project_name is the discriminator rather than project_id: a row whose project was deleted
    // out from under it reads back as no project rather than a half-built object.
    let project = match (project_id, project_name) {
        (Some(id), Some(name)) => Some(TodoProject {
            id,
            name,
            color: r.get::<_, Option<String>>("project_color")?.unwrap_or_else(|| DEFAULT_TODO_COLOR.to_string()),
            position: r.get::<_, Option<i64>>("project_position")?.unwrap_or(0),
            created_at: r.get::<_, Option<String>>("project_created_at")?.unwrap_or_default(),
        }),
        _ => None,
    };
    Ok(TodoRow {
        state_is_completed,
        todo: Todo {
            id: r.get("id")?,
            title: r.get("title")?,
            notes: r.get("notes")?,
            state: TodoState {
                id: r.get("state_id")?,
                label: r.get("state_label")?,
                color: r.get("state_color")?,
                position: r.get("state_position")?,
                is_completed: state_is_completed,
                is_default: r.get::<_, i64>("state_is_default")? == 1,
                created_at: r.get("state_created_at")?,
            },
            project,
            labels: vec![],
            milestone: r.get("milestone")?,
            priority: r.get::<_, Option<i64>>("priority")?.unwrap_or(0),
            start_date: r.get("start_date")?,
            due_date: r.get("due_date")?,
            source: TodoSource::parse(&source),
            source_label: r.get("source_label")?,
            parent_id: r.get("parent_id")?,
            parent_title: r.get("parent_title")?,
            child_count: r.get("child_count")?,
            completed_child_count: r.get::<_, Option<i64>>("completed_child_count")?.unwrap_or(0),
            created_at: r.get("created_at")?,
            completed_at: r.get("completed_at")?,
        },
    })
}

fn validate_todo_title(title: &str) -> Result<String> {
    let t = js_trim(title);
    if t.is_empty() {
        return fail("Todo title must be a non-empty string");
    }
    if js_len(t) > MAX_TODO_TITLE_LENGTH {
        return fail(format!("Todo title must be {MAX_TODO_TITLE_LENGTH} characters or fewer"));
    }
    Ok(t.to_string())
}

fn validate_todo_notes(notes: Option<&str>) -> Result<Option<String>> {
    let Some(notes) = notes else { return Ok(None) };
    let t = js_trim(notes);
    if t.is_empty() {
        return Ok(None);
    }
    if js_len(t) > NOTES_MAX_LENGTH {
        return fail(format!("Todo notes must be {NOTES_MAX_LENGTH} characters or fewer"));
    }
    Ok(Some(t.to_string()))
}

/// Optional short free text, blank normalised to null.
fn validate_todo_text_field(value: Option<&str>, field: &str) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let t = js_trim(value);
    if t.is_empty() {
        return Ok(None);
    }
    if js_len(t) > MAX_TODO_TEXT_FIELD_LENGTH {
        return fail(format!("Todo {field} must be {MAX_TODO_TEXT_FIELD_LENGTH} characters or fewer"));
    }
    Ok(Some(t.to_string()))
}

fn validate_todo_date(value: Option<&str>, field: &str) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let t = js_trim(value);
    if t.is_empty() {
        return Ok(None);
    }
    if !matches_date_shape(t) {
        return fail(format!("Todo {field} must be in YYYY-MM-DD format"));
    }
    if !is_valid_iso_date(t) {
        return fail(format!("Todo {field} is not a real date"));
    }
    Ok(Some(t.to_string()))
}

/// Rejects anything outside 0-4 rather than clamping, so a typo from an agent is visible.
fn validate_todo_priority(value: Option<i64>) -> Result<i64> {
    let Some(v) = value else { return Ok(0) };
    if !(0..=MAX_TODO_PRIORITY).contains(&v) {
        return fail(format!(
            "Todo priority must be between 0 and {MAX_TODO_PRIORITY} ({})",
            TODO_PRIORITY_LABELS.join(", ")
        ));
    }
    Ok(v)
}

fn assert_date_order(start: &Option<String>, due: &Option<String>) -> Result<()> {
    if let (Some(s), Some(d)) = (start, due) {
        if s > d {
            return fail("Todo startDate must not be after dueDate");
        }
    }
    Ok(())
}

fn validate_todo_source_label(label: Option<&str>) -> Option<String> {
    let t = js_trim(label?);
    if t.is_empty() {
        return None;
    }
    Some(js_truncate(t, MAX_TODO_SOURCE_LABEL_LENGTH))
}

fn resolve_state_id(db: &Database, state_id: Option<i64>) -> Result<i64> {
    let Some(id) = state_id else { return db.default_state_id() };
    let row =
        optional_row(db.conn().query_row("SELECT id FROM todo_states WHERE id = ?", [id], |r| r.get::<_, i64>(0)))?;
    match row {
        Some(id) => Ok(id),
        None => fail(format!("State with id {id} not found")),
    }
}

/// Rejects an unknown project id up front, so a bad write never reaches the todos table.
fn resolve_project_id(conn: &Connection, project_id: Option<i64>) -> Result<Option<i64>> {
    let Some(id) = project_id else { return Ok(None) };
    let found =
        optional_row(conn.query_row("SELECT id FROM todo_projects WHERE id = ?", [id], |r| r.get::<_, i64>(0)))?;
    if found.is_none() {
        return fail(format!("Project with id {id} not found"));
    }
    Ok(Some(id))
}

/// Validates `parent_id` as the new parent of `child_id`. A todo must never end up inside its own
/// subtree; walking up from the proposed parent catches every depth, and the `seen` set bounds the
/// walk so a cycle already sitting in the data cannot hang the app. `child_id` is `None` on create.
fn resolve_parent_id(conn: &Connection, child_id: Option<i64>, parent_id: i64) -> Result<i64> {
    let parent =
        optional_row(conn.query_row("SELECT id FROM todos WHERE id = ?", [parent_id], |r| r.get::<_, i64>(0)))?;
    if parent.is_none() {
        return fail(format!("Parent todo with id {parent_id} not found"));
    }
    let Some(child_id) = child_id else { return Ok(parent_id) };
    if parent_id == child_id {
        return fail("A todo cannot be its own parent");
    }
    let mut seen: HashSet<i64> = HashSet::new();
    let mut cursor = Some(parent_id);
    while let Some(c) = cursor {
        if seen.contains(&c) {
            break;
        }
        if c == child_id {
            return fail("That would nest the todo inside its own subtree");
        }
        seen.insert(c);
        let next = optional_row(conn.query_row("SELECT parent_id FROM todos WHERE id = ?", [c], |r| {
            r.get::<_, Option<i64>>(0)
        }))?;
        cursor = next.flatten();
    }
    Ok(parent_id)
}

fn is_completed_state(conn: &Connection, state_id: i64) -> Result<bool> {
    let row = optional_row(conn.query_row(
        "SELECT is_completed FROM todo_states WHERE id = ?",
        [state_id],
        |r| r.get::<_, i64>(0),
    ))?;
    Ok(row == Some(1))
}

/// Validates that every label id exists, without writing anything. Must run before the sync hook
/// publishes this create/update: an oplog append cannot be undone by a SQL rollback, so a stale
/// label id discovered later would leave a phantom todo on every peer (B-4).
fn assert_label_ids_exist(conn: &Connection, label_ids: &[i64]) -> Result<()> {
    let mut seen = HashSet::new();
    for id in label_ids {
        if !seen.insert(*id) {
            continue;
        }
        let found =
            optional_row(conn.query_row("SELECT id FROM todo_labels WHERE id = ?", [id], |r| r.get::<_, i64>(0)))?;
        if found.is_none() {
            return fail(format!("Label with id {id} not found"));
        }
    }
    Ok(())
}

fn dedupe(ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    ids.iter().copied().filter(|i| seen.insert(*i)).collect()
}

struct FilterClause {
    where_sql: String,
    params: Vec<Value>,
}

/// The WHERE clause shared by `list_todos` and `count_todos`, so they cannot drift on what
/// "matches the filters" means.
fn build_todo_filter_clause(input: &ListTodosInput) -> FilterClause {
    let filter = input.filter.unwrap_or(TodoFilter::All);
    let mut clauses: Vec<&str> = vec![];
    let mut params: Vec<Value> = vec![];

    match filter {
        TodoFilter::Active => clauses.push("s.is_completed = 0"),
        TodoFilter::Done => clauses.push("s.is_completed = 1"),
        TodoFilter::Ai => clauses.push("t.source = 'ai'"),
        TodoFilter::All => {}
    }
    if let Some(v) = input.state_id {
        clauses.push("t.state_id = ?");
        params.push(Value::Integer(v));
    }
    if let Some(v) = input.project_id {
        clauses.push("t.project_id = ?");
        params.push(Value::Integer(v));
    }
    if let Some(v) = input.label_id {
        // EXISTS rather than a join, so a todo carrying the label once is returned once.
        clauses.push("EXISTS (SELECT 1 FROM todo_label_links k WHERE k.todo_id = t.id AND k.label_id = ?)");
        params.push(Value::Integer(v));
    }
    if let Some(v) = input.parent_id {
        clauses.push("t.parent_id = ?");
        params.push(Value::Integer(v));
    }
    let where_sql = if clauses.is_empty() { String::new() } else { format!(" WHERE {}", clauses.join(" AND ")) };
    FilterClause { where_sql, params }
}

/// What `clear_completed_todos` swept: the row count, and the blobs those rows referenced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearCompletedTodosResult {
    pub count: i64,
    /// Every sha256 whose attachment row was deleted, deduplicated. A sha listed here may still be
    /// referenced by a surviving todo: `count_attachments_by_sha` decides that.
    pub deleted_shas: Vec<String>,
}

impl Database {
    fn attach_labels(&self, rows: Vec<TodoRow>) -> Result<Vec<Todo>> {
        let mut todos: Vec<Todo> = rows.into_iter().map(|r| r.todo).collect();
        let ids: Vec<i64> = todos.iter().map(|t| t.id).collect();
        let mut by_todo = self.labels_by_todo_id(&ids)?;
        for t in &mut todos {
            t.labels = by_todo.remove(&t.id).unwrap_or_default();
        }
        Ok(todos)
    }

    fn todo_row_by_id(&self, id: i64) -> Result<Option<TodoRow>> {
        optional_row(self.conn().query_row(&format!("{TODO_SELECT} WHERE t.id = ?"), [id], todo_from_row))
    }

    fn todo_by_id(&self, id: i64) -> Result<Todo> {
        let Some(row) = self.todo_row_by_id(id)? else {
            return fail(format!("Todo with id {id} not found"));
        };
        Ok(self.attach_labels(vec![row])?.remove(0))
    }

    /// Replaces a todo's whole label set. Callers must already have run `assert_label_ids_exist`
    /// before publishing the same operation to the oplog.
    fn replace_todo_labels(&self, conn: &Connection, todo_id: i64, todo_uuid: &str, label_ids: &[i64]) -> Result<()> {
        let unique = dedupe(label_ids);
        let before: HashSet<i64> = {
            let mut stmt = conn.prepare("SELECT label_id FROM todo_label_links WHERE todo_id = ?")?;
            let ids = stmt.query_map([todo_id], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
            ids
        };
        conn.execute("DELETE FROM todo_label_links WHERE todo_id = ?", [todo_id])?;
        for id in &unique {
            conn.execute("INSERT INTO todo_label_links (todo_id, label_id) VALUES (?, ?)", params![todo_id, id])?;
        }
        let after: HashSet<i64> = unique.iter().copied().collect();
        for id in &before {
            if !after.contains(id) {
                let label_uuid = ensure_uuid(conn, "todo_labels", *id)?;
                self.sync().record_link(conn, "todo_label_links", LinkOp::Unlink, todo_uuid, &label_uuid)?;
            }
        }
        for id in &unique {
            if !before.contains(id) {
                let label_uuid = ensure_uuid(conn, "todo_labels", *id)?;
                self.sync().record_link(conn, "todo_label_links", LinkOp::Link, todo_uuid, &label_uuid)?;
            }
        }
        Ok(())
    }

    pub fn create_todo(&self, input: &CreateTodoInput) -> Result<Todo> {
        let conn = self.conn();
        let title = validate_todo_title(&input.title)?;
        let notes = validate_todo_notes(input.notes.as_deref())?;
        let project_id = resolve_project_id(conn, input.project_id)?;
        let milestone = validate_todo_text_field(input.milestone.as_deref(), "milestone")?;
        let priority = validate_todo_priority(input.priority)?;
        let start_date = validate_todo_date(input.start_date.as_deref(), "startDate")?;
        let due_date = validate_todo_date(input.due_date.as_deref(), "dueDate")?;
        assert_date_order(&start_date, &due_date)?;

        let source = input.source.unwrap_or(TodoSource::User);
        // A source label only makes sense for AI-written todos.
        let source_label =
            if source == TodoSource::Ai { validate_todo_source_label(input.source_label.as_deref()) } else { None };

        let state_id = resolve_state_id(self, input.state_id)?;
        let completed_at = if is_completed_state(conn, state_id)? { Some(now_iso()) } else { None };
        let parent_id = match input.parent_id {
            None => None,
            Some(p) => Some(resolve_parent_id(conn, None, p)?),
        };

        let created_at = now_iso();
        let uuid = new_uuid();

        // The insert and the label links go in together: a todo that briefly exists without the
        // labels it was created with would be visible to a concurrent read on the same connection.
        let tx = conn.unchecked_transaction()?;
        if let Some(label_ids) = &input.label_ids {
            assert_label_ids_exist(&tx, label_ids)?;
        }

        // A device with sync on hands out its own coordination-free ids; otherwise AUTOINCREMENT.
        let explicit_id = self.sync().allocate_todo_id(&tx)?;
        if let Some(explicit) = explicit_id {
            tx.execute(
                "INSERT INTO todos (id, claimed_id, title, notes, state_id, project_id, milestone, priority, start_date, due_date, source, source_label, parent_id, created_at, completed_at, uuid) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    explicit,
                    explicit,
                    title,
                    notes,
                    state_id,
                    project_id,
                    milestone,
                    priority,
                    start_date,
                    due_date,
                    source.as_str(),
                    source_label,
                    parent_id,
                    created_at,
                    completed_at,
                    uuid,
                ],
            )?;
        } else {
            tx.execute(
                "INSERT INTO todos (title, notes, state_id, project_id, milestone, priority, start_date, due_date, source, source_label, parent_id, created_at, completed_at, uuid) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    title,
                    notes,
                    state_id,
                    project_id,
                    milestone,
                    priority,
                    start_date,
                    due_date,
                    source.as_str(),
                    source_label,
                    parent_id,
                    created_at,
                    completed_at,
                    uuid,
                ],
            )?;
        }

        let id: i64 = tx.query_row("SELECT last_insert_rowid() AS id", [], |r| r.get(0))?;
        // Both branches end up claiming the number they were actually given.
        tx.execute("UPDATE todos SET claimed_id = ? WHERE id = ? AND claimed_id IS NULL", params![id, id])?;

        // What travels is the claim -- the number this device issued -- never the resolved id: two
        // machines working apart claim the same number and each derives the same final assignment.
        let state_uuid = ensure_uuid(&tx, "todo_states", state_id)?;
        let project_uuid = match project_id {
            None => None,
            Some(p) => Some(ensure_uuid(&tx, "todo_projects", p)?),
        };
        let parent_uuid = match parent_id {
            None => None,
            Some(p) => Some(ensure_uuid(&tx, "todos", p)?),
        };
        let fields: Fields = vec![
            ("claimed_id", json!(id)),
            ("title", json!(title)),
            ("notes", json!(notes)),
            ("milestone", json!(milestone)),
            ("priority", json!(priority)),
            ("start_date", json!(start_date)),
            ("due_date", json!(due_date)),
            ("source", json!(source.as_str())),
            ("source_label", json!(source_label)),
            ("created_at", json!(created_at)),
            ("completed_at", json!(completed_at)),
            ("state_uuid", json!(state_uuid)),
            ("project_uuid", json!(project_uuid)),
            ("parent_uuid", json!(parent_uuid)),
        ];
        self.sync().record_upsert(&tx, "todos", &uuid, &fields)?;

        if let Some(label_ids) = &input.label_ids {
            self.replace_todo_labels(&tx, id, &uuid, label_ids)?;
        }
        tx.commit()?;

        self.todo_by_id(id)
    }

    pub fn list_todos(&self, input: &ListTodosInput) -> Result<Vec<Todo>> {
        let conn = self.conn();
        // `id` short-circuits every other field.
        if let Some(id) = input.id {
            let mut stmt = conn.prepare(&format!("{TODO_SELECT} WHERE t.id = ?"))?;
            let rows = stmt.query_map([id], todo_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            return self.attach_labels(rows);
        }

        let FilterClause { where_sql, params: mut p } = build_todo_filter_clause(input);
        // Completed sink to the bottom; among the rest, dated before undated and soonest first.
        // `t.id ASC` is pinned last as the only field guaranteed to fully order two tied rows,
        // so a LIMIT/OFFSET page never shows a row twice or misses one.
        let order = " ORDER BY s.is_completed ASC, (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at DESC, t.id ASC";
        let mut sql = format!("{TODO_SELECT}{where_sql}{order}");
        if let Some(limit) = input.limit {
            sql.push_str(" LIMIT ? OFFSET ?");
            p.push(Value::Integer(limit));
            p.push(Value::Integer(input.offset.unwrap_or(0)));
        }
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(p), todo_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        self.attach_labels(rows)
    }

    /// Total rows `list_todos` would match for the same filter fields, ignoring `id`/`limit`/`offset`.
    pub fn count_todos(&self, input: &ListTodosInput) -> Result<i64> {
        let FilterClause { where_sql, params: p } = build_todo_filter_clause(input);
        Ok(self.conn().query_row(
            &format!("SELECT COUNT(*) AS count FROM todos t INNER JOIN todo_states s ON s.id = t.state_id{where_sql}"),
            params_from_iter(p),
            |r| r.get(0),
        )?)
    }

    pub fn update_todo(&self, input: &UpdateTodoInput) -> Result<Todo> {
        let conn = self.conn();
        let Some(existing_row) = self.todo_row_by_id(input.id)? else {
            return fail(format!("Todo with id {} not found", input.id));
        };
        let existing = &existing_row.todo;

        let title = match &input.title {
            None => existing.title.clone(),
            Some(t) => validate_todo_title(t)?,
        };
        let notes = match &input.notes {
            None => existing.notes.clone(),
            Some(n) => validate_todo_notes(n.as_deref())?,
        };
        // Three-way: absent keeps the current project, null clears it, an id moves the todo.
        let project_id = match input.project_id {
            None => self.raw_project_id(input.id)?,
            Some(p) => resolve_project_id(conn, p)?,
        };
        let milestone = match &input.milestone {
            None => existing.milestone.clone(),
            Some(m) => validate_todo_text_field(m.as_deref(), "milestone")?,
        };
        let priority = match input.priority {
            None => existing.priority,
            Some(p) => validate_todo_priority(Some(p))?,
        };
        let start_date = match &input.start_date {
            None => existing.start_date.clone(),
            Some(d) => validate_todo_date(d.as_deref(), "startDate")?,
        };
        let due_date = match &input.due_date {
            None => existing.due_date.clone(),
            Some(d) => validate_todo_date(d.as_deref(), "dueDate")?,
        };
        assert_date_order(&start_date, &due_date)?;

        let state_id = match input.state_id {
            None => existing.state.id,
            Some(s) => resolve_state_id(self, Some(s))?,
        };

        // Three-way: absent leaves the link alone, null lifts the todo to the top level.
        let parent_id = match input.parent_id {
            None => existing.parent_id,
            Some(None) => None,
            Some(Some(p)) => Some(resolve_parent_id(conn, Some(input.id), p)?),
        };

        let was_completed = existing_row.state_is_completed;
        let now_completed = is_completed_state(conn, state_id)?;
        let mut completed_at = existing.completed_at.clone();
        if now_completed && !was_completed {
            completed_at = Some(now_iso());
        } else if !now_completed {
            completed_at = None;
        }
        // Editing a todo that is already completed keeps its original completion time.

        let tx = conn.unchecked_transaction()?;
        if let Some(label_ids) = &input.label_ids {
            assert_label_ids_exist(&tx, label_ids)?;
        }
        tx.execute(
            "UPDATE todos SET title = ?, notes = ?, state_id = ?, project_id = ?, milestone = ?, priority = ?, \
                              start_date = ?, due_date = ?, parent_id = ?, completed_at = ? \
             WHERE id = ?",
            params![
                title,
                notes,
                state_id,
                project_id,
                milestone,
                priority,
                start_date,
                due_date,
                parent_id,
                completed_at,
                input.id,
            ],
        )?;

        let todo_uuid = ensure_uuid(&tx, "todos", input.id)?;
        // Only the fields this call touched go to the oplog: publishing an unchanged field's value
        // would carry this call's fresh HLC, which can outrank a concurrent edit to that field
        // made on another device and silently revert it.
        let mut changed: Fields = vec![("id", json!(input.id))];
        if input.title.is_some() {
            changed.push(("title", json!(title)));
        }
        if input.notes.is_some() {
            changed.push(("notes", json!(notes)));
        }
        if input.milestone.is_some() {
            changed.push(("milestone", json!(milestone)));
        }
        if input.priority.is_some() {
            changed.push(("priority", json!(priority)));
        }
        if input.start_date.is_some() {
            changed.push(("start_date", json!(start_date)));
        }
        if input.due_date.is_some() {
            changed.push(("due_date", json!(due_date)));
        }
        if input.state_id.is_some() {
            changed.push(("state_uuid", json!(ensure_uuid(&tx, "todo_states", state_id)?)));
            changed.push(("completed_at", json!(completed_at)));
        }
        if input.project_id.is_some() {
            let project_uuid = match project_id {
                None => None,
                Some(p) => Some(ensure_uuid(&tx, "todo_projects", p)?),
            };
            changed.push(("project_uuid", json!(project_uuid)));
        }
        if input.parent_id.is_some() {
            let parent_uuid = match parent_id {
                None => None,
                Some(p) => Some(ensure_uuid(&tx, "todos", p)?),
            };
            changed.push(("parent_uuid", json!(parent_uuid)));
        }
        self.sync().record_upsert(&tx, "todos", &todo_uuid, &changed)?;

        // Absent leaves the label set alone; an empty list is a deliberate "remove them all".
        if let Some(label_ids) = &input.label_ids {
            self.replace_todo_labels(&tx, input.id, &todo_uuid, label_ids)?;
        }
        tx.commit()?;

        self.todo_by_id(input.id)
    }

    /// The stored `project_id` even when the joined project row is gone, so "absent keeps the
    /// project" keeps the dangling id instead of silently nulling it.
    fn raw_project_id(&self, todo_id: i64) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row("SELECT project_id FROM todos WHERE id = ?", [todo_id], |r| r.get::<_, Option<i64>>(0))?)
    }

    /// Deletes one todo and lifts its children to the top level. Returns the attachment shas the
    /// todo held, for blob garbage collection.
    pub fn delete_todo(&self, id: i64) -> Result<Vec<String>> {
        let conn = self.conn();
        let uuid = ensure_uuid(conn, "todos", id)?;
        let tx = conn.unchecked_transaction()?;
        // Read before the delete rather than trusting ON DELETE CASCADE: a cascade leaves nothing to read.
        let shas: Vec<String> = {
            let mut stmt = tx.prepare("SELECT sha256 FROM todo_attachments WHERE todo_id = ?")?;
            let v = stmt.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            v
        };
        tx.execute("DELETE FROM todo_attachments WHERE todo_id = ?", [id])?;
        tx.execute("UPDATE todos SET parent_id = NULL WHERE parent_id = ?", [id])?;
        tx.execute("DELETE FROM todos WHERE id = ?", [id])?;
        tx.commit()?;
        self.sync().record_delete(conn, "todos", &uuid)?;
        Ok(shas)
    }

    /// Removes every todo sitting in a completed state.
    pub fn clear_completed_todos(&self) -> Result<ClearCompletedTodosResult> {
        let conn = self.conn();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) AS count FROM todos t INNER JOIN todo_states s ON s.id = t.state_id WHERE s.is_completed = 1",
            [],
            |r| r.get(0),
        )?;
        let tx = conn.unchecked_transaction()?;
        let deleted_shas: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT a.sha256 AS sha256 FROM todo_attachments a \
                 INNER JOIN todos t ON t.id = a.todo_id \
                 INNER JOIN todo_states s ON s.id = t.state_id \
                 WHERE s.is_completed = 1",
            )?;
            let v = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            v
        };
        tx.execute_batch(
            "DELETE FROM todo_attachments WHERE todo_id IN (
               SELECT t.id FROM todos t INNER JOIN todo_states s ON s.id = t.state_id WHERE s.is_completed = 1)",
        )?;
        // Children of a cleared todo survive at the top level, the same as a single delete.
        tx.execute_batch(
            "UPDATE todos SET parent_id = NULL WHERE parent_id IN (
               SELECT t.id FROM todos t INNER JOIN todo_states s ON s.id = t.state_id WHERE s.is_completed = 1)",
        )?;
        tx.execute_batch("DELETE FROM todos WHERE state_id IN (SELECT id FROM todo_states WHERE is_completed = 1)")?;
        tx.commit()?;
        Ok(ClearCompletedTodosResult { count, deleted_shas })
    }

    /// Distinct milestone names already in use, for the autocomplete list.
    pub fn list_todo_milestones(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn().prepare(
            "SELECT DISTINCT milestone FROM todos WHERE milestone IS NOT NULL ORDER BY milestone COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }
}
