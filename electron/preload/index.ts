import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AssignTagInput,
  ClaudeCodeLiveStats,
  ClaudeCodeSessionPreview,
  CreateTagInput,
  IssuesListInput,
  IssuesSetTokenInput,
  ListSessionsInput,
  SaveSessionInput,
  SaveSessionWithTrackingInput,
  TimerSettings,
  UpdateTagInput,
  WorklogLogInput,
} from "../../src/shared/types.ts";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  session: {
    save: (input: SaveSessionInput) => ipcRenderer.invoke("session:save", input),
    saveWithTracking: (input: SaveSessionWithTrackingInput) =>
      ipcRenderer.invoke("session:save-with-tracking", input),
    list: (input: ListSessionsInput) => ipcRenderer.invoke("session:list", input),
    delete: (id: string) => ipcRenderer.invoke("session:delete", id),
    updateDuration: (input: { id: string; actualDurationSeconds: number }) =>
      ipcRenderer.invoke("session:update-duration", input),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings: TimerSettings) => ipcRenderer.invoke("settings:save", settings),
    getValue: (key: string) => ipcRenderer.invoke("settings:get-value", key),
    setValue: (key: string, value: string | null) => ipcRenderer.invoke("settings:set-value", key, value),
  },
  tag: {
    create: (input: CreateTagInput) => ipcRenderer.invoke("tag:create", input),
    list: () => ipcRenderer.invoke("tag:list"),
    update: (input: UpdateTagInput) => ipcRenderer.invoke("tag:update", input),
    delete: (id: number) => ipcRenderer.invoke("tag:delete", id),
    assign: (input: AssignTagInput) => ipcRenderer.invoke("tag:assign", input),
    unassign: (input: AssignTagInput) => ipcRenderer.invoke("tag:unassign", input),
    listForSession: (sessionId: string) => ipcRenderer.invoke("tag:list-for-session", sessionId),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
  },
  issues: {
    list: (input: IssuesListInput) => ipcRenderer.invoke("issues:list", input),
    providerStatus: () => ipcRenderer.invoke("issues:provider-status"),
    setToken: (input: IssuesSetTokenInput) => ipcRenderer.invoke("issues:set-token", input),
    deleteToken: () => ipcRenderer.invoke("issues:delete-token"),
    testToken: () => ipcRenderer.invoke("issues:test-token"),
    fetchComments: (input: { repo: string; issueNumber: number }) =>
      ipcRenderer.invoke("issues:fetch-comments", input),
  },
  linear: {
    setToken: (input: { token: string }) => ipcRenderer.invoke("linear:set-token", input),
    deleteToken: () => ipcRenderer.invoke("linear:delete-token"),
    testConnection: () => ipcRenderer.invoke("linear:test-connection"),
    listTeams: () => ipcRenderer.invoke("linear:list-teams"),
    setTeam: (input: { teamId: string; teamName: string }) => ipcRenderer.invoke("linear:set-team", input),
    getTeam: () => ipcRenderer.invoke("linear:get-team"),
    fetchIssues: (input: { forceRefresh?: boolean }) => ipcRenderer.invoke("linear:fetch-issues", input),
    providerStatus: () => ipcRenderer.invoke("linear:provider-status"),
    fetchComments: (input: { issueId: string }) => ipcRenderer.invoke("linear:fetch-comments", input),
  },
  jira: {
    setToken: (input: { token: string }) => ipcRenderer.invoke("jira:set-token", input),
    deleteToken: () => ipcRenderer.invoke("jira:delete-token"),
    testConnection: () => ipcRenderer.invoke("jira:test-connection"),
    fetchIssues: (input: { forceRefresh?: boolean }) => ipcRenderer.invoke("jira:fetch-issues", input),
    providerStatus: () => ipcRenderer.invoke("jira:provider-status"),
    fetchComments: (input: { issueKey: string }) => ipcRenderer.invoke("jira:fetch-comments", input),
    setAuthType: (input: { authType: string }) => ipcRenderer.invoke("jira:set-auth-type", input),
    setDomain: (input: { domain: string }) => ipcRenderer.invoke("jira:set-domain", input),
    setEmail: (input: { email: string }) => ipcRenderer.invoke("jira:set-email", input),
    setProjectKey: (input: { projectKey: string }) => ipcRenderer.invoke("jira:set-project-key", input),
    setJqlFilter: (input: { jql: string }) => ipcRenderer.invoke("jira:set-jql-filter", input),
  },
  worklog: {
    log: (input: WorklogLogInput) => ipcRenderer.invoke("worklog:log", input),
    markLogged: (input: { sessionIds: string[]; worklogId: string }) =>
      ipcRenderer.invoke("worklog:mark-logged", input),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  },
  claudeTracker: {
    // Phase 1: Scan (v1.2)
    scan: (input: { projectDirName: string }) => ipcRenderer.invoke("claude-tracker:scan", input),
    // Phase 2: Track selected (v1.2)
    trackSelected: (input: { sessionUuids: string[] }) =>
      ipcRenderer.invoke("claude-tracker:track-selected", input),
    // Lifecycle
    stop: () => ipcRenderer.invoke("claude-tracker:stop"),
    pause: () => ipcRenderer.invoke("claude-tracker:pause"),
    resume: () => ipcRenderer.invoke("claude-tracker:resume"),
    // Scan all projects for active sessions (lightweight, for dropdown selection)
    scanAll: () => ipcRenderer.invoke("claude-tracker:scan-all"),
    // Configuration
    getProjects: () => ipcRenderer.invoke("claude-tracker:get-projects"),
    // Historical data
    getForSession: (input: { sessionId: string }) => ipcRenderer.invoke("claude-tracker:get-for-session", input),
    // Push events
    onUpdate: (callback: (stats: ClaudeCodeLiveStats) => void) => {
      // Wrap callback to extract payload from the IPC event
      const handler = (_event: IpcRendererEvent, stats: ClaudeCodeLiveStats) => {
        callback(stats);
      };
      ipcRenderer.on("claude-tracker:update", handler);
      // Return an unsubscribe function that removes this specific listener
      return () => {
        ipcRenderer.removeListener("claude-tracker:update", handler);
      };
    },
    onNewSession: (callback: (data: { session: ClaudeCodeSessionPreview }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { session: ClaudeCodeSessionPreview }) => {
        callback(data);
      };
      ipcRenderer.on("claude-tracker:new-session", handler);
      return () => {
        ipcRenderer.removeListener("claude-tracker:new-session", handler);
      };
    },
  },
});