// src/main/ipc-handlers.ts
// Registers all IPC handlers for the main process

import { ipcMain } from "electron";
import type { ListSessionsInput, SaveSessionInput, TimerSettings } from "../shared/types.ts";
import { deleteSession, getSettings, listSessions, saveSession, saveSettings } from "./database.ts";

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
}
