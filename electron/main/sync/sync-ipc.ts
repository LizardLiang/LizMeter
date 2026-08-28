// electron/main/sync/sync-ipc.ts
// Registers all sync:* IPC handlers. Called from ipc-handlers.ts's registerIpcHandlers(), the
// exact existing pattern music/music-ipc.ts already establishes.
//
// There is no `sync:enable` channel: per the tactical plan's Milestone 6, turning sync on has
// no separate UI surface -- it happens implicitly the first time an existing Data Location move
// (`data-location:move`) targets a folder with real data to protect or another device's history
// to adopt. See sync-manager.ts's `decidePendingSyncAction`.

import { ipcMain } from "electron";
import { dismissNotice, disableSync, getSyncStatus, listNotices } from "./sync-manager.ts";

export function registerSyncIpcHandlers(): void {
  ipcMain.handle("sync:get-status", () => {
    return getSyncStatus();
  });

  ipcMain.handle("sync:disable", () => {
    disableSync();
  });

  ipcMain.handle("sync:list-notices", (_event, input: { includeDismissed?: boolean } = {}) => {
    return listNotices(input.includeDismissed === true);
  });

  ipcMain.handle("sync:dismiss-notice", (_event, input: { id: number }) => {
    dismissNotice(input.id);
  });
}
