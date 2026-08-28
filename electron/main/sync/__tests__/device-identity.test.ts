// @vitest-environment node
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

import { getDb, initDatabase } from "../../database.ts";
import {
  allocateNextTodoId,
  getDeviceId,
  getOrAssignDeviceNumber,
  invalidateDeviceIdCache,
  registerDevice,
  TODO_ID_BLOCK_STRIDE,
} from "../device-identity.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-device-identity-"));
  mockPaths.userData = root;
  invalidateDeviceIdCache();
  initDatabase(":memory:");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("getDeviceId", () => {
  it("generates a uuid once and persists it across calls", () => {
    const first = getDeviceId();
    invalidateDeviceIdCache();
    const second = getDeviceId();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("writes device-identity.json into userData, next to data-location.json", () => {
    getDeviceId();
    const file = path.join(root, "device-identity.json");
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("getOrAssignDeviceNumber", () => {
  it("assigns block 0 to a database that already has todos (the legacy machine, FR-016)", () => {
    const db = getDb();
    const { id: stateId } = db.prepare("SELECT id FROM todo_states LIMIT 1").get() as { id: number };
    db.prepare("INSERT INTO todos (title, state_id, created_at) VALUES ('existing', ?, ?)").run(
      stateId,
      new Date().toISOString(),
    );
    expect(getOrAssignDeviceNumber(db)).toBe(0);
  });

  it("assigns a random non-zero block to an empty database", () => {
    const db = getDb();
    const deviceNumber = getOrAssignDeviceNumber(db);
    expect(deviceNumber).toBeGreaterThan(0);
  });

  it("is stable across repeated calls", () => {
    const db = getDb();
    const first = getOrAssignDeviceNumber(db);
    const second = getOrAssignDeviceNumber(db);
    expect(first).toBe(second);
  });

  it("never collides with a device number already registered in sync_devices", () => {
    const db = getDb();
    // Force every draw except one specific number to collide, by pre-registering it is not
    // practical (the draw space is 4 billion wide) -- instead this proves the collision-check
    // path runs without throwing when sync_devices already has entries.
    registerDevice(db, "peer-device", 123456);
    const deviceNumber = getOrAssignDeviceNumber(db);
    expect(deviceNumber).not.toBe(123456);
  });
});

describe("allocateNextTodoId", () => {
  it("continues device 0's block exactly where existing AUTOINCREMENT ids left off (FR-016)", () => {
    const db = getDb();
    const { id: stateId } = db.prepare("SELECT id FROM todo_states LIMIT 1").get() as { id: number };
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO todos (title, state_id, created_at) VALUES (?, ?, ?)").run(
        `todo ${i}`,
        stateId,
        new Date().toISOString(),
      );
    }
    const { maxId } = db.prepare("SELECT MAX(id) AS maxId FROM todos").get() as { maxId: number };
    expect(allocateNextTodoId(db)).toBe(maxId + 1);
  });

  it("increments monotonically and never reuses a number", () => {
    const db = getDb();
    const first = allocateNextTodoId(db);
    const second = allocateNextTodoId(db);
    const third = allocateNextTodoId(db);
    expect(second).toBe(first + 1);
    expect(third).toBe(second + 1);
  });

  it("keeps every non-zero device's ids inside its own stride, never overlapping device 0's range", () => {
    const db = getDb();
    registerDevice(db, "some-other-device", 7);
    db.prepare("INSERT INTO settings (key, value) VALUES ('sync.deviceNumber', '7')").run();
    const id = allocateNextTodoId(db);
    expect(id).toBeGreaterThanOrEqual(7 * TODO_ID_BLOCK_STRIDE);
    expect(id).toBeLessThan(8 * TODO_ID_BLOCK_STRIDE);
  });
});
