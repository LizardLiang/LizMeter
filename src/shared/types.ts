// src/shared/types.ts
// Shared TypeScript type definitions used by both main process and renderer

// --- Timer Types ---

export type TimerType = "work" | "short_break" | "long_break";

export type TimerStatus = "idle" | "running" | "paused" | "completed";

// --- Session Types ---

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
  issueProvider: "github" | "linear" | null;
  issueId: string | null;
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
  issueProvider?: "github" | "linear";
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

// --- Issue Reference (discriminated union for session linking) ---

export type IssueRef =
  | { provider: "github"; number: number; title: string; url: string; }
  | { provider: "linear"; identifier: string; title: string; url: string; };

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

// --- Electron API (exposed via contextBridge) ---

export interface ElectronAPI {
  platform: string;
  session: {
    save: (input: SaveSessionInput) => Promise<Session>;
    list: (input: ListSessionsInput) => Promise<ListSessionsResult>;
    delete: (id: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<TimerSettings>;
    save: (settings: TimerSettings) => Promise<void>;
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
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
}
