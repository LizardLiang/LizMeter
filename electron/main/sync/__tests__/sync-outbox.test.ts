// @vitest-environment node
// The write path queues oplog lines in sync_outbox inside the row's own transaction and appends
// them to the shared file only after the commit. Each test names the failure it guards against.

import fs from "node:fs";
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
  assignTag,
  createTag,
  createTodo,
  deleteTag,
  listTags,
  listTodos,
  saveSession,
} from "../../database.ts";
import { createTwoDeviceHarness, type HarnessDevice, type TwoDeviceHarness } from "../../../../src/test/two-device-harness.ts";
import { enableSyncOnExistingMachine } from "../migration.ts";
import { listSyncNotices } from "../notices.ts";
import { getOplogFilePath } from "../oplog.ts";
import { flushOutboxOnQuit } from "../sync-manager.ts";
import { flushOutbox, setSyncEnabled } from "../sync-writer.ts";

let harness: TwoDeviceHarness;

beforeEach(() => {
  harness = createTwoDeviceHarness(mockPaths);
});

afterEach(() => {
  harness.cleanup();
});

function oplogPath(device: HarnessDevice): string {
  return getOplogFilePath(harness.sharedDir, device.deviceId);
}

function oplogLines(device: HarnessDevice): string[] {
  const file = oplogPath(device);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

function outboxCount(device: HarnessDevice): number {
  try {
    return (device.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function pendingNotices(device: HarnessDevice) {
  return listSyncNotices(device.db).filter((n) => n.kind === "publish-pending");
}

/** A regular file where the shared `sync` folder belongs: every publish attempt fails until it is removed. */
function blockSharedFolder(): string {
  const blocker = path.join(harness.sharedDir, "sync");
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.writeFileSync(blocker, "not a folder");
  return blocker;
}

function unblockSharedFolder(blocker: string): void {
  fs.rmSync(blocker, { force: true });
}

describe("7a: a failed write leaves no public line", () => {
  it("publishes nothing and queues nothing when the transaction fails after the record call", () => {
    harness.deviceA.db.exec(
      "CREATE TRIGGER fail_clock BEFORE INSERT ON sync_field_clocks BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );

    expect(() => harness.as(harness.deviceA, () => createTag({ name: "ghost", color: "#7aa2f7" }))).toThrow(/boom/);

    expect(oplogLines(harness.deviceA)).toEqual([]);
    expect(outboxCount(harness.deviceA)).toBe(0);
    expect(harness.as(harness.deviceA, () => listTags())).toEqual([]);
  });
});

describe("7b: a delete is published even when the folder is unreachable at the time", () => {
  it("keeps the delete locally, queues its line, and the peer sees it after the next flush", () => {
    harness.as(harness.deviceA, () => createTag({ name: "doomed", color: "#7aa2f7" }));
    harness.sync(harness.deviceB);
    expect(harness.as(harness.deviceB, () => listTags().map((t) => t.name))).toEqual(["doomed"]);

    const blocker = blockSharedFolder();
    const tagId = harness.as(harness.deviceA, () => listTags()[0]!.id);
    harness.as(harness.deviceA, () => deleteTag(tagId));
    expect(harness.as(harness.deviceA, () => listTags())).toEqual([]);

    unblockSharedFolder(blocker);
    harness.as(harness.deviceA, () => flushOutbox(harness.deviceA.db));
    harness.sync(harness.deviceB);

    expect(harness.as(harness.deviceB, () => listTags())).toEqual([]);
  });
});

describe("7c: an unreachable folder keeps the edit and shows a notice", () => {
  it("saves locally, counts the waiting lines, then publishes all in order and clears the notice", () => {
    const blocker = blockSharedFolder();

    harness.as(harness.deviceA, () => createTodo({ title: "first" }));
    harness.as(harness.deviceA, () => createTodo({ title: "second" }));

    expect(harness.as(harness.deviceA, () => listTodos().map((t) => t.title)).sort()).toEqual(["first", "second"]);
    const waiting = outboxCount(harness.deviceA);
    expect(waiting).toBeGreaterThanOrEqual(2);
    const notices = pendingNotices(harness.deviceA);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toBe(`${waiting} changes waiting to publish`);

    unblockSharedFolder(blocker);
    harness.as(harness.deviceA, () => flushOutbox(harness.deviceA.db));

    expect(outboxCount(harness.deviceA)).toBe(0);
    expect(pendingNotices(harness.deviceA)).toEqual([]);
    const lines = oplogLines(harness.deviceA);
    expect(lines).toHaveLength(waiting);
    const titles = lines
      .map((l) => JSON.parse(l) as { fields?: { title?: { value: string } } })
      .map((e) => e.fields?.title?.value)
      .filter((t): t is string => t !== undefined);
    expect(titles).toEqual(["first", "second"]);

    harness.sync(harness.deviceB);
    expect(harness.as(harness.deviceB, () => listTodos().map((t) => t.title)).sort()).toEqual(["first", "second"]);
  });
});

describe("7d: a line published twice is applied once", () => {
  it("re-sends every line after a crash between the append and the outbox delete", () => {
    harness.as(harness.deviceA, () => {
      const session = saveSession({
        title: "focus",
        timerType: "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
      });
      const tag = createTag({ name: "deep", color: "#7aa2f7" });
      assignTag({ sessionId: session.id, tagId: tag.id });
    });
    const once = oplogLines(harness.deviceA);
    expect(once.length).toBeGreaterThan(0);

    // The crash: the lines are in the file, and the outbox still holds them.
    const insert = harness.deviceA.db.prepare("INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)");
    for (const line of once) insert.run(line, new Date().toISOString());
    harness.as(harness.deviceA, () => flushOutbox(harness.deviceA.db));
    expect(oplogLines(harness.deviceA)).toEqual([...once, ...once]);

    harness.sync(harness.deviceB);
    harness.sync(harness.deviceB);
    const onB = harness.as(harness.deviceB, () => ({ tags: listTags().map((t) => t.name) }));
    expect(onB.tags).toEqual(["deep"]);
    const applied = harness.deviceB.db.prepare("SELECT COUNT(*) AS n FROM sync_applied_ops").get() as { n: number };
    expect(applied.n).toBe(once.length);
  });
});

describe("7e: the first publish resumes after a crash", () => {
  function seedUnsyncedDevice(): void {
    setSyncEnabled(harness.deviceA.db, false);
    harness.as(harness.deviceA, () => {
      createTodo({ title: "one" });
      createTodo({ title: "two" });
      createTag({ name: "tag-one", color: "#7aa2f7" });
    });
  }

  it("turns the flag on and queues every row in one transaction, or does neither", () => {
    seedUnsyncedDevice();
    harness.deviceA.db.exec(
      "CREATE TRIGGER fail_late BEFORE INSERT ON sync_field_clocks WHEN (SELECT COUNT(*) FROM sync_field_clocks) >= 4 BEGIN SELECT RAISE(ABORT, 'crash'); END",
    );

    expect(() =>
      harness.as(harness.deviceA, () => enableSyncOnExistingMachine(harness.deviceA.db, undefined, harness.sharedDir))
    ).toThrow(/crash/);

    const flag = harness.deviceA.db.prepare("SELECT value FROM settings WHERE key = 'sync.enabled'").get() as
      | { value: string }
      | undefined;
    expect(flag?.value).not.toBe("true");
    expect(oplogLines(harness.deviceA)).toEqual([]);
    expect(outboxCount(harness.deviceA)).toBe(0);

    harness.deviceA.db.exec("DROP TRIGGER fail_late");
    harness.as(harness.deviceA, () => enableSyncOnExistingMachine(harness.deviceA.db, undefined, harness.sharedDir));
    harness.sync(harness.deviceB);
    expect(harness.as(harness.deviceB, () => listTodos().map((t) => t.title)).sort()).toEqual(["one", "two"]);
    expect(harness.as(harness.deviceB, () => listTags().map((t) => t.name))).toEqual(["tag-one"]);
  });

  it("publishes a complete outbox at the next flush when the crash comes after the commit", () => {
    seedUnsyncedDevice();
    const blocker = blockSharedFolder();
    harness.as(harness.deviceA, () => enableSyncOnExistingMachine(harness.deviceA.db, undefined, harness.sharedDir));
    expect(outboxCount(harness.deviceA)).toBeGreaterThan(0);

    unblockSharedFolder(blocker);
    harness.as(harness.deviceA, () => flushOutbox(harness.deviceA.db));
    harness.sync(harness.deviceB);

    expect(harness.as(harness.deviceB, () => listTodos().map((t) => t.title)).sort()).toEqual(["one", "two"]);
  });
});

describe("7f: a torn last line is healed", () => {
  it("starts the next line on its own line so the new entries stay readable", () => {
    const file = oplogPath(harness.deviceA);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v":1,"op":"upsert","torn');

    harness.as(harness.deviceA, () => createTag({ name: "after-tear", color: "#7aa2f7" }));

    const lines = oplogLines(harness.deviceA);
    expect(lines[0]).toBe('{"v":1,"op":"upsert","torn');
    for (const line of lines.slice(1)) expect(() => JSON.parse(line)).not.toThrow();

    harness.sync(harness.deviceB);
    expect(harness.as(harness.deviceB, () => listTags().map((t) => t.name))).toEqual(["after-tear"]);
  });
});

describe("12a: a device with sync off publishes nothing at quit", () => {
  it("keeps the queued lines out of the shared file", () => {
    const blocker = blockSharedFolder();
    harness.as(harness.deviceA, () => createTag({ name: "queued", color: "#7aa2f7" }));
    expect(outboxCount(harness.deviceA)).toBeGreaterThan(0);

    setSyncEnabled(harness.deviceA.db, false);
    unblockSharedFolder(blocker);
    harness.as(harness.deviceA, () => flushOutboxOnQuit());

    expect(oplogLines(harness.deviceA)).toEqual([]);
    expect(outboxCount(harness.deviceA)).toBeGreaterThan(0);
  });

  it("still publishes at quit while sync is on", () => {
    const blocker = blockSharedFolder();
    harness.as(harness.deviceA, () => createTag({ name: "queued", color: "#7aa2f7" }));
    unblockSharedFolder(blocker);
    harness.as(harness.deviceA, () => flushOutboxOnQuit());

    expect(outboxCount(harness.deviceA)).toBe(0);
    expect(oplogLines(harness.deviceA).length).toBeGreaterThan(0);
  });
});

describe("12b: a failed append is undone before the retry", () => {
  it("cuts the torn fragment off the file, then publishes every line whole", () => {
    harness.as(harness.deviceA, () => createTag({ name: "before", color: "#7aa2f7" }));
    const intact = fs.readFileSync(oplogPath(harness.deviceA), "utf8");

    const realAppend = fs.appendFileSync.bind(fs);
    const spy = vi.spyOn(fs, "appendFileSync").mockImplementationOnce((file, data, options) => {
      realAppend(file, String(data).slice(0, 20), options as never);
      throw new Error("disk full");
    });
    try {
      harness.as(harness.deviceA, () => createTag({ name: "torn", color: "#7aa2f7" }));
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(oplogPath(harness.deviceA), "utf8")).toBe(intact);
    expect(outboxCount(harness.deviceA)).toBeGreaterThan(0);

    harness.as(harness.deviceA, () => flushOutbox(harness.deviceA.db));
    for (const line of oplogLines(harness.deviceA)) expect(() => JSON.parse(line)).not.toThrow();
    harness.sync(harness.deviceB);
    expect(harness.as(harness.deviceB, () => listTags().map((t) => t.name)).sort()).toEqual(["before", "torn"]);
  });
});

describe("flush timing", () => {
  it("holds lines until the outermost transaction commits", () => {
    harness.as(harness.deviceA, () => {
      harness.deviceA.db.transaction(() => {
        createTag({ name: "inner", color: "#7aa2f7" });
        expect(oplogLines(harness.deviceA)).toEqual([]);
      })();
      flushOutbox(harness.deviceA.db);
    });
    expect(oplogLines(harness.deviceA).length).toBeGreaterThan(0);
  });

  it("retries by itself after 30 seconds and keeps a dismissed notice dismissed", () => {
    vi.useFakeTimers();
    try {
      const blocker = blockSharedFolder();
      harness.as(harness.deviceA, () => createTag({ name: "later", color: "#7aa2f7" }));
      const [notice] = pendingNotices(harness.deviceA);
      harness.deviceA.db.prepare("UPDATE sync_notices SET dismissed = 1 WHERE id = ?").run(notice!.id);

      vi.advanceTimersByTime(30_000);
      expect(listSyncNotices(harness.deviceA.db).filter((n) => n.kind === "publish-pending")).toEqual([]);

      unblockSharedFolder(blocker);
      harness.as(harness.deviceA, () => vi.advanceTimersByTime(30_000));
      expect(outboxCount(harness.deviceA)).toBe(0);
      expect(oplogLines(harness.deviceA).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
