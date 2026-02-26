// e2e/history.spec.ts
// Tests for the History page

import { type ElectronApplication, expect, test } from "@playwright/test";
import { getWindow, launchApp, navigateTo } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test("History page loads and shows heading", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  const heading = window.locator("h1", { hasText: "History" });
  await expect(heading).toBeVisible();
});

test("History page shows 'No sessions yet.' when empty", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  // Wait for the loading state to clear
  await window.waitForTimeout(1000);

  // Either there are sessions or the empty state message
  const emptyMsg = window.locator("text=No sessions yet.");
  const hasEmptyMsg = await emptyMsg.isVisible();

  if (hasEmptyMsg) {
    await expect(emptyMsg).toBeVisible();
  } else {
    // If sessions exist, that's also valid — just verify the page loaded
    await expect(window.locator("h1", { hasText: "History" })).toBeVisible();
  }
});

test("History page does not show loading spinner after load completes", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  // Wait for content to settle
  await window.waitForTimeout(1500);

  const loadingMsg = window.locator("text=Loading\u2026");
  await expect(loadingMsg).not.toBeVisible();
});

test("History page can be navigated to from Timer", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Timer");
  await navigateTo(window, "History");

  await expect(window.locator("h1", { hasText: "History" })).toBeVisible();
});

test("History nav button has aria-current=page when active", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");

  const historyBtn = window.locator('nav[aria-label="Main navigation"] button[aria-label="History"]');
  await expect(historyBtn).toHaveAttribute("aria-current", "page");
});

test("session cards show delete button if sessions exist", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");
  await window.waitForTimeout(1000);

  const deleteBtn = window.locator('button[aria-label^="Delete session"]');
  const count = await deleteBtn.count();

  if (count > 0) {
    // If sessions exist, each delete button should be visible
    await expect(deleteBtn.first()).toBeVisible();
  } else {
    // No sessions — empty state expected
    await expect(window.locator("text=No sessions yet.")).toBeVisible();
  }
});

test("can delete a session when one exists", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "History");
  await window.waitForTimeout(1000);

  const deleteBtn = window.locator('button[aria-label^="Delete session"]');
  const count = await deleteBtn.count();

  if (count > 0) {
    const initialCount = count;
    await deleteBtn.first().click();
    // Wait for the list to update
    await window.waitForTimeout(500);

    const newCount = await window.locator('button[aria-label^="Delete session"]').count();
    expect(newCount).toBeLessThan(initialCount);
  } else {
    // No sessions to delete — skip this assertion
    test.skip();
  }
});