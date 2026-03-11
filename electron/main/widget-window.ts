// electron/main/widget-window.ts
// Factory and manager for the always-on-top desktop widget BrowserWindow

import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettingValue, setSettingValue } from "./database.ts";
import { WIDGET_SETTINGS_KEYS } from "../../src/shared/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

let widgetWindow: BrowserWindow | null = null;

/**
 * Validates that the given position is visible on at least one display.
 * Returns true if the position is on-screen.
 */
function isPositionOnScreen(x: number, y: number): boolean {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const { x: dx, y: dy, width, height } = display.bounds;
    if (x >= dx && x < dx + width && y >= dy && y < dy + height) {
      return true;
    }
  }
  return false;
}

/**
 * Computes the default top-right position with 20px margin.
 */
function getDefaultPosition(): { x: number; y: number } {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width } = primaryDisplay.workArea;
  return {
    x: x + width - 240 - 20,
    y: y + 20,
  };
}

/**
 * Creates the widget BrowserWindow.
 * @param position Optional saved position. Falls back to top-right if off-screen.
 */
export function createWidgetWindow(position?: { x: number; y: number } | null): BrowserWindow {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    return widgetWindow;
  }

  const pos = position && isPositionOnScreen(position.x, position.y)
    ? position
    : getDefaultPosition();

  // Use taller widget when avatars are configured
  const hasAvatar = !!(
    getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_IDLE)
    || getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_THINKING)
    || getSettingValue(WIDGET_SETTINGS_KEYS.AVATAR_TOOL_USE)
  );

  widgetWindow = new BrowserWindow({
    width: 240,
    height: hasAvatar ? 112 : 80,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "../preload/widget.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Enforce highest always-on-top level so the widget stays above all other windows
  widgetWindow.setAlwaysOnTop(true, "screen-saver");

  // Persist position when user drags the widget
  widgetWindow.on("moved", () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    const [winX, winY] = widgetWindow.getPosition();
    setSettingValue(WIDGET_SETTINGS_KEYS.POS_X, String(winX));
    setSettingValue(WIDGET_SETTINGS_KEYS.POS_Y, String(winY));
  });

  widgetWindow.on("closed", () => {
    widgetWindow = null;
  });

  if (VITE_DEV_SERVER_URL) {
    void widgetWindow.loadURL(`${VITE_DEV_SERVER_URL}src/renderer/widget/index.html`);
  } else {
    void widgetWindow.loadFile(path.join(__dirname, "../../dist/src/renderer/widget/index.html"));
  }

  return widgetWindow;
}

/**
 * Returns the current widget window instance or null if not created.
 */
export function getWidgetWindow(): BrowserWindow | null {
  if (widgetWindow && widgetWindow.isDestroyed()) {
    widgetWindow = null;
  }
  return widgetWindow;
}

/**
 * Destroys the widget window if it exists.
 */
export function destroyWidgetWindow(): void {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
  }
  widgetWindow = null;
}