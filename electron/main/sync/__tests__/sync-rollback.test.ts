// @vitest-environment node
// B-4 regression: a local write that rolls back (e.g. an unknown label id) must never leave a
// published oplog entry behind. `recordUpsert` appends to the oplog file via
// `fs.appendFileSync`, which no SQL transaction rollback can undo -- so validating the label ids
// *before* recordUpsert runs, not just before `replaceTodoLabels`'s own writes, is what closes
// this. See database.ts's `assertLabelIdsExist` doc comment for the full failure chain this
// prevents (a phantom todo published to every peer, then a recycled id that poisons every future
// merge pass).

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

import { createTodo, getDb, initDatabase, updateTodo } from "../../database.ts";
import { invalidateDataDirCache } from "../../data-location.ts";
import { getDeviceId, invalidateDeviceIdCache } from "../device-identity.ts";
import { getOplogFilePath, readOplogEntries, type OplogUpsertEntry } from "../oplog.ts";
import { setSyncEnabled } from "../sync-writer.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-sync-rollback-"));
  mockPaths.userData = root;
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  initDatabase(":memory:");
  setSyncEnabled(getDb(), true);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function todoUpsertEntries() {
  const filePath = getOplogFilePath(root, getDeviceId());
  return readOplogEntries(filePath).entries.filter(
    (e): e is OplogUpsertEntry => e.op === "upsert" && e.table === "todos",
  );
}

describe("B-4: a rolled-back local write never publishes to the oplog", () => {
  it("createTodo with an unknown label id throws and leaves no oplog entry behind", () => {
    expect(() => createTodo({ title: "Doomed create", labelIds: [999999] })).toThrow();
    expect(todoUpsertEntries().length).toBe(0);
  });

  it("a later successful create is unaffected -- no id or counter was ever consumed by the failed attempt", () => {
    expect(() => createTodo({ title: "Doomed create", labelIds: [999999] })).toThrow();

    const ok = createTodo({ title: "Real todo" });

    expect(ok.id).toBeGreaterThan(0);
    expect(todoUpsertEntries().length).toBe(1);
    expect(todoUpsertEntries()[0]?.rowUuid).toBeDefined();
  });

  it("updateTodo with an unknown label id throws and publishes no new oplog entry for that call", () => {
    const created = createTodo({ title: "Existing todo" });
    const before = todoUpsertEntries().length;

    expect(() => updateTodo({ id: created.id, title: "Changed", labelIds: [999999] })).toThrow();

    expect(todoUpsertEntries().length).toBe(before);
  });
});
