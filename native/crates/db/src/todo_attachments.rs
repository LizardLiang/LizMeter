//! Todo attachments (`database.ts` attachment section).

use crate::attachment_url::{attachment_kind_for_ext, attachment_url, ext_from_file_name};
use crate::error::{fail, Result};
use crate::sync_hook::{attachment_row_key, ensure_uuid};
use crate::util::now_iso;
use crate::{optional_row, Database};
use lizmeter_core::{TodoAttachment, TodoAttachmentKind};
use rusqlite::{params, Row};
use serde_json::json;

const ATTACHMENT_SELECT: &str =
    "SELECT id, todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at FROM todo_attachments";

/// The on-disk extension is derived from `file_name` rather than stored in its own column, because
/// the blob store derives the blob's name the same way: one helper, one answer.
fn attachment_from_row(r: &Row<'_>) -> rusqlite::Result<TodoAttachment> {
    let sha256: String = r.get("sha256")?;
    let file_name: String = r.get("file_name")?;
    let kind: String = r.get("kind")?;
    let url = attachment_url(&sha256, &ext_from_file_name(&file_name));
    Ok(TodoAttachment {
        id: r.get("id")?,
        todo_id: r.get("todo_id")?,
        sha256,
        file_name,
        mime_type: r.get("mime_type")?,
        size_bytes: r.get("size_bytes")?,
        kind: TodoAttachmentKind::parse(&kind),
        url,
        created_at: r.get("created_at")?,
    })
}

#[derive(Debug, Clone)]
pub struct CreateTodoAttachmentInput {
    pub todo_id: i64,
    /// Lower-case hex sha256 of the file contents, as returned by the blob store.
    pub sha256: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    /// Defaults to the classification of the file name's extension.
    pub kind: Option<TodoAttachmentKind>,
}

impl Database {
    /// Attaches a stored blob to a todo. Attaching the same sha to the same todo again returns the
    /// existing row: pasting one screenshot twice gives one entry, not a duplicate or an error.
    pub fn create_todo_attachment(&self, input: &CreateTodoAttachmentInput) -> Result<TodoAttachment> {
        let conn = self.conn();
        let todo_exists =
            optional_row(conn.query_row("SELECT id FROM todos WHERE id = ?", [input.todo_id], |r| r.get::<_, i64>(0)))?;
        if todo_exists.is_none() {
            return fail(format!("Todo {} not found", input.todo_id));
        }

        let existing = optional_row(conn.query_row(
            &format!("{ATTACHMENT_SELECT} WHERE todo_id = ? AND sha256 = ?"),
            params![input.todo_id, input.sha256],
            attachment_from_row,
        ))?;
        if let Some(e) = existing {
            return Ok(e);
        }

        let kind = input.kind.unwrap_or_else(|| attachment_kind_for_ext(&ext_from_file_name(&input.file_name)));
        conn.execute(
            "INSERT INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                input.todo_id,
                input.sha256,
                input.file_name,
                input.mime_type,
                input.size_bytes,
                kind.as_str(),
                now_iso(),
            ],
        )?;

        // Read before the sync hook runs any SQL of its own: last_insert_rowid() is connection-global.
        let row = conn.query_row(
            &format!("{ATTACHMENT_SELECT} WHERE id = last_insert_rowid()"),
            [],
            attachment_from_row,
        )?;

        let todo_uuid = ensure_uuid(conn, "todos", input.todo_id)?;
        self.sync().record_upsert(
            conn,
            "todo_attachments",
            &attachment_row_key(&todo_uuid, &input.sha256),
            &vec![
                ("file_name", json!(input.file_name)),
                ("mime_type", json!(input.mime_type)),
                ("size_bytes", json!(input.size_bytes)),
                ("kind", json!(kind.as_str())),
            ],
        )?;
        Ok(row)
    }

    /// Every attachment on one todo, oldest first.
    pub fn list_todo_attachments(&self, todo_id: i64) -> Result<Vec<TodoAttachment>> {
        let mut stmt = self.conn().prepare(&format!("{ATTACHMENT_SELECT} WHERE todo_id = ? ORDER BY id ASC"))?;
        let rows = stmt.query_map([todo_id], attachment_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_todo_attachment(&self, id: i64) -> Result<Option<TodoAttachment>> {
        optional_row(self.conn().query_row(&format!("{ATTACHMENT_SELECT} WHERE id = ?"), [id], attachment_from_row))
    }

    /// Deletes one attachment row and hands back what it deleted, so the caller can collect the blob.
    pub fn delete_todo_attachment(&self, id: i64) -> Result<Option<TodoAttachment>> {
        let Some(existing) = self.get_todo_attachment(id)? else { return Ok(None) };
        let conn = self.conn();
        conn.execute("DELETE FROM todo_attachments WHERE id = ?", [id])?;
        let todo_uuid = ensure_uuid(conn, "todos", existing.todo_id)?;
        self.sync().record_delete(conn, "todo_attachments", &attachment_row_key(&todo_uuid, &existing.sha256))?;
        Ok(Some(existing))
    }

    /// How many rows still reference a blob: the refcount that keeps a shared image alive when one
    /// of the two todos embedding it is deleted.
    pub fn count_attachments_by_sha(&self, sha256: &str) -> Result<i64> {
        Ok(self.conn().query_row(
            "SELECT COUNT(*) AS count FROM todo_attachments WHERE sha256 = ?",
            [sha256],
            |r| r.get(0),
        )?)
    }

    /// Every distinct sha still referenced; the orphan sweep diffs the attachments folder against this.
    pub fn list_all_attachment_shas(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn().prepare("SELECT DISTINCT sha256 FROM todo_attachments")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }
}
