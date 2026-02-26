// e2e/stopwatch.spec.ts
// Tests for the Time Tracking (stopwatch) mode

import { type ElectronApplication, expect, test } from "@playwright/test";
import { getWindow, launchApp, navigateTo, switchToTimeTracking } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test.beforeEach(async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Timer");
  await switchToTimeTracking(window);
});

test("can switch to Time Tracking mode", async () => {
  const window = await getWindow(app);
  const timeTrackingTab = window.locator('button[role="tab"]:has-text("Time Tracking")');
  await expect(timeTrackingTab).toHaveAttribute("aria-selected", "true");
});

test("stopwatch section label is visible", async () => {
  const window = await getWindow(app);
  // StopwatchView renders a div with text "Stopwatch"
  await expect(window.locator("text=Stopwatch")).toBeVisible();
});

test("Start button is disabled when description is empty", async () => {
  const window = await getWindow(app);
  const startBtn = window.locator("button", { hasText: "Start" });
  await expect(startBtn).toBeDisabled();
});

test("Start button is enabled after typing a description", async () => {
  const window = await getWindow(app);

  // Type in the ProseMirror editor in stopwatch view
  const editor = window.locator(".ProseMirror").first();
  await editor.click();
  await editor.type("Working on feature X");

  const startBtn = window.locator("button", { hasText: "Start" });
  await expect(startBtn).toBeEnabled();

  // Clean up: navigate away and back to reset
  await navigateTo(window, "History");
  await navigateTo(window, "Timer");
  await switchToTimeTracking(window);
});

test("clicking Start shows Pause and Stop buttons", async () => {
  const window = await getWindow(app);

  const editor = window.locator(".ProseMirror").first();
  await editor.click();
  await editor.type("Testing stopwatch start");

  const startBtn = window.locator("button", { hasText: "Start" });
  await startBtn.click();

  // After start, may show issue prompt (if promptForIssue is true).
  // If issue prompt appears, skip it.
  const skipBtn = window.locator("button", { hasText: "Skip" });
  if (await skipBtn.isVisible({ timeout: 1000 })) {
    await skipBtn.click();
  }

  await expect(window.locator("button", { hasText: "Pause" })).toBeVisible({ timeout: 3000 });
  await expect(window.locator("button", { hasText: "Stop" })).toBeVisible({ timeout: 3000 });

  // Clean up: stop the stopwatch
  await window.locator("button", { hasText: "Stop" }).click();
});

test("Pausing stopwatch shows Resume and Stop buttons", async () => {
  const window = await getWindow(app);

  const editor = window.locator(".ProseMirror").first();
  await editor.click();
  await editor.type("Pause resume test");

  await window.locator("button", { hasText: "Start" }).click();

  // Handle possible issue prompt
  const skipBtn = window.locator("button", { hasText: "Skip" });
  if (await skipBtn.isVisible({ timeout: 1000 })) {
    await skipBtn.click();
  }

  await window.locator("button", { hasText: "Pause" }).waitFor({ state: "visible", timeout: 3000 });
  await window.locator("button", { hasText: "Pause" }).click();

  await expect(window.locator("button", { hasText: "Resume" })).toBeVisible({ timeout: 3000 });
  await expect(window.locator("button", { hasText: "Stop" })).toBeVisible();

  // Clean up
  await window.locator("button", { hasText: "Stop" }).click();
});

test("elapsed time display starts at 0:00:00", async () => {
  const window = await getWindow(app);
  // The elapsed display shows formatted time. Before starting it should be 0:00:00.
  const elapsed = window.locator(".ProseMirror").first();
  // The elapsed time element is rendered in StopwatchView with the formatElapsed output.
  // Look for the time display which shows 0:00:00 initially
  const elapsedDisplay = window.locator("text=0:00:00");
  await expect(elapsedDisplay).toBeVisible();
});

test("description input is disabled when stopwatch is running", async () => {
  const window = await getWindow(app);

  const editor = window.locator(".ProseMirror").first();
  await editor.click();
  await editor.type("Disabled input test");

  await window.locator("button", { hasText: "Start" }).click();

  // Handle possible issue prompt
  const skipBtn = window.locator("button", { hasText: "Skip" });
  if (await skipBtn.isVisible({ timeout: 1000 })) {
    await skipBtn.click();
  }

  await window.locator("button", { hasText: "Pause" }).waitFor({ state: "visible", timeout: 3000 });

  // The editor should now be non-editable (disabled)
  // TipTap sets contenteditable="false" when disabled
  const editorAfterStart = window.locator(".ProseMirror").first();
  const contentEditable = await editorAfterStart.getAttribute("contenteditable");
  expect(contentEditable).toBe("false");

  // Clean up
  await window.locator("button", { hasText: "Stop" }).click();
});

test("switching from Time Tracking back to Pomodoro shows timer controls", async () => {
  const window = await getWindow(app);

  // Switch back to Pomodoro
  await window.locator('button[role="tab"]:has-text("Pomodoro")').click();
  await window.waitForTimeout(200);

  const pomodoroTab = window.locator('button[role="tab"]:has-text("Pomodoro")');
  await expect(pomodoroTab).toHaveAttribute("aria-selected", "true");

  // Timer type selector should be visible (only in Pomodoro mode)
  const typeGroup = window.locator('[role="group"][aria-label="Timer type"]');
  await expect(typeGroup).toBeVisible();
});