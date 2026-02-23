// electron/main/ipc-handlers.ts
// Registers all IPC handlers for the main process

import { ipcMain, shell } from "electron";
import type {
  AssignTagInput,
  CreateTagInput,
  IssueProviderStatus,
  IssuesListInput,
  IssuesSetTokenInput,
  ListSessionsInput,
  SaveSessionInput,
  TimerSettings,
  UpdateTagInput,
} from "../../src/shared/types.ts";
import {
  assignTag,
  createTag,
  deleteSession,
  deleteTag,
  getSettings,
  listSessions,
  listTags,
  listTagsForSession,
  saveSession,
  saveSettings,
  unassignTag,
  updateTag,
} from "./database.ts";
import { getProvider, setProvider } from "./issue-providers/index.ts";
import { GitHubProvider } from "./issue-providers/github-provider.ts";
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

  // Issue tracker handlers
  ipcMain.handle("issues:list", async (_event, input: IssuesListInput) => {
    const provider = getProvider();
    if (!provider) throw new IssueProviderError("No token configured", "NO_TOKEN");
    return { issues: await provider.listIssues(input) };
  });

  ipcMain.handle("issues:provider-status", (): IssueProviderStatus => ({
    configured: hasToken(),
    provider: hasToken() ? "github" : null,
  }));

  ipcMain.handle("issues:set-token", (_event, input: IssuesSetTokenInput) => {
    if (!input.token || input.token.trim().length === 0) {
      throw new Error("Token cannot be empty");
    }
    saveToken(input.token.trim());
    setProvider(new GitHubProvider(input.token.trim()));
  });

  ipcMain.handle("issues:test-token", async () => {
    const provider = getProvider();
    if (!provider) throw new IssueProviderError("No token configured", "NO_TOKEN");
    return provider.testConnection();
  });

  ipcMain.handle("issues:delete-token", () => {
    getProvider()?.destroy();
    setProvider(null);
    deleteToken();
  });

  ipcMain.handle("shell:open-external", (_event, url: string) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
  });
}
