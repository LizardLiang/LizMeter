//! Shared types mirroring `src/shared/types.ts`. Field names serialize to the same
//! camelCase JSON the Electron build exchanges with the renderer, the pipe and the DB layer.

use serde::{Deserialize, Serialize};

// --- Timer ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimerType {
    Work,
    ShortBreak,
    LongBreak,
    Stopwatch,
}

impl TimerType {
    pub fn as_str(self) -> &'static str {
        match self {
            TimerType::Work => "work",
            TimerType::ShortBreak => "short_break",
            TimerType::LongBreak => "long_break",
            TimerType::Stopwatch => "stopwatch",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "work" => TimerType::Work,
            "short_break" => TimerType::ShortBreak,
            "long_break" => TimerType::LongBreak,
            "stopwatch" => TimerType::Stopwatch,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppMode {
    Pomodoro,
    TimeTracking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimerStatus {
    Idle,
    Running,
    Paused,
    Completed,
}

// --- Sessions ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorklogStatus {
    NotLogged,
    Logged,
    Failed,
}

impl WorklogStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorklogStatus::NotLogged => "not_logged",
            WorklogStatus::Logged => "logged",
            WorklogStatus::Failed => "failed",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "logged" => WorklogStatus::Logged,
            "failed" => WorklogStatus::Failed,
            _ => WorklogStatus::NotLogged,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueProviderKind {
    Github,
    Linear,
    Jira,
    Todo,
}

impl IssueProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueProviderKind::Github => "github",
            IssueProviderKind::Linear => "linear",
            IssueProviderKind::Jira => "jira",
            IssueProviderKind::Todo => "todo",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "github" => IssueProviderKind::Github,
            "linear" => IssueProviderKind::Linear,
            "jira" => IssueProviderKind::Jira,
            "todo" => IssueProviderKind::Todo,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub timer_type: TimerType,
    pub planned_duration_seconds: i64,
    pub actual_duration_seconds: i64,
    pub completed_at: String,
    pub tags: Vec<Tag>,
    pub issue_number: Option<i64>,
    pub issue_title: Option<String>,
    pub issue_url: Option<String>,
    pub issue_provider: Option<IssueProviderKind>,
    pub issue_id: Option<String>,
    pub worklog_status: WorklogStatus,
    pub worklog_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogLogInput {
    pub session_id: String,
    pub issue_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_time_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_override: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklogLogResult {
    pub worklog_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionInput {
    pub title: String,
    pub timer_type: TimerType,
    pub planned_duration_seconds: i64,
    pub actual_duration_seconds: i64,
    #[serde(default)]
    pub issue_number: Option<i64>,
    #[serde(default)]
    pub issue_title: Option<String>,
    #[serde(default)]
    pub issue_url: Option<String>,
    #[serde(default)]
    pub issue_provider: Option<IssueProviderKind>,
    #[serde(default)]
    pub issue_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsInput {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub tag_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResult {
    pub sessions: Vec<Session>,
    pub total: i64,
}

// --- Settings ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerSettings {
    pub work_duration: i64,
    pub short_break_duration: i64,
    pub long_break_duration: i64,
}

pub const DEFAULT_SETTINGS: TimerSettings = TimerSettings {
    work_duration: 1500,
    short_break_duration: 300,
    long_break_duration: 900,
};

pub const MIN_DURATION: i64 = 1;
pub const MAX_DURATION: i64 = 7200;
pub const MAX_TITLE_LENGTH: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopwatchSettings {
    pub max_duration_seconds: i64,
    pub prompt_for_issue: bool,
}

// --- Tags ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagInput {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTagInput {
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignTagInput {
    pub session_id: String,
    pub tag_id: i64,
}

// --- Todos ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoSource {
    User,
    Ai,
}

impl TodoSource {
    pub fn as_str(self) -> &'static str {
        match self {
            TodoSource::User => "user",
            TodoSource::Ai => "ai",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "ai" {
            TodoSource::Ai
        } else {
            TodoSource::User
        }
    }
}

pub const TODO_PRIORITY_LABELS: [&str; 5] = ["No priority", "Urgent", "High", "Medium", "Low"];
pub const MAX_TODO_PRIORITY: i64 = 4;
pub const NOTES_MAX_LENGTH: usize = 32_000;

pub fn todo_priority_label(priority: i64) -> &'static str {
    usize::try_from(priority)
        .ok()
        .and_then(|i| TODO_PRIORITY_LABELS.get(i))
        .copied()
        .unwrap_or(TODO_PRIORITY_LABELS[0])
}

pub const TODO_COLORS: [&str; 9] = [
    "#7aa2f7", "#bb9af7", "#7dcfff", "#9ece6a", "#f7768e", "#ff9e64", "#e0af68", "#c678dd",
    "#565f89",
];
pub const DEFAULT_TODO_COLOR: &str = TODO_COLORS[0];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoState {
    pub id: i64,
    pub label: String,
    pub color: String,
    pub position: i64,
    pub is_completed: bool,
    pub is_default: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoStateInput {
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoStateInput {
    pub id: i64,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub is_completed: Option<bool>,
    #[serde(default)]
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoProject {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoProjectInput {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoProjectInput {
    pub id: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoLabel {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoLabelInput {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoLabelInput {
    pub id: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    pub notes: Option<String>,
    pub state: TodoState,
    pub project: Option<TodoProject>,
    pub labels: Vec<TodoLabel>,
    pub milestone: Option<String>,
    pub priority: i64,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub source: TodoSource,
    pub source_label: Option<String>,
    pub parent_id: Option<i64>,
    pub parent_title: Option<String>,
    pub child_count: i64,
    pub completed_child_count: i64,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// Three-way field helper: absent -> `None`, explicit `null` -> `Some(None)`, value -> `Some(Some(v))`.
pub mod nullable {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn deserialize<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(d).map(Some)
    }

    pub fn serialize<T, S>(v: &Option<Option<T>>, s: S) -> Result<S::Ok, S::Error>
    where
        T: Serialize,
        S: Serializer,
    {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoInput {
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub state_id: Option<i64>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub label_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub milestone: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub source: Option<TodoSource>,
    #[serde(default)]
    pub source_label: Option<String>,
    #[serde(default)]
    pub parent_id: Option<i64>,
}

/// Three-way fields use `Option<Option<T>>`: outer `None` = absent (keep), `Some(None)` = clear.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoInput {
    pub id: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    pub notes: Option<Option<String>>,
    #[serde(default)]
    pub state_id: Option<i64>,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Option<i64>>,
    #[serde(default)]
    pub label_ids: Option<Vec<i64>>,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    pub milestone: Option<Option<String>>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    pub start_date: Option<Option<String>>,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    pub due_date: Option<Option<String>>,
    #[serde(default, with = "nullable", skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<Option<i64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoFilter {
    All,
    Active,
    Done,
    Ai,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTodosInput {
    #[serde(default)]
    pub filter: Option<TodoFilter>,
    #[serde(default)]
    pub state_id: Option<i64>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub label_id: Option<i64>,
    #[serde(default)]
    pub parent_id: Option<i64>,
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

// --- Attachments ---

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TodoAttachmentKind {
    Image,
    File,
}

impl TodoAttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TodoAttachmentKind::Image => "image",
            TodoAttachmentKind::File => "file",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "image" {
            TodoAttachmentKind::Image
        } else {
            TodoAttachmentKind::File
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoAttachment {
    pub id: i64,
    pub todo_id: i64,
    pub sha256: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub kind: TodoAttachmentKind,
    pub url: String,
    pub created_at: String,
}

/// Opens the OS file picker, then attaches whatever was chosen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTodoAttachmentInput {
    pub todo_id: i64,
}

/// Paste or drop: the caller already holds the bytes, so no picker is involved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddTodoAttachmentBufferInput {
    pub todo_id: i64,
    pub file_name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

pub const ATTACHMENT_MAX_BYTES: u64 = 25 * 1024 * 1024;
pub const ATTACHMENT_IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "avif"];

// --- Issues ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssueLabel {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub state: String,
    pub labels: Vec<IssueLabel>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueProviderStatus {
    pub configured: bool,
    pub provider: Option<String>,
    pub linear_configured: bool,
    pub linear_team_selected: bool,
    pub jira_configured: bool,
    pub jira_domain_set: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinearIssueState {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
    pub priority: i64,
    pub state: LinearIssueState,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinearTeam {
    pub id: String,
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProviderStatus {
    pub configured: bool,
    pub team_selected: bool,
    pub team_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JiraAuthType {
    Cloud,
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    pub id: String,
    pub key: String,
    pub title: String,
    pub url: String,
    pub status: String,
    pub priority: Option<String>,
    pub assignee: Option<String>,
    pub issue_type: Option<String>,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraProviderStatus {
    pub configured: bool,
    pub domain_set: bool,
    pub project_key_set: bool,
    pub auth_type: Option<JiraAuthType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "lowercase")]
pub enum IssueRef {
    Github { number: i64, title: String, url: String },
    Linear { identifier: String, title: String, url: String },
    Jira { key: String, title: String, url: String },
    Todo { id: i64, title: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuesListInput {
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub force_refresh: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuesListResult {
    pub issues: Vec<Issue>,
}

// --- Claude Code tracker ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeProject {
    pub dir_name: String,
    pub display_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSessionPreview {
    pub cc_session_uuid: String,
    pub last_activity_at: String,
    pub first_user_message: Option<String>,
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSessionPreviewWithProject {
    #[serde(flatten)]
    pub preview: ClaudeCodeSessionPreview,
    pub project_dir_name: String,
    pub project_display_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeIdlePeriod {
    pub start_at: String,
    pub end_at: String,
    pub duration_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSessionData {
    pub cc_session_uuid: String,
    pub file_edit_count: i64,
    pub total_idle_seconds: i64,
    pub idle_period_count: i64,
    pub first_activity_at: Option<String>,
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub files_edited: Vec<String>,
    #[serde(default)]
    pub idle_periods: Vec<ClaudeCodeIdlePeriod>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeSessionSummary {
    pub id: String,
    #[serde(flatten)]
    pub data: ClaudeCodeSessionData,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeSessionActivityType {
    Thinking,
    ToolUse,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionActivity {
    #[serde(rename = "type")]
    pub kind: ClaudeSessionActivityType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeLiveStats {
    pub active_sessions: i64,
    pub total_files_edited: i64,
    pub files_edited_list: Vec<String>,
    pub last_activity_timestamp: Option<String>,
    pub idle_sessions: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_activity: Option<ClaudeSessionActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub const IDLE_THRESHOLD_MIN: i64 = 1;
pub const IDLE_THRESHOLD_MAX: i64 = 60;
pub const IDLE_THRESHOLD_DEFAULT: i64 = 5;

// --- Neovim ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NvimActivity {
    pub id: i64,
    pub project: String,
    pub file: String,
    pub recorded_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NvimActivityGroup {
    pub project: String,
    pub activities: Vec<NvimActivity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListNvimActivityInput {
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListNvimActivityResult {
    pub records: Vec<NvimActivity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionWithTrackingInput {
    pub title: String,
    pub timer_type: TimerType,
    pub planned_duration_seconds: i64,
    pub actual_duration_seconds: i64,
    #[serde(default)]
    pub issue_number: Option<i64>,
    #[serde(default)]
    pub issue_title: Option<String>,
    #[serde(default)]
    pub issue_url: Option<String>,
    #[serde(default)]
    pub issue_provider: Option<IssueProviderKind>,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub claude_code_sessions: Option<Vec<ClaudeCodeSessionData>>,
}

// --- Music ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub id: String,
    pub source_url: String,
    pub source_id: String,
    pub source_site: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_seconds: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub is_cached: bool,
    pub cache_size_bytes: Option<i64>,
    pub play_count: i64,
    pub last_played_at: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaylistSource {
    UserCreated,
    SavedQueue,
}

impl PlaylistSource {
    pub fn as_str(self) -> &'static str {
        match self {
            PlaylistSource::UserCreated => "user_created",
            PlaylistSource::SavedQueue => "saved_queue",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "saved_queue" {
            PlaylistSource::SavedQueue
        } else {
            PlaylistSource::UserCreated
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlaylist {
    pub id: i64,
    pub name: String,
    pub source: PlaylistSource,
    pub track_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTrack {
    pub id: i64,
    pub playlist_id: i64,
    pub track_id: String,
    pub position: i64,
    pub track: MusicTrack,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicQueueItem {
    pub queue_id: String,
    pub track: MusicTrack,
    pub source_playlist_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub yt_dlp_installed: bool,
    pub ffmpeg_installed: bool,
    pub yt_dlp_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryInfo {
    pub yt_dlp_size: Option<i64>,
    pub ffmpeg_size: Option<i64>,
    pub storage_path: String,
    pub yt_dlp_filename: String,
    pub ffmpeg_filename: String,
    pub yt_dlp_url: Option<String>,
    pub ffmpeg_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryDownloadProgress {
    pub binary: String,
    pub percent: f64,
    pub bytes_downloaded: i64,
    pub total_bytes: i64,
    pub speed: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub current_bytes: i64,
    pub max_bytes: i64,
    pub track_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MusicPlayRequest {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicPlayResult {
    pub stream_url: String,
    pub track: MusicTrack,
    pub from_cache: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MusicMetaResult {
    pub track: MusicTrack,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportProgress {
    pub total: Option<i64>,
    pub current: i64,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MusicErrorCode {
    BinaryMissing,
    BinaryDownloadFailed,
    DownloadInProgress,
    ExtractionFailed,
    ExtractionTimeout,
    NetworkError,
    InvalidUrl,
    UnsupportedSource,
    CacheFull,
    CacheFileBusy,
    FormatError,
    ChecksumUnavailable,
    HashMismatch,
    PlaylistNotFound,
    TrackNotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DamageReason {
    Missing,
    Empty,
    Unreadable,
    Corrupt,
    Truncated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DamagedTrackInfo {
    pub track: MusicTrack,
    pub reason: DamageReason,
    pub detail: String,
    pub container_duration: Option<f64>,
    pub expected_duration: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntegrityCheckResult {
    pub damaged: Vec<DamagedTrackInfo>,
    pub checked: i64,
    pub total: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityProgress {
    pub current: i64,
    pub total: i64,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MusicSortField {
    LastPlayedAt,
    Title,
    DurationSeconds,
    AddedAt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicSortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicLibraryListInput {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub sort_field: Option<MusicSortField>,
    #[serde(default)]
    pub sort_dir: Option<MusicSortDir>,
    #[serde(default)]
    pub cached_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MusicLibraryListResult {
    pub tracks: Vec<MusicTrack>,
    pub total: i64,
}

/// Exactly one of `track_id` / `url` is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistAddTrackInput {
    pub playlist_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    Off,
    Queue,
    One,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicPlaybackState {
    Playing,
    Paused,
    Buffering,
    Stopped,
}

// --- Data location ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationInfo {
    pub data_dir: String,
    pub default_data_dir: String,
    pub is_custom: bool,
    pub available: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DataLocationMoveErrorCode {
    SameDir,
    Nested,
    NotWritable,
    TargetHasData,
    SyncEnabledConfirmRequired,
    AdoptConfirmRequired,
    TargetHasUnsyncedDbConfirmRequired,
    CopyFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DataLocationMoveResult {
    Ok {
        ok: bool,
        #[serde(rename = "dataDir")]
        data_dir: String,
    },
    Err {
        ok: bool,
        code: DataLocationMoveErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocationMoveInput {
    pub target_dir: String,
    #[serde(default)]
    pub use_existing: Option<bool>,
    #[serde(default)]
    pub confirm_disconnect_sync: Option<bool>,
    #[serde(default)]
    pub confirm_adopt: Option<bool>,
    #[serde(default)]
    pub confirm_unsynced_db: Option<bool>,
}

// --- Sync ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceInfo {
    pub device_id: String,
    pub device_number: i64,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncHalted {
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub last_synced_at: Option<String>,
    pub halted: Option<SyncHalted>,
    pub devices: Vec<SyncDeviceInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncNoticeKind {
    DiscardAfterDelete,
    ClockDrift,
    PlaceholderBlocked,
    StrayFile,
    StaleMachineRebuild,
    AdoptedBackup,
    TodoIdReassigned,
    OplogEntrySkipped,
    MergeFailed,
    PublishPending,
}

impl SyncNoticeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncNoticeKind::DiscardAfterDelete => "discard-after-delete",
            SyncNoticeKind::ClockDrift => "clock-drift",
            SyncNoticeKind::PlaceholderBlocked => "placeholder-blocked",
            SyncNoticeKind::StrayFile => "stray-file",
            SyncNoticeKind::StaleMachineRebuild => "stale-machine-rebuild",
            SyncNoticeKind::AdoptedBackup => "adopted-backup",
            SyncNoticeKind::TodoIdReassigned => "todo-id-reassigned",
            SyncNoticeKind::OplogEntrySkipped => "oplog-entry-skipped",
            SyncNoticeKind::MergeFailed => "merge-failed",
            SyncNoticeKind::PublishPending => "publish-pending",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNotice {
    pub id: i64,
    pub kind: String,
    pub message: String,
    pub detail: Option<String>,
    pub created_at: String,
    pub dismissed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenumberStatus {
    ConfirmRequired,
    Done,
    NothingToDo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenumberPair {
    pub from: i64,
    pub to: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenumberOutcome {
    pub status: RenumberStatus,
    pub count: i64,
    pub renumbered: Vec<RenumberPair>,
    pub backup_path: Option<String>,
}

// --- Widget ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetTimerSnapshot {
    pub mode: AppMode,
    pub status: TimerStatus,
    pub timer_type: TimerType,
    pub display_seconds: i64,
    pub title: String,
    pub planned_duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_activity: Option<ClaudeSessionActivityType>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AvatarPaths {
    pub idle: Option<String>,
    pub thinking: Option<String>,
    pub tool_use: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WidgetVisibility {
    Always,
    WhenActive,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WidgetPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WidgetSettings {
    pub enabled: bool,
    pub visibility: WidgetVisibility,
    pub position: Option<WidgetPosition>,
    pub avatars: AvatarPaths,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WidgetControlAction {
    PlayPause,
    Stop,
}

pub mod widget_settings_keys {
    pub const ENABLED: &str = "widget_enabled";
    pub const VISIBILITY: &str = "widget_visibility";
    pub const POS_X: &str = "widget_pos_x";
    pub const POS_Y: &str = "widget_pos_y";
    pub const AVATAR_IDLE: &str = "widget_avatar_idle";
    pub const AVATAR_THINKING: &str = "widget_avatar_thinking";
    pub const AVATAR_TOOL_USE: &str = "widget_avatar_tool_use";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timer_type_wire_names() {
        assert_eq!(serde_json::to_value(TimerType::ShortBreak).unwrap(), json!("short_break"));
        assert_eq!(serde_json::to_value(AppMode::TimeTracking).unwrap(), json!("time-tracking"));
    }

    #[test]
    fn update_todo_three_way() {
        let a: UpdateTodoInput = serde_json::from_value(json!({"id": 1})).unwrap();
        assert_eq!(a.project_id, None);
        let b: UpdateTodoInput = serde_json::from_value(json!({"id": 1, "projectId": null})).unwrap();
        assert_eq!(b.project_id, Some(None));
        let c: UpdateTodoInput = serde_json::from_value(json!({"id": 1, "projectId": 3})).unwrap();
        assert_eq!(c.project_id, Some(Some(3)));
    }

    #[test]
    fn issue_ref_tagged() {
        let r = IssueRef::Todo { id: 4, title: "x".into() };
        assert_eq!(serde_json::to_value(&r).unwrap(), json!({"provider": "todo", "id": 4, "title": "x"}));
    }

    #[test]
    fn sync_notice_kind_wire() {
        assert_eq!(serde_json::to_value(SyncNoticeKind::TodoIdReassigned).unwrap(), json!("todo-id-reassigned"));
    }

    #[test]
    fn music_error_code_wire() {
        assert_eq!(serde_json::to_value(MusicErrorCode::BinaryMissing).unwrap(), json!("BINARY_MISSING"));
        assert_eq!(
            serde_json::to_value(DataLocationMoveErrorCode::TargetHasUnsyncedDbConfirmRequired).unwrap(),
            json!("TARGET_HAS_UNSYNCED_DB_CONFIRM_REQUIRED")
        );
    }

    #[test]
    fn widget_avatar_paths_use_snake_case_keys() {
        let a = AvatarPaths { idle: None, thinking: None, tool_use: Some("x".into()) };
        assert_eq!(serde_json::to_value(a).unwrap()["tool_use"], json!("x"));
    }
}
