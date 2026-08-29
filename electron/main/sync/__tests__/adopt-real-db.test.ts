// @vitest-environment node
// Fix Round regression test for B-2 / C-001: proves the adopt path against a REAL on-disk
// database file, not the sql.js shim's old always-in-memory behavior. Hermes's exact finding was
// that no Vitest test in this codebase could exercise this, because the shim ignored the path
// argument it was given -- see better-sqlite3-shim.ts's own header comment for the fix that makes
// this test possible. This reproduces exactly the sequence index.ts performs on a real adopt
// (markDeviceAsAdopted -> backupExistingPrivateDbBeforeAdopt -> initDatabase() with no override
// -> applyPendingSyncActionAfterInit), without needing a real Electron app object.

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
  backupExistingPrivateDbBeforeAdopt,
  getDbDir,
  invalidateDataDirCache,
  markDeviceAsAdopted,
} from "../../data-location.ts";
import { closeDatabase, createTodo, getDb, initDatabase, listTodos, setActiveDatabaseForTesting } from "../../database.ts";
import { invalidateDeviceIdCache } from "../device-identity.ts";
import { getSyncDevicesDir } from "../oplog.ts";
import { applyPendingSyncActionAfterInit } from "../sync-manager.ts";
import { isSyncEnabled } from "../sync-writer.ts";

let root: string;
let deviceBUserData: string;
let sharedDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-adopt-real-db-"));
  deviceBUserData = path.join(root, "userData-b");
  sharedDir = path.join(root, "shared");
  fs.mkdirSync(deviceBUserData, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("adopting a shared folder on a device that already used LizMeter standalone (B-2)", () => {
  it("backs up the device's own real database instead of silently opening and wiping it", () => {
    // --- Device B has been using LizMeter standalone for months: a real db file at its default
    // (private) location, with real local data, sync never touched. ---
    mockPaths.userData = deviceBUserData;
    invalidateDataDirCache();
    invalidateDeviceIdCache();
    setActiveDatabaseForTesting(null);
    initDatabase(); // no path override -- resolves through getDbDir()/getDataDir() for real
    createTodo({ title: "device B's own pre-existing standalone todo" });

    const dbPath = path.join(deviceBUserData, "lizmeter.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const originalBytes = fs.readFileSync(dbPath);
    expect(originalBytes.toString("latin1")).toContain("device B's own pre-existing standalone todo");

    // The shared folder already holds a peer's (device A's) real published history.
    const peerDir = getSyncDevicesDir(sharedDir);
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(peerDir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.oplog.jsonl"), "");

    // Matches index.ts's real ordering: checkpoint + close happens before any file-level
    // manipulation (ipc-handlers.ts's data-location:move handler does this before relaunch).
    closeDatabase();

    // moveDataTo's real "Change Folder..." flow would have written this pointer -- without it,
    // getDataDir() still names device B's own userData folder instead of the shared one, and
    // the rest of this test would silently exercise the wrong directory.
    fs.writeFileSync(
      path.join(deviceBUserData, "data-location.json"),
      `${JSON.stringify({ dataDir: sharedDir })}\n`,
      "utf8",
    );
    invalidateDataDirCache();

    // --- index.ts's pre-init adopt sequence. ---
    markDeviceAsAdopted();
    const backupPath = backupExistingPrivateDbBeforeAdopt();

    expect(backupPath).not.toBeNull();
    expect(backupPath).toMatch(/\.pre-adopt-.*\.bak$/);
    // The old file is gone from its original path -- renamed away, not left there to be
    // silently reopened and wiped by rebuildFromSnapshot.
    expect(fs.existsSync(dbPath)).toBe(false);
    // The backup is a real, intact, byte-identical copy of device B's own history.
    expect(fs.readFileSync(backupPath!)).toEqual(originalBytes);

    // --- initDatabase() resolves to the exact same path as before (still private/userData,
    // Milestone 6's correction is preserved) -- but the file has been moved out of the way, so
    // this opens a genuinely fresh database, not device B's own populated one. ---
    setActiveDatabaseForTesting(null);
    initDatabase();
    expect(getDbDir()).toBe(deviceBUserData);
    expect(listTodos().some((t) => t.title === "device B's own pre-existing standalone todo")).toBe(false);

    applyPendingSyncActionAfterInit({ action: "adopt", targetDir: sharedDir });

    expect(isSyncEnabled(getDb())).toBe(true);
    // Device B's original data was never destroyed -- it is still sitting in the backup file,
    // completely untouched, exactly as FR-017 requires.
    expect(fs.readFileSync(backupPath!)).toEqual(originalBytes);

    // B-2: device B must never be assigned block 0 -- the shared folder already had a peer's
    // oplog file in it (device A's), so device B is joining an existing history, not
    // originating it. This assertion alone is NOT regression evidence for the isVirginSyncFolder
    // fix in device-identity.ts: by this point backupExistingPrivateDbBeforeAdopt has already
    // renamed device B's populated db out of the way and initDatabase() opened a genuinely fresh
    // one, so the *old* row-count heuristic ("count > 0 ? 0 : draw") would also see a row count of
    // zero here and fall through to the same random draw, passing this exact check for the wrong
    // reason -- confirmed by reverting only device-identity.ts to HEAD and re-running this file,
    // which still passes. The genuine RED/GREEN proof for the row-count-vs-virgin-folder fix is
    // device-identity.test.ts's own "draws a random block for a device with plenty of local data,
    // once the shared folder already has peer activity (B-2)" case, which asserts this property
    // while local data is still present and fails against the old heuristic on its own.
    const { value: deviceNumberStr } = getDb().prepare("SELECT value FROM settings WHERE key = 'sync.deviceNumber'")
      .get() as { value: string };
    expect(Number(deviceNumberStr)).not.toBe(0);
  });
});
