// @vitest-environment node
// Milestone 7: retention, compaction, and stale-machine rebuild (FR-018, FR-019).

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

import { createTodo, createTodoProject, deleteTodo, listTodoProjects, listTodos } from "../../database.ts";
import { createTwoDeviceHarness, type TwoDeviceHarness } from "../../../../src/test/two-device-harness.ts";
import { getSyncDevicesDir, readOplogEntries } from "../oplog.ts";
import {
  backupBeforeRebuild,
  isStale,
  markSyncedNow,
  rebuildFromSnapshot,
  RETENTION_DAYS,
  writeSnapshotIfDue,
} from "../snapshot.ts";

let harness: TwoDeviceHarness;

beforeEach(() => {
  harness = createTwoDeviceHarness(mockPaths);
});

afterEach(() => {
  harness.cleanup();
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = RETENTION_DAYS * ONE_DAY_MS;

describe("writeSnapshotIfDue", () => {
  it("writes a snapshot file containing every existing row, and is a no-op again the same day", () => {
    harness.as(harness.deviceA, () => createTodo({ title: "keep me" }));
    harness.as(harness.deviceA, () => createTodoProject({ name: "Alpha" }));

    const now = Date.now();
    const wroteFirst = harness.as(
      harness.deviceA,
      () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now),
    );
    expect(wroteFirst).toBe(true);

    const dir = getSyncDevicesDir(harness.sharedDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".snapshot.json"));
    expect(files.length).toBe(1);

    const snapshot = JSON.parse(fs.readFileSync(`${dir}/${files[0]}`, "utf8")) as { entries: unknown[] };
    expect(snapshot.entries.length).toBeGreaterThan(0);

    // Same day: no-op.
    const wroteSecond = harness.as(
      harness.deviceA,
      () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now + 60_000),
    );
    expect(wroteSecond).toBe(false);

    // A day later: due again.
    const wroteThird = harness.as(
      harness.deviceA,
      () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now + ONE_DAY_MS + 1),
    );
    expect(wroteThird).toBe(true);
  });

  it("trims this device's own oplog to entries newer than the retention window (FR-018)", () => {
    const t0 = 1_000_000_000_000; // arbitrary fixed epoch for deterministic aging
    harness.as(harness.deviceA, () => createTodo({ title: "old entry" }));

    // Age the just-written oplog entry past the retention window by rewriting its hlc directly.
    const oplogPath = harness.as(
      harness.deviceA,
      () => `${getSyncDevicesDir(harness.sharedDir)}/${harness.deviceA.deviceId}.oplog.jsonl`,
    );
    const { entries } = readOplogEntries(oplogPath);
    expect(entries.length).toBeGreaterThan(0);
    const aged = entries.map((e) => ({ ...e, hlc: { ...e.hlc, physicalMs: t0 - RETENTION_MS - ONE_DAY_MS } }));
    fs.writeFileSync(oplogPath, aged.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    harness.as(harness.deviceA, () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, t0));

    const { entries: afterTrim } = readOplogEntries(oplogPath);
    expect(afterTrim.length).toBe(0);
  });
});

describe("H-002: tombstones are pruned by the retention window, not kept forever", () => {
  it("prunes an aged tombstone from sync_tombstones when a snapshot is written", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "will be deleted" }));
    harness.as(harness.deviceA, () => deleteTodo(created.id));

    const t0 = 1_000_000_000_000;
    // Age the tombstone directly -- the same technique the oplog-trim test above already uses.
    harness.as(harness.deviceA, () => {
      harness.deviceA.db.prepare("UPDATE sync_tombstones SET hlc_physical_ms = ?").run(t0 - RETENTION_MS - ONE_DAY_MS);
    });

    const beforeCount = harness.as(
      harness.deviceA,
      () => (harness.deviceA.db.prepare("SELECT COUNT(*) AS c FROM sync_tombstones").get() as { c: number }).c,
    );
    expect(beforeCount).toBeGreaterThan(0);

    harness.as(harness.deviceA, () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, t0));

    const afterCount = harness.as(
      harness.deviceA,
      () => (harness.deviceA.db.prepare("SELECT COUNT(*) AS c FROM sync_tombstones").get() as { c: number }).c,
    );
    expect(afterCount).toBe(0);
  });

  it("excludes an aged tombstone from a freshly built snapshot's own entries (FR-018)", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "will be deleted" }));
    harness.as(harness.deviceA, () => deleteTodo(created.id));

    const t0 = 1_000_000_000_000;
    harness.as(harness.deviceA, () => {
      harness.deviceA.db.prepare("UPDATE sync_tombstones SET hlc_physical_ms = ?").run(t0 - RETENTION_MS - ONE_DAY_MS);
    });

    harness.as(harness.deviceA, () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, t0));

    const dir = getSyncDevicesDir(harness.sharedDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".snapshot.json"));
    const snapshot = JSON.parse(fs.readFileSync(`${dir}/${files[0]}`, "utf8")) as {
      entries: Array<{ op: string }>;
    };
    expect(snapshot.entries.some((e) => e.op === "delete")).toBe(false);
  });
});

describe("isStale / rebuildFromSnapshot (FR-019)", () => {
  it("is not stale before the retention window and stale after it", () => {
    const now = 1_000_000_000_000;
    harness.as(harness.deviceA, () => markSyncedNow(harness.deviceA.db, now));

    expect(harness.as(harness.deviceA, () => isStale(harness.deviceA.db, now + ONE_DAY_MS))).toBe(false);
    expect(harness.as(harness.deviceA, () => isStale(harness.deviceA.db, now + RETENTION_MS + ONE_DAY_MS))).toBe(true);
  });

  it("is not stale for a machine that has never synced yet", () => {
    expect(harness.as(harness.deviceB, () => isStale(harness.deviceB.db))).toBe(false);
  });

  it("rebuilds a stale machine from the most recent snapshot and writes a notice", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "from the snapshot" }));
    const now = Date.now();
    harness.as(harness.deviceA, () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now));

    // Simulate B being wildly out of date: wipe its own view and force a rebuild.
    const rebuilt = harness.as(
      harness.deviceB,
      () => rebuildFromSnapshot(harness.deviceB.db, harness.sharedDir, harness.deviceB.deviceId, now + 1000),
    );
    expect(rebuilt).toBe(true);

    const onB = harness.as(harness.deviceB, () => listTodos().find((t) => t.id === created.id));
    expect(onB?.title).toBe("from the snapshot");

    const notices = harness.as(
      harness.deviceB,
      () => harness.deviceB.db.prepare("SELECT * FROM sync_notices WHERE kind = 'stale-machine-rebuild'").all(),
    );
    expect(notices.length).toBe(1);
  });

  it("returns false and changes nothing when no snapshot exists anywhere yet", () => {
    const rebuilt = harness.as(
      harness.deviceB,
      () => rebuildFromSnapshot(harness.deviceB.db, harness.sharedDir, harness.deviceB.deviceId),
    );
    expect(rebuilt).toBe(false);
  });

  it("also carries project ordering and names through a rebuild", () => {
    harness.as(harness.deviceA, () => createTodoProject({ name: "Alpha" }));
    harness.as(harness.deviceA, () => createTodoProject({ name: "Beta" }));
    const now = Date.now();
    harness.as(harness.deviceA, () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now));

    harness.as(harness.deviceB, () => rebuildFromSnapshot(harness.deviceB.db, harness.sharedDir, harness.deviceB.deviceId, now + 1000));

    const onB = harness.as(harness.deviceB, () => listTodoProjects());
    expect(onB.map((p) => p.name).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("rebuilds a machine that already has its own todos, without violating the todo_states foreign key (R2-B3)", () => {
    // Every rebuild test above rebuilds device B while it has zero todos -- the one shape that
    // can never trigger the bug this test is for. A todo's state_id is not nullable-by-default:
    // resolveStateId always resolves to a real todo_states row (the seeded default, here), so any
    // machine with any todos at all reaches wipe()'s `DELETE FROM todo_states` while a todo still
    // references it. Under foreign_keys = ON with no ON DELETE action on state_id, that used to
    // throw FOREIGN KEY constraint failed on the very first statement, roll back the whole wipe,
    // and get swallowed by sync-manager.ts's bare console.warn -- so FR-019's rebuild could never
    // actually run on any machine that had done any work at all.
    harness.as(harness.deviceB, () => createTodo({ title: "device B's own pre-rebuild todo" }));

    const created = harness.as(harness.deviceA, () => createTodo({ title: "from the snapshot" }));
    const now = Date.now();
    harness.as(harness.deviceA, () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now));

    const rebuilt = harness.as(
      harness.deviceB,
      () => rebuildFromSnapshot(harness.deviceB.db, harness.sharedDir, harness.deviceB.deviceId, now + 1000),
    );
    expect(rebuilt).toBe(true);

    const onB = harness.as(harness.deviceB, () => listTodos());
    // The wipe genuinely ran: B's own pre-existing todo is gone, replaced by the snapshot's.
    expect(onB.some((t) => t.title === "device B's own pre-rebuild todo")).toBe(false);
    expect(onB.find((t) => t.id === created.id)?.title).toBe("from the snapshot");
  });
});

describe("backupBeforeRebuild", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-rebuild-backup-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies the db file and its -wal/-shm siblings, when present, to a timestamped .bak (R2-W7)", () => {
    const dbPath = path.join(dir, "lizmeter.db");
    fs.writeFileSync(dbPath, "pretend sqlite bytes");
    fs.writeFileSync(`${dbPath}-wal`, "pretend wal bytes");
    // No -shm file this time -- must not be required.

    const backupPath = backupBeforeRebuild(dbPath);

    expect(backupPath).toMatch(/\.pre-rebuild-.*\.bak$/);
    expect(fs.readFileSync(backupPath!, "utf8")).toBe("pretend sqlite bytes");
    expect(fs.readFileSync(`${backupPath}-wal`, "utf8")).toBe("pretend wal bytes");
    expect(fs.existsSync(`${backupPath}-shm`)).toBe(false);
  });

  it("is a no-op when there is nothing at the given path (e.g. every :memory:-backed test)", () => {
    expect(backupBeforeRebuild(":memory:")).toBeNull();
    expect(backupBeforeRebuild(path.join(dir, "does-not-exist.db"))).toBeNull();
  });
});
