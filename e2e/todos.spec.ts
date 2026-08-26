// e2e/todos.spec.ts
// Tests for the Todos page markdown notes editor: live preview and the expanded editor.
//
// Not covered here, on purpose:
//   - Paste of a file into the notes editor. Playwright can only hand Chromium a
//     hand-assembled DataTransfer, so such a test would prove that the fake object works, not
//     that a real OS clipboard paste works.
//   - Native OS file drop into the notes editor. Same reason: Playwright cannot synthesize a
//     genuine OS drag payload.
//   - The "Add file" attachment button, which opens the native OS file picker. Playwright
//     cannot drive that dialog.
// All three stay manual-only. The handler logic behind them is unit-tested in
// src/renderer/src/components/__tests__/MarkdownEditor.test.tsx.

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { getWindow, launchApp, navigateTo } from "./helpers.ts";

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await launchApp();
});

test.afterAll(async () => {
  await app.close();
});

/** The todo dialog in create mode. Create mode needs no seeded rows, so it is the reachable one. */
const TODO_DIALOG = '[role="dialog"][aria-label="New todo"]';
/** The expanded notes editor. It is portalled to document.body, so it is NOT inside TODO_DIALOG. */
const NOTES_MODAL = '[role="dialog"][aria-label="Edit Notes"]';

/**
 * Open the create-mode todo dialog with its notes editor focused and empty.
 *
 * Create mode is used throughout because it reaches the same MarkdownEditor as edit mode
 * without depending on the developer's local todo rows, and because nothing here saves, so no
 * test writes to the real database.
 */
async function openNewTodoDialog(window: Page): Promise<void> {
  await navigateTo(window, "Todos");
  await window.getByRole("button", { name: /^New/ }).click();
  await expect(window.locator(TODO_DIALOG)).toBeVisible();
}

/** The inline notes editor's editable surface. */
function notesEditor(window: Page) {
  return window.locator(`${TODO_DIALOG} .cm-content`);
}

/** Focus the inline notes editor and type `text` into it. */
async function typeNotes(window: Page, text: string): Promise<void> {
  const editor = notesEditor(window);
  await editor.click();
  await window.keyboard.type(text);
}

// Every test leaves the app on the Todos page with no dialog open, so the next one starts from
// a known state even though the whole file shares one Electron instance.
test.afterEach(async () => {
  const window = await getWindow(app);

  const modal = window.locator(NOTES_MODAL);
  if (await modal.isVisible()) {
    await modal.locator('button[aria-label="Close without saving"]').click();
    await expect(modal).toBeHidden();
  }

  const dialog = window.locator(TODO_DIALOG);
  if (await dialog.isVisible()) {
    await dialog.locator('button[aria-label="Close"]').click();
    await expect(dialog).toBeHidden();
  }
});

test("Todos page opens a create dialog with a markdown notes editor", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await expect(window.locator(`${TODO_DIALOG} .cm-editor`)).toBeVisible();
  await expect(notesEditor(window)).toBeVisible();
});

test("notes editor renders markdown on a line the cursor has left", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  // Line 1 carries the markdown, line 2 parks the cursor away from it.
  await typeNotes(window, "**bold**\nplain tail");

  const strong = window.locator(`${TODO_DIALOG} .cm-content .cm-md-strong`);
  await expect(strong).toHaveCount(1);
  await expect(strong).toHaveText("bold");

  // The `**` delimiters are replaced away, so the rendered line reads as prose.
  const firstLine = window.locator(`${TODO_DIALOG} .cm-content .cm-line`).first();
  await expect(firstLine).toHaveText("bold");
});

test("notes editor reveals raw markdown on the line the cursor is on", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await typeNotes(window, "**bold**\nplain tail");
  await expect(window.locator(`${TODO_DIALOG} .cm-content .cm-md-strong`)).toHaveCount(1);

  // Move the cursor back onto the markdown line: it must go back to raw source.
  await window.keyboard.press("ArrowUp");

  await expect(window.locator(`${TODO_DIALOG} .cm-content .cm-md-strong`)).toHaveCount(0);
  const firstLine = window.locator(`${TODO_DIALOG} .cm-content .cm-line`).first();
  await expect(firstLine).toHaveText("**bold**");
});

test("expand button opens the notes modal seeded with the inline text", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await typeNotes(window, "# heading\nbody");
  await window.locator(`${TODO_DIALOG} button[aria-label="Open full editor"]`).click();

  const modal = window.locator(NOTES_MODAL);
  await expect(modal).toBeVisible();
  await expect(modal.locator(".cm-content")).toContainText("heading");
  await expect(modal.locator(".cm-content")).toContainText("body");
});

test("Escape closes only the notes modal and leaves the todo dialog open", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await typeNotes(window, "work in progress");
  await window.locator(`${TODO_DIALOG} button[aria-label="Open full editor"]`).click();

  const modal = window.locator(NOTES_MODAL);
  await expect(modal).toBeVisible();

  await window.keyboard.press("Escape");

  // The regression this file exists for: one Escape used to close the modal AND the dialog,
  // discarding everything typed into the todo.
  await expect(modal).toBeHidden();
  await expect(window.locator(TODO_DIALOG)).toBeVisible();
  await expect(notesEditor(window)).toHaveText("work in progress");
});

test("Escape discards edits made in the notes modal", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await typeNotes(window, "kept");
  await window.locator(`${TODO_DIALOG} button[aria-label="Open full editor"]`).click();

  const modal = window.locator(NOTES_MODAL);
  await expect(modal).toBeVisible();
  // The modal autofocuses its own editor but leaves the cursor at offset 0, so the caret is
  // moved to the end before typing. Otherwise the draft would read " discardedkept".
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type(" discarded");
  await expect(modal.locator(".cm-content")).toHaveText("kept discarded");

  await window.keyboard.press("Escape");

  await expect(modal).toBeHidden();
  await expect(notesEditor(window)).toHaveText("kept");
});

test("Done in the notes modal applies the draft to the inline editor", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await typeNotes(window, "kept");
  await window.locator(`${TODO_DIALOG} button[aria-label="Open full editor"]`).click();

  const modal = window.locator(NOTES_MODAL);
  await expect(modal).toBeVisible();
  await window.keyboard.press("ControlOrMeta+End");
  await window.keyboard.type(" and applied");

  await modal.locator("button", { hasText: "Done" }).click();

  await expect(modal).toBeHidden();
  await expect(window.locator(TODO_DIALOG)).toBeVisible();
  await expect(notesEditor(window)).toHaveText("kept and applied");
});

test("Escape closes the todo dialog when no modal is open", async () => {
  const window = await getWindow(app);
  await openNewTodoDialog(window);

  await window.keyboard.press("Escape");

  await expect(window.locator(TODO_DIALOG)).toBeHidden();
});
