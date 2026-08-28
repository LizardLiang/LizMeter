// electron/main/ipc-handlers.ts
// Registers all IPC handlers for the main process

import { Notification, app, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import type {
  AddTodoAttachmentBufferInput,
  AddTodoAttachmentInput,
  AvatarPaths,
  AssignTagInput,
  CreateTagInput,
  CreateTodoInput,
  CreateTodoLabelInput,
  CreateTodoProjectInput,
  CreateTodoStateInput,
  DataLocationInfo,
  DataLocationMoveInput,
  DataLocationMoveResult,
  IssueProviderStatus,
  IssuesListInput,
  IssuesSetTokenInput,
  JiraAuthType,
  JiraProviderStatus,
  LinearProviderStatus,
  ListNvimActivityInput,
  ListSessionsInput,
  ListTodosInput,
  SaveSessionInput,
  SaveSessionWithTrackingInput,
  TimerSettings,
  TodoAttachment,
  UpdateTagInput,
  UpdateTodoInput,
  UpdateTodoLabelInput,
  UpdateTodoProjectInput,
  UpdateTodoStateInput,
  WidgetControlAction,
  WidgetSettings,
  WidgetTimerSnapshot,
} from "../../src/shared/types.ts";
import { WIDGET_SETTINGS_KEYS } from "../../src/shared/types.ts";
import { isUploadableSession, summarizeMergedWorklogSessions } from "../../src/shared/worklog.ts";
import {
  attachmentPathFor,
  collectAttachmentBlobs,
  deleteBlobIfUnreferenced,
  storeBuffer,
} from "./attachment-store.ts";
import { extFromFileName } from "./attachment-url.ts";
import { getDataDirStatus, moveDataTo } from "./data-location.ts";
import { decidePendingSyncAction, writePendingSyncAction } from "./sync/sync-manager.ts";
import { createWidgetWindow, destroyWidgetWindow, getWidgetWindow } from "./widget-window.ts";
import { getMainWindow } from "./index.ts";
import {
  assignTag,
  clearCompletedTodos,
  closeDatabase,
  createTag,
  createTodo,
  createTodoAttachment,
  createTodoLabel,
  createTodoProject,
  createTodoState,
  deleteSession,
  deleteSettingValue,
  deleteTag,
  deleteTodo,
  deleteTodoAttachment,
  deleteTodoLabel,
  deleteTodoProject,
  deleteTodoState,
  getClaudeCodeDataForSession,
  getDb,
  getTodoAttachment,
  getSessionById,
  getSettingValue,
  getSettings,
  initDatabase,
  listNvimActivityByDate,
  listSessions,
  listTags,
  listTagsForSession,
  listTodoAttachments,
  listTodoLabels,
  listTodoMilestones,
  listTodoProjects,
  listTodos,
  listTodoStates,
  reorderTodoProjects,
  reorderTodoStates,
  saveSession,
  saveSessionWithTracking,
  saveSettings,
  setSettingValue,
  unassignTag,
  updateSessionDuration,
  updateTag,
  updateTodo,
  updateTodoLabel,
  updateTodoProject,
  updateTodoState,
  updateWorklogStatus,
} from "./database.ts";
import {
  getProjects,
  pauseTracking,
  resumeTracking,
  scanAllProjects,
  scanSessions,
  stopTrackingAndGetData,
  trackSelectedSessions,
} from "./claude-code-tracker.ts";
import {
  getGitHubProvider,
  getJiraProvider,
  getLinearProvider,
  setJiraProvider,
  setLinearProvider,
  setProvider,
} from "./issue-providers/index.ts";
import { GitHubProvider } from "./issue-providers/github-provider.ts";
import { JiraProvider } from "./issue-providers/jira-provider.ts";
import { LinearProvider } from "./issue-providers/linear-provider.ts";
import { IssueProviderError } from "./issue-providers/types.ts";
import { deleteToken, hasToken, loadToken, saveToken } from "./issue-providers/token-storage.ts";
import { registerMusicIpcHandlers } from "./music/music-ipc.ts";
import { registerSyncIpcHandlers } from "./sync/sync-ipc.ts";

export function registerIpcHandlers(): void {
  registerMusicIpcHandlers();
  registerSyncIpcHandlers();
  ipcMain.handle("session:save", (_event, input: SaveSessionInput) => {
    return saveSession(input);
  });

  ipcMain.handle("session:save-with-tracking", (_event, input: SaveSessionWithTrackingInput) => {
    return saveSessionWithTracking(input);
  });

  ipcMain.handle("session:list", (_event, input: ListSessionsInput) => {
    return listSessions(input ?? {});
  });

  ipcMain.handle("session:update-duration", (_event, input: { id: string; actualDurationSeconds: number }) => {
    return updateSessionDuration(input.id, input.actualDurationSeconds);
  });

  ipcMain.handle("session:delete", (_event, id: string) => {
    return deleteSession(id);
  });

  ipcMain.handle("settings:get", () => {
    return getSettings();
  });

  ipcMain.handle("settings:save", (_event, settings: TimerSettings) => {
    return saveSettings(settings);
  });

  ipcMain.handle("settings:get-value", (_event, key: string) => {
    return getSettingValue(key);
  });

  ipcMain.handle("settings:set-value", (_event, key: string, value: string | null) => {
    if (value === null) {
      deleteSettingValue(key);
    } else {
      setSettingValue(key, value);
    }
  });

  // Tag handlers
  ipcMain.handle("tag:create", (_event, input: CreateTagInput) => {
    return createTag(input);
  });

  ipcMain.handle("tag:list", () => {
    return listTags();
  });

  ipcMain.handle("tag:update", (_event, input: UpdateTagInput) => {
    return updateTag(input);
  });

  ipcMain.handle("tag:delete", (_event, id: number) => {
    return deleteTag(id);
  });

  ipcMain.handle("tag:assign", (_event, input: AssignTagInput) => {
    return assignTag(input);
  });

  ipcMain.handle("tag:unassign", (_event, input: AssignTagInput) => {
    return unassignTag(input);
  });

  ipcMain.handle("tag:list-for-session", (_event, sessionId: string) => {
    return listTagsForSession(sessionId);
  });

  // Todo handlers
  ipcMain.handle("todo:create", (_event, input: CreateTodoInput) => {
    return createTodo(input);
  });

  ipcMain.handle("todo:list", (_event, input: ListTodosInput | undefined) => {
    return listTodos(input ?? {});
  });

  ipcMain.handle("todo:update", (_event, input: UpdateTodoInput) => {
    return updateTodo(input);
  });

  ipcMain.handle("todo:delete", (_event, id: number) => {
    // Blobs outlive the row only until nothing references them; the shas come back from the
    // delete because a cascade leaves nothing to read afterwards.
    collectAttachmentBlobs(deleteTodo(id));
  });

  ipcMain.handle("todo:clear-completed", () => {
    const { count, deletedShas } = clearCompletedTodos();
    collectAttachmentBlobs(deletedShas);
    return count;
  });

  ipcMain.handle("todo:list-milestones", () => {
    return listTodoMilestones();
  });

  // --- Todo attachment handlers ---

  const ATTACHMENT_PICKER_FILTERS = [
    { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif"] },
    { name: "Documents", extensions: ["pdf", "txt", "md", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx"] },
    { name: "All Files", extensions: ["*"] },
  ];

  /** Guesses a MIME type from the extension. Display metadata only — nothing branches on it. */
  function mimeTypeForExt(ext: string): string {
    const map: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      pdf: "application/pdf",
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      zip: "application/zip",
    };
    return map[ext] ?? "application/octet-stream";
  }

  ipcMain.handle(
    "attachment:add",
    async (_event, input: AddTodoAttachmentInput): Promise<TodoAttachment | null> => {
      const result = await dialog.showOpenDialog({
        title: "Attach a file to this todo",
        filters: ATTACHMENT_PICKER_FILTERS,
        properties: ["openFile"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;

      const srcPath = result.filePaths[0]!;
      const fileName = path.basename(srcPath);
      // Read into memory rather than copying: storeBuffer has to hash the bytes anyway, and
      // ATTACHMENT_MAX_BYTES keeps the buffer bounded at 25 MB.
      const data = fs.readFileSync(srcPath);
      const stored = storeBuffer(data, fileName);

      return createTodoAttachment({
        todoId: input.todoId,
        sha256: stored.sha256,
        fileName,
        mimeType: mimeTypeForExt(stored.ext),
        sizeBytes: stored.sizeBytes,
      });
    },
  );

  ipcMain.handle(
    "attachment:add-buffer",
    (_event, input: AddTodoAttachmentBufferInput): TodoAttachment => {
      const stored = storeBuffer(Buffer.from(input.data), input.fileName);
      return createTodoAttachment({
        todoId: input.todoId,
        sha256: stored.sha256,
        fileName: input.fileName,
        mimeType: input.mimeType || mimeTypeForExt(stored.ext),
        sizeBytes: stored.sizeBytes,
      });
    },
  );

  ipcMain.handle("attachment:list", (_event, todoId: number): TodoAttachment[] => {
    return listTodoAttachments(todoId);
  });

  ipcMain.handle("attachment:delete", (_event, id: number): void => {
    const removed = deleteTodoAttachment(id);
    if (!removed) return;
    deleteBlobIfUnreferenced(removed.sha256, extFromFileName(removed.fileName));
  });

  ipcMain.handle("attachment:open", async (_event, id: number): Promise<string | null> => {
    const attachment = getTodoAttachment(id);
    if (!attachment) return "Attachment not found";
    const file = attachmentPathFor(attachment.sha256, extFromFileName(attachment.fileName));
    if (!fs.existsSync(file)) return "The attached file is missing from disk";
    // shell.openPath resolves with "" on success and an error message otherwise.
    const error = await shell.openPath(file);
    return error === "" ? null : error;
  });

  ipcMain.handle("attachment:reveal", (_event, id: number): void => {
    const attachment = getTodoAttachment(id);
    if (!attachment) return;
    shell.showItemInFolder(attachmentPathFor(attachment.sha256, extFromFileName(attachment.fileName)));
  });

  // Todo state handlers
  ipcMain.handle("todo-state:list", () => {
    return listTodoStates();
  });

  ipcMain.handle("todo-state:create", (_event, input: CreateTodoStateInput) => {
    return createTodoState(input);
  });

  ipcMain.handle("todo-state:update", (_event, input: UpdateTodoStateInput) => {
    return updateTodoState(input);
  });

  ipcMain.handle("todo-state:delete", (_event, input: { id: number; reassignToId: number }) => {
    return deleteTodoState(input.id, input.reassignToId);
  });

  ipcMain.handle("todo-state:reorder", (_event, orderedIds: number[]) => {
    return reorderTodoStates(orderedIds);
  });

  // Todo project handlers
  ipcMain.handle("todo-project:list", () => {
    return listTodoProjects();
  });

  ipcMain.handle("todo-project:create", (_event, input: CreateTodoProjectInput) => {
    return createTodoProject(input);
  });

  ipcMain.handle("todo-project:update", (_event, input: UpdateTodoProjectInput) => {
    return updateTodoProject(input);
  });

  ipcMain.handle("todo-project:delete", (_event, id: number) => {
    return deleteTodoProject(id);
  });

  ipcMain.handle("todo-project:reorder", (_event, orderedIds: number[]) => {
    return reorderTodoProjects(orderedIds);
  });

  // Todo label handlers
  ipcMain.handle("todo-label:list", () => {
    return listTodoLabels();
  });

  ipcMain.handle("todo-label:create", (_event, input: CreateTodoLabelInput) => {
    return createTodoLabel(input);
  });

  ipcMain.handle("todo-label:update", (_event, input: UpdateTodoLabelInput) => {
    return updateTodoLabel(input);
  });

  ipcMain.handle("todo-label:delete", (_event, id: number) => {
    return deleteTodoLabel(id);
  });

  // Issue tracker handlers (GitHub)
  ipcMain.handle("issues:list", async (_event, input: IssuesListInput) => {
    const provider = getGitHubProvider();
    if (!provider) throw new IssueProviderError("No token configured", "NO_TOKEN");
    return { issues: await provider.listIssues(input) };
  });

  ipcMain.handle("issues:provider-status", (): IssueProviderStatus => {
    const linearConfigured = hasToken("linear");
    const linearTeamId = getSettingValue("linear_team_id");
    const jiraConfigured = hasToken("jira");
    return {
      configured: hasToken("github"),
      provider: hasToken("github") ? "github" : null,
      linearConfigured,
      linearTeamSelected: linearConfigured && linearTeamId !== null,
      jiraConfigured,
      jiraDomainSet: jiraConfigured && getSettingValue("jira_domain") !== null,
    };
  });

  ipcMain.handle("issues:set-token", (_event, input: IssuesSetTokenInput) => {
    if (!input.token || input.token.trim().length === 0) {
      throw new Error("Token cannot be empty");
    }
    saveToken(input.token.trim(), "github");
    setProvider(new GitHubProvider(input.token.trim()));
  });

  ipcMain.handle("issues:test-token", async () => {
    const provider = getGitHubProvider();
    if (!provider) throw new IssueProviderError("No token configured", "NO_TOKEN");
    return provider.testConnection();
  });

  ipcMain.handle("issues:fetch-comments", async (_event, input: { repo: string; issueNumber: number }) => {
    const provider = getGitHubProvider() as import("./issue-providers/github-provider.ts").GitHubProvider | null;
    if (!provider) throw new IssueProviderError("No token configured", "NO_TOKEN");
    return provider.fetchComments(input.repo, input.issueNumber);
  });

  ipcMain.handle("issues:delete-token", () => {
    getGitHubProvider()?.destroy();
    setProvider(null);
    deleteToken("github");
  });

  // Linear IPC handlers
  ipcMain.handle("linear:set-token", (_event, input: { token: string }) => {
    if (!input.token || input.token.trim().length === 0) {
      throw new Error("Token cannot be empty");
    }
    const trimmed = input.token.trim();
    saveToken(trimmed, "linear");
    setLinearProvider(new LinearProvider(trimmed));
  });

  ipcMain.handle("linear:delete-token", () => {
    getLinearProvider()?.destroy();
    setLinearProvider(null);
    deleteToken("linear");
    deleteSettingValue("linear_team_id");
    deleteSettingValue("linear_team_name");
  });

  ipcMain.handle("linear:test-connection", async () => {
    const provider = getLinearProvider();
    if (!provider) throw new IssueProviderError("No Linear API key configured", "NO_TOKEN");
    return provider.testConnection();
  });

  ipcMain.handle("linear:list-teams", async () => {
    const provider = getLinearProvider();
    if (!provider) throw new IssueProviderError("No Linear API key configured", "NO_TOKEN");
    return provider.listTeams();
  });

  ipcMain.handle("linear:set-team", (_event, input: { teamId: string; teamName: string }) => {
    setSettingValue("linear_team_id", input.teamId);
    setSettingValue("linear_team_name", input.teamName);
  });

  ipcMain.handle("linear:get-team", (): { teamId: string; teamName: string } | null => {
    const teamId = getSettingValue("linear_team_id");
    const teamName = getSettingValue("linear_team_name");
    if (!teamId || !teamName) return null;
    return { teamId, teamName };
  });

  ipcMain.handle("linear:fetch-issues", async (_event, input: { forceRefresh?: boolean }) => {
    const provider = getLinearProvider();
    if (!provider) throw new IssueProviderError("No Linear API key configured", "NO_TOKEN");
    const teamId = getSettingValue("linear_team_id");
    if (!teamId) throw new IssueProviderError("No Linear team selected", "NO_TOKEN");
    return provider.fetchIssues(teamId, input?.forceRefresh ?? false);
  });

  ipcMain.handle("linear:fetch-comments", async (_event, input: { issueId: string }) => {
    const provider = getLinearProvider();
    if (!provider) throw new IssueProviderError("No Linear API key configured", "NO_TOKEN");
    return provider.fetchComments(input.issueId);
  });

  ipcMain.handle("linear:provider-status", (): LinearProviderStatus => {
    const configured = hasToken("linear");
    const teamId = getSettingValue("linear_team_id");
    const teamName = getSettingValue("linear_team_name");
    return {
      configured,
      teamSelected: configured && teamId !== null,
      teamName: configured && teamName ? teamName : null,
    };
  });

  // Jira IPC handlers

  function reconstructJiraProvider(): void {
    const token = loadToken("jira");
    const domain = getSettingValue("jira_domain");
    const email = getSettingValue("jira_email");
    const authType = (getSettingValue("jira_auth_type") as JiraAuthType) ?? "cloud";
    if (token && domain && email) {
      getJiraProvider()?.destroy();
      setJiraProvider(new JiraProvider(domain, email, token, authType));
    }
  }

  ipcMain.handle("jira:set-token", (_event, input: { token: string }) => {
    if (!input.token || input.token.trim().length === 0) {
      throw new Error("Token cannot be empty");
    }
    const trimmed = input.token.trim();
    saveToken(trimmed, "jira");
    const domain = getSettingValue("jira_domain");
    const email = getSettingValue("jira_email");
    const authType = (getSettingValue("jira_auth_type") as JiraAuthType) ?? "cloud";
    if (domain && email) {
      setJiraProvider(new JiraProvider(domain, email, trimmed, authType));
    }
  });

  ipcMain.handle("jira:delete-token", () => {
    getJiraProvider()?.destroy();
    setJiraProvider(null);
    deleteToken("jira");
    deleteSettingValue("jira_domain");
    deleteSettingValue("jira_email");
    deleteSettingValue("jira_project_key");
    deleteSettingValue("jira_jql_filter");
    deleteSettingValue("jira_auth_type");
  });

  ipcMain.handle("jira:test-connection", async () => {
    const provider = getJiraProvider();
    if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");
    return provider.testConnection();
  });

  ipcMain.handle("jira:fetch-issues", async (_event, input: { forceRefresh?: boolean }) => {
    const provider = getJiraProvider();
    if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");
    const projectKey = getSettingValue("jira_project_key");
    const jqlFilter = getSettingValue("jira_jql_filter");
    return provider.fetchIssues(projectKey, jqlFilter, input?.forceRefresh ?? false);
  });

  ipcMain.handle("jira:fetch-comments", async (_event, input: { issueKey: string }) => {
    const provider = getJiraProvider();
    if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");
    return provider.fetchComments(input.issueKey);
  });

  ipcMain.handle("jira:provider-status", (): JiraProviderStatus => {
    const configured = hasToken("jira");
    const domain = getSettingValue("jira_domain");
    const projectKey = getSettingValue("jira_project_key");
    const authType = getSettingValue("jira_auth_type") as JiraAuthType | null;
    return {
      configured,
      domainSet: configured && domain !== null,
      projectKeySet: configured && projectKey !== null,
      authType,
    };
  });

  ipcMain.handle("jira:set-auth-type", (_event, input: { authType: JiraAuthType }) => {
    setSettingValue("jira_auth_type", input.authType);
    reconstructJiraProvider();
  });

  ipcMain.handle("jira:set-domain", (_event, input: { domain: string }) => {
    setSettingValue("jira_domain", input.domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    reconstructJiraProvider();
  });

  ipcMain.handle("jira:set-email", (_event, input: { email: string }) => {
    setSettingValue("jira_email", input.email.trim());
    reconstructJiraProvider();
  });

  ipcMain.handle("jira:set-project-key", (_event, input: { projectKey: string }) => {
    if (input.projectKey.trim()) {
      setSettingValue("jira_project_key", input.projectKey.trim());
    } else {
      deleteSettingValue("jira_project_key");
    }
  });

  ipcMain.handle("jira:set-jql-filter", (_event, input: { jql: string }) => {
    if (input.jql.trim()) {
      setSettingValue("jira_jql_filter", input.jql.trim());
    } else {
      deleteSettingValue("jira_jql_filter");
    }
  });

  // Claude Code Tracker IPC handlers

  // Phase 1: Scan for active sessions, start directory watcher (v1.2)
  ipcMain.handle(
    "claude-tracker:scan",
    (event, input: { projectDirName: string }) => {
      const idleThresholdMinutes = parseInt(
        getSettingValue("claude_tracker.idle_threshold_minutes") ?? "5",
        10,
      );
      const threshold = isNaN(idleThresholdMinutes) ? 5 : idleThresholdMinutes;
      return scanSessions(input.projectDirName, event.sender, threshold);
    },
  );

  // Phase 2: Begin tracking only selected sessions (v1.2)
  ipcMain.handle(
    "claude-tracker:track-selected",
    (_event, input: { sessionUuids: string[] }) => {
      return trackSelectedSessions(input.sessionUuids);
    },
  );

  ipcMain.handle("claude-tracker:stop", () => {
    return stopTrackingAndGetData();
  });

  // Pause data collection while timer is paused (v1.2)
  ipcMain.handle("claude-tracker:pause", () => {
    pauseTracking();
  });

  // Resume data collection when timer resumes (v1.2)
  ipcMain.handle("claude-tracker:resume", () => {
    resumeTracking();
  });

  ipcMain.handle("claude-tracker:get-projects", () => {
    return getProjects();
  });

  ipcMain.handle("claude-tracker:scan-all", () => {
    return scanAllProjects();
  });

  ipcMain.handle("claude-tracker:get-for-session", (_event, input: { sessionId: string }) => {
    return getClaudeCodeDataForSession(input.sessionId);
  });

  // --- Data location handlers ---

  ipcMain.handle("data-location:get", (): DataLocationInfo => {
    return getDataDirStatus();
  });

  ipcMain.handle("data-location:choose", async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: "Choose where LizMeter keeps its data",
      defaultPath: getDataDirStatus().dataDir,
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Use This Folder",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  });

  ipcMain.handle(
    "data-location:move",
    (_event, input: DataLocationMoveInput): DataLocationMoveResult => {
      // Decided while the database is still open, on the pre-move data -- targetHasOtherDevicesData
      // and hasAnySyncableLocalData both need a live connection. Writing nothing here (the
      // ordinary-relocate case) leaves this feature invisible, exactly like today's move.
      const pendingSyncAction = decidePendingSyncAction(input.targetDir);

      // Copying an open SQLite file can capture a half-written page, so fold the WAL back into
      // the main file and drop the connection before anything is read.
      try {
        getDb().pragma("wal_checkpoint(TRUNCATE)");
      } catch (err) {
        console.warn("[data-location] checkpoint before move failed:", err);
      }
      closeDatabase();

      const result = moveDataTo(input.targetDir, { useExisting: input.useExisting === true });

      if (!result.ok) {
        // Nothing moved, so reopen at the unchanged location -- a refused move must leave the app
        // working, not wedged with a closed database. No pending sync action was ever written.
        initDatabase();
        return result;
      }

      if (pendingSyncAction !== null) {
        writePendingSyncAction(pendingSyncAction);
      }

      // Relaunch rather than reopen: the protocol handler, the widget window and the renderer all
      // hold paths resolved at startup. Deferred so this reply reaches the renderer first.
      // `app.quit()` rather than `app.exit()` so `will-quit` still tears down the named pipe --
      // the relaunched instance cannot claim it otherwise.
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 250);

      return result;
    },
  );

  ipcMain.handle("data-location:reveal", async (): Promise<void> => {
    const { dataDir } = getDataDirStatus();
    if (!fs.existsSync(dataDir)) return;
    await shell.openPath(dataDir);
  });

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });

  // Neovim Activity handlers
  ipcMain.handle("nvim-activity:list-by-date", (_event, input: ListNvimActivityInput) => {
    return listNvimActivityByDate(input.date);
  });

  // Notification handler
  ipcMain.handle("notification:timer-complete", (_event, title: string, body: string) => {
    if (typeof title !== "string" || typeof body !== "string") return;
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  // --- Widget IPC handlers ---

  // Cache of the latest snapshot for answering requestState
  let cachedSnapshot: WidgetTimerSnapshot | null = null;

  // Main renderer pushes state updates → relay to widget
  ipcMain.on("widget:state-update", (_event, snapshot: WidgetTimerSnapshot) => {
    cachedSnapshot = snapshot;
    const widget = getWidgetWindow();
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send("widget:state-push", snapshot);
      // Show/hide widget based on "when-active" visibility setting
      const visibility = getSettingValue(WIDGET_SETTINGS_KEYS.VISIBILITY) || "always";
      if (visibility === "when-active") {
        const isActive = snapshot.status === "running" || snapshot.status === "paused";
        if (isActive) {
          widget.show();
        } else {
          widget.hide();
        }
      }
    }
  });

  // Widget sends a control action → relay to main renderer
  ipcMain.on("widget:control", (_event, action: WidgetControlAction) => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send("widget:control-relay", action);
      // Bring main window to front on stop
      if (action === "stop") {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      }
    }
  });

  // Widget requests current state → send cached snapshot and relay to main renderer
  ipcMain.on("widget:request-state", () => {
    const widget = getWidgetWindow();
    if (cachedSnapshot && widget && !widget.isDestroyed()) {
      widget.webContents.send("widget:state-push", cachedSnapshot);
    }
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send("widget:request-state-relay");
    }
  });

  // Widget moved — persist position
  ipcMain.on("widget:move", (_event, pos: { x: number; y: number }) => {
    setSettingValue(WIDGET_SETTINGS_KEYS.POS_X, String(pos.x));
    setSettingValue(WIDGET_SETTINGS_KEYS.POS_Y, String(pos.y));
  });

  // Helper: read avatar file and return as data URI, or null if missing
  function fileToDataUri(filePath: string | null): string | null {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    const mimeMap: Record<string, string> = {
      gif: "image/gif",
      png: "image/png",
      webp: "image/webp",
      apng: "image/apng",
    };
    const mime = mimeMap[ext] ?? "image/png";
    const data = fs.readFileSync(filePath);
    return `data:${mime};base64,${data.toString("base64")}`;
  }

  // Helper: read avatar data URIs from settings
  function getAvatarDataUris(): AvatarPaths {
    return {
      idle: fileToDataUri(getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_IDLE)),
      thinking: fileToDataUri(getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_THINKING)),
      tool_use: fileToDataUri(getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_TOOL_USE)),
    };
  }

  // Helper: check if any avatar file path is stored
  function hasAnyAvatar(): boolean {
    return !!(
      getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_IDLE)
      || getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_THINKING)
      || getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_TOOL_USE)
    );
  }

  // Get all widget settings
  ipcMain.handle("widget:settings-get", (): WidgetSettings => {
    const enabled = getSettingValue(WIDGET_SETTINGS_KEYS.ENABLED) === "true";
    const visibilityRaw = getSettingValue(WIDGET_SETTINGS_KEYS.VISIBILITY);
    const visibility = (visibilityRaw === "when-active" ? "when-active" : "always") as WidgetSettings["visibility"];
    const posXStr = getSettingValue(WIDGET_SETTINGS_KEYS.POS_X);
    const posYStr = getSettingValue(WIDGET_SETTINGS_KEYS.POS_Y);
    const position = posXStr && posYStr
      ? { x: parseInt(posXStr, 10), y: parseInt(posYStr, 10) }
      : null;
    return { enabled, visibility, position, avatars: getAvatarDataUris() };
  });

  // Save widget settings — create or destroy widget window based on enabled flag
  ipcMain.handle("widget:settings-save", (_event, settings: Partial<WidgetSettings>) => {
    if (settings.enabled !== undefined) {
      setSettingValue(WIDGET_SETTINGS_KEYS.ENABLED, settings.enabled ? "true" : "false");
      if (settings.enabled) {
        const posXStr = getSettingValue(WIDGET_SETTINGS_KEYS.POS_X);
        const posYStr = getSettingValue(WIDGET_SETTINGS_KEYS.POS_Y);
        const position = posXStr && posYStr
          ? { x: parseInt(posXStr, 10), y: parseInt(posYStr, 10) }
          : null;
        createWidgetWindow(position);
      } else {
        destroyWidgetWindow();
      }
    }
    if (settings.visibility !== undefined) {
      setSettingValue(WIDGET_SETTINGS_KEYS.VISIBILITY, settings.visibility);
      // Apply visibility immediately
      const widget = getWidgetWindow();
      if (widget && !widget.isDestroyed()) {
        if (settings.visibility === "when-active") {
          const isActive = cachedSnapshot?.status === "running" || cachedSnapshot?.status === "paused";
          if (isActive) {
            widget.show();
          } else {
            widget.hide();
          }
        } else {
          widget.show();
        }
      }
    }
    if (settings.position !== undefined) {
      if (settings.position === null) {
        setSettingValue(WIDGET_SETTINGS_KEYS.POS_X, "");
        setSettingValue(WIDGET_SETTINGS_KEYS.POS_Y, "");
        // Move widget back to default position
        const widget = getWidgetWindow();
        if (widget && !widget.isDestroyed()) {
          const primaryDisplay = screen.getPrimaryDisplay();
          const { x, y, width } = primaryDisplay.workArea;
          widget.setPosition(x + width - 240 - 20, y + 20);
        }
      } else {
        setSettingValue(WIDGET_SETTINGS_KEYS.POS_X, String(settings.position.x));
        setSettingValue(WIDGET_SETTINGS_KEYS.POS_Y, String(settings.position.y));
      }
    }
  });

  // --- Avatar IPC handlers ---

  const AVATAR_SLOT_KEY_MAP: Record<keyof AvatarPaths, string> = {
    idle: WIDGET_SETTINGS_KEYS.AVATAR_IDLE,
    thinking: WIDGET_SETTINGS_KEYS.AVATAR_THINKING,
    tool_use: WIDGET_SETTINGS_KEYS.AVATAR_TOOL_USE,
  };

  function getAvatarsDir(): string {
    const dir = path.join(app.getPath("userData"), "avatars");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function resizeWidgetForAvatars(): void {
    const widget = getWidgetWindow();
    if (!widget || widget.isDestroyed()) return;
    const width = widget.getSize()[0];
    if (width === undefined) return;
    widget.setSize(width, hasAnyAvatar() ? 112 : 80);
  }

  ipcMain.handle("widget:avatar-upload", async (_event, slot: keyof AvatarPaths): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: `Select avatar for "${slot}" status`,
      filters: [{ name: "Images", extensions: ["gif", "png", "webp", "apng"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const srcPath = result.filePaths[0]!;
    const ext = path.extname(srcPath);
    const destName = `avatar-${slot}${ext}`;
    const destPath = path.join(getAvatarsDir(), destName);
    fs.copyFileSync(srcPath, destPath);

    const settingsKey = AVATAR_SLOT_KEY_MAP[slot];
    setSettingValue(settingsKey, destPath);

    // Notify widget of updated avatars and resize
    const widget = getWidgetWindow();
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send("widget:avatars-updated", getAvatarDataUris());
    }
    resizeWidgetForAvatars();

    return fileToDataUri(destPath);
  });

  ipcMain.handle("widget:avatar-remove", (_event, slot: keyof AvatarPaths) => {
    const settingsKey = AVATAR_SLOT_KEY_MAP[slot];
    const currentPath = getSettingValue(settingsKey);
    if (currentPath && fs.existsSync(currentPath)) {
      fs.unlinkSync(currentPath);
    }
    deleteSettingValue(settingsKey);

    // Notify widget of updated avatars and resize
    const widget = getWidgetWindow();
    if (widget && !widget.isDestroyed()) {
      widget.webContents.send("widget:avatars-updated", getAvatarDataUris());
    }
    resizeWidgetForAvatars();
  });

  ipcMain.handle("widget:avatar-get-paths", (): AvatarPaths => {
    return getAvatarDataUris();
  });

  // Mark sessions as logged without making a Jira API call (used for bulk combined worklogs)
  ipcMain.handle(
    "worklog:mark-logged",
    (_event, input: { sessionIds: string[]; worklogId: string }) => {
      for (const sessionId of input.sessionIds) {
        const session = getSessionById(sessionId);
        if (session && isUploadableSession(session)) {
          updateWorklogStatus(sessionId, "logged", input.worklogId);
        }
      }
    },
  );

  ipcMain.handle(
    "worklog:log",
    async (
      _event,
        input: {
          sessionId: string;
          issueKey: string;
          selectedSessionIds?: string[];
          startTimeOverride?: string;
          endTimeOverride?: string;
          descriptionOverride?: string;
      },
    ) => {
      const provider = getJiraProvider();
      if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");

      // Fetch session from database
      const session = getSessionById(input.sessionId);
      if (!session) throw new Error("Session not found");
      if (!isUploadableSession(session)) {
        throw new IssueProviderError(
          "Only work and stopwatch sessions can be uploaded to Jira",
          "INELIGIBLE",
        );
      }

      // Calculate started timestamp and duration
      let started: string;
      let durationSeconds: number;

      if (input.selectedSessionIds && input.selectedSessionIds.length > 1) {
        const selectedSessions = input.selectedSessionIds
          .map((sessionId) => getSessionById(sessionId))
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
          .filter((candidate) => candidate.issueProvider === "jira" && candidate.issueId === input.issueKey);
        const merged = summarizeMergedWorklogSessions(selectedSessions);

        if (merged.uploadableSessionIds.length === 0 || !merged.startedAt) {
          throw new IssueProviderError(
            "Select at least one work or stopwatch session to upload",
            "INELIGIBLE",
          );
        }

        durationSeconds = merged.totalDurationSeconds;
        started = input.startTimeOverride ? new Date(input.startTimeOverride).toISOString() : merged.startedAt;
      } else if (input.startTimeOverride && input.endTimeOverride) {
        // Use override times for single-session uploads.
        const startDate = new Date(input.startTimeOverride);
        const endDate = new Date(input.endTimeOverride);
        durationSeconds = Math.round((endDate.getTime() - startDate.getTime()) / 1000);
        started = startDate.toISOString();
      } else {
        // Default: completedAt - actualDurationSeconds
        const completedDate = new Date(session.completedAt);
        const startedDate = new Date(completedDate.getTime() - session.actualDurationSeconds * 1000);
        started = startedDate.toISOString();
        durationSeconds = session.actualDurationSeconds;
      }

      // Guard: duration too short
      if (durationSeconds < 60) {
        throw new IssueProviderError(
          "Session duration is less than 60 seconds (Jira minimum)",
          "INELIGIBLE",
        );
      }

      // Build comment
      const comment = input.descriptionOverride ?? (session.title || "Work session");

      try {
        const result = await provider.addWorklog(
          input.issueKey,
          durationSeconds,
          started,
          comment,
        );
        updateWorklogStatus(input.sessionId, "logged", result.id);
        return { worklogId: result.id };
      } catch (err) {
        updateWorklogStatus(input.sessionId, "failed");
        throw err;
      }
    },
  );

  // ---- Media key globalShortcut fallback (T3.8) ----
  // Registers system-level media key shortcuts to relay play/pause/next/prev to the renderer.
  // Falls back gracefully if the shortcut is already registered by another app.
  app.whenReady().then(() => {
    const mediaKeys: Array<{ shortcut: string; action: string }> = [
      { shortcut: "MediaPlayPause", action: "MediaPlayPause" },
      { shortcut: "MediaNextTrack", action: "MediaNextTrack" },
      { shortcut: "MediaPreviousTrack", action: "MediaPreviousTrack" },
    ];

    for (const { shortcut, action } of mediaKeys) {
      try {
        const registered = globalShortcut.register(shortcut, () => {
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send("music:media-key", action);
          }
        });
        if (!registered) {
          console.warn(`[media-keys] Failed to register shortcut: ${shortcut}`);
        }
      } catch (err) {
        // Non-fatal — mediaSession in renderer handles it when the app is focused
        console.warn(`[media-keys] Could not register ${shortcut}:`, err);
      }
    }
  }).catch(() => {});
}
