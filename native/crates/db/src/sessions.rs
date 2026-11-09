//! Sessions, Claude Code tracking data and worklog status (`database.ts` session section).

use crate::error::{fail, Result};
use crate::sync_hook::Fields;
use crate::util::{js_trim, js_truncate, new_uuid, now_iso};
use crate::{optional_row, Database};
use lizmeter_core::{
    ClaudeCodeIdlePeriod, ClaudeCodeSessionData, ClaudeCodeSessionSummary, IssueProviderKind, ListSessionsInput,
    ListSessionsResult, SaveSessionInput, SaveSessionWithTrackingInput, Session, Tag, TimerType, WorklogStatus,
    MAX_TITLE_LENGTH,
};
use rusqlite::{params, Row};
use serde_json::{json, Value};

const SESSION_COLUMNS: &str = "id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at, \
     issue_number, issue_title, issue_url, issue_provider, issue_id, worklog_status, worklog_id";

fn session_from_row(row: &Row<'_>, tags: Vec<Tag>) -> rusqlite::Result<Session> {
    let timer_type: String = row.get("timer_type")?;
    let provider: Option<String> = row.get("issue_provider")?;
    let worklog: Option<String> = row.get("worklog_status")?;
    Ok(Session {
        id: row.get("id")?,
        title: row.get("title")?,
        // A stored value outside the enum would be a corrupt row; fall back to work rather than fail the page.
        timer_type: TimerType::parse(&timer_type).unwrap_or(TimerType::Work),
        planned_duration_seconds: row.get("planned_duration_seconds")?,
        actual_duration_seconds: row.get("actual_duration_seconds")?,
        completed_at: row.get("completed_at")?,
        tags,
        issue_number: row.get("issue_number")?,
        issue_title: row.get("issue_title")?,
        issue_url: row.get("issue_url")?,
        issue_provider: provider.as_deref().and_then(IssueProviderKind::parse),
        issue_id: row.get("issue_id")?,
        worklog_status: WorklogStatus::parse(worklog.as_deref().unwrap_or("not_logged")),
        worklog_id: row.get("worklog_id")?,
    })
}

fn sanitize_title(title: &str) -> String {
    js_truncate(js_trim(title), MAX_TITLE_LENGTH)
}

fn validate_session_input(input: &SaveSessionInput) -> Result<String> {
    let title = sanitize_title(&input.title);
    if input.timer_type == TimerType::Stopwatch {
        if input.planned_duration_seconds < 0 {
            return fail(format!("Invalid plannedDurationSeconds: {}", input.planned_duration_seconds));
        }
    } else if input.planned_duration_seconds <= 0 {
        return fail(format!("Invalid plannedDurationSeconds: {}", input.planned_duration_seconds));
    }
    if input.actual_duration_seconds < 0 {
        return fail(format!("Invalid actualDurationSeconds: {}", input.actual_duration_seconds));
    }
    Ok(title)
}

fn build_session_result(id: String, title: String, input: &SaveSessionInput, completed_at: String) -> Session {
    Session {
        id,
        title,
        timer_type: input.timer_type,
        planned_duration_seconds: input.planned_duration_seconds,
        actual_duration_seconds: input.actual_duration_seconds,
        completed_at,
        tags: vec![],
        issue_number: input.issue_number,
        issue_title: input.issue_title.clone(),
        issue_url: input.issue_url.clone(),
        issue_provider: input.issue_provider,
        issue_id: input.issue_id.clone(),
        worklog_status: WorklogStatus::NotLogged,
        worklog_id: None,
    }
}

fn session_upsert_fields(title: &str, input: &SaveSessionInput, completed_at: &str) -> Fields {
    vec![
        ("title", json!(title)),
        ("timer_type", json!(input.timer_type.as_str())),
        ("planned_duration_seconds", json!(input.planned_duration_seconds)),
        ("actual_duration_seconds", json!(input.actual_duration_seconds)),
        ("completed_at", json!(completed_at)),
        ("issue_number", json!(input.issue_number)),
        ("issue_title", json!(input.issue_title)),
        ("issue_url", json!(input.issue_url)),
        ("issue_provider", json!(input.issue_provider.map(IssueProviderKind::as_str))),
        ("issue_id", json!(input.issue_id)),
    ]
}

const INSERT_SESSION: &str = "INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at, issue_number, issue_title, issue_url, issue_provider, issue_id) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

impl Database {
    pub fn save_session(&self, input: &SaveSessionInput) -> Result<Session> {
        let title = validate_session_input(input)?;
        let id = new_uuid();
        let completed_at = now_iso();

        self.conn().execute(
            INSERT_SESSION,
            params![
                id,
                title,
                input.timer_type.as_str(),
                input.planned_duration_seconds,
                input.actual_duration_seconds,
                completed_at,
                input.issue_number,
                input.issue_title,
                input.issue_url,
                input.issue_provider.map(IssueProviderKind::as_str),
                input.issue_id,
            ],
        )?;
        self.sync().record_upsert(self.conn(), "sessions", &id, &session_upsert_fields(&title, input, &completed_at))?;
        Ok(build_session_result(id, title, input, completed_at))
    }

    /// Saves a session and its Claude Code tracking rows atomically. Tracking data is
    /// machine-local and never syncs.
    pub fn save_session_with_tracking(&self, input: &SaveSessionWithTrackingInput) -> Result<Session> {
        let plain = SaveSessionInput {
            title: input.title.clone(),
            timer_type: input.timer_type,
            planned_duration_seconds: input.planned_duration_seconds,
            actual_duration_seconds: input.actual_duration_seconds,
            issue_number: input.issue_number,
            issue_title: input.issue_title.clone(),
            issue_url: input.issue_url.clone(),
            issue_provider: input.issue_provider,
            issue_id: input.issue_id.clone(),
        };
        let title = validate_session_input(&plain)?;
        let id = new_uuid();
        let completed_at = now_iso();

        let tx = self.conn().unchecked_transaction()?;
        tx.execute(
            INSERT_SESSION,
            params![
                id,
                title,
                plain.timer_type.as_str(),
                plain.planned_duration_seconds,
                plain.actual_duration_seconds,
                completed_at,
                plain.issue_number,
                plain.issue_title,
                plain.issue_url,
                plain.issue_provider.map(IssueProviderKind::as_str),
                plain.issue_id,
            ],
        )?;
        self.sync().record_upsert(&tx, "sessions", &id, &session_upsert_fields(&title, &plain, &completed_at))?;

        if let Some(cc_sessions) = &input.claude_code_sessions {
            for cc in cc_sessions {
                insert_cc_session(&tx, &id, cc)?;
            }
        }
        tx.commit()?;
        Ok(build_session_result(id, title, &plain, completed_at))
    }

    pub fn list_sessions(&self, input: &ListSessionsInput) -> Result<ListSessionsResult> {
        let conn = self.conn();
        let limit = input.limit.unwrap_or(50);
        let offset = input.offset.unwrap_or(0);

        let (raw, total): (Vec<Session>, i64) = if let Some(tag_id) = input.tag_id {
            let cols = SESSION_COLUMNS.split(", ").map(|c| format!("s.{c}")).collect::<Vec<_>>().join(", ");
            let mut stmt = conn.prepare(&format!(
                "SELECT {cols} FROM sessions s \
                 INNER JOIN session_tags st ON st.session_id = s.id AND st.tag_id = ? \
                 ORDER BY s.completed_at DESC LIMIT ? OFFSET ?"
            ))?;
            let rows = stmt
                .query_map(params![tag_id, limit, offset], |r| session_from_row(r, vec![]))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let total: i64 = conn.query_row(
                "SELECT COUNT(*) as count FROM sessions s INNER JOIN session_tags st ON st.session_id = s.id AND st.tag_id = ?",
                [tag_id],
                |r| r.get(0),
            )?;
            (rows, total)
        } else {
            let mut stmt = conn.prepare(&format!(
                "SELECT {SESSION_COLUMNS} FROM sessions ORDER BY completed_at DESC LIMIT ? OFFSET ?"
            ))?;
            let rows = stmt
                .query_map(params![limit, offset], |r| session_from_row(r, vec![]))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let total: i64 = conn.query_row("SELECT COUNT(*) as count FROM sessions", [], |r| r.get(0))?;
            (rows, total)
        };

        let mut sessions = raw;
        for s in &mut sessions {
            s.tags = self.list_tags_for_session(&s.id)?;
        }
        Ok(ListSessionsResult { sessions, total })
    }

    pub fn get_session_by_id(&self, id: &str) -> Result<Option<Session>> {
        let row = optional_row(self.conn().query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?"),
            [id],
            |r| session_from_row(r, vec![]),
        ))?;
        match row {
            None => Ok(None),
            Some(mut s) => {
                s.tags = self.list_tags_for_session(id)?;
                Ok(Some(s))
            }
        }
    }

    /// No-op if the id does not exist.
    pub fn delete_session(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM sessions WHERE id = ?", [id])?;
        self.sync().record_delete(self.conn(), "sessions", id)
    }

    pub fn update_session_duration(&self, id: &str, actual_duration_seconds: i64) -> Result<Session> {
        self.conn().execute(
            "UPDATE sessions SET actual_duration_seconds = ? WHERE id = ?",
            params![actual_duration_seconds, id],
        )?;
        self.sync().record_upsert(
            self.conn(),
            "sessions",
            id,
            &vec![("actual_duration_seconds", json!(actual_duration_seconds))],
        )?;
        match self.get_session_by_id(id)? {
            Some(s) => Ok(s),
            None => fail(format!("Session not found after update: {id}")),
        }
    }

    pub fn update_worklog_status(&self, session_id: &str, status: WorklogStatus, worklog_id: Option<&str>) -> Result<()> {
        let conn = self.conn();
        let mut fields: Vec<(&'static str, Value)> = vec![("worklog_status", json!(status.as_str()))];
        if let Some(wid) = worklog_id {
            conn.execute(
                "UPDATE sessions SET worklog_status = ?, worklog_id = ? WHERE id = ?",
                params![status.as_str(), wid, session_id],
            )?;
            fields.push(("worklog_id", json!(wid)));
        } else {
            conn.execute(
                "UPDATE sessions SET worklog_status = ? WHERE id = ?",
                params![status.as_str(), session_id],
            )?;
        }
        self.sync().record_upsert(conn, "sessions", session_id, &fields)
    }

    pub fn get_claude_code_data_for_session(&self, session_id: &str) -> Result<Option<Vec<ClaudeCodeSessionSummary>>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, cc_session_uuid, file_edit_count, total_idle_seconds, idle_period_count, \
                    first_activity_at, last_activity_at, files_edited \
             FROM claude_code_sessions WHERE session_id = ? ORDER BY first_activity_at ASC",
        )?;
        type CcRow = (String, String, i64, i64, i64, Option<String>, Option<String>, String);
        let cc_rows: Vec<CcRow> = stmt
            .query_map([session_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        if cc_rows.is_empty() {
            return Ok(None);
        }

        let mut idle_stmt = conn.prepare(
            "SELECT start_at, end_at, duration_seconds FROM claude_code_idle_periods \
             WHERE cc_session_id = ? ORDER BY start_at ASC",
        )?;
        let mut sessions = Vec::with_capacity(cc_rows.len());
        for (id, uuid, edits, idle_secs, idle_count, first, last, files_json) in cc_rows {
            let idle_periods = idle_stmt
                .query_map([&id], |r| {
                    Ok(ClaudeCodeIdlePeriod { start_at: r.get(0)?, end_at: r.get(1)?, duration_seconds: r.get(2)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let files_edited: Vec<String> = serde_json::from_str(&files_json).unwrap_or_default();
            sessions.push(ClaudeCodeSessionSummary {
                id,
                data: ClaudeCodeSessionData {
                    cc_session_uuid: uuid,
                    file_edit_count: edits,
                    total_idle_seconds: idle_secs,
                    idle_period_count: idle_count,
                    first_activity_at: first,
                    last_activity_at: last,
                    files_edited,
                    idle_periods,
                },
            });
        }
        Ok(Some(sessions))
    }
}

fn insert_cc_session(conn: &rusqlite::Connection, session_id: &str, cc: &ClaudeCodeSessionData) -> Result<()> {
    let cc_id = new_uuid();
    let files_json = serde_json::to_string(&cc.files_edited)?;
    // SELECT-before-INSERT keeps the save idempotent per (session, cc uuid).
    let existing = optional_row(conn.query_row(
        "SELECT id FROM claude_code_sessions WHERE session_id = ? AND cc_session_uuid = ?",
        params![session_id, cc.cc_session_uuid],
        |r| r.get::<_, String>(0),
    ))?;
    if existing.is_some() {
        return Ok(());
    }
    conn.execute(
        "INSERT OR IGNORE INTO claude_code_sessions \
         (id, session_id, cc_session_uuid, file_edit_count, total_idle_seconds, idle_period_count, first_activity_at, last_activity_at, files_edited) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            cc_id,
            session_id,
            cc.cc_session_uuid,
            cc.file_edit_count,
            cc.total_idle_seconds,
            cc.idle_period_count,
            cc.first_activity_at,
            cc.last_activity_at,
            files_json,
        ],
    )?;
    for p in &cc.idle_periods {
        conn.execute(
            "INSERT INTO claude_code_idle_periods (cc_session_id, start_at, end_at, duration_seconds) VALUES (?, ?, ?, ?)",
            params![cc_id, p.start_at, p.end_at, p.duration_seconds],
        )?;
    }
    Ok(())
}
