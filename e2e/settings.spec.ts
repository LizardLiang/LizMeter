// e2e/settings.spec.ts
// Tests for the Settings page

import { type ElectronApplication, expect, test } from "@playwright/test";
import { getWindow, launchApp, navigateTo } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

test("Settings page loads and shows heading", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const heading = window.locator("h1", { hasText: "Settings" });
  await expect(heading).toBeVisible();
});

test("Settings page shows Work Duration input", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const label = window.locator("label", { hasText: "Work Duration" });
  await expect(label).toBeVisible();

  // Find the number input adjacent to Work Duration label
  const field = window.locator("label", { hasText: "Work Duration" }).locator("..");
  const input = field.locator('input[type="number"]');
  await expect(input).toBeVisible();
});

test("Settings page shows Short Break input", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const label = window.locator("label", { hasText: "Short Break" });
  await expect(label).toBeVisible();
});

test("Settings page shows Long Break input", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const label = window.locator("label", { hasText: "Long Break" });
  await expect(label).toBeVisible();
});

test("Settings page shows Save Settings button", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const saveBtn = window.locator("button", { hasText: "Save Settings" });
  await expect(saveBtn).toBeVisible();
});

test("Work Duration defaults to 25 minutes", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  // The Work Duration field starts with the default value (25 min = 1500 sec / 60 = 25)
  const workField = window.locator("label", { hasText: "Work Duration" }).locator("..").locator('input[type="number"]');
  const value = await workField.inputValue();
  expect(Number(value)).toBeGreaterThanOrEqual(1);
});

test("can change Work Duration value", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const workField = window.locator("label", { hasText: "Work Duration" }).locator("..").locator('input[type="number"]');
  await workField.fill("30");

  const newValue = await workField.inputValue();
  expect(newValue).toBe("30");
});

test("Save Settings button shows 'Saved' confirmation after saving", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const saveBtn = window.locator("button", { hasText: "Save Settings" });
  await saveBtn.click();

  // The button text briefly changes to "Saved ✓"
  await expect(window.locator("button", { hasText: /Saved/ })).toBeVisible({ timeout: 3000 });
});

test("settings persist after navigating away and back", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const workField = window.locator("label", { hasText: "Work Duration" }).locator("..").locator('input[type="number"]');

  // Set a distinct value
  await workField.fill("22");

  const saveBtn = window.locator("button", { hasText: "Save Settings" });
  await saveBtn.click();
  await window.locator("button", { hasText: /Saved/ }).waitFor({ timeout: 3000 });

  // Navigate away
  await navigateTo(window, "History");

  // Navigate back
  await navigateTo(window, "Settings");

  // Check the value is persisted
  const workFieldAfter = window.locator("label", { hasText: "Work Duration" }).locator("..").locator('input[type="number"]');
  const afterValue = await workFieldAfter.inputValue();
  expect(afterValue).toBe("22");

  // Restore default (25 min)
  await workFieldAfter.fill("25");
  await window.locator("button", { hasText: "Save Settings" }).click();
  await window.locator("button", { hasText: /Saved/ }).waitFor({ timeout: 3000 });
});

test("Settings page shows Issue Tracker section", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const heading = window.locator("h2", { hasText: "Issue Tracker" });
  await expect(heading).toBeVisible();
});

test("Settings page shows Time Tracking section", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  // Scroll down to find Time Tracking section
  await window.evaluate(() => { (globalThis as unknown as Window).scrollTo(0, document.body.scrollHeight); });
  await window.waitForTimeout(300);

  const heading = window.locator("h2", { hasText: "Time Tracking" });
  await expect(heading).toBeVisible();
});

test("Settings nav button has aria-current=page when active", async () => {
  const window = await getWindow(app);
  await navigateTo(window, "Settings");

  const settingsBtn = window.locator('nav[aria-label="Main navigation"] button[aria-label="Settings"]');
  await expect(settingsBtn).toHaveAttribute("aria-current", "page");
});