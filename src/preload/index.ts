import { contextBridge, ipcRenderer } from "electron";
import type { ListSessionsInput, SaveSessionInput, TimerSettings } from "../shared/types.ts";

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
});
