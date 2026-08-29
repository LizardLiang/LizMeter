// electron/main/sync/sync-ipc.ts
// Registers all sync:* IPC handlers. Called from ipc-handlers.ts's registerIpcHandlers(), the
// exact existing pattern music/music-ipc.ts already establishes.
//
// There is no `sync:enable` channel: per the tactical plan's Milestone 6, turning sync on has
// no separate UI surface -- it happens implicitly the first time an existing Data Location move
// (`data-location:move`) targets a folder with real data to protect or another device's history
// to adopt. See sync-manager.ts's `decidePendingSyncAction`.

import { ipcMain } from "electron";
import {
  dismissNotice,
  disableSync,
  getPendingRenumberCount,
  getSyncStatus,
  listNotices,
  renumberLegacyTodoIds,
} from "./sync-manager.ts";

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

  // How many todos still carry a 15-digit number from the retired block scheme. Drives whether the
  // Settings control appears at all -- on a machine with nothing to fix, it should not.
  ipcMain.handle("sync:pending-renumber-count", () => {
    return getPendingRenumberCount();
  });

  // The refuse-once-then-proceed shape `requiresAdoptConfirmation` and
  // `requiresUnsyncedDbConfirmation` already use: a one-way step never runs on the first ask.
  ipcMain.handle("sync:renumber-legacy-ids", (_event, input: { confirm?: boolean } = {}) => {
    return renumberLegacyTodoIds(input.confirm === true);
  });
}
