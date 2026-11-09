//! Claude Code session tracker: a port of `electron/main/claude-code-tracker.ts`.
//!
//! The TypeScript module reacts to `fs.watch` events and a 30 s fallback poll. This one has no
//! background threads: the app calls [`ClaudeTracker::poll`] on a timer and applies what comes
//! back (a stats update, new-session notices). `poll` does the work of the debounced file
//! watchers, the directory watcher, the sub-agent watchers and the fallback poll in one pass, so
//! a missed event cannot lose data.

use lizmeter_core::{
    ClaudeCodeIdlePeriod, ClaudeCodeLiveStats, ClaudeCodeProject, ClaudeCodeSessionData, ClaudeCodeSessionPreview,
    ClaudeCodeSessionPreviewWithProject, ClaudeSessionActivity, ClaudeSessionActivityType,
};
use lizmeter_db::util::{js_len, js_trim, js_truncate};
use serde_json::Value;
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const SUBAGENT_KEY_PREFIX: &str = "subagent:";
const SESSION_BUFFER_MS: i64 = 120_000;
const MAX_PARTIAL_LINE_UNITS: usize = 1_048_576;
const FIRST_USER_MSG_SCAN_LINES: usize = 100;
const FIRST_USER_MSG_MAX_CHARS: usize = 60;
const NEW_SESSION_EMIT_GAP: Duration = Duration::from_secs(1);

/// `os.homedir()/.claude/projects`.
pub fn default_projects_root() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from);
    home.unwrap_or_else(std::env::temp_dir).join(".claude").join("projects")
}

/// Validates a project directory name and resolves it under `projects_root`. Rejects traversal.
pub fn validate_project_dir_name(projects_root: &Path, dir_name: &str) -> Result<PathBuf, String> {
    if js_trim(dir_name).is_empty() {
        return Err("Project directory name cannot be empty".into());
    }
    if dir_name.contains(['/', '\\']) || dir_name.contains("..") {
        return Err("Invalid project directory name: contains path separators".into());
    }
    let allowed = dir_name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !allowed {
        return Err("Invalid project directory name: contains disallowed characters".into());
    }
    let resolved = projects_root.join(dir_name);
    if !resolved.starts_with(projects_root) || resolved == projects_root {
        return Err("Invalid project directory name: path escapes projects directory".into());
    }
    Ok(resolved)
}

/// Decodes an encoded project directory name to a readable path. Lossy and best effort.
pub fn decode_project_path(dir_name: &str) -> String {
    let b = dir_name.as_bytes();
    if b.len() > 3 && b[0].is_ascii_uppercase() && b[1] == b'-' && b[2] == b'-' {
        return format!("{}:\\{}", b[0] as char, dir_name[3..].replace('-', "\\"));
    }
    format!("/{}", dir_name.replace('-', "/"))
}

/// One parsed JSONL record: only the fields the tracker reads.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonlLine {
    pub kind: String,
    pub timestamp: Option<String>,
    pub content: Option<Value>,
}

/// `parseJsonlLine`: `None` for blank, malformed or non-object lines.
pub fn parse_jsonl_line(raw: &str) -> Option<JsonlLine> {
    let trimmed = js_trim(raw);
    if trimmed.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let obj = value.as_object()?;
    Some(JsonlLine {
        kind: obj.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
        timestamp: obj.get("timestamp").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        content: obj.get("message").and_then(|m| m.get("content")).cloned(),
    })
}

fn tool_use_blocks(line: &JsonlLine) -> Vec<&Value> {
    if line.kind != "assistant" {
        return vec![];
    }
    match &line.content {
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.as_object().is_some_and(|o| o.get("type").and_then(Value::as_str) == Some("tool_use")))
            .collect(),
        _ => vec![],
    }
}

/// Paths written by `Write` / `Edit` tool calls on an assistant line.
pub fn extract_file_edits_from_line(line: &JsonlLine) -> Vec<String> {
    tool_use_blocks(line)
        .into_iter()
        .filter(|b| matches!(b.get("name").and_then(Value::as_str), Some("Write" | "Edit")))
        .filter_map(|b| b.get("input")?.get("file_path")?.as_str())
        .filter(|p| !js_trim(p).is_empty())
        .map(str::to_string)
        .collect()
}

/// Every tool name on an assistant line.
pub fn extract_tool_names_from_line(line: &JsonlLine) -> Vec<String> {
    tool_use_blocks(line).into_iter().filter_map(|b| b.get("name")?.as_str()).map(str::to_string).collect()
}

/// Milliseconds since the epoch for an ISO timestamp, or `None` where JS yields `NaN`.
fn parse_ms(ts: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
        return Some(dt.timestamp_millis());
    }
    let naive = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    naive.and_local_timezone(chrono::Local).single().map(|d| d.timestamp_millis())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, Default)]
pub struct SessionState {
    pub cc_session_uuid: String,
    /// Insertion order, as the JS `Set` keeps it.
    pub files_edited: Vec<String>,
    pub last_message_timestamp: Option<String>,
    pub first_activity_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub idle_periods: Vec<ClaudeCodeIdlePeriod>,
    pub bytes_read: u64,
    pub file_path: PathBuf,
    pub partial_line: String,
    pub last_line_type: Option<String>,
    pub last_tool_names: Vec<String>,
}

impl SessionState {
    fn new(uuid: String, file_path: PathBuf, bytes_read: u64) -> Self {
        SessionState { cc_session_uuid: uuid, file_path, bytes_read, ..Default::default() }
    }
}

/// `processLines`: folds new lines into the session's activity, idle periods and edited files.
pub fn process_lines(state: &mut SessionState, lines: &[JsonlLine], idle_threshold_ms: i64) {
    for line in lines {
        let Some(ts) = &line.timestamp else { continue };
        if state.first_activity_at.is_none() {
            state.first_activity_at = Some(ts.clone());
        }
        state.last_activity_at = Some(ts.clone());

        if let Some(prev) = &state.last_message_timestamp {
            if let (Some(now), Some(before)) = (parse_ms(ts), parse_ms(prev)) {
                let gap = now - before;
                if gap >= idle_threshold_ms {
                    state.idle_periods.push(ClaudeCodeIdlePeriod {
                        start_at: prev.clone(),
                        end_at: ts.clone(),
                        // Math.round on a positive value: halves round up.
                        duration_seconds: (gap as f64 / 1000.0).round() as i64,
                    });
                }
            }
        }
        state.last_message_timestamp = Some(ts.clone());

        state.last_line_type = Some(line.kind.clone());
        if line.kind == "assistant" {
            state.last_tool_names = extract_tool_names_from_line(line);
        } else if line.kind == "user" {
            state.last_tool_names.clear();
        }

        for path in extract_file_edits_from_line(line) {
            if !state.files_edited.contains(&path) {
                state.files_edited.push(path);
            }
        }
    }
}

/// What `read_new_lines` returned.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadResult {
    pub lines: Vec<JsonlLine>,
    pub new_offset: u64,
    pub new_partial_line: String,
}

/// Reads the bytes after `start_offset`, splits complete lines and keeps the unfinished tail.
/// A locked file (sharing violation, access denied) is skipped for this pass.
pub fn read_new_lines(path: &Path, start_offset: u64, partial: &str) -> std::io::Result<ReadResult> {
    let skip = || ReadResult { lines: vec![], new_offset: start_offset, new_partial_line: partial.to_string() };
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) => return Ok(skip()),
        Err(e) => return Err(e),
    };
    let size = file.metadata()?.len();
    if size <= start_offset {
        return Ok(skip());
    }
    file.seek(SeekFrom::Start(start_offset))?;
    let mut buf = Vec::with_capacity((size - start_offset) as usize);
    file.take(size - start_offset).read_to_end(&mut buf)?;

    let content = format!("{partial}{}", String::from_utf8_lossy(&buf));
    let mut raw: Vec<&str> = content.split('\n').collect();
    let tail = raw.pop().unwrap_or("");
    let new_partial_line = if js_len(tail) > MAX_PARTIAL_LINE_UNITS { String::new() } else { tail.to_string() };
    let lines = raw.into_iter().filter_map(parse_jsonl_line).collect();
    Ok(ReadResult { lines, new_offset: start_offset + buf.len() as u64, new_partial_line })
}

fn read_chunk(path: &Path, from_end: bool, max: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    file.seek(SeekFrom::Start(if from_end { size - n } else { 0 })).ok()?;
    let mut buf = Vec::new();
    file.take(n).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Timestamp of the last parsable line in the final 4 KB of the file.
pub fn read_last_line_timestamp(path: &Path) -> Option<String> {
    let chunk = read_chunk(path, true, 4096)?;
    let lines: Vec<&str> = chunk.split('\n').filter(|l| !js_trim(l).is_empty()).collect();
    lines.into_iter().rev().find_map(|l| parse_jsonl_line(l).and_then(|p| p.timestamp))
}

/// First user message in the first 100 lines, at most 60 characters; system-injected text skipped.
pub fn extract_first_user_message(path: &Path) -> Option<String> {
    let chunk = read_chunk(path, false, 16384)?;
    let mut count = 0usize;
    for raw in chunk.split('\n') {
        if count >= FIRST_USER_MSG_SCAN_LINES {
            break;
        }
        let trimmed = js_trim(raw);
        if trimmed.is_empty() {
            continue;
        }
        count += 1;
        let Some(parsed) = parse_jsonl_line(trimmed) else { continue };
        if parsed.kind != "user" {
            continue;
        }
        let text: Option<String> = match &parsed.content {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Array(blocks)) => blocks.iter().find_map(|b| {
                let o = b.as_object()?;
                if o.get("type")?.as_str()? != "text" {
                    return None;
                }
                o.get("text")?.as_str().map(str::to_string)
            }),
            _ => None,
        };
        let Some(text) = text else { continue };
        let t = js_trim(&text);
        if t.is_empty() || t.starts_with('<') {
            continue;
        }
        if js_len(t) <= FIRST_USER_MSG_MAX_CHARS {
            return Some(t.to_string());
        }
        return Some(format!("{}\u{2026}", js_truncate(t, FIRST_USER_MSG_MAX_CHARS - 1)));
    }
    None
}

fn session_uuid_of(file_name: &str) -> &str {
    file_name.strip_suffix(".jsonl").unwrap_or(file_name)
}

fn scan_previews(dir: &Path) -> Vec<ClaudeCodeSessionPreview> {
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let now = now_ms();
    let buffer_start = now - SESSION_BUFFER_MS;
    let mut previews = vec![];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".jsonl") || !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let file_path = entry.path();
        let Some(last) = read_last_line_timestamp(&file_path) else { continue };
        let Some(ms) = parse_ms(&last) else { continue };
        if ms < buffer_start || ms > now {
            continue;
        }
        previews.push(ClaudeCodeSessionPreview {
            cc_session_uuid: session_uuid_of(&name).to_string(),
            last_activity_at: last,
            first_user_message: extract_first_user_message(&file_path),
            file_path: file_path.to_string_lossy().into_owned(),
        });
    }
    previews
}

/// Result of `claude-tracker:scan`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScanResult {
    pub success: bool,
    pub error: Option<String>,
    pub sessions: Vec<ClaudeCodeSessionPreview>,
}

/// What one [`ClaudeTracker::poll`] produced.
#[derive(Debug, Default, PartialEq)]
pub struct PollOutput {
    /// Set when tracked data changed; the `claude-tracker:update` payload.
    pub stats: Option<ClaudeCodeLiveStats>,
    /// `claude-tracker:new-session` payloads, at most one per second.
    pub new_sessions: Vec<ClaudeCodeSessionPreview>,
}

pub struct ClaudeTracker {
    projects_root: PathBuf,
    sessions: Vec<SessionState>,
    frozen: Vec<SessionState>,
    discovered: Vec<ClaudeCodeSessionPreview>,
    tracked: Vec<String>,
    idle_threshold_ms: i64,
    watched_project_path: Option<PathBuf>,
    paused: bool,
    queue: VecDeque<ClaudeCodeSessionPreview>,
    last_emit: Option<Instant>,
    /// Files seen in the project directory, so a poll reports each new one once.
    known_files: BTreeSet<String>,
    dirty: bool,
}

impl ClaudeTracker {
    pub fn new(projects_root: impl Into<PathBuf>) -> Self {
        ClaudeTracker {
            projects_root: projects_root.into(),
            sessions: vec![],
            frozen: vec![],
            discovered: vec![],
            tracked: vec![],
            idle_threshold_ms: 15 * 60 * 1000,
            watched_project_path: None,
            paused: false,
            queue: VecDeque::new(),
            last_emit: None,
            known_files: BTreeSet::new(),
            dirty: false,
        }
    }

    fn is_active(&self) -> bool {
        self.watched_project_path.is_some() || !self.sessions.is_empty() || !self.frozen.is_empty()
    }

    /// Phase 1: scan a project for sessions active in the last two minutes. Starts no tracking.
    pub fn scan_sessions(&mut self, project_dir_name: &str, idle_threshold_minutes: Option<i64>) -> ScanResult {
        if self.is_active() {
            self.destroy();
        }
        let resolved = match validate_project_dir_name(&self.projects_root, project_dir_name) {
            Ok(p) => p,
            Err(error) => return ScanResult { success: false, error: Some(error), sessions: vec![] },
        };
        if !resolved.is_dir() {
            return ScanResult { success: false, error: Some("Project not found".into()), sessions: vec![] };
        }
        self.idle_threshold_ms = idle_threshold_minutes.unwrap_or(5) * 60 * 1000;
        self.watched_project_path = Some(resolved.clone());
        let sessions = scan_previews(&resolved);
        self.discovered = sessions.clone();
        self.known_files = jsonl_names(&resolved);
        let mut sorted = sessions;
        sorted.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
        ScanResult { success: true, error: None, sessions: sorted }
    }

    /// Phase 2: track exactly the selected sessions. Sessions dropped from the set are frozen
    /// (their data is kept for `stop`). `read_from_start` reads new sessions from byte 0.
    pub fn track_selected_sessions(&mut self, uuids: &[String], read_from_start: bool) -> usize {
        for uuid in self.tracked.clone() {
            if uuids.contains(&uuid) {
                continue;
            }
            if let Some(i) = self.sessions.iter().position(|s| s.cc_session_uuid == uuid) {
                let state = self.sessions.remove(i);
                self.frozen.push(state);
            }
            let prefix = format!("{SUBAGENT_KEY_PREFIX}{uuid}/");
            let (sub, keep): (Vec<_>, Vec<_>) =
                std::mem::take(&mut self.sessions).into_iter().partition(|s| s.cc_session_uuid.starts_with(&prefix));
            self.sessions = keep;
            self.frozen.extend(sub);
            self.tracked.retain(|u| *u != uuid);
        }

        for uuid in uuids {
            if self.tracked.contains(uuid) {
                continue;
            }
            // A session deselected earlier comes back with the data it had gathered.
            if self.frozen.iter().any(|s| s.cc_session_uuid == *uuid) {
                let prefix = format!("{SUBAGENT_KEY_PREFIX}{uuid}/");
                let (back, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.frozen)
                    .into_iter()
                    .partition(|s| s.cc_session_uuid == *uuid || s.cc_session_uuid.starts_with(&prefix));
                self.frozen = keep;
                self.sessions.extend(back);
                self.tracked.push(uuid.clone());
                continue;
            }
            let Some(preview) = self.discovered.iter().find(|s| s.cc_session_uuid == *uuid).cloned() else { continue };
            let Ok(meta) = fs::metadata(&preview.file_path) else { continue };
            let start = if read_from_start { 0 } else { meta.len() };
            self.sessions.push(SessionState::new(uuid.clone(), PathBuf::from(&preview.file_path), start));
            self.tracked.push(uuid.clone());
            self.scan_subagents(uuid);
        }
        self.dirty = true;
        self.tracked.len()
    }

    /// Tracks every `agent-*.jsonl` under `<project>/<parent>/subagents/` not tracked yet.
    fn scan_subagents(&mut self, parent: &str) -> bool {
        let Some(project) = self.watched_project_path.clone() else { return false };
        let dir = project.join(parent).join("subagents");
        let Ok(entries) = fs::read_dir(&dir) else { return false };
        let mut found = false;
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("agent-") && n.ends_with(".jsonl"))
            .collect();
        names.sort();
        for name in names {
            let key = format!("{SUBAGENT_KEY_PREFIX}{parent}/{name}");
            if self.sessions.iter().any(|s| s.cc_session_uuid == key) {
                continue;
            }
            let mut state = SessionState::new(key, dir.join(&name), 0);
            // A full read from byte 0 reflects an already-active sub-agent at once.
            if let Ok(read) = read_new_lines(&state.file_path, 0, "") {
                state.bytes_read = read.new_offset;
                state.partial_line = read.new_partial_line;
                process_lines(&mut state, &read.lines, self.idle_threshold_ms);
                self.sessions.push(state);
                found = true;
            }
        }
        found
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    fn process_file(&mut self, index: usize) -> bool {
        let idle = self.idle_threshold_ms;
        let state = &mut self.sessions[index];
        let Ok(read) = read_new_lines(&state.file_path, state.bytes_read, &state.partial_line) else { return false };
        let changed = read.new_offset != state.bytes_read;
        state.bytes_read = read.new_offset;
        state.partial_line = read.new_partial_line;
        if !read.lines.is_empty() {
            process_lines(state, &read.lines, idle);
        }
        changed
    }

    /// One pass of everything the watchers and the fallback poll do. Call it every ~500 ms.
    pub fn poll(&mut self) -> PollOutput {
        let mut out = PollOutput::default();
        let mut changed = std::mem::take(&mut self.dirty);

        if !self.paused {
            for i in 0..self.sessions.len() {
                if self.process_file(i) {
                    changed = true;
                }
            }
            for parent in self.tracked.clone() {
                if self.scan_subagents(&parent) {
                    changed = true;
                }
            }
        }

        // The directory watcher keeps running while paused.
        if let Some(project) = self.watched_project_path.clone() {
            let current = jsonl_names(&project);
            let fresh: Vec<String> = current.difference(&self.known_files).cloned().collect();
            self.known_files = current;
            for name in fresh {
                let uuid = session_uuid_of(&name).to_string();
                if self.tracked.contains(&uuid)
                    || self.discovered.iter().any(|s| s.cc_session_uuid == uuid)
                    || self.frozen.iter().any(|s| s.cc_session_uuid == uuid)
                {
                    continue;
                }
                let file_path = project.join(&name);
                let Some(last) = read_last_line_timestamp(&file_path) else {
                    // No timestamp yet: look again once the session writes its first record.
                    self.known_files.remove(&name);
                    continue;
                };
                let preview = ClaudeCodeSessionPreview {
                    cc_session_uuid: uuid.clone(),
                    last_activity_at: last,
                    first_user_message: extract_first_user_message(&file_path),
                    file_path: file_path.to_string_lossy().into_owned(),
                };
                self.discovered.push(preview.clone());
                if !self.tracked.is_empty() {
                    let mut all = self.tracked.clone();
                    all.push(uuid.clone());
                    self.track_selected_sessions(&all, true);
                    // Read the new session's history now so this update already carries it.
                    if let Some(i) = self.sessions.iter().position(|s| s.cc_session_uuid == uuid) {
                        self.process_file(i);
                    }
                    changed = true;
                } else {
                    self.queue.push_back(preview);
                }
            }
        }

        if let Some(next) = self.next_new_session() {
            out.new_sessions.push(next);
        }
        if changed || self.dirty {
            self.dirty = false;
            out.stats = Some(self.aggregate_stats());
        }
        out
    }

    fn next_new_session(&mut self) -> Option<ClaudeCodeSessionPreview> {
        if self.queue.is_empty() {
            return None;
        }
        if self.last_emit.is_some_and(|t| t.elapsed() < NEW_SESSION_EMIT_GAP) {
            return None;
        }
        self.last_emit = Some(Instant::now());
        self.queue.pop_front()
    }

    /// Live stats across all tracked sessions.
    pub fn aggregate_stats(&self) -> ClaudeCodeLiveStats {
        let mut all_files: Vec<String> = vec![];
        for s in &self.sessions {
            for f in &s.files_edited {
                if !all_files.contains(f) {
                    all_files.push(f.clone());
                }
            }
        }
        let now = now_ms();
        let mut last: Option<String> = None;
        let mut idle = 0;
        for s in &self.sessions {
            if let Some(at) = &s.last_activity_at {
                if last.as_ref().is_none_or(|l| at > l) {
                    last = Some(at.clone());
                }
                if parse_ms(at).is_some_and(|ms| now - ms > self.idle_threshold_ms) {
                    idle += 1;
                }
            }
        }
        ClaudeCodeLiveStats {
            active_sessions: self.sessions.len() as i64,
            total_files_edited: all_files.len() as i64,
            files_edited_list: all_files,
            last_activity_timestamp: last,
            idle_sessions: idle,
            session_activity: derive_activity(&self.sessions),
            error: None,
        }
    }

    /// Final read of every active file, then every session's data; clears the tracker.
    pub fn stop_and_get_data(&mut self) -> Vec<ClaudeCodeSessionData> {
        for i in 0..self.sessions.len() {
            self.process_file(i);
        }
        let result = self
            .sessions
            .iter()
            .chain(self.frozen.iter())
            .map(|s| ClaudeCodeSessionData {
                cc_session_uuid: s.cc_session_uuid.clone(),
                file_edit_count: s.files_edited.len() as i64,
                total_idle_seconds: s.idle_periods.iter().map(|p| p.duration_seconds).sum(),
                idle_period_count: s.idle_periods.len() as i64,
                first_activity_at: s.first_activity_at.clone(),
                last_activity_at: s.last_activity_at.clone(),
                files_edited: s.files_edited.clone(),
                idle_periods: s.idle_periods.clone(),
            })
            .collect();
        self.destroy();
        result
    }

    /// Releases everything. Safe to call twice.
    pub fn destroy(&mut self) {
        self.sessions.clear();
        self.frozen.clear();
        self.discovered.clear();
        self.tracked.clear();
        self.queue.clear();
        self.known_files.clear();
        self.last_emit = None;
        self.watched_project_path = None;
        self.paused = false;
        self.dirty = false;
    }

    /// Every project directory, sorted by its display path.
    pub fn get_projects(&self) -> Vec<ClaudeCodeProject> {
        let Ok(entries) = fs::read_dir(&self.projects_root) else { return vec![] };
        let mut projects: Vec<ClaudeCodeProject> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| {
                let dir_name = e.file_name().to_string_lossy().into_owned();
                ClaudeCodeProject { display_path: decode_project_path(&dir_name), dir_name }
            })
            .collect();
        projects.sort_by(|a, b| locale_compare(&a.display_path, &b.display_path));
        projects
    }

    /// Lightweight scan of every project for sessions active in the last two minutes.
    pub fn scan_all_projects(&self) -> Vec<ClaudeCodeSessionPreviewWithProject> {
        let Ok(entries) = fs::read_dir(&self.projects_root) else { return vec![] };
        let mut all = vec![];
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().into_owned();
            let display = decode_project_path(&dir_name);
            for preview in scan_previews(&entry.path()) {
                all.push(ClaudeCodeSessionPreviewWithProject {
                    preview,
                    project_dir_name: dir_name.clone(),
                    project_display_path: display.clone(),
                });
            }
        }
        all.sort_by(|a, b| b.preview.last_activity_at.cmp(&a.preview.last_activity_at));
        all
    }
}

/// `String.prototype.localeCompare` for the ASCII-leaning paths shown here: case-insensitive
/// first, lower case before upper case on a tie.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| s.chars().flat_map(char::to_lowercase).collect::<Vec<char>>();
    key(a).cmp(&key(b)).then_with(|| b.cmp(a))
}

fn jsonl_names(dir: &Path) -> BTreeSet<String> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".jsonl"))
                .collect()
        })
        .unwrap_or_default()
}

/// Priority: thinking > tool_use > idle, across all tracked sessions.
fn derive_activity(states: &[SessionState]) -> Option<ClaudeSessionActivity> {
    if states.is_empty() {
        return None;
    }
    let mut thinking = false;
    let mut best_tool: Option<&SessionState> = None;
    let mut idle = false;
    for s in states {
        let (Some(kind), Some(at)) = (&s.last_line_type, &s.last_activity_at) else { continue };
        match kind.as_str() {
            "user" => thinking = true,
            "assistant" if !s.last_tool_names.is_empty() => {
                if best_tool.is_none_or(|b| Some(at) > b.last_activity_at.as_ref()) {
                    best_tool = Some(s);
                }
            }
            "assistant" => idle = true,
            _ => {}
        }
    }
    if thinking {
        return Some(ClaudeSessionActivity { kind: ClaudeSessionActivityType::Thinking, tool_names: None });
    }
    if let Some(s) = best_tool {
        return Some(ClaudeSessionActivity {
            kind: ClaudeSessionActivityType::ToolUse,
            tool_names: Some(s.last_tool_names.clone()),
        });
    }
    idle.then_some(ClaudeSessionActivity { kind: ClaudeSessionActivityType::Idle, tool_names: None })
}
