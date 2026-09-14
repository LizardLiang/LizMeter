// @vitest-environment node
// Defect 1 regression (2026-09-14 stuck-merge-pass bug): applyFieldsLww used to bind a peer's
// change.value straight into `UPDATE ${table} SET ${fieldName} = ?` with no coercion. Real
// better-sqlite3 throws `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and
// null` the instant a raw JS boolean reaches `.run()` -- and since applyOplogEntries wraps the
// whole pass in one transaction, that throw rolled back every pending entry, not just the
// offending one.
//
// The Vitest sql.js shim does NOT reproduce this: it silently tolerates a boolean bind (see
// .claude/.Arena/debt.md), so a test that only asserts "the merge succeeded" would pass whether
// or not toBindValue (row-codec.ts) is actually wired in. This test instead captures the exact
// value bound into the UPDATE statement and asserts it is never a boolean -- proof the coercion
// runs, independent of whether the shim underneath would have caught the original bug.

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

import { createTodoState, getDb, initDatabase } from "../../database.ts";
import { invalidateDataDirCache } from "../../data-location.ts";
import { getOrAssignDeviceNumber, invalidateDeviceIdCache } from "../device-identity.ts";
import { tick } from "../hlc.ts";
import { applyOplogEntries } from "../merge-engine.ts";
import { buildUpsertEntry } from "../oplog.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-bind-coercion-"));
  mockPaths.userData = root;
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  initDatabase(":memory:");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Wraps `database.prepare` so any `.run()` call against a matching SQL string has its bound
 * parameters recorded, without changing what the statement actually does.
 */
function captureRunBinds(database: ReturnType<typeof getDb>, sqlFragment: string): unknown[][] {
  const captured: unknown[][] = [];
  const originalPrepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation(((sql: string) => {
    const stmt = originalPrepare(sql);
    if (!sql.includes(sqlFragment)) return stmt;
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (...args: unknown[]) => {
            captured.push(args);
            return (target.run as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }) as typeof database.prepare);
  return captured;
}

describe("applyFieldsLww: peer-authored boolean field values are coerced before binding", () => {
  it("binds 0, never a JS boolean, for an is_completed change carrying a raw boolean (peer oplog line 165's shape)", () => {
    const database = getDb();
    const created = createTodoState({ label: "Staged", color: "#7aa2f7" });
    const row = database.prepare("SELECT uuid FROM todo_states WHERE id = ?").get(created.id) as { uuid: string };

    const capturedBinds = captureRunBinds(database, "UPDATE todo_states SET is_completed");

    const deviceNumber = getOrAssignDeviceNumber(database);
    const hlc = tick(database, deviceNumber);
    // A raw JS `false`, mirroring peer oplog line 165 (opId fd39a710-c766-4aab-b8eb-6328f8da1200):
    // an entry written before the producer-side fix, still sitting on disk, still arriving from an
    // older peer build.
    const entry = buildUpsertEntry(hlc, "todo_states", row.uuid, { is_completed: { value: false, hlc } });

    expect(() => applyOplogEntries(database, [entry])).not.toThrow();

    expect(capturedBinds.length).toBe(1);
    const [boundValue] = capturedBinds[0]!;
    expect(typeof boundValue).not.toBe("boolean");
    expect(boundValue).toBe(0);

    const after = database.prepare("SELECT is_completed FROM todo_states WHERE id = ?").get(created.id) as {
      is_completed: number;
    };
    expect(after.is_completed).toBe(0);
  });

  it("binds 1, never a JS boolean, for a `true` field value", () => {
    const database = getDb();
    const created = createTodoState({ label: "Verified", color: "#9ece6a" });
    const row = database.prepare("SELECT uuid FROM todo_states WHERE id = ?").get(created.id) as { uuid: string };

    const capturedBinds = captureRunBinds(database, "UPDATE todo_states SET is_completed");

    const deviceNumber = getOrAssignDeviceNumber(database);
    const hlc = tick(database, deviceNumber);
    const entry = buildUpsertEntry(hlc, "todo_states", row.uuid, { is_completed: { value: true, hlc } });

    applyOplogEntries(database, [entry]);

    expect(capturedBinds.length).toBe(1);
    const [boundValue] = capturedBinds[0]!;
    expect(typeof boundValue).not.toBe("boolean");
    expect(boundValue).toBe(1);
  });
});
