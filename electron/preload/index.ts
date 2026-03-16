import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AssignTagInput,
  AvatarPaths,
  BinaryDownloadProgress,
  ClaudeCodeLiveStats,
  ClaudeCodeSessionPreview,
  CreateTagInput,
  ImportProgress,
  IssuesListInput,
  IssuesSetTokenInput,
  ListNvimActivityInput,
  ListSessionsInput,
  MusicLibraryListInput,
  MusicMetaResult,
  MusicPlayRequest,
  MusicPlayResult,
  MusicTrack,
  PlaylistAddTrackInput,
  SaveSessionInput,
  SaveSessionWithTrackingInput,
  TimerSettings,
  UpdateTagInput,
  WidgetControlAction,
  WidgetSettings,
  WidgetTimerSnapshot,
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
  notification: {
    timerComplete: (title: string, body: string) =>
      ipcRenderer.invoke("notification:timer-complete", title, body),
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
  nvimActivity: {
    listByDate: (input: ListNvimActivityInput) =>
      ipcRenderer.invoke("nvim-activity:list-by-date", input),
  },
  music: {
    // Playback
    play: (input: MusicPlayRequest): Promise<MusicPlayResult> => ipcRenderer.invoke("music:play", input),
    stop: (): Promise<void> => ipcRenderer.invoke("music:stop"),
    meta: (input: { url: string }): Promise<MusicMetaResult> => ipcRenderer.invoke("music:meta", input),

    // Library
    libraryList: (input: MusicLibraryListInput) => ipcRenderer.invoke("music:library:list", input),
    libraryDelete: (trackId: string) => ipcRenderer.invoke("music:library:delete", trackId),

    // Playlists
    playlistCreate: (input: { name: string; trackIds?: string[] }) =>
      ipcRenderer.invoke("music:playlist:create", input),
    playlistRename: (input: { id: number; name: string }) =>
      ipcRenderer.invoke("music:playlist:rename", input),
    playlistDelete: (id: number) => ipcRenderer.invoke("music:playlist:delete", id),
    playlistList: () => ipcRenderer.invoke("music:playlist:list"),
    playlistTracks: (playlistId: number) => ipcRenderer.invoke("music:playlist:tracks", playlistId),
    playlistAddTrack: (input: PlaylistAddTrackInput) =>
      ipcRenderer.invoke("music:playlist:add-track", input),
    playlistRemoveTrack: (playlistTrackId: number) =>
      ipcRenderer.invoke("music:playlist:remove-track", playlistTrackId),
    playlistReorder: (input: { playlistId: number; trackEntryId: number; toPosition: number }) =>
      ipcRenderer.invoke("music:playlist:reorder", input),

    // Cache
    cacheStats: () => ipcRenderer.invoke("music:cache:stats"),
    cacheClear: () => ipcRenderer.invoke("music:cache:clear"),
    cacheSetLimit: (maxBytes: number) => ipcRenderer.invoke("music:cache:set-limit", maxBytes),

    // Binary management
    binaryStatus: () => ipcRenderer.invoke("music:binary:status"),
    binaryInfo: () => ipcRenderer.invoke("music:binary:info"),
    binaryDownload: () => ipcRenderer.invoke("music:binary:download"),

    // Import
    importCancel: () => ipcRenderer.invoke("music:import:cancel"),

    // Reset
    reset: (input: { deleteBinaries: boolean }) => ipcRenderer.invoke("music:reset", input),

    // Push event listeners (each returns an unsubscribe function)
    onImportProgress: (callback: (progress: ImportProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: ImportProgress) => callback(progress);
      ipcRenderer.on("music:import:progress", handler);
      return () => ipcRenderer.removeListener("music:import:progress", handler);
    },
    onDownloadProgress: (callback: (progress: BinaryDownloadProgress) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: BinaryDownloadProgress) => callback(progress);
      ipcRenderer.on("music:binary:download-progress", handler);
      return () => ipcRenderer.removeListener("music:binary:download-progress", handler);
    },
    onStreamCached: (callback: (data: { trackId: string }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { trackId: string }) => callback(data);
      ipcRenderer.on("music:stream:cached", handler);
      return () => ipcRenderer.removeListener("music:stream:cached", handler);
    },
    onMediaKey: (callback: (action: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, action: string) => callback(action);
      ipcRenderer.on("music:media-key", handler);
      return () => ipcRenderer.removeListener("music:media-key", handler);
    },
    onPlaylistImported: (callback: (data: { tracks: MusicTrack[] }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: { tracks: MusicTrack[] }) => callback(data);
      ipcRenderer.on("music:playlist:imported", handler);
      return () => ipcRenderer.removeListener("music:playlist:imported", handler);
    },
  },
  widget: {
    sendStateUpdate: (snapshot: WidgetTimerSnapshot) => {
      ipcRenderer.send("widget:state-update", snapshot);
    },
    onControlRelay: (callback: (action: WidgetControlAction) => void) => {
      const handler = (_event: IpcRendererEvent, action: WidgetControlAction) => callback(action);
      ipcRenderer.on("widget:control-relay", handler);
      return () => ipcRenderer.removeListener("widget:control-relay", handler);
    },
    onRequestStateRelay: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on("widget:request-state-relay", handler);
      return () => ipcRenderer.removeListener("widget:request-state-relay", handler);
    },
    getSettings: (): Promise<WidgetSettings> => ipcRenderer.invoke("widget:settings-get"),
    saveSettings: (settings: Partial<WidgetSettings>): Promise<void> =>
      ipcRenderer.invoke("widget:settings-save", settings),
    uploadAvatar: (slot: keyof AvatarPaths): Promise<string | null> =>
      ipcRenderer.invoke("widget:avatar-upload", slot),
    removeAvatar: (slot: keyof AvatarPaths): Promise<void> =>
      ipcRenderer.invoke("widget:avatar-remove", slot),
    getAvatarPaths: (): Promise<AvatarPaths> =>
      ipcRenderer.invoke("widget:avatar-get-paths"),
  },
});