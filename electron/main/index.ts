import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeDatabase, getSettingValue, initDatabase } from "./database.ts";
import { getAttachmentsDir, sweepOrphanBlobs } from "./attachment-store.ts";
import { ATTACHMENT_SCHEME_NAME, resolveAttachmentPath } from "./attachment-url.ts";
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

app.whenReady().then(() => {
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

  // Serves userData/attachments over app-media://. resolveAttachmentPath is the whole
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