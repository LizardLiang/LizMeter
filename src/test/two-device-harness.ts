// src/test/two-device-harness.ts
// Simulates two LizMeter installations sharing one cloud-drive folder, without needing two real
// machines or two real Electron processes. This is what resolves the PRD's flagged test gap:
// "the E2E suite launches one real Electron instance, and unit tests never exercise the
// populated-upgrade path."
//
// database.ts, data-location.ts and device-identity.ts each cache a single module-level "this
// process's device" (the open db handle, the resolved data dir, the resolved device identity).
// `switchToDevice` switches all three together, so calling a `database.ts` function "as device B" and
// then switching back to "device A" behaves exactly like two real machines that never observe
// each other's process -- each only ever sees the shared folder on disk.
//
// The calling test file must declare its own `vi.mock("electron", ...)` reading from the same
// `mockPaths` object passed in here (see any test using this harness for the exact shape) --
// `vi.mock` is hoisted per file, so this module cannot declare it on the caller's behalf.

import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { invalidateDataDirCache } from "../../electron/main/data-location.ts";
import { getDb, initDatabase, setActiveDatabaseForTesting } from "../../electron/main/database.ts";
import { getDeviceId, invalidateDeviceIdCache } from "../../electron/main/sync/device-identity.ts";
import { runMergePass } from "../../electron/main/sync/merge-pass.ts";
import { setSyncEnabled } from "../../electron/main/sync/sync-writer.ts";

export interface HarnessDevice {
  name: string;
  db: Database.Database;
  userDataDir: string;
  deviceId: string;
}

export interface TwoDeviceHarness {
  sharedDir: string;
  deviceA: HarnessDevice;
  deviceB: HarnessDevice;
  /** Makes `device` the active database, data dir, and device identity for every call that follows. */
  switchToDevice: (device: HarnessDevice) => void;
  /** Reads every peer's oplog and applies new entries to `device`'s local database. */
  sync: (device: HarnessDevice) => ReturnType<typeof runMergePass>;
  /** Switches to `device`, runs `fn`, and switches back to whichever device was active before. */
  as: <T>(device: HarnessDevice, fn: () => T) => T;
  cleanup: () => void;
}

/**
 * `mockPaths` must be the same mutable object the calling test file's own
 * `vi.mock("electron", () => ({ app: { getPath: () => mockPaths.userData } }))` reads from.
 */
export function createTwoDeviceHarness(mockPaths: { userData: string; }): TwoDeviceHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-sync-harness-"));
  const sharedDir = path.join(root, "shared");
  fs.mkdirSync(sharedDir, { recursive: true });

  function makeDevice(name: string): HarnessDevice {
    const userDataDir = path.join(root, name);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "data-location.json"),
      `${JSON.stringify({ dataDir: sharedDir })}\n`,
      "utf8",
    );

    mockPaths.userData = userDataDir;
    invalidateDataDirCache();
    invalidateDeviceIdCache();
    // Detach whatever handle is currently active (e.g. the other device's) so initDatabase's own
    // "close the previous connection" step does not tear it down out from under it.
    setActiveDatabaseForTesting(null);
    initDatabase(":memory:");
    const db = getDb();
    setSyncEnabled(db, true);
    const deviceId = getDeviceId();
    return { name, db, userDataDir, deviceId };
  }

  const deviceA = makeDevice("device-a");
  const deviceB = makeDevice("device-b");

  let active: HarnessDevice = deviceA;

  function switchToDevice(device: HarnessDevice): void {
    mockPaths.userData = device.userDataDir;
    invalidateDataDirCache();
    invalidateDeviceIdCache();
    setActiveDatabaseForTesting(device.db);
    active = device;
  }

  function as<T>(device: HarnessDevice, fn: () => T): T {
    const previous = active;
    switchToDevice(device);
    try {
      return fn();
    } finally {
      switchToDevice(previous);
    }
  }

  function sync(device: HarnessDevice) {
    return as(device, () => runMergePass(device.db, sharedDir, device.deviceId));
  }

  // Leave the harness pointed at device A, matching "the test starts as device A" convention.
  switchToDevice(deviceA);

  return {
    sharedDir,
    deviceA,
    deviceB,
    switchToDevice,
    sync,
    as,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
