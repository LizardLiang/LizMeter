// src/shared/types.ts
// Shared TypeScript type definitions used by both main process and renderer

// --- Timer Types ---

export type TimerType = "work" | "short_break" | "long_break" | "stopwatch";

export type AppMode = "pomodoro" | "time-tracking";

export type TimerStatus = "idle" | "running" | "paused" | "completed";

// --- Session Types ---

export type WorklogStatus = "not_logged" | "logged" | "failed";

export interface Session {
  id: string; // UUID v4
  title: string; // user-entered title, may be empty string
  timerType: TimerType; // which timer mode was used
  plannedDurationSeconds: number; // configured duration
  actualDurationSeconds: number; // elapsed active time (excludes pauses)
  completedAt: string; // ISO 8601 timestamp
  tags: Tag[]; // assigned tags (populated on read)
  // Legacy GitHub fields (preserved for backward compat)
  issueNumber: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
  // New generic provider fields
  issueProvider: "github" | "linear" | "jira" | null;
  issueId: string | null;
  // Worklog tracking fields (Jira only)
  worklogStatus: WorklogStatus;
  worklogId: string | null;
}

export interface WorklogLogInput {
  sessionId: string;
  issueKey: string;
  startTimeOverride?: string; // ISO string
  endTimeOverride?: string; // ISO string
  descriptionOverride?: string;
}

export interface WorklogLogResult {
  worklogId: string;
}

export interface SaveSessionInput {
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  // Legacy (still used for GitHub backward compat)
  issueNumber?: number;
  issueTitle?: string;
  issueUrl?: string;
  // New generic provider fields
  issueProvider?: "github" | "linear" | "jira";
  issueId?: string;
}

export interface ListSessionsInput {
  limit?: number; // default 50
  offset?: number; // default 0
  tagId?: number; // filter by tag (optional)
}

export interface ListSessionsResult {
  sessions: Session[];
  total: number; // total count for pagination
}

// --- Settings Types ---

export interface TimerSettings {
  workDuration: number; // seconds
  shortBreakDuration: number; // seconds
  longBreakDuration: number; // seconds
}

export interface StopwatchSettings {
  maxDurationSeconds: number; // 0 = no limit, default 28800 (8h)
  promptForIssue: boolean;
}

// --- Tag Types ---

export interface Tag {
  id: number;
  name: string;
  color: string;
  createdAt: string;
}

export interface CreateTagInput {
  name: string;
  color: string;
}

export interface UpdateTagInput {
  id: number;
  name: string;
  color: string;
}

export interface AssignTagInput {
  sessionId: string; // UUID
  tagId: number;
}

// --- Issue Tracker Types ---

export interface Issue {
  number: number;
  title: string;
  url: string; // html_url
  repo: string; // "owner/repo"
  state: "open" | "closed";
  labels: IssueLabel[];
  updatedAt: string; // ISO 8601
}

export interface IssueLabel {
  name: string;
  color: string; // hex without #, e.g. "7aa2f7"
}

export interface IssueProviderStatus {
  configured: boolean;
  provider: "github" | null;
  // Linear provider status (new fields, additive)
  linearConfigured: boolean;
  linearTeamSelected: boolean;
  // Jira provider status
  jiraConfigured: boolean;
  jiraDomainSet: boolean;
}

// --- Linear Issue Types ---

export interface LinearIssueState {
  name: string; // e.g., "In Progress"
  type: string; // "backlog" | "unstarted" | "started" | "completed" | "cancelled"
}

export interface LinearIssue {
  id: string; // Linear UUID
  identifier: string; // e.g., "LIN-42"
  title: string;
  url: string;
  priority: number; // 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
  state: LinearIssueState;
  updatedAt: string; // ISO 8601
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string; // e.g., "LIN" (prefix for issue identifiers)
}

export interface LinearProviderStatus {
  configured: boolean; // API key exists
  teamSelected: boolean; // Team has been chosen
  teamName: string | null; // Display name of selected team
}

// --- Jira Types ---

export type JiraAuthType = "cloud" | "server";

// --- Jira Issue Types ---

export interface JiraIssue {
  id: string;
  key: string;
  title: string;
  url: string;
  status: string;
  priority: string | null;
  assignee: string | null;
  issueType: string | null;
  labels: string[];
}

export interface JiraProviderStatus {
  configured: boolean;
  domainSet: boolean;
  projectKeySet: boolean;
  authType: JiraAuthType | null;
}

// --- Issue Comment Types ---

export interface IssueComment {
  id: string;
  author: string;
  body: string; // plain text or markdown
  createdAt: string; // ISO 8601
}

// --- Issue Reference (discriminated union for session linking) ---

export type IssueRef =
  | { provider: "github"; number: number; title: string; url: string; }
  | { provider: "linear"; identifier: string; title: string; url: string; }
  | { provider: "jira"; key: string; title: string; url: string; };

export interface IssuesListInput {
  repo?: string; // optional "owner/repo" filter
  forceRefresh?: boolean; // if true, clears cache before fetching
}

export interface IssuesListResult {
  issues: Issue[];
}

export interface IssuesSetTokenInput {
  token: string;
  provider: "github";
}

// --- Claude Code Tracker Types ---

export interface ClaudeCodeProject {
  dirName: string; // Encoded directory name (canonical ID)
  displayPath: string; // Best-effort decoded path
}

export interface ClaudeCodeIdlePeriod {
  startAt: string;
  endAt: string;
  durationSeconds: number;
}

export interface ClaudeCodeSessionData {
  ccSessionUuid: string;
  fileEditCount: number;
  totalIdleSeconds: number;
  idlePeriodCount: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  filesEdited: string[];
  idlePeriods: ClaudeCodeIdlePeriod[];
}

// Extends ClaudeCodeSessionData with the database row ID
export interface ClaudeCodeSessionSummary extends ClaudeCodeSessionData {
  id: string; // Database row ID (UUID v4, generated by LizMeter)
}

export interface ClaudeCodeLiveStats {
  activeSessions: number;
  totalFilesEdited: number;
  filesEditedList: string[];
  lastActivityTimestamp: string | null;
  idleSessions: number;
  error?: string; // Error message for display in compact stats
}

// Idle threshold validation constants
export const IDLE_THRESHOLD_MIN = 1; // minutes
export const IDLE_THRESHOLD_MAX = 60; // minutes
export const IDLE_THRESHOLD_DEFAULT = 5; // minutes

// Input type for the atomic save
export interface SaveSessionWithTrackingInput {
  // Timer session fields (same as SaveSessionInput)
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  issueNumber?: number;
  issueTitle?: string;
  issueUrl?: string;
  issueProvider?: "github" | "linear" | "jira";
  issueId?: string;
  // Claude Code tracking data (optional)
  claudeCodeSessions?: ClaudeCodeSessionData[];
}

// --- Electron API (exposed via contextBridge) ---

export interface ElectronAPI {
  platform: string;
  session: {
    save: (input: SaveSessionInput) => Promise<Session>;
    saveWithTracking: (input: SaveSessionWithTrackingInput) => Promise<Session>;
    list: (input: ListSessionsInput) => Promise<ListSessionsResult>;
    delete: (id: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<TimerSettings>;
    save: (settings: TimerSettings) => Promise<void>;
    getValue: (key: string) => Promise<string | null>;
    setValue: (key: string, value: string | null) => Promise<void>;
  };
  tag: {
    create: (input: CreateTagInput) => Promise<Tag>;
    list: () => Promise<Tag[]>;
    update: (input: UpdateTagInput) => Promise<Tag>;
    delete: (id: number) => Promise<void>;
    assign: (input: AssignTagInput) => Promise<void>;
    unassign: (input: AssignTagInput) => Promise<void>;
    listForSession: (sessionId: string) => Promise<Tag[]>;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
  issues: {
    list: (input: IssuesListInput) => Promise<IssuesListResult>;
    providerStatus: () => Promise<IssueProviderStatus>;
    setToken: (input: IssuesSetTokenInput) => Promise<void>;
    deleteToken: () => Promise<void>;
    testToken: () => Promise<{ username: string; }>;
    fetchComments: (input: { repo: string; issueNumber: number; }) => Promise<IssueComment[]>;
  };
  linear: {
    setToken: (input: { token: string; }) => Promise<void>;
    deleteToken: () => Promise<void>;
    testConnection: () => Promise<{ displayName: string; }>;
    listTeams: () => Promise<LinearTeam[]>;
    setTeam: (input: { teamId: string; teamName: string; }) => Promise<void>;
    getTeam: () => Promise<{ teamId: string; teamName: string; } | null>;
    fetchIssues: (input: { forceRefresh?: boolean; }) => Promise<LinearIssue[]>;
    providerStatus: () => Promise<LinearProviderStatus>;
    fetchComments: (input: { issueId: string; }) => Promise<IssueComment[]>;
  };
  jira: {
    setToken: (input: { token: string; }) => Promise<void>;
    deleteToken: () => Promise<void>;
    testConnection: () => Promise<{ displayName: string; }>;
    fetchIssues: (input: { forceRefresh?: boolean; }) => Promise<JiraIssue[]>;
    providerStatus: () => Promise<JiraProviderStatus>;
    fetchComments: (input: { issueKey: string; }) => Promise<IssueComment[]>;
    setAuthType: (input: { authType: JiraAuthType; }) => Promise<void>;
    setDomain: (input: { domain: string; }) => Promise<void>;
    setEmail: (input: { email: string; }) => Promise<void>;
    setProjectKey: (input: { projectKey: string; }) => Promise<void>;
    setJqlFilter: (input: { jql: string; }) => Promise<void>;
  };
  worklog: {
    log: (input: WorklogLogInput) => Promise<WorklogLogResult>;
    markLogged: (input: { sessionIds: string[]; worklogId: string; }) => Promise<void>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  claudeTracker: {
    start: (input: { projectDirName: string; }) => Promise<{ started: boolean; error?: string; }>;
    stop: () => Promise<{ sessions: ClaudeCodeSessionData[]; }>;
    getProjects: () => Promise<{ projects: ClaudeCodeProject[]; }>;
    getForSession: (input: { sessionId: string; }) => Promise<{ sessions: ClaudeCodeSessionSummary[]; } | null>;
    onUpdate: (callback: (stats: ClaudeCodeLiveStats) => void) => () => void; // Returns unsubscribe fn
  };
}
