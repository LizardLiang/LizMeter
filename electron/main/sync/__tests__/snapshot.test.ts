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

import Database from "better-sqlite3";
import {
  createTodo,
  createTodoAttachment,
  createTodoProject,
  deleteTodo,
  listTodoAttachments,
  listTodoProjects,
  listTodos,
  saveSessionWithTracking,
} from "../../database.ts";
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

  it("preserves claude_code_sessions/idle_periods across a rebuild by re-linking them to a session that survives it (H3-B1)", () => {
    // claude_code_sessions/idle_periods are FR-003 machine-local -- never oplogged, never
    // snapshotted -- so `DELETE FROM sessions` inside wipe() cascades them away unless
    // rebuildFromSnapshot explicitly preserves and re-links them itself.
    const session = harness.as(harness.deviceB, () =>
      saveSessionWithTracking({
        title: "session with claude code activity",
        timerType: "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
        claudeCodeSessions: [{
          ccSessionUuid: "cc-uuid-1",
          fileEditCount: 3,
          totalIdleSeconds: 60,
          idlePeriodCount: 1,
          firstActivityAt: "2026-01-01T00:00:00.000Z",
          lastActivityAt: "2026-01-01T00:10:00.000Z",
          filesEdited: ["a.ts"],
          idlePeriods: [
            { startAt: "2026-01-01T00:05:00.000Z", endAt: "2026-01-01T00:06:00.000Z", durationSeconds: 60 },
          ],
        }],
      }));

    // B's session is a synced row (its oplog entry was appended by saveSessionWithTracking above).
    // A pulls it in, then publishes a snapshot that includes it -- this is the snapshot B will
    // rebuild from, so the session (and therefore its cascade-linked activity rows) has somewhere
    // to survive into.
    harness.sync(harness.deviceA);
    const now = Date.now();
    harness.as(
      harness.deviceA,
      () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now),
    );

    const rebuilt = harness.as(
      harness.deviceB,
      () => rebuildFromSnapshot(harness.deviceB.db, harness.sharedDir, harness.deviceB.deviceId, now + 1000),
    );
    expect(rebuilt).toBe(true);

    const ccSessions = harness.as(
      harness.deviceB,
      () =>
        harness.deviceB.db.prepare("SELECT * FROM claude_code_sessions WHERE session_id = ?").all(
          session.id,
        ),
    ) as Array<{ id: string; cc_session_uuid: string; file_edit_count: number }>;
    expect(ccSessions.length).toBe(1);
    expect(ccSessions[0]!.cc_session_uuid).toBe("cc-uuid-1");
    expect(ccSessions[0]!.file_edit_count).toBe(3);

    const idlePeriods = harness.as(
      harness.deviceB,
      () =>
        harness.deviceB.db.prepare("SELECT * FROM claude_code_idle_periods WHERE cc_session_id = ?").all(
          ccSessions[0]!.id,
        ),
    ) as Array<{ duration_seconds: number }>;
    expect(idlePeriods.length).toBe(1);
    expect(idlePeriods[0]!.duration_seconds).toBe(60);
  });

  it("rebuilds todo_attachments from the snapshot instead of losing them to the cascade (H3-B1)", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "has an attachment" }));
    harness.as(harness.deviceA, () =>
      createTodoAttachment({
        todoId: created.id,
        sha256: "a".repeat(64),
        fileName: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 1234,
      }));

    const now = Date.now();
    harness.as(
      harness.deviceA,
      () => writeSnapshotIfDue(harness.deviceA.db, harness.sharedDir, harness.deviceA.deviceId, now),
    );

    const rebuilt = harness.as(
      harness.deviceB,
      () => rebuildFromSnapshot(harness.deviceB.db, harness.sharedDir, harness.deviceB.deviceId, now + 1000),
    );
    expect(rebuilt).toBe(true);

    const onB = harness.as(harness.deviceB, () => listTodos().find((t) => t.id === created.id));
    expect(onB).toBeDefined();

    const attachments = harness.as(harness.deviceB, () => listTodoAttachments(onB!.id));
    expect(attachments.length).toBe(1);
    expect(attachments[0]!.fileName).toBe("screenshot.png");
    expect(attachments[0]!.sha256).toBe("a".repeat(64));
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

  it("marks the backup's own lastSyncedAt as fresh, so restoring it does not immediately re-trigger the same rebuild (H3-B1)", () => {
    const dbPath = path.join(dir, "lizmeter.db");
    const seed = new Database(dbPath);
    seed.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const staleTimestamp = new Date(Date.now() - RETENTION_MS - ONE_DAY_MS).toISOString();
    seed.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("sync.lastSyncedAt", staleTimestamp);
    seed.close();

    const backupPath = backupBeforeRebuild(dbPath);
    expect(backupPath).not.toBeNull();

    const restored = new Database(backupPath!);
    const row = restored.prepare("SELECT value FROM settings WHERE key = ?").get("sync.lastSyncedAt") as
      | { value: string }
      | undefined;
    restored.close();

    expect(row).toBeDefined();
    expect(row!.value).not.toBe(staleTimestamp);
    // "Fresh" means isStale() would read this as not-stale if the backup were restored in place.
    expect(Date.now() - Date.parse(row!.value)).toBeLessThan(ONE_DAY_MS);
  });
});
