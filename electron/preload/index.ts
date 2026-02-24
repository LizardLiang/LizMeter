import { contextBridge, ipcRenderer } from "electron";
import type {
  AssignTagInput,
  CreateTagInput,
  IssuesListInput,
  IssuesSetTokenInput,
  ListSessionsInput,
  SaveSessionInput,
  TimerSettings,
  UpdateTagInput,
} from "../../src/shared/types.ts";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  session: {
    save: (input: SaveSessionInput) => ipcRenderer.invoke("session:save", input),
    list: (input: ListSessionsInput) => ipcRenderer.invoke("session:list", input),
    delete: (id: string) => ipcRenderer.invoke("session:delete", id),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings: TimerSettings) => ipcRenderer.invoke("settings:save", settings),
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
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  },
});