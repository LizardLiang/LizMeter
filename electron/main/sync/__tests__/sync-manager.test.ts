// @vitest-environment node
// Milestone 5/6: sync-manager's decision logic for wiring the Data Location move flow to sync
// setup, and data-location.ts's private-db-dir escape hatch for an adopting device.

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

import {
  getDataDir,
  getDbDir,
  isAdoptedDevice,
  markDeviceAsAdopted,
} from "../../data-location.ts";
import { createTodo, getDb, initDatabase, listTodos, setActiveDatabaseForTesting } from "../../database.ts";
import { invalidateDataDirCache } from "../../data-location.ts";
import { getDeviceId, invalidateDeviceIdCache } from "../device-identity.ts";
import { getSyncDevicesDir, readOplogEntries } from "../oplog.ts";
import {
  applyPendingSyncActionAfterInit,
  decidePendingSyncAction,
  requiresAdoptConfirmation,
} from "../sync-manager.ts";
import { isSyncEnabled } from "../sync-writer.ts";

let root: string;
let userDataA: string;
let sharedDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-sync-manager-"));
  userDataA = path.join(root, "userData-a");
  sharedDir = path.join(root, "shared");
  fs.mkdirSync(userDataA, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  mockPaths.userData = userDataA;
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  setActiveDatabaseForTesting(null);
  initDatabase(":memory:");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("decidePendingSyncAction", () => {
  it("returns null for an ordinary relocate with no local data and no peer history at the target", () => {
    expect(decidePendingSyncAction(sharedDir)).toBeNull();
  });

  it("returns an 'enable' action when this device has real data and sync is not yet on", () => {
    createTodo({ title: "existing work" });
    expect(decidePendingSyncAction(sharedDir)).toEqual({ action: "enable" });
  });

  it("returns an 'adopt' action when the target already holds another device's oplog", () => {
    const peerDir = getSyncDevicesDir(sharedDir);
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(peerDir, "11111111-1111-1111-1111-111111111111.oplog.jsonl"), "");

    expect(decidePendingSyncAction(sharedDir)).toEqual({ action: "adopt", targetDir: sharedDir });
  });

  it("prefers 'adopt' even when this device also has local data (adoption always wins per FR-017)", () => {
    createTodo({ title: "local work that will be archived, not merged" });
    const peerDir = getSyncDevicesDir(sharedDir);
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(peerDir, "22222222-2222-2222-2222-222222222222.oplog.jsonl"), "");

    expect(decidePendingSyncAction(sharedDir)).toEqual({ action: "adopt", targetDir: sharedDir });
  });
});

describe("requiresAdoptConfirmation (R2-B1)", () => {
  // The ipc-handlers.ts data-location:move handler has no test file in this codebase (Hermes's
  // own finding), so this decision is extracted as its own pure function specifically to be
  // testable in isolation -- this proves the guard's own logic; the handler wiring itself
  // (that ipc-handlers.ts actually calls this function before doing anything destructive) is
  // verified by code reading, documented as such in implementation-notes.md.

  it("requires confirmation for an adopt action that has not been confirmed", () => {
    expect(requiresAdoptConfirmation({ action: "adopt", targetDir: sharedDir }, false)).toBe(true);
  });

  it("does not require confirmation once the caller has explicitly confirmed the adopt", () => {
    expect(requiresAdoptConfirmation({ action: "adopt", targetDir: sharedDir }, true)).toBe(false);
  });

  it("never requires confirmation for an 'enable' action -- there is nothing of a peer's to discard", () => {
    expect(requiresAdoptConfirmation({ action: "enable" }, false)).toBe(false);
  });

  it("never requires confirmation for an ordinary relocate (no pending sync action at all)", () => {
    expect(requiresAdoptConfirmation(null, false)).toBe(false);
  });
});

describe("getDbDir / isAdoptedDevice", () => {
  it("matches getDataDir() until this device has adopted", () => {
    expect(isAdoptedDevice()).toBe(false);
    expect(getDbDir()).toBe(getDataDir());
  });

  it("switches to the private userData folder once marked as adopted", () => {
    markDeviceAsAdopted();
    expect(isAdoptedDevice()).toBe(true);
    expect(getDbDir()).toBe(userDataA);
  });
});

describe("applyPendingSyncActionAfterInit", () => {
  it("'enable': migrates identity, turns sync on, and publishes existing rows", () => {
    const created = createTodo({ title: "publish me" });
    applyPendingSyncActionAfterInit({ action: "enable" });

    const database = getDb();
    expect(isSyncEnabled(database)).toBe(true);

    const oplogPath = `${getSyncDevicesDir(getDataDir())}/${getDeviceId()}.oplog.jsonl`;
    const { entries } = readOplogEntries(oplogPath);
    const publishedTodo = entries.find((e) => e.op === "upsert" && e.table === "todos");
    expect(publishedTodo).toBeDefined();
    expect(created.id).toBeGreaterThan(0);
  });

  it("'adopt': registers a new device, rebuilds from the shared oplog, and turns sync on", () => {
    // Device A: publish some real data into the shared folder first.
    createTodo({ title: "from device A" });
    applyPendingSyncActionAfterInit({ action: "enable" });
    const deviceADataDir = getDataDir();
    // Copy A's oplog into the shared target the test will point device B at.
    const aOplogDir = getSyncDevicesDir(deviceADataDir);
    const bTargetDir = path.join(root, "shared-target");
    fs.mkdirSync(getSyncDevicesDir(bTargetDir), { recursive: true });
    for (const name of fs.readdirSync(aOplogDir)) {
      fs.copyFileSync(path.join(aOplogDir, name), path.join(getSyncDevicesDir(bTargetDir), name));
    }

    // Device B: fresh identity, fresh (private) database, pointed at the same target folder.
    const userDataB = path.join(root, "userData-b");
    fs.mkdirSync(userDataB, { recursive: true });
    fs.writeFileSync(path.join(userDataB, "data-location.json"), `${JSON.stringify({ dataDir: bTargetDir })}\n`, "utf8");

    mockPaths.userData = userDataB;
    invalidateDataDirCache();
    invalidateDeviceIdCache();
    markDeviceAsAdopted();
    setActiveDatabaseForTesting(null);
    initDatabase(":memory:");

    applyPendingSyncActionAfterInit({ action: "adopt", targetDir: bTargetDir });

    const database = getDb();
    expect(isSyncEnabled(database)).toBe(true);
    expect(listTodos().some((t) => t.title === "from device A")).toBe(true);
  });
});
