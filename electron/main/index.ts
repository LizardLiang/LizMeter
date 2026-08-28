import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDatabase, getSettingValue, initDatabase } from "./database.ts";
import { getAttachmentsDir, sweepOrphanBlobs } from "./attachment-store.ts";
import { ATTACHMENT_SCHEME_NAME, resolveAttachmentPath } from "./attachment-url.ts";
import { clearCustomDataDir, getDataDirStatus, invalidateDataDirCache } from "./data-location.ts";
import { destroyTracker } from "./claude-code-tracker.ts";
import { registerIpcHandlers } from "./ipc-handlers.ts";
import { destroyPipeServer, startPipeServer } from "./pipe-server.ts";
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

  // Collects blobs left behind by a crash between the file write and the row insert.
  sweepOrphanBlobs();

  registerIpcHandlers();
  registerWindowControlHandlers();
  startPipeServer();
  initProviderFromDisk();
  initLinearProviderFromDisk();
  initJiraProviderFromDisk();
  createWindow();

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
  destroyPipeServer();
  destroyTracker();
  closeDatabase();
});