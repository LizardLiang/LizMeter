// e2e/timer.spec.ts
// Tests for the Pomodoro timer page

import { type ElectronApplication, expect, test } from "@playwright/test";
import { getWindow, launchApp, navigateTo, typeInRichTextEditor } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test.beforeEach(async () => {
  const window = await getWindow(app);
  // Always start on timer page in Pomodoro mode
  await navigateTo(window, "Timer");
  // Make sure we are in Pomodoro mode
  const pomodoroTab = window.locator('button[role="tab"]:has-text("Pomodoro")');
  const isSelected = await pomodoroTab.getAttribute("aria-selected");
  if (isSelected !== "true") {
    await pomodoroTab.click();
    await window.waitForTimeout(200);
  }
});

test("timer page shows Pomodoro mode toggle tabs", async () => {
  const window = await getWindow(app);
  await expect(window.locator('button[role="tab"]:has-text("Pomodoro")')).toBeVisible();
  await expect(window.locator('button[role="tab"]:has-text("Time Tracking")')).toBeVisible();
});

test("timer type selector shows Work, Short Break, Long Break", async () => {
  const window = await getWindow(app);
  const typeGroup = window.locator('[role="group"][aria-label="Timer type"]');
  await expect(typeGroup).toBeVisible();
  await expect(typeGroup.locator("button", { hasText: "Work" })).toBeVisible();
  await expect(typeGroup.locator("button", { hasText: "Short Break" })).toBeVisible();
  await expect(typeGroup.locator("button", { hasText: "Long Break" })).toBeVisible();
});

test("Start button is disabled when session description is empty", async () => {
  const window = await getWindow(app);
  // The TipTap editor should be empty — Start should be disabled
  const startBtn = window.locator("button", { hasText: "Start" }).first();
  await expect(startBtn).toBeDisabled();
});

test("Start button is enabled after typing a session description", async () => {
  const window = await getWindow(app);
  await typeInRichTextEditor(window, "My test session");

  const startBtn = window.locator("button", { hasText: "Start" }).first();
  await expect(startBtn).toBeEnabled();

  // Clean up: reset by navigating away and back (resets the React state)
  await navigateTo(window, "History");
  await navigateTo(window, "Timer");
});

test("clicking Start begins the timer and shows Pause button", async () => {
  const window = await getWindow(app);
  await typeInRichTextEditor(window, "Timer start test");

  const startBtn = window.locator("button", { hasText: "Start" }).first();
  await startBtn.click();

  // After starting, Pause button should appear
  const pauseBtn = window.locator("button", { hasText: "Pause" });
  await expect(pauseBtn).toBeVisible({ timeout: 3000 });

  // Reset the timer to clean up
  const resetBtn = window.locator("button", { hasText: "Reset" });
  await resetBtn.click();
});

test("Pause button changes to Resume when clicked", async () => {
  const window = await getWindow(app);
  await typeInRichTextEditor(window, "Pause resume test");

  await window.locator("button", { hasText: "Start" }).first().click();
  await window.locator("button", { hasText: "Pause" }).click();

  const resumeBtn = window.locator("button", { hasText: "Resume" });
  await expect(resumeBtn).toBeVisible({ timeout: 3000 });

  // Clean up
  const resetBtn = window.locator("button", { hasText: "Reset" });
  await resetBtn.click();
});

test("Reset button stops the timer and returns to idle state", async () => {
  const window = await getWindow(app);
  await typeInRichTextEditor(window, "Reset test session");

  await window.locator("button", { hasText: "Start" }).first().click();
  await window.locator("button", { hasText: "Pause" }).waitFor({ state: "visible", timeout: 3000 });
  await window.locator("button", { hasText: "Reset" }).click();

  // After reset, Start button should reappear (but disabled since description was cleared)
  // The timer should be back to idle
  const startBtn = window.locator("button", { hasText: "Start" }).first();
  await expect(startBtn).toBeVisible({ timeout: 3000 });
});

test("selecting Short Break changes timer type", async () => {
  const window = await getWindow(app);
  const typeGroup = window.locator('[role="group"][aria-label="Timer type"]');
  const shortBreakBtn = typeGroup.locator("button", { hasText: "Short Break" });

  await shortBreakBtn.click();

  // The button should now be pressed
  await expect(shortBreakBtn).toHaveAttribute("aria-pressed", "true");
});

test("selecting Long Break changes timer type", async () => {
  const window = await getWindow(app);
  const typeGroup = window.locator('[role="group"][aria-label="Timer type"]');
  const longBreakBtn = typeGroup.locator("button", { hasText: "Long Break" });

  await longBreakBtn.click();

  await expect(longBreakBtn).toHaveAttribute("aria-pressed", "true");
});

test("selecting Work resets to work type", async () => {
  const window = await getWindow(app);
  const typeGroup = window.locator('[role="group"][aria-label="Timer type"]');

  await typeGroup.locator("button", { hasText: "Short Break" }).click();
  await typeGroup.locator("button", { hasText: "Work" }).click();

  await expect(typeGroup.locator("button", { hasText: "Work" })).toHaveAttribute("aria-pressed", "true");
});

test("timer type buttons are disabled when timer is running", async () => {
  const window = await getWindow(app);
  await typeInRichTextEditor(window, "Running timer test");

  await window.locator("button", { hasText: "Start" }).first().click();
  await window.locator("button", { hasText: "Pause" }).waitFor({ state: "visible", timeout: 3000 });

  const typeGroup = window.locator('[role="group"][aria-label="Timer type"]');
  const workBtn = typeGroup.locator("button", { hasText: "Work" });
  await expect(workBtn).toBeDisabled();

  // Clean up
  await window.locator("button", { hasText: "Reset" }).click();
});

test("Session Description label is visible", async () => {
  const window = await getWindow(app);
  const label = window.locator("label", { hasText: "Session Description" });
  await expect(label).toBeVisible();
});

test("timer shows section label 'Timer'", async () => {
  const window = await getWindow(app);
  // The TimerView renders a sectionLabel div
  const sectionLabel = window.locator("text=Timer").first();
  await expect(sectionLabel).toBeVisible();
});