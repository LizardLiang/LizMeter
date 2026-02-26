// e2e/navigation.spec.ts
// Tests for sidebar navigation between pages

import { type ElectronApplication, expect, test } from "@playwright/test";
import { getWindow, launchApp, navigateTo } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test("sidebar has all 7 navigation buttons", async () => {
  const window = await getWindow(app);
  const nav = window.locator('nav[aria-label="Main navigation"]');

  const expectedLabels = ["Timer", "History", "Issues", "Claude", "Stats", "Tags", "Settings"];
  for (const label of expectedLabels) {
    await expect(nav.locator(`button[aria-label="${label}"]`)).toBeVisible();
  }
});

test("navigating to History page shows History heading", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  const heading = window.locator("h1", { hasText: "History" });
  await expect(heading).toBeVisible();
});

test("navigating to Settings page shows Settings heading", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const heading = window.locator("h1", { hasText: "Settings" });
  await expect(heading).toBeVisible();
});

test("navigating to Stats page loads without error", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Stats");
  // Stats page should load — no crash
  await window.waitForTimeout(500);
  // Verify no error overlay / the app is still responsive
  const nav = window.locator('nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible();
});

test("navigating to Tags page loads without error", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Tags");
  await window.waitForTimeout(500);
  const nav = window.locator('nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible();
});

test("navigating to Issues page loads without error", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Issues");
  await window.waitForTimeout(500);
  const nav = window.locator('nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible();
});

test("navigating to Claude page loads without error", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Claude");
  await window.waitForTimeout(500);
  const nav = window.locator('nav[aria-label="Main navigation"]');
  await expect(nav).toBeVisible();
});

test("navigating back to Timer page shows mode toggle", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");
  await navigateTo(window, "Timer");

  const modeToggle = window.locator('[role="tablist"][aria-label="App mode"]');
  await expect(modeToggle).toBeVisible();
});

test("active page button has aria-current=page", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  const historyBtn = window.locator('nav[aria-label="Main navigation"] button[aria-label="History"]');
  await expect(historyBtn).toHaveAttribute("aria-current", "page");
});

test("inactive page buttons do not have aria-current", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  const timerBtn = window.locator('nav[aria-label="Main navigation"] button[aria-label="Timer"]');
  // aria-current should be absent or not equal to "page"
  const ariaCurrent = await timerBtn.getAttribute("aria-current");
  expect(ariaCurrent).toBeNull();
});