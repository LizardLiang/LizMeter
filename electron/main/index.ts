import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, getSettingValue, initDatabase } from "./database.ts";
import { destroyTracker } from "./claude-code-tracker.ts";
import { registerIpcHandlers } from "./ipc-handlers.ts";
import { destroyNvimPipeServer, startNvimPipeServer } from "./nvim-pipe-server.ts";
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
    dialog.showErrorBox(
      "Database Error",
      `Failed to initialize the database. The app cannot start.\n\nError: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    app.quit();
    return;
  }

  registerIpcHandlers();
  registerWindowControlHandlers();
  startNvimPipeServer();
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
  destroyNvimPipeServer();
  destroyTracker();
  closeDatabase();
});