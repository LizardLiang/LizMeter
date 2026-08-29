import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDatabase, getDb, getSettingValue, initDatabase } from "./database.ts";
import { getAttachmentsDir, sweepOrphanBlobs } from "./attachment-store.ts";
import { ATTACHMENT_SCHEME_NAME, resolveAttachmentPath } from "./attachment-url.ts";
import { clearCustomDataDir, getDataDirStatus, invalidateDataDirCache } from "./data-location.ts";
import { destroyTracker } from "./claude-code-tracker.ts";
import { registerIpcHandlers } from "./ipc-handlers.ts";
import { destroyPipeServer, startPipeServer } from "./pipe-server.ts";
import {
  applyPendingSyncActionAfterInit,
  consumePendingSyncActionBeforeInit,
  setTodosChangedCallback,
  startSyncManager,
  stopSyncManager,
  writePendingSyncAction,
} from "./sync/sync-manager.ts";
import { addSyncNotice } from "./sync/notices.ts";
import { isSyncEnabled } from "./sync/sync-writer.ts";
import { backupExistingPrivateDbBeforeAdopt, markDeviceAsAdopted, markPrivateDb } from "./data-location.ts";
import {
  initJiraProviderFromDisk,
  initLinearProviderFromDisk,
  initProviderFromDisk,
} from "./issue-providers/index.ts";
import { createWidgetWindow, destroyWidgetWindow } from "./widget-window.ts";
import { WIDGET_SETTINGS_KEYS } from "../../src/shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

// Enable remote debugging for agent-browser testing in dev mode
if (VITE_DEV_SERVER_URL) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");

  // Isolate dev data from an already-running installed build. Both share the same
  // userData folder (package name "lizmeter" vs productName "LizMeter" collide on
  // case-insensitive Windows) and the same named pipe, so a dev instance launched
  // while the installed app is open would corrupt its live DB / steal its pipe.
  // setPath must run before app.whenReady() -- Electron ignores it after ready.
  const devUserDataPath = path.join(app.getPath("appData"), "lizmeter-dev");
  // app.setPath throws if the target directory does not exist yet -- create it first.
  fs.mkdirSync(devUserDataPath, { recursive: true });
  app.setPath("userData", devUserDataPath);
  const devPipePath = process.platform === "win32"
    ? "\\\\.\\pipe\\lizmeter-dev"
    : "/tmp/lizmeter-dev.sock";
  console.log(`[dev] userData: ${devUserDataPath} | pipe: ${devPipePath}`);
}

// Attachments are served over a custom scheme rather than file:// or a data URI.
//
// This call must run at module top level, before the app is ready — after `whenReady()` it
// silently does nothing and every attachment image fails with no useful error. `bypassCSP` is
// deliberately absent: the renderer's CSP names `app-media:` in `img-src` explicitly.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_SCHEME_NAME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// Prevent music subsystem errors from crashing the app
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  // Don't crash the app for non-fatal errors — just log them
});

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// Register window control IPC handlers scoped to the sender window
function registerWindowControlHandlers(): void {
  ipcMain.on("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.on("window:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });
}

function createWindow(): BrowserWindow {
  Menu.setApplicationMenu(null);

  const iconPath = path.join(__dirname, "../../assets/icon.png");

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  // A file dropped anywhere in an Electron window navigates the renderer to that file and
  // wipes app state. Nothing in this app navigates the main frame, so refusing every
  // navigation away from the current URL is safe and closes that hole for good.
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
    }
  });

  win.webContents.on("render-process-gone", () => {
    destroyTracker();
  });

  win.on("close", () => {
    destroyWidgetWindow();
  });

  if (VITE_DEV_SERVER_URL) {
    void win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    void win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return win;
}

/**
 * Blocks startup while the user's data folder is missing.
 *
 * Only reachable when the data was moved to a folder that has since gone away — an external
 * drive, a network share, a synced folder not yet pulled down. Opening the default folder
 * instead would create an empty database and read as total data loss, so the user decides.
 *
 * Returns false when the app should quit.
 */
function ensureDataDirAvailable(): boolean {
  for (;;) {
    const status = getDataDirStatus();
    if (status.available) return true;

    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "Data Folder Not Found",
      message: "LizMeter cannot find its data folder.",
      detail: [
        status.dataDir,
        "",
        "The drive may not be connected. Reconnect it and retry, or go back to the default folder:",
        status.defaultDataDir,
        "",
        "Going back to the default folder does not delete anything.",
      ].join("\n"),
      buttons: ["Retry", "Use Default Folder", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });

    if (choice === 0) {
      invalidateDataDirCache();
      continue;
    }
    if (choice === 1) {
      clearCustomDataDir();
      return true;
    }
    return false;
  }
}

app.whenReady().then(() => {
  if (!ensureDataDirAvailable()) {
    app.quit();
    return;
  }

  // Must run before initDatabase(): marking this device's *working* database as private
  // (userData), never the shared data folder, before the very first initDatabase() call is what
  // makes getDbDir() in data-location.ts resolve there for that call -- see
  // implementation-notes.md's Fix Round for why every device that turns sync on, not just an
  // adopter, needs this.
  const pendingSyncAction = consumePendingSyncActionBeforeInit();
  let adoptBackupPath: string | null = null;
  // M-004: everything below through markPrivateDb() is a synchronous local (userData, never the
  // shared cloud folder) filesystem write or rename that can throw -- disk full, or a file lock
  // momentarily held by antivirus/indexing software right after a relaunch, both real on Windows.
  // consumePendingSyncActionBeforeInit() above already deleted the marker (by design, so a crash
  // between read and delete cannot replay a stale action forever), so an uncaught throw here would
  // leave nothing to retry from -- the same "silent, windowless, non-quitting process" R2-B2
  // exists to prevent for the block below, at a call site R2-B2 did not cover. initDatabase() has
  // not run yet at this point, so soldiering on afterward risks opening the wrong database (e.g.
  // a shared folder's, before this device's private-db marker was actually written) -- quitting
  // cleanly and retrying the whole action from the top next launch is safer than guessing.
  try {
    if (pendingSyncAction?.action === "adopt") {
      markDeviceAsAdopted();
      // A device that used LizMeter standalone before ever touching sync already has a real
      // database sitting at this same private location -- rename it out of the way so the
      // adoption below opens (and rebuildFromSnapshot then repopulates) a genuinely fresh file,
      // never that device's own pre-existing history (FR-017's "rebuild a fresh local database").
      adoptBackupPath = backupExistingPrivateDbBeforeAdopt();
    } else if (pendingSyncAction?.action === "enable") {
      markPrivateDb();
    }
  } catch (err) {
    console.error("[startup] pre-init sync action setup failed:", err);
    if (pendingSyncAction !== null) {
      writePendingSyncAction(pendingSyncAction);
    }
    dialog.showErrorBox(
      "Startup Error",
      `Could not prepare this machine's sync setup. The app will retry on the next launch.\n\nError: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    app.quit();
    return;
  }

  try {
    initDatabase();
  } catch (err) {
    // Logged before the modal: showErrorBox blocks startup with no window and no
    // console trace, which leaves a failed migration impossible to diagnose.
    console.error("[startup] initDatabase failed:", err);
    dialog.showErrorBox(
      "Database Error",
      `Failed to initialize the database. The app cannot start.\n\nError: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    app.quit();
    return;
  }

  // Serves the data folder's attachments over app-media://. resolveAttachmentPath is the whole
  // security boundary: it returns null for anything but a <64 hex>.<ext> basename that
  // still resolves inside the attachments folder.
  protocol.handle(ATTACHMENT_SCHEME_NAME, (request) => {
    const file = resolveAttachmentPath(request.url, getAttachmentsDir());
    if (file === null) return new Response("not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // R2-B2: this can throw -- most commonly NotFullyHydratedError (FR-014), an unhydrated cloud
  // placeholder in a folder this device was just pointed at, which is the *expected* state right
  // after an adopt or enable, not an exotic one. By this point consumePendingSyncActionBeforeInit
  // has already deleted the marker and initDatabase() above has already opened (for "adopt", a
  // freshly-emptied; for "enable", the relocated real) database -- an uncaught throw here used to
  // leave both of those committed with no window ever created (app.whenReady().then(...) had no
  // .catch, and the uncaughtException handler above deliberately does not quit), producing a
  // silent, windowless, non-quitting process. Wrapping this alone is not enough on its own to
  // undo what already committed, so on failure the marker is rewritten: the whole action retries
  // from the top on the next launch instead of being silently dropped, and every step it retries
  // is safe to re-enter (markDeviceAsAdopted/markPrivateDb are no-ops once already marked;
  // backupExistingPrivateDbBeforeAdopt renames aside whatever now sits at the private path,
  // including this attempt's own emptied-out database, never touching the original backup again).
  try {
    applyPendingSyncActionAfterInit(pendingSyncAction);
  } catch (err) {
    console.warn("[startup] pending sync action failed, will retry on next launch:", err);
    if (pendingSyncAction !== null) {
      writePendingSyncAction(pendingSyncAction);
    }
  }

  if (adoptBackupPath !== null) {
    // FR-017: the old database is never deleted, and its location must be surfaced, not just
    // left silently on disk for the user to stumble across.
    addSyncNotice(
      getDb(),
      "adopted-backup",
      "This machine's previous database was kept as a backup before adopting the shared data.",
      adoptBackupPath,
    );
  }

  // Collects blobs left behind by a crash between the file write and the row insert. Skipped
  // while sync is on: this device's local todo_attachments rows only reflect what has merged in
  // so far, so a purely local refcount cannot tell "orphaned" apart from "a peer's attachment
  // that has not synced to this device yet" -- deleting the latter destroys it for every device,
  // since attachments are content-addressed and this is the one copy on disk.
  if (!isSyncEnabled(getDb())) {
    sweepOrphanBlobs();
  }

  registerIpcHandlers();
  registerWindowControlHandlers();
  startPipeServer();
  initProviderFromDisk();
  initLinearProviderFromDisk();
  initJiraProviderFromDisk();
  setTodosChangedCallback(() => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send("todo:changed");
  });
  createWindow();
  // startSyncManager's first pass runs a synchronous merge (potentially many oplog entries) --
  // scheduled on the next tick, after the window already exists, rather than blocking it. This
  // does not change what happens, only when: the window was created above and starts loading
  // immediately either way, but deferring the merge keeps that load from ever waiting behind it.
  setImmediate(() => startSyncManager());

  // Create widget if enabled in settings
  const widgetEnabled = getSettingValue(WIDGET_SETTINGS_KEYS.ENABLED);
  if (widgetEnabled === "true") {
    const posXStr = getSettingValue(WIDGET_SETTINGS_KEYS.POS_X);
    const posYStr = getSettingValue(WIDGET_SETTINGS_KEYS.POS_Y);
    const position = posXStr && posYStr
      ? { x: parseInt(posXStr, 10), y: parseInt(posYStr, 10) }
      : null;
    createWidgetWindow(position);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopSyncManager();
  destroyPipeServer();
  destroyTracker();
  closeDatabase();
});