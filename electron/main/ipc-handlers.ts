// electron/main/ipc-handlers.ts
// Registers all IPC handlers for the main process

import { ipcMain, shell } from "electron";
import type {
  AssignTagInput,
  CreateTagInput,
  IssueProviderStatus,
  IssuesListInput,
  IssuesSetTokenInput,
  JiraAuthType,
  JiraProviderStatus,
  LinearProviderStatus,
  ListSessionsInput,
  SaveSessionInput,
  SaveSessionWithTrackingInput,
  TimerSettings,
  UpdateTagInput,
} from "../../src/shared/types.ts";
import {
  assignTag,
  createTag,
  deleteSession,
  deleteSettingValue,
  deleteTag,
  getClaudeCodeDataForSession,
  getSessionById,
  getSettingValue,
  getSettings,
  listSessions,
  listTags,
  listTagsForSession,
  saveSession,
  saveSessionWithTracking,
  saveSettings,
  setSettingValue,
  unassignTag,
  updateSessionDuration,
  updateTag,
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

export function registerIpcHandlers(): void {
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

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });

  // Mark sessions as logged without making a Jira API call (used for bulk combined worklogs)
  ipcMain.handle(
    "worklog:mark-logged",
    (_event, input: { sessionIds: string[]; worklogId: string }) => {
      for (const sessionId of input.sessionIds) {
        updateWorklogStatus(sessionId, "logged", input.worklogId);
      }
    },
  );

  // Worklog IPC handler
  ipcMain.handle(
    "worklog:log",
    async (
      _event,
      input: {
        sessionId: string;
        issueKey: string;
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

      // Calculate started timestamp and duration
      let started: string;
      let durationSeconds: number;

      if (input.startTimeOverride && input.endTimeOverride) {
        // Use override times
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
}