// @vitest-environment node
// Defect 2 (2026-09-14 stuck-merge-pass bug's other half): before this fix, any merge-pass error
// that was not a NotFullyHydratedError or a RebuildBackupFailedError fell into a bare
// `console.warn` in runMergePassSafely's catch -- no notice, no halt, no OS notification.
// SyncStatus kept reporting "enabled" with a stale lastSyncedAt, and the failure retried
// identically and silently every 30 seconds. This proves a generic failure now takes the same
// halt-on-transition path the two special-cased errors already had (FR-031: quiet on every retry
// while still blocked, one notice/notification on the transition into "halted").
//
// All three assertions live in one `it`, deliberately: sync-manager.ts's `haltedReason` is a
// module-level variable that outlives any single test, so a fresh `it` block does not start from
// "never halted" the way a fresh :memory: database does. Sequencing every step inside one test
// (fail -> fail again -> recover) is what lets this test control that shared state instead of
// silently inheriting whatever the previous `it` left behind.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaths = { userData: "" };
const notifications: Array<{ title: string; body: string }> = [];

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return mockPaths.userData;
      throw new Error(`unexpected app.getPath(${name})`);
    },
  },
  Notification: class {
    static isSupported(): boolean {
      return true;
    }
    constructor(private opts: { title: string; body: string }) {}
    show(): void {
      notifications.push(this.opts);
    }
  },
}));

// merge-pass.ts's runMergePass is the first real work runMergePassSafely does once isStale()
// returns false (the default for a database that has never synced) -- mocking it to throw lets
// this test force the generic catch branch without needing a real boolean-bind failure.
const runMergePassMock = vi.fn();
vi.mock("../merge-pass.ts", () => ({
  runMergePass: (...args: unknown[]) => runMergePassMock(...args),
}));

import { getDb, initDatabase, setActiveDatabaseForTesting } from "../../database.ts";
import { invalidateDataDirCache } from "../../data-location.ts";
import { invalidateDeviceIdCache } from "../device-identity.ts";
import { getSyncStatus, listNotices, runMergePassSafely } from "../sync-manager.ts";
import { setSyncEnabled } from "../sync-writer.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-merge-failed-"));
  mockPaths.userData = root;
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  setActiveDatabaseForTesting(null);
  initDatabase(":memory:");
  setSyncEnabled(getDb(), true);
  notifications.length = 0;
  runMergePassMock.mockReset();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runMergePassSafely: a generic merge-pass error is no longer swallowed into console.warn", () => {
  it("halts with a merge-failed notice on first failure, dedupes on repeats, recovers on success", () => {
    const failureMessage = "SQLite3 can only bind numbers, strings, bigints, buffers, and null";
    runMergePassMock.mockImplementation(() => {
      throw new TypeError(failureMessage);
    });

    // First failure: transition into "halted" -- exactly one notice, one OS notification.
    runMergePassSafely();

    expect(getSyncStatus().halted?.reason).toBe(failureMessage);
    let mergeFailed = listNotices().filter((n) => n.kind === "merge-failed");
    expect(mergeFailed.length).toBe(1);
    expect(mergeFailed[0]?.detail).toBe(failureMessage);
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.body).toBe(failureMessage);

    // Repeated failures while still halted: FR-031 wants silence, not a repeat alarm every pass.
    runMergePassSafely();
    runMergePassSafely();

    mergeFailed = listNotices().filter((n) => n.kind === "merge-failed");
    expect(mergeFailed.length).toBe(1);
    expect(notifications.length).toBe(1);

    // A later pass succeeds: the halt clears, so the *next* failure (if any) would count as a
    // fresh transition again rather than staying silently swallowed forever.
    runMergePassMock.mockImplementation(() => ({ applied: 0, skippedAlreadyApplied: 0, notices: 0 }));
    runMergePassSafely();

    expect(getSyncStatus().halted).toBeNull();
  });
});
