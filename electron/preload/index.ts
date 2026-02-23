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
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  },
});
