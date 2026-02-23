import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, initDatabase } from "./database.ts";
import { registerIpcHandlers } from "./ipc-handlers.ts";
import { initJiraProviderFromDisk, initLinearProviderFromDisk, initProviderFromDisk } from "./issue-providers/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

function createWindow() {
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 600,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  ipcMain.on("window:minimize", () => win.minimize());
  ipcMain.on("window:maximize", () => {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on("window:close", () => win.close());

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
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
  initProviderFromDisk();
  initLinearProviderFromDisk();
  initJiraProviderFromDisk();
  createWindow();

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
  closeDatabase();
});
