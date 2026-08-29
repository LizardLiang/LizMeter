// @vitest-environment node
// M-001 / FR-032: reports an unexpected file in the shared sync folder (most commonly a
// cloud-drive "conflicted copy" rename) instead of silently ignoring it. The `"stray-file"`
// notice kind was reserved in notices.ts since Milestone 8 but nothing ever constructed one --
// see stray-files.ts's header comment.

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

import { getDb, initDatabase, setActiveDatabaseForTesting } from "../../database.ts";
import { invalidateDataDirCache } from "../../data-location.ts";
import { invalidateDeviceIdCache } from "../device-identity.ts";
import { getSyncDevicesDir } from "../oplog.ts";
import { scanForStrayFiles } from "../stray-files.ts";

let root: string;
let sharedDir: string;
let devicesDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-stray-files-"));
  sharedDir = path.join(root, "shared");
  devicesDir = getSyncDevicesDir(sharedDir);
  fs.mkdirSync(devicesDir, { recursive: true });
  mockPaths.userData = path.join(root, "userData");
  fs.mkdirSync(mockPaths.userData, { recursive: true });
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  setActiveDatabaseForTesting(null);
  initDatabase(":memory:");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function notices() {
  return getDb().prepare("SELECT * FROM sync_notices WHERE kind = 'stray-file'").all() as Array<
    { detail: string | null }
  >;
}

describe("scanForStrayFiles", () => {
  it("raises a stray-file notice for a cloud-drive conflicted-copy rename", () => {
    const strayName = "11111111-1111-1111-1111-111111111111.oplog (Conflicted Copy 2026-08-28).jsonl";
    fs.writeFileSync(path.join(devicesDir, strayName), "");

    scanForStrayFiles(getDb(), sharedDir);

    const rows = notices();
    expect(rows.length).toBe(1);
    expect(rows[0]?.detail).toBe(strayName);
  });

  it("never raises a notice for a real device's own oplog or snapshot file", () => {
    fs.writeFileSync(path.join(devicesDir, "22222222-2222-2222-2222-222222222222.oplog.jsonl"), "");
    fs.writeFileSync(path.join(devicesDir, "22222222-2222-2222-2222-222222222222.snapshot.json"), "{}");

    scanForStrayFiles(getDb(), sharedDir);

    expect(notices().length).toBe(0);
  });

  it("does not re-raise a notice for the same stray filename on a later scan", () => {
    const strayName = "definitely-not-a-uuid.oplog.jsonl";
    fs.writeFileSync(path.join(devicesDir, strayName), "");

    scanForStrayFiles(getDb(), sharedDir);
    scanForStrayFiles(getDb(), sharedDir); // simulates the next 30-second periodic re-scan

    expect(notices().length).toBe(1);
  });

  it("is a no-op when the sync folder does not exist yet", () => {
    fs.rmSync(devicesDir, { recursive: true, force: true });
    expect(() => scanForStrayFiles(getDb(), sharedDir)).not.toThrow();
    expect(notices().length).toBe(0);
  });
});
