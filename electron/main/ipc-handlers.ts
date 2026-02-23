// electron/main/ipc-handlers.ts
// Registers all IPC handlers for the main process

import { ipcMain, shell } from "electron";
import type {
  AssignTagInput,
  CreateTagInput,
  IssueProviderStatus,
  IssuesListInput,
  IssuesSetTokenInput,
  LinearProviderStatus,
  ListSessionsInput,
  SaveSessionInput,
  TimerSettings,
  UpdateTagInput,
} from "../../src/shared/types.ts";
import {
  assignTag,
  createTag,
  deleteSession,
  deleteSettingValue,
  deleteTag,
  getSettingValue,
  getSettings,
  listSessions,
  listTags,
  listTagsForSession,
  saveSession,
  saveSettings,
  setSettingValue,
  unassignTag,
  updateTag,
} from "./database.ts";
import { getGitHubProvider, getLinearProvider, setLinearProvider, setProvider } from "./issue-providers/index.ts";
import { GitHubProvider } from "./issue-providers/github-provider.ts";
import { LinearProvider } from "./issue-providers/linear-provider.ts";
import { IssueProviderError } from "./issue-providers/types.ts";
import { deleteToken, hasToken, saveToken } from "./issue-providers/token-storage.ts";

export function registerIpcHandlers(): void {
  ipcMain.handle("session:save", (_event, input: SaveSessionInput) => {
    return saveSession(input);
  });

  ipcMain.handle("session:list", (_event, input: ListSessionsInput) => {
    return listSessions(input ?? {});
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
    return {
      configured: hasToken("github"),
      provider: hasToken("github") ? "github" : null,
      linearConfigured,
      linearTeamSelected: linearConfigured && linearTeamId !== null,
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

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });
}