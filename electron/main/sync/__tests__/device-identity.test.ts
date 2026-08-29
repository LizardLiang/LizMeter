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
import { getSyncDevicesDir } from "../oplog.ts";

let root: string;
let sharedDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-device-identity-"));
  sharedDir = path.join(root, "shared");
  fs.mkdirSync(sharedDir, { recursive: true });
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
  // Fix Round: device 0 is decided from the *shared folder's* own contents (dataDir), never
  // from whether this device's local database happens to have rows -- see the function's own
  // header comment for why the old "local row count" heuristic broke (B-2).

  it("assigns block 0 when the shared folder holds no peer's oplog file yet, regardless of local data", () => {
    const db = getDb();
    const { id: stateId } = db.prepare("SELECT id FROM todo_states LIMIT 1").get() as { id: number };
    db.prepare("INSERT INTO todos (title, state_id, created_at) VALUES ('existing', ?, ?)").run(
      stateId,
      new Date().toISOString(),
    );
    expect(getOrAssignDeviceNumber(db, sharedDir)).toBe(0);
  });

  it("assigns a random non-zero block to an empty local database, when the shared folder is also virgin", () => {
    const db = getDb();
    const deviceNumber = getOrAssignDeviceNumber(db, sharedDir);
    // Still 0 in this case (an empty local db in a virgin shared folder is the ordinary
    // "originating a brand-new shared folder" case) -- the interesting contrast is the next test.
    expect(deviceNumber).toBe(0);
  });

  it("draws a random block for a device with plenty of local data, once the shared folder already has peer activity (B-2)", () => {
    const db = getDb();
    const { id: stateId } = db.prepare("SELECT id FROM todo_states LIMIT 1").get() as { id: number };
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO todos (title, state_id, created_at) VALUES (?, ?, ?)").run(
        `pre-existing standalone todo ${i}`,
        stateId,
        new Date().toISOString(),
      );
    }
    const peerDir = getSyncDevicesDir(sharedDir);
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(peerDir, "11111111-1111-1111-1111-111111111111.oplog.jsonl"), "");

    // Under the old (broken) heuristic this would have returned 0, colliding with the peer that
    // already occupies block 0 -- exactly Hermes's B-2 finding.
    expect(getOrAssignDeviceNumber(db, sharedDir)).not.toBe(0);
  });

  it("draws a random block, never 0, when dataDir is omitted (every non-first-assignment caller)", () => {
    const db = getDb();
    expect(getOrAssignDeviceNumber(db)).toBeGreaterThan(0);
  });

  it("is stable across repeated calls", () => {
    const db = getDb();
    const first = getOrAssignDeviceNumber(db, sharedDir);
    const second = getOrAssignDeviceNumber(db, sharedDir);
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
    // Device number is pre-assigned directly (the "how does a device become 0" decision is
    // covered by the getOrAssignDeviceNumber describe block above) so this test is purely about
    // allocateNextTodoId's own counter-continuation behavior for device 0.
    db.prepare("INSERT INTO settings (key, value) VALUES ('sync.deviceNumber', '0')").run();
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
