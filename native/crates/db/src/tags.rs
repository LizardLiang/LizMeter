//! Session tags (`database.ts` tag section).

use crate::error::{fail, Result};
use crate::sync_hook::{ensure_uuid, LinkOp};
use crate::util::{js_len, js_trim, new_uuid, now_iso};
use crate::Database;
use lizmeter_core::{AssignTagInput, CreateTagInput, Tag, UpdateTagInput, TODO_COLORS};
use rusqlite::{params, Row};
use serde_json::json;

const MAX_TAG_NAME_LENGTH: usize = 32;

/// The eight tag colours: the todo palette without the muted grey.
fn is_valid_tag_color(color: &str) -> bool {
    TODO_COLORS[..8].contains(&color)
}

fn validate_tag_name(name: &str) -> Result<String> {
    let trimmed = js_trim(name);
    if trimmed.is_empty() {
        return fail("Tag name must be a non-empty string");
    }
    if js_len(trimmed) > MAX_TAG_NAME_LENGTH {
        return fail(format!("Tag name must be {MAX_TAG_NAME_LENGTH} characters or fewer"));
    }
    Ok(trimmed.to_string())
}

fn validate_tag_color(color: &str) -> Result<String> {
    if !is_valid_tag_color(color) {
        return fail(format!("Invalid tag color. Must be one of: {}", TODO_COLORS[..8].join(", ")));
    }
    Ok(color.to_string())
}

pub(crate) fn tag_from_row(r: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, created_at: r.get(3)? })
}

impl Database {
    pub fn create_tag(&self, input: &CreateTagInput) -> Result<Tag> {
        let conn = self.conn();
        let name = validate_tag_name(&input.name)?;
        let color = validate_tag_color(&input.color)?;
        let created_at = now_iso();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO tags (name, color, created_at, uuid) VALUES (?, ?, ?, ?)",
            params![name, color, created_at, uuid],
        )?;
        self.sync().record_upsert(
            conn,
            "tags",
            &uuid,
            &vec![("name", json!(name)), ("color", json!(color)), ("created_at", json!(created_at))],
        )?;
        Ok(conn.query_row(
            "SELECT id, name, color, created_at FROM tags WHERE name = ? COLLATE NOCASE",
            [&name],
            tag_from_row,
        )?)
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let mut stmt = self.conn().prepare("SELECT id, name, color, created_at FROM tags ORDER BY name ASC")?;
        let tags = stmt.query_map([], tag_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tags)
    }

    pub fn update_tag(&self, input: &UpdateTagInput) -> Result<Tag> {
        let conn = self.conn();
        let name = validate_tag_name(&input.name)?;
        let color = validate_tag_color(&input.color)?;
        let changes = conn.execute(
            "UPDATE tags SET name = ?, color = ? WHERE id = ?",
            params![name, color, input.id],
        )?;
        if changes == 0 {
            return fail(format!("Tag with id {} not found", input.id));
        }
        let uuid = ensure_uuid(conn, "tags", input.id)?;
        self.sync().record_upsert(conn, "tags", &uuid, &vec![("name", json!(name)), ("color", json!(color))])?;
        Ok(conn.query_row("SELECT id, name, color, created_at FROM tags WHERE id = ?", [input.id], tag_from_row)?)
    }

    pub fn delete_tag(&self, id: i64) -> Result<()> {
        let conn = self.conn();
        let uuid = ensure_uuid(conn, "tags", id)?;
        conn.execute("DELETE FROM tags WHERE id = ?", [id])?;
        self.sync().record_delete(conn, "tags", &uuid)
    }

    pub fn assign_tag(&self, input: &AssignTagInput) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)",
            params![input.session_id, input.tag_id],
        )?;
        let tag_uuid = ensure_uuid(conn, "tags", input.tag_id)?;
        self.sync().record_link(conn, "session_tags", LinkOp::Link, &input.session_id, &tag_uuid)
    }

    pub fn unassign_tag(&self, input: &AssignTagInput) -> Result<()> {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?",
            params![input.session_id, input.tag_id],
        )?;
        let tag_uuid = ensure_uuid(conn, "tags", input.tag_id)?;
        self.sync().record_link(conn, "session_tags", LinkOp::Unlink, &input.session_id, &tag_uuid)
    }

    pub fn list_tags_for_session(&self, session_id: &str) -> Result<Vec<Tag>> {
        let mut stmt = self.conn().prepare(
            "SELECT t.id, t.name, t.color, t.created_at FROM tags t \
             INNER JOIN session_tags st ON st.tag_id = t.id WHERE st.session_id = ? ORDER BY t.name ASC",
        )?;
        let tags = stmt.query_map([session_id], tag_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tags)
    }
}
