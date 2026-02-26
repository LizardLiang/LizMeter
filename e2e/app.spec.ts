// e2e/app.spec.ts
// Basic app launch and sanity checks

import { type ElectronApplication, expect, test } from "@playwright/test";
import { getWindow, launchApp } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test("window opens successfully", async () => {
  const window = await getWindow(app);
  expect(window).toBeTruthy();
});

test("window has correct title", async () => {
  const window = await getWindow(app);
  const title = await window.title();
  expect(title).toBe("LizMeter");
});

test("app loads without JavaScript errors", async () => {
  const window = await getWindow(app);
  const errors: string[] = [];
  window.on("pageerror", (err) => errors.push(err.message));
  await window.waitForTimeout(1000);
  expect(errors).toHaveLength(0);
});

test("main navigation sidebar is visible", async () => {
  const window = await getWindow(app);
  const nav = window.locator('nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible();
});

test("timer page is shown by default", async () => {
  const window = await getWindow(app);
  // ModeToggle is only rendered on the timer page
  const modeToggle = window.locator('[role="tablist"][aria-label="App mode"]');
  await expect(modeToggle).toBeVisible();
});