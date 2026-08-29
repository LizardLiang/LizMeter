// @vitest-environment node
// The one-time fold of block-allocated (15-digit) todo ids into the dense run. The user's locked
// decision was deliberately narrow: numbers issued by the folder-originating machine are the ones
// already referenced in notes and MCP calls, so they never move -- only the unusable big ones do.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaths = { userData: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return mockPaths.userData;
      throw new Error(`unexpected app.getPath(${name})`);
    },
  },
}));

import { closeDatabase, getDb, initDatabase, listTodos } from "../../database.ts";
import { LEGACY_TODO_ID_BLOCK_STRIDE, invalidateDeviceIdCache } from "../device-identity.ts";
import { countBlockAllocatedTodos, renumberBlockAllocatedTodoIds } from "../migration.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-renumber-"));
  mockPaths.userData = root;
  invalidateDeviceIdCache();
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Inserts a todo directly, so a block-allocated id can be planted the way a real second machine left it. */
function insertTodo(id: number, title: string, createdAt: string): void {
  const db = getDb();
  const { id: stateId } = db.prepare("SELECT id FROM todo_states LIMIT 1").get() as { id: number };
  db.prepare(
    "INSERT INTO todos (id, claimed_id, title, state_id, created_at, uuid) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, id, title, stateId, createdAt, `uuid-${id}`);
}

describe("renumberBlockAllocatedTodoIds", () => {
  it("appends block-allocated ids after the highest untouched one, in creation order", () => {
    insertTodo(1, "first", "2026-01-01T00:00:00.000Z");
    insertTodo(120, "highest normal", "2026-01-02T00:00:00.000Z");
    const stride = LEGACY_TODO_ID_BLOCK_STRIDE;
    insertTodo(7 * stride + 2, "big second", "2026-03-02T00:00:00.000Z");
    insertTodo(7 * stride + 1, "big first", "2026-03-01T00:00:00.000Z");
    insertTodo(9 * stride + 5, "big third", "2026-03-03T00:00:00.000Z");

    const result = renumberBlockAllocatedTodoIds(getDb());

    expect(result.renumbered.map((r) => r.to)).toEqual([121, 122, 123]);
    const byTitle = new Map(listTodos().map((t) => [t.title, t.id]));
    expect(byTitle.get("big first")).toBe(121);
    expect(byTitle.get("big second")).toBe(122);
    expect(byTitle.get("big third")).toBe(123);
  });

  it("leaves every id below the stride exactly where it was", () => {
    insertTodo(1, "one", "2026-01-01T00:00:00.000Z");
    insertTodo(2, "two", "2026-01-02T00:00:00.000Z");
    insertTodo(50, "fifty", "2026-01-03T00:00:00.000Z");
    insertTodo(7 * LEGACY_TODO_ID_BLOCK_STRIDE + 1, "big", "2026-03-01T00:00:00.000Z");

    renumberBlockAllocatedTodoIds(getDb());

    const byTitle = new Map(listTodos().map((t) => [t.title, t.id]));
    expect(byTitle.get("one")).toBe(1);
    expect(byTitle.get("two")).toBe(2);
    expect(byTitle.get("fifty")).toBe(50);
    expect(byTitle.get("big")).toBe(51);
  });

  it("is a no-op on a second run", () => {
    insertTodo(10, "normal", "2026-01-01T00:00:00.000Z");
    insertTodo(7 * LEGACY_TODO_ID_BLOCK_STRIDE + 1, "big", "2026-03-01T00:00:00.000Z");

    renumberBlockAllocatedTodoIds(getDb());
    const afterFirst = listTodos().map((t) => `${t.id}:${t.title}`).sort();

    const second = renumberBlockAllocatedTodoIds(getDb());
    expect(second.renumbered).toEqual([]);
    expect(listTodos().map((t) => `${t.id}:${t.title}`).sort()).toEqual(afterFirst);
  });

  it("does nothing at all when there is nothing block-allocated", () => {
    insertTodo(1, "only", "2026-01-01T00:00:00.000Z");
    expect(countBlockAllocatedTodos(getDb())).toBe(0);
    expect(renumberBlockAllocatedTodoIds(getDb()).renumbered).toEqual([]);
  });

  it("carries sub-todo, label, and attachment references across the renumber", () => {
    const db = getDb();
    const bigId = 7 * LEGACY_TODO_ID_BLOCK_STRIDE + 1;
    insertTodo(5, "parent", "2026-01-01T00:00:00.000Z");
    insertTodo(bigId, "child with references", "2026-03-01T00:00:00.000Z");
    db.prepare("UPDATE todos SET parent_id = 5 WHERE id = ?").run(bigId);
    db.prepare("INSERT INTO todo_labels (name, color, created_at, uuid) VALUES ('L', '#fff', ?, 'lu')")
      .run("2026-01-01T00:00:00.000Z");
    const { id: labelId } = db.prepare("SELECT id FROM todo_labels WHERE uuid = 'lu'").get() as { id: number };
    db.prepare("INSERT INTO todo_label_links (todo_id, label_id) VALUES (?, ?)").run(bigId, labelId);
    db.prepare(
      `INSERT INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at)
       VALUES (?, 'abc', 'f.png', 'image/png', 1, 'file', ?)`,
    ).run(bigId, "2026-03-01T00:00:00.000Z");

    const { renumbered } = renumberBlockAllocatedTodoIds(db);
    const newId = renumbered[0]!.to;

    const child = listTodos().find((t) => t.title === "child with references");
    expect(child?.id).toBe(newId);
    expect(child?.parentId).toBe(5);
    expect(db.prepare("SELECT COUNT(*) AS c FROM todo_label_links WHERE todo_id = ?").get(newId)).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM todo_attachments WHERE todo_id = ?").get(newId)).toEqual({ c: 1 });
  });

  it("records a notice listing what moved", () => {
    insertTodo(3, "normal", "2026-01-01T00:00:00.000Z");
    insertTodo(7 * LEGACY_TODO_ID_BLOCK_STRIDE + 1, "big", "2026-03-01T00:00:00.000Z");

    renumberBlockAllocatedTodoIds(getDb());

    const notices = getDb()
      .prepare("SELECT * FROM sync_notices WHERE kind = 'todo-id-reassigned'")
      .all() as Array<{ detail: string | null }>;
    expect(notices.length).toBe(1);
    expect(notices[0]!.detail).toContain("-> #4");
  });
});
