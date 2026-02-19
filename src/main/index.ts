import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { closeDatabase, initDatabase } from "./database.ts";
import { registerIpcHandlers } from "./ipc-handlers.ts";

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env["ELECTRON_DEV"]) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
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
