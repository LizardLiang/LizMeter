// e2e/helpers.ts
// Shared helpers for Playwright E2E tests

import path from "path";
import { fileURLToPath } from "url";
import { type ElectronApplication, type Page, _electron as electron } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ELECTRON_MAIN = path.resolve(__dirname, "../dist-electron/main/index.js");

/**
 * Launch a fresh Electron app instance.
 * Each test file should call this in beforeAll and close in afterAll.
 */
export async function launchApp(): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [ELECTRON_MAIN],
    timeout: 30000,
  });
  return app;
}

/**
 * Get the first (and only) window of the app.
 * Waits for the window to be ready by checking the DOM is loaded.
 */
export async function getWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  // Wait for the React app to be hydrated
  await window.waitForLoadState("domcontentloaded");
  return window;
}

/**
 * Navigate to a specific sidebar page by its aria-label.
 * Pages: Timer, History, Issues, Claude, Stats, Tags, Settings
 */
export async function navigateTo(window: Page, pageLabel: string): Promise<void> {
  await window.click(`nav[aria-label="Main navigation"] button[aria-label="${pageLabel}"]`);
  // Small wait for React to re-render after navigation
  await window.waitForTimeout(200);
}

/**
 * Type text into the TipTap rich text editor.
 * The editor uses a contenteditable div inside .ProseMirror.
 * Finds the first visible ProseMirror editor in the page.
 */
export async function typeInRichTextEditor(window: Page, text: string): Promise<void> {
  const editor = window.locator(".ProseMirror").first();
  await editor.click();
  await editor.type(text);
}

/**
 * Clear and type text into the TipTap rich text editor.
 */
export async function clearAndTypeInRichTextEditor(window: Page, text: string): Promise<void> {
  const editor = window.locator(".ProseMirror").first();
  await editor.click();
  // Select all and delete
  await window.keyboard.press("Control+a");
  await window.keyboard.press("Backspace");
  await editor.type(text);
}

/**
 * Wait for an element to be visible with a reasonable timeout.
 */
export async function waitForVisible(window: Page, selector: string, timeout = 5000): Promise<void> {
  await window.locator(selector).waitFor({ state: "visible", timeout });
}

/**
 * Switch the app mode to Time Tracking (stopwatch mode).
 */
export async function switchToTimeTracking(window: Page): Promise<void> {
  await window.click('button[role="tab"]:has-text("Time Tracking")');
  await window.waitForTimeout(200);
}

/**
 * Switch the app mode to Pomodoro.
 */
export async function switchToPomodoro(window: Page): Promise<void> {
  await window.click('button[role="tab"]:has-text("Pomodoro")');
  await window.waitForTimeout(200);
}