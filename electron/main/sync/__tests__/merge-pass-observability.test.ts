// @vitest-environment node
// Ticket #932: unreadable peer entries are deliberately skipped so compatible entries can keep
// syncing, but the skip must still be visible in Settings and must not create a notice every 30
// seconds while the same append-only oplog remains unchanged.

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
import { runMergePass } from "../merge-pass.ts";
import { getSyncDevicesDir } from "../oplog.ts";

let root: string;
let sharedDir: string;
let peerOplogPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-merge-observability-"));
  sharedDir = path.join(root, "shared");
  mockPaths.userData = path.join(root, "userData");
  fs.mkdirSync(getSyncDevicesDir(sharedDir), { recursive: true });
  fs.mkdirSync(mockPaths.userData, { recursive: true });
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  setActiveDatabaseForTesting(null);
  initDatabase(":memory:");

  peerOplogPath = path.join(
    getSyncDevicesDir(sharedDir),
    "11111111-1111-1111-1111-111111111111.oplog.jsonl",
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function skippedNotices(): Array<{ message: string; detail: string | null }> {
  return getDb()
    .prepare("SELECT message, detail FROM sync_notices WHERE kind = 'oplog-entry-skipped' ORDER BY id")
    .all() as Array<{ message: string; detail: string | null }>;
}

describe("runMergePass skipped-entry observability", () => {
  it("reports each distinct per-file skipped count once without halting compatible sync", () => {
    fs.writeFileSync(
      peerOplogPath,
      [
        "not json",
        JSON.stringify({
          v: 2,
          opId: "future-entry",
          hlc: { physicalMs: 1, counter: 0, deviceNumber: 1 },
          table: "todos",
          rowUuid: "future-row",
          op: "delete",
        }),
      ].join("\n"),
    );

    expect(() => runMergePass(getDb(), sharedDir, "22222222-2222-2222-2222-222222222222")).not.toThrow();
    expect(skippedNotices()).toEqual([
      {
        message: "2 entries in a peer sync log were skipped because this version of LizMeter could not read them.",
        detail: "11111111-1111-1111-1111-111111111111.oplog.jsonl: 2 skipped",
      },
    ]);

    runMergePass(getDb(), sharedDir, "22222222-2222-2222-2222-222222222222");
    expect(skippedNotices()).toHaveLength(1);

    fs.appendFileSync(peerOplogPath, "\nstill not json");
    runMergePass(getDb(), sharedDir, "22222222-2222-2222-2222-222222222222");

    expect(skippedNotices()).toHaveLength(2);
    expect(skippedNotices()[1]).toEqual({
      message: "3 entries in a peer sync log were skipped because this version of LizMeter could not read them.",
      detail: "11111111-1111-1111-1111-111111111111.oplog.jsonl: 3 skipped",
    });
  });
});
