//! Todo states, projects and labels (`database.ts` todo metadata sections).

use crate::error::{fail, Result};
use crate::sync_hook::{ensure_uuid, Fields};
use crate::util::{js_len, js_trim, new_uuid, now_iso};
use crate::{optional_row, placeholders, Database};
use lizmeter_core::{
    CreateTodoLabelInput, CreateTodoProjectInput, CreateTodoStateInput, TodoLabel, TodoProject, TodoState,
    UpdateTodoLabelInput, UpdateTodoProjectInput, UpdateTodoStateInput, DEFAULT_TODO_COLOR, TODO_COLORS,
};
use rusqlite::{params, params_from_iter, Connection, Row};
use serde_json::json;
use std::collections::{HashMap, HashSet};

const MAX_TODO_STATE_LABEL_LENGTH: usize = 32;
const MAX_TODO_PROJECT_NAME_LENGTH: usize = 60;
const MAX_TODO_LABEL_NAME_LENGTH: usize = 40;

const TODO_STATE_COLUMNS: &str = "id, label, color, position, is_completed, is_default, created_at";
const TODO_PROJECT_COLUMNS: &str = "id, name, color, position, created_at";
const TODO_LABEL_COLUMNS: &str = "id, name, color, created_at";

pub(crate) fn state_from_row(r: &Row<'_>) -> rusqlite::Result<TodoState> {
    Ok(TodoState {
        id: r.get(0)?,
        label: r.get(1)?,
        color: r.get(2)?,
        position: r.get(3)?,
        is_completed: r.get::<_, i64>(4)? == 1,
        is_default: r.get::<_, i64>(5)? == 1,
        created_at: r.get(6)?,
    })
}

fn project_from_row(r: &Row<'_>) -> rusqlite::Result<TodoProject> {
    Ok(TodoProject { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, position: r.get(3)?, created_at: r.get(4)? })
}

pub(crate) fn label_from_row(r: &Row<'_>) -> rusqlite::Result<TodoLabel> {
    Ok(TodoLabel { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, created_at: r.get(3)? })
}

/// States, projects and labels all draw from one palette, so one check serves all three.
fn validate_palette_color(color: &str, kind: &str) -> Result<String> {
    if !TODO_COLORS.contains(&color) {
        return fail(format!("Invalid {kind} color. Must be one of: {}", TODO_COLORS.join(", ")));
    }
    Ok(color.to_string())
}

fn validate_text(value: &str, empty_msg: &str, max: usize, too_long: &str) -> Result<String> {
    let t = js_trim(value);
    if t.is_empty() {
        return fail(empty_msg);
    }
    if js_len(t) > max {
        return fail(too_long);
    }
    Ok(t.to_string())
}

fn validate_state_label(label: &str) -> Result<String> {
    validate_text(
        label,
        "State label must be a non-empty string",
        MAX_TODO_STATE_LABEL_LENGTH,
        &format!("State label must be {MAX_TODO_STATE_LABEL_LENGTH} characters or fewer"),
    )
}

fn validate_project_name(name: &str) -> Result<String> {
    validate_text(
        name,
        "Project name must be a non-empty string",
        MAX_TODO_PROJECT_NAME_LENGTH,
        &format!("Project name must be {MAX_TODO_PROJECT_NAME_LENGTH} characters or fewer"),
    )
}

fn validate_label_name(name: &str) -> Result<String> {
    validate_text(
        name,
        "Label name must be a non-empty string",
        MAX_TODO_LABEL_NAME_LENGTH,
        &format!("Label name must be {MAX_TODO_LABEL_NAME_LENGTH} characters or fewer"),
    )
}

/// Ids in `ordered`, then the rest of `all` in their existing order. Unknown ids are an error.
fn final_order(all: &[i64], ordered: &[i64], kind: &str) -> Result<Vec<i64>> {
    let known: HashSet<i64> = all.iter().copied().collect();
    for id in ordered {
        if !known.contains(id) {
            return fail(format!("{kind} with id {id} not found"));
        }
    }
    let seen: HashSet<i64> = ordered.iter().copied().collect();
    let mut out = ordered.to_vec();
    out.extend(all.iter().copied().filter(|id| !seen.contains(id)));
    Ok(out)
}

fn ids_by_position(conn: &Connection, table: &str) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(&format!("SELECT id FROM {table} ORDER BY position ASC"))?;
    let ids = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
    Ok(ids)
}

/// Keeps positions contiguous after a delete so reordering stays predictable.
fn renumber_positions(conn: &Connection, table: &str) -> Result<()> {
    for (index, id) in ids_by_position(conn, table)?.into_iter().enumerate() {
        conn.execute(&format!("UPDATE {table} SET position = ? WHERE id = ?"), params![index as i64, id])?;
    }
    Ok(())
}

impl Database {
    // --- States ---

    pub fn list_todo_states(&self) -> Result<Vec<TodoState>> {
        let mut stmt =
            self.conn().prepare(&format!("SELECT {TODO_STATE_COLUMNS} FROM todo_states ORDER BY position ASC"))?;
        let rows = stmt.query_map([], state_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Resolves a state by label, case-insensitively.
    pub fn find_todo_state_by_label(&self, label: &str) -> Result<Option<TodoState>> {
        optional_row(self.conn().query_row(
            &format!("SELECT {TODO_STATE_COLUMNS} FROM todo_states WHERE label = ? COLLATE NOCASE"),
            [js_trim(label)],
            state_from_row,
        ))
    }

    pub fn create_todo_state(&self, input: &CreateTodoStateInput) -> Result<TodoState> {
        let conn = self.conn();
        let label = validate_state_label(&input.label)?;
        let color = match &input.color {
            None => "#7aa2f7".to_string(),
            Some(c) => validate_palette_color(c, "state")?,
        };
        let existing = optional_row(conn.query_row(
            "SELECT id FROM todo_states WHERE label = ? COLLATE NOCASE",
            [&label],
            |r| r.get::<_, i64>(0),
        ))?;
        if existing.is_some() {
            return fail(format!("A state named \"{label}\" already exists"));
        }
        let next: i64 =
            conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_states", [], |r| r.get(0))?;
        let created_at = now_iso();
        let uuid = new_uuid();
        let tx = self.begin_txn()?;
        tx.execute(
            "INSERT INTO todo_states (label, color, position, is_completed, is_default, created_at, uuid) VALUES (?, ?, ?, 0, 0, ?, ?)",
            params![label, color, next, created_at, uuid],
        )?;
        // last_insert_rowid() is connection-global: read before the sync hook runs SQL of its own.
        let row = tx.query_row(
            &format!("SELECT {TODO_STATE_COLUMNS} FROM todo_states WHERE id = last_insert_rowid()"),
            [],
            state_from_row,
        )?;
        // Flags publish as 0/1, never booleans: better-sqlite3 cannot bind a boolean.
        self.sync().record_upsert(
            &tx,
            "todo_states",
            &uuid,
            &vec![
                ("label", json!(label)),
                ("color", json!(color)),
                ("is_completed", json!(0)),
                ("is_default", json!(0)),
                ("created_at", json!(created_at)),
            ],
        )?;
        tx.commit()?;
        Ok(row)
    }

    pub fn update_todo_state(&self, input: &UpdateTodoStateInput) -> Result<TodoState> {
        let conn = self.conn();
        let Some(existing) = optional_row(conn.query_row(
            &format!("SELECT {TODO_STATE_COLUMNS} FROM todo_states WHERE id = ?"),
            [input.id],
            state_from_row,
        ))?
        else {
            return fail(format!("State with id {} not found", input.id));
        };

        let label = match &input.label {
            None => existing.label.clone(),
            Some(l) => validate_state_label(l)?,
        };
        let color = match &input.color {
            None => existing.color.clone(),
            Some(c) => validate_palette_color(c, "state")?,
        };

        if label.to_lowercase() != existing.label.to_lowercase() {
            let clash = optional_row(conn.query_row(
                "SELECT id FROM todo_states WHERE label = ? COLLATE NOCASE AND id != ?",
                params![label, input.id],
                |r| r.get::<_, i64>(0),
            ))?;
            if clash.is_some() {
                return fail(format!("A state named \"{label}\" already exists"));
            }
        }

        let is_completed = input.is_completed.unwrap_or(existing.is_completed);
        let is_default = input.is_default.unwrap_or(existing.is_default);

        // At least one state must mean "completed", or todo_complete has nowhere to go.
        if !is_completed && existing.is_completed {
            let count: i64 =
                conn.query_row("SELECT COUNT(*) AS count FROM todo_states WHERE is_completed = 1", [], |r| r.get(0))?;
            if count <= 1 {
                return fail("At least one state must be marked as completed");
            }
        }
        if !is_default && existing.is_default {
            return fail("Pick another state as the default rather than clearing this one");
        }

        let tx = self.begin_txn()?;
        // Default and completed are single-winner flags.
        if is_default {
            tx.execute("UPDATE todo_states SET is_default = 0 WHERE id != ?", [input.id])?;
        }
        if is_completed {
            tx.execute("UPDATE todo_states SET is_completed = 0 WHERE id != ?", [input.id])?;
        }
        tx.execute(
            "UPDATE todo_states SET label = ?, color = ?, is_completed = ?, is_default = ? WHERE id = ?",
            params![label, color, i64::from(is_completed), i64::from(is_default), input.id],
        )?;

        // Only fields this call touched go to the oplog: re-publishing an untouched field would
        // carry a fresh HLC that can silently revert a concurrent edit made on another device.
        let mut changed: Fields = vec![];
        if input.label.is_some() {
            changed.push(("label", json!(label)));
        }
        if input.color.is_some() {
            changed.push(("color", json!(color)));
        }
        if input.is_completed.is_some() {
            changed.push(("is_completed", json!(i64::from(is_completed))));
        }
        if input.is_default.is_some() {
            changed.push(("is_default", json!(i64::from(is_default))));
        }
        let uuid = ensure_uuid(&tx, "todo_states", input.id)?;
        self.sync().record_upsert(&tx, "todo_states", &uuid, &changed)?;
        tx.commit()?;

        Ok(conn.query_row(
            &format!("SELECT {TODO_STATE_COLUMNS} FROM todo_states WHERE id = ?"),
            [input.id],
            state_from_row,
        )?)
    }

    /// Deletes a state and moves every todo using it onto `reassign_to_id`. Returns how many moved.
    pub fn delete_todo_state(&self, id: i64, reassign_to_id: i64) -> Result<i64> {
        let conn = self.conn();
        let target = optional_row(conn.query_row(
            "SELECT id, is_default, is_completed FROM todo_states WHERE id = ?",
            [id],
            |r| Ok((r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
        ))?;
        let Some((is_default, is_completed)) = target else {
            return fail(format!("State with id {id} not found"));
        };
        if id == reassign_to_id {
            return fail("Cannot reassign todos to the state being deleted");
        }
        let replacement = optional_row(conn.query_row(
            "SELECT id FROM todo_states WHERE id = ?",
            [reassign_to_id],
            |r| r.get::<_, i64>(0),
        ))?;
        if replacement.is_none() {
            return fail(format!("State with id {reassign_to_id} not found"));
        }
        if is_default == 1 {
            return fail("Pick another default state before deleting this one");
        }
        if is_completed == 1 {
            return fail("Pick another completed state before deleting this one");
        }

        let count: i64 =
            conn.query_row("SELECT COUNT(*) AS count FROM todos WHERE state_id = ?", [id], |r| r.get(0))?;
        let uuid = ensure_uuid(conn, "todo_states", id)?;

        let tx = self.begin_txn()?;
        tx.execute("UPDATE todos SET state_id = ? WHERE state_id = ?", params![reassign_to_id, id])?;
        tx.execute("DELETE FROM todo_states WHERE id = ?", [id])?;
        renumber_positions(&tx, "todo_states")?;
        self.sync().record_delete(&tx, "todo_states", &uuid)?;
        tx.commit()?;
        Ok(count)
    }

    /// Rewrites positions to match the given order. Ids not listed keep their relative order at the end.
    pub fn reorder_todo_states(&self, ordered_ids: &[i64]) -> Result<Vec<TodoState>> {
        let conn = self.conn();
        let all = ids_by_position(conn, "todo_states")?;
        let order = final_order(&all, ordered_ids, "State")?;
        let tx = self.begin_txn()?;
        for (index, id) in order.iter().enumerate() {
            tx.execute("UPDATE todo_states SET position = ? WHERE id = ?", params![index as i64, id])?;
        }
        self.sync().record_reorder(&tx, "todo_states", &order)?;
        tx.commit()?;
        self.list_todo_states()
    }

    // --- Projects ---

    pub fn list_todo_projects(&self) -> Result<Vec<TodoProject>> {
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {TODO_PROJECT_COLUMNS} FROM todo_projects ORDER BY position ASC"))?;
        let rows = stmt.query_map([], project_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn find_todo_project_by_name(&self, name: &str) -> Result<Option<TodoProject>> {
        optional_row(self.conn().query_row(
            &format!("SELECT {TODO_PROJECT_COLUMNS} FROM todo_projects WHERE name = ? COLLATE NOCASE"),
            [js_trim(name)],
            project_from_row,
        ))
    }

    pub fn create_todo_project(&self, input: &CreateTodoProjectInput) -> Result<TodoProject> {
        let conn = self.conn();
        let name = validate_project_name(&input.name)?;
        let color = match &input.color {
            None => DEFAULT_TODO_COLOR.to_string(),
            Some(c) => validate_palette_color(c, "project")?,
        };
        let existing = optional_row(conn.query_row(
            "SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE",
            [&name],
            |r| r.get::<_, i64>(0),
        ))?;
        if existing.is_some() {
            return fail(format!("A project named \"{name}\" already exists"));
        }
        let next: i64 =
            conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects", [], |r| r.get(0))?;
        let created_at = now_iso();
        let uuid = new_uuid();
        let tx = self.begin_txn()?;
        tx.execute(
            "INSERT INTO todo_projects (name, color, position, created_at, uuid) VALUES (?, ?, ?, ?, ?)",
            params![name, color, next, created_at, uuid],
        )?;
        let row = tx.query_row(
            &format!("SELECT {TODO_PROJECT_COLUMNS} FROM todo_projects WHERE id = last_insert_rowid()"),
            [],
            project_from_row,
        )?;
        self.sync().record_upsert(
            &tx,
            "todo_projects",
            &uuid,
            &vec![("name", json!(name)), ("color", json!(color)), ("created_at", json!(created_at))],
        )?;
        tx.commit()?;
        Ok(row)
    }

    pub fn update_todo_project(&self, input: &UpdateTodoProjectInput) -> Result<TodoProject> {
        let conn = self.conn();
        let Some(existing) = optional_row(conn.query_row(
            &format!("SELECT {TODO_PROJECT_COLUMNS} FROM todo_projects WHERE id = ?"),
            [input.id],
            project_from_row,
        ))?
        else {
            return fail(format!("Project with id {} not found", input.id));
        };
        let name = match &input.name {
            None => existing.name.clone(),
            Some(n) => validate_project_name(n)?,
        };
        let color = match &input.color {
            None => existing.color.clone(),
            Some(c) => validate_palette_color(c, "project")?,
        };
        if name.to_lowercase() != existing.name.to_lowercase() {
            let clash = optional_row(conn.query_row(
                "SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE AND id != ?",
                params![name, input.id],
                |r| r.get::<_, i64>(0),
            ))?;
            if clash.is_some() {
                return fail(format!("A project named \"{name}\" already exists"));
            }
        }
        let tx = self.begin_txn()?;
        tx.execute("UPDATE todo_projects SET name = ?, color = ? WHERE id = ?", params![name, color, input.id])?;
        let mut changed: Fields = vec![];
        if input.name.is_some() {
            changed.push(("name", json!(name)));
        }
        if input.color.is_some() {
            changed.push(("color", json!(color)));
        }
        let uuid = ensure_uuid(&tx, "todo_projects", input.id)?;
        self.sync().record_upsert(&tx, "todo_projects", &uuid, &changed)?;
        tx.commit()?;
        Ok(conn.query_row(
            &format!("SELECT {TODO_PROJECT_COLUMNS} FROM todo_projects WHERE id = ?"),
            [input.id],
            project_from_row,
        )?)
    }

    /// Deletes a project and clears it from every todo that held it. Returns how many todos changed.
    pub fn delete_todo_project(&self, id: i64) -> Result<i64> {
        let conn = self.conn();
        let target =
            optional_row(conn.query_row("SELECT id FROM todo_projects WHERE id = ?", [id], |r| r.get::<_, i64>(0)))?;
        if target.is_none() {
            return fail(format!("Project with id {id} not found"));
        }
        let count: i64 =
            conn.query_row("SELECT COUNT(*) AS count FROM todos WHERE project_id = ?", [id], |r| r.get(0))?;
        let uuid = ensure_uuid(conn, "todo_projects", id)?;

        let tx = self.begin_txn()?;
        // Explicit rather than relying on ON DELETE SET NULL: an upgraded database added the
        // column by ALTER TABLE, and the pragma is not guaranteed to have been on for those rows.
        tx.execute("UPDATE todos SET project_id = NULL WHERE project_id = ?", [id])?;
        tx.execute("DELETE FROM todo_projects WHERE id = ?", [id])?;
        renumber_positions(&tx, "todo_projects")?;
        self.sync().record_delete(&tx, "todo_projects", &uuid)?;
        tx.commit()?;
        Ok(count)
    }

    pub fn reorder_todo_projects(&self, ordered_ids: &[i64]) -> Result<Vec<TodoProject>> {
        let conn = self.conn();
        let all = ids_by_position(conn, "todo_projects")?;
        let order = final_order(&all, ordered_ids, "Project")?;
        let tx = self.begin_txn()?;
        for (index, id) in order.iter().enumerate() {
            tx.execute("UPDATE todo_projects SET position = ? WHERE id = ?", params![index as i64, id])?;
        }
        self.sync().record_reorder(&tx, "todo_projects", &order)?;
        tx.commit()?;
        self.list_todo_projects()
    }

    // --- Labels ---

    /// Name-ordered rather than position-ordered: labels are a set, not a sequence.
    pub fn list_todo_labels(&self) -> Result<Vec<TodoLabel>> {
        let mut stmt = self
            .conn()
            .prepare(&format!("SELECT {TODO_LABEL_COLUMNS} FROM todo_labels ORDER BY name COLLATE NOCASE ASC"))?;
        let rows = stmt.query_map([], label_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn find_todo_label_by_name(&self, name: &str) -> Result<Option<TodoLabel>> {
        optional_row(self.conn().query_row(
            &format!("SELECT {TODO_LABEL_COLUMNS} FROM todo_labels WHERE name = ? COLLATE NOCASE"),
            [js_trim(name)],
            label_from_row,
        ))
    }

    /// Get-or-create: typing an existing name into the label picker means "use that one".
    pub fn create_todo_label(&self, input: &CreateTodoLabelInput) -> Result<TodoLabel> {
        let conn = self.conn();
        let name = validate_label_name(&input.name)?;
        let color = match &input.color {
            None => DEFAULT_TODO_COLOR.to_string(),
            Some(c) => validate_palette_color(c, "label")?,
        };
        let existing = optional_row(conn.query_row(
            &format!("SELECT {TODO_LABEL_COLUMNS} FROM todo_labels WHERE name = ? COLLATE NOCASE"),
            [&name],
            label_from_row,
        ))?;
        if let Some(l) = existing {
            return Ok(l);
        }
        let created_at = now_iso();
        let uuid = new_uuid();
        let tx = self.begin_txn()?;
        tx.execute(
            "INSERT INTO todo_labels (name, color, created_at, uuid) VALUES (?, ?, ?, ?)",
            params![name, color, created_at, uuid],
        )?;
        let row = tx.query_row(
            &format!("SELECT {TODO_LABEL_COLUMNS} FROM todo_labels WHERE id = last_insert_rowid()"),
            [],
            label_from_row,
        )?;
        self.sync().record_upsert(
            &tx,
            "todo_labels",
            &uuid,
            &vec![("name", json!(name)), ("color", json!(color)), ("created_at", json!(created_at))],
        )?;
        tx.commit()?;
        Ok(row)
    }

    pub fn update_todo_label(&self, input: &UpdateTodoLabelInput) -> Result<TodoLabel> {
        let conn = self.conn();
        let Some(existing) = optional_row(conn.query_row(
            &format!("SELECT {TODO_LABEL_COLUMNS} FROM todo_labels WHERE id = ?"),
            [input.id],
            label_from_row,
        ))?
        else {
            return fail(format!("Label with id {} not found", input.id));
        };
        let name = match &input.name {
            None => existing.name.clone(),
            Some(n) => validate_label_name(n)?,
        };
        let color = match &input.color {
            None => existing.color.clone(),
            Some(c) => validate_palette_color(c, "label")?,
        };
        if name.to_lowercase() != existing.name.to_lowercase() {
            let clash = optional_row(conn.query_row(
                "SELECT id FROM todo_labels WHERE name = ? COLLATE NOCASE AND id != ?",
                params![name, input.id],
                |r| r.get::<_, i64>(0),
            ))?;
            if clash.is_some() {
                return fail(format!("A label named \"{name}\" already exists"));
            }
        }
        let tx = self.begin_txn()?;
        tx.execute("UPDATE todo_labels SET name = ?, color = ? WHERE id = ?", params![name, color, input.id])?;
        let mut changed: Fields = vec![];
        if input.name.is_some() {
            changed.push(("name", json!(name)));
        }
        if input.color.is_some() {
            changed.push(("color", json!(color)));
        }
        let uuid = ensure_uuid(&tx, "todo_labels", input.id)?;
        self.sync().record_upsert(&tx, "todo_labels", &uuid, &changed)?;
        tx.commit()?;
        Ok(conn.query_row(
            &format!("SELECT {TODO_LABEL_COLUMNS} FROM todo_labels WHERE id = ?"),
            [input.id],
            label_from_row,
        )?)
    }

    /// Detaches the label from every todo, then deletes it. Returns how many todos lost it.
    pub fn delete_todo_label(&self, id: i64) -> Result<i64> {
        let conn = self.conn();
        let target =
            optional_row(conn.query_row("SELECT id FROM todo_labels WHERE id = ?", [id], |r| r.get::<_, i64>(0)))?;
        if target.is_none() {
            return fail(format!("Label with id {id} not found"));
        }
        let count: i64 =
            conn.query_row("SELECT COUNT(*) AS count FROM todo_label_links WHERE label_id = ?", [id], |r| r.get(0))?;
        let uuid = ensure_uuid(conn, "todo_labels", id)?;

        let tx = self.begin_txn()?;
        tx.execute("DELETE FROM todo_label_links WHERE label_id = ?", [id])?;
        tx.execute("DELETE FROM todo_labels WHERE id = ?", [id])?;
        self.sync().record_delete(&tx, "todo_labels", &uuid)?;
        tx.commit()?;
        Ok(count)
    }

    /// Every label for the given todos in one query, keyed by todo id. One extra query per list
    /// call beats one query per todo.
    pub(crate) fn labels_by_todo_id(&self, todo_ids: &[i64]) -> Result<HashMap<i64, Vec<TodoLabel>>> {
        let mut by_todo: HashMap<i64, Vec<TodoLabel>> = HashMap::new();
        if todo_ids.is_empty() {
            return Ok(by_todo);
        }
        let mut stmt = self.conn().prepare(&format!(
            "SELECT k.todo_id, l.id, l.name, l.color, l.created_at \
             FROM todo_label_links k INNER JOIN todo_labels l ON l.id = k.label_id \
             WHERE k.todo_id IN ({}) ORDER BY l.name COLLATE NOCASE ASC",
            placeholders(todo_ids.len())
        ))?;
        let rows = stmt.query_map(params_from_iter(todo_ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                TodoLabel { id: r.get(1)?, name: r.get(2)?, color: r.get(3)?, created_at: r.get(4)? },
            ))
        })?;
        for row in rows {
            let (todo_id, label) = row?;
            by_todo.entry(todo_id).or_default().push(label);
        }
        Ok(by_todo)
    }
}
