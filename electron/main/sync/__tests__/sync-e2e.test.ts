// @vitest-environment node
// End-to-end sync tests using the two-device harness (Milestone 9): two independent in-memory
// databases wired to the real sync engine, sharing one real temp folder standing in for the
// cloud-drive folder. No real second machine or Electron process needed.

import fs from "node:fs";
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

import { createTodo, createTodoLabel, createTodoProject, deleteTodo, listTodoLabels, listTodoProjects, listTodos, reorderTodoProjects, updateTodo } from "../../database.ts";
import { createTwoDeviceHarness, type TwoDeviceHarness } from "../../../../src/test/two-device-harness.ts";
import { getOplogFilePath } from "../oplog.ts";
import { getOrAssignDeviceNumber } from "../device-identity.ts";

let harness: TwoDeviceHarness;

beforeEach(() => {
  harness = createTwoDeviceHarness(mockPaths);
});

afterEach(() => {
  harness.cleanup();
});

describe("FR-008: field-level last-write-wins", () => {
  it("keeps A's title and B's due date when each edits a different field concurrently", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "Ship the release" }));
    harness.sync(harness.deviceB); // B now has the todo too

    // Concurrent, unsynced edits on each side.
    harness.as(harness.deviceA, () => updateTodo({ id: created.id, title: "Ship the release NOW" }));
    harness.as(harness.deviceB, () => updateTodo({ id: created.id, dueDate: "2026-09-01" }));

    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);

    const onA = harness.as(harness.deviceA, () => listTodos().find((t) => t.title.startsWith("Ship")));
    const onB = harness.as(harness.deviceB, () => listTodos().find((t) => t.title.startsWith("Ship")));

    expect(onA?.title).toBe("Ship the release NOW");
    expect(onA?.dueDate).toBe("2026-09-01");
    expect(onB?.title).toBe("Ship the release NOW");
    expect(onB?.dueDate).toBe("2026-09-01");
  });
});

describe("FR-007 / FR-009: delete always wins, and the discard is visible", () => {
  it("keeps a todo deleted even when an unsynced concurrent edit arrives later, and raises a notice", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "Doomed todo" }));
    harness.sync(harness.deviceB);

    harness.as(harness.deviceA, () => deleteTodo(created.id));
    harness.as(harness.deviceB, () => updateTodo({ id: created.id, title: "I did not know it was deleted" }));

    harness.sync(harness.deviceB); // B applies A's delete
    harness.sync(harness.deviceA); // A applies B's (now-discarded) edit

    const onA = harness.as(harness.deviceA, () => listTodos().find((t) => t.id === created.id));
    const onB = harness.as(harness.deviceB, () => listTodos().find((t) => t.id === created.id));
    expect(onA).toBeUndefined();
    expect(onB).toBeUndefined();

    const noticeOnA = harness.as(
      harness.deviceA,
      () => harness.deviceA.db.prepare("SELECT * FROM sync_notices WHERE kind = 'discard-after-delete'").all(),
    );
    expect(noticeOnA.length).toBeGreaterThan(0);
  });
});

describe("FR-010: same-named entities converge to one record", () => {
  it("collapses two independently-created labels with the same name into one, on both machines", () => {
    harness.as(harness.deviceA, () => createTodoLabel({ name: "bug", color: "#f7768e" }));
    harness.as(harness.deviceB, () => createTodoLabel({ name: "bug", color: "#9ece6a" }));

    harness.sync(harness.deviceA);
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA); // second pass: A also needs to see B's alias-redirect entry

    const labelsOnA = harness.as(harness.deviceA, () => listTodoLabels().filter((l) => l.name.toLowerCase() === "bug"));
    const labelsOnB = harness.as(harness.deviceB, () => listTodoLabels().filter((l) => l.name.toLowerCase() === "bug"));

    expect(labelsOnA.length).toBe(1);
    expect(labelsOnB.length).toBe(1);
  });
});

describe("FR-011: project ordering converges", () => {
  it("propagates a reorder from A to B", () => {
    const p1 = harness.as(harness.deviceA, () => createTodoProject({ name: "Alpha" }));
    const p2 = harness.as(harness.deviceA, () => createTodoProject({ name: "Beta" }));
    harness.sync(harness.deviceB);

    harness.as(harness.deviceA, () => reorderTodoProjects([p2.id, p1.id]));
    harness.sync(harness.deviceB);

    const onB = harness.as(harness.deviceB, () => listTodoProjects());
    const beta = onB.find((p) => p.name === "Beta")!;
    const alpha = onB.find((p) => p.name === "Alpha")!;
    expect(beta.position).toBeLessThan(alpha.position);
  });
});

describe("B-1: an unknown/malicious field name from a peer's oplog is skipped, not injected or fatal", () => {
  it("ignores the bad field, applies every legitimate field in the same entry, and never throws", () => {
    const created = harness.as(harness.deviceA, () => createTodo({ title: "Original title" }));
    harness.sync(harness.deviceB);

    const rowUuid = harness.as(
      harness.deviceA,
      () => (harness.deviceA.db.prepare("SELECT uuid FROM todos WHERE id = ?").get(created.id) as { uuid: string }).uuid,
    );
    const filePath = harness.as(harness.deviceA, () => getOplogFilePath(harness.sharedDir, harness.deviceA.deviceId));
    const hlc = { physicalMs: Date.now(), counter: 0, deviceNumber: 1 };
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        v: 1,
        opId: "malicious-field-entry",
        hlc,
        table: "todos",
        op: "upsert",
        rowUuid,
        fields: {
          title: { value: "Legit concurrent title", hlc },
          // A crafted key that would form a syntactically valid second assignment if
          // interpolated verbatim into `UPDATE todos SET ${fieldName} = ?` -- see B-1. Placed
          // *after* the legit "title" field above (object key order is JS iteration order), so
          // an unguarded implementation would overwrite the legit title back to this malicious
          // value and set a literal "pwned" into notes -- both directly observable below,
          // rather than a weaker check that ordering could accidentally satisfy anyway.
          "notes = 'pwned', title": { value: "malicious", hlc },
        },
      })}\n`,
      "utf8",
    );

    expect(() => harness.sync(harness.deviceB)).not.toThrow();

    const onB = harness.as(harness.deviceB, () => listTodos().find((t) => t.id === created.id));
    expect(onB?.title).toBe("Legit concurrent title");
    expect(onB?.notes).toBeNull();
  });
});

describe("B-5: an entry whose dependency has not arrived yet is retried on a later pass, not lost", () => {
  it("a label link that sorts before its own todo's upsert resolves once that todo exists locally", () => {
    const label = harness.as(harness.deviceA, () => createTodoLabel({ name: "urgent" }));
    harness.sync(harness.deviceB);

    const labelUuid = harness.as(
      harness.deviceA,
      () => (harness.deviceA.db.prepare("SELECT uuid FROM todo_labels WHERE id = ?").get(label.id) as { uuid: string }).uuid,
    );
    const todoUuid = "11111111-1111-1111-1111-111111111111";
    const filePath = harness.as(harness.deviceA, () => getOplogFilePath(harness.sharedDir, harness.deviceA.deviceId));

    // Crafted so the link's HLC sorts BEFORE the todo's own upsert HLC -- an out-of-causal-order
    // arrival (e.g. clock skew between real machines) is exactly the scenario Hermes's B-5
    // finding named: "entry arrival order is HLC order, not dependency order".
    fs.appendFileSync(
      filePath,
      [
        JSON.stringify({
          v: 1,
          opId: "early-link",
          hlc: { physicalMs: 1000, counter: 0, deviceNumber: 1 },
          table: "todo_label_links",
          op: "link",
          fields: { fromUuid: todoUuid, toUuid: labelUuid },
        }),
        JSON.stringify({
          v: 1,
          opId: "late-todo-upsert",
          hlc: { physicalMs: 2000, counter: 0, deviceNumber: 1 },
          table: "todos",
          op: "upsert",
          rowUuid: todoUuid,
          fields: { title: { value: "Arrived after its own link", hlc: { physicalMs: 2000, counter: 0, deviceNumber: 1 } } },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    // Pass 1: within this one batch, the link (HLC 1000) is considered before the todo (HLC
    // 2000) exists locally -- it must defer, not silently succeed or get marked applied anyway.
    harness.sync(harness.deviceB);

    const appliedAfterPass1 = harness.as(
      harness.deviceB,
      () => harness.deviceB.db.prepare("SELECT 1 FROM sync_applied_ops WHERE op_id = 'early-link'").get(),
    );
    expect(appliedAfterPass1).toBeUndefined();

    const todoExistsAfterPass1 = harness.as(
      harness.deviceB,
      () => listTodos().some((t) => t.title === "Arrived after its own link"),
    );
    expect(todoExistsAfterPass1).toBe(true); // the todo itself did apply in pass 1

    const linkedAfterPass1 = harness.as(
      harness.deviceB,
      () =>
        harness.deviceB.db
          .prepare(
            `SELECT 1 FROM todo_label_links k
             INNER JOIN todos t ON t.id = k.todo_id
             WHERE t.uuid = ?`,
          )
          .get(todoUuid) !== undefined,
    );
    expect(linkedAfterPass1).toBe(false); // not linked yet -- this is the deferred half

    // Pass 2: re-reading the same file, the still-unmarked link entry is reconsidered -- this
    // time the todo already exists locally, so it resolves. Under the old bug (markApplied
    // unconditional) this entry would already have been marked in pass 1 and never reach here.
    harness.sync(harness.deviceB);

    const linkedAfterPass2 = harness.as(
      harness.deviceB,
      () =>
        harness.deviceB.db
          .prepare(
            `SELECT 1 FROM todo_label_links k
             INNER JOIN todos t ON t.id = k.todo_id
             WHERE t.uuid = ?`,
          )
          .get(todoUuid) !== undefined,
    );
    expect(linkedAfterPass2).toBe(true);

    const appliedAfterPass2 = harness.as(
      harness.deviceB,
      () => harness.deviceB.db.prepare("SELECT 1 FROM sync_applied_ops WHERE op_id = 'early-link'").get(),
    );
    expect(appliedAfterPass2).toBeDefined();
  });
});

describe("FR-020: an unknown future schema version is skipped, not fatal", () => {
  it("keeps applying every other entry when one line names a future version", () => {
    const t1 = harness.as(harness.deviceA, () => createTodo({ title: "Known-good entry" }));

    const filePath = harness.as(harness.deviceA, () => getOplogFilePath(harness.sharedDir, harness.deviceA.deviceId));
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        v: 999,
        opId: "future-entry",
        hlc: { physicalMs: Date.now(), counter: 0, deviceNumber: 1 },
        table: "todos",
        op: "upsert",
        rowUuid: "unknown-row",
        fields: { title: { value: "from the future", hlc: { physicalMs: Date.now(), counter: 0, deviceNumber: 1 } } },
      })}\n`,
      "utf8",
    );

    expect(() => harness.sync(harness.deviceB)).not.toThrow();

    const onB = harness.as(harness.deviceB, () => listTodos().find((t) => t.id === t1.id));
    expect(onB?.title).toBe("Known-good entry");
  });
});

describe("FR-005: two offline machines never assign the same permanent todo number", () => {
  it("keeps every todo id distinct after both devices create work before ever syncing with each other", () => {
    // Device A originates the shared folder (assigns block 0 -- see device-identity.ts's own
    // header comment) and publishes something, so B's own first-assignment sees a non-virgin
    // folder and is guaranteed a different block. This goes through the real production function
    // (getOrAssignDeviceNumber with dataDir), not the harness's own setSyncEnabled shortcut, which
    // never assigns a device number at all until something calls allocateNextTodoId with no
    // dataDir -- exactly the gap that left this requirement with no end-to-end test (R2-W3 is a
    // live path to the exact collision this test guards against).
    const deviceANumber = harness.as(
      harness.deviceA,
      () => getOrAssignDeviceNumber(harness.deviceA.db, harness.sharedDir),
    );
    expect(deviceANumber).toBe(0);

    const aFirst = harness.as(harness.deviceA, () => createTodo({ title: "A's first todo" }));
    harness.sync(harness.deviceB); // publishes A's oplog file into the shared folder, for B to see

    const deviceBNumber = harness.as(
      harness.deviceB,
      () => getOrAssignDeviceNumber(harness.deviceB.db, harness.sharedDir),
    );
    expect(deviceBNumber).not.toBe(0);
    expect(deviceBNumber).not.toBe(deviceANumber);

    // Both machines now go fully offline from each other and create several todos of their own,
    // with no coordination at all between them.
    const aIds = harness.as(
      harness.deviceA,
      () => Array.from({ length: 5 }, (_, i) => createTodo({ title: `A todo ${i}` }).id),
    );
    const bIds = harness.as(
      harness.deviceB,
      () => Array.from({ length: 5 }, (_, i) => createTodo({ title: `B todo ${i}` }).id),
    );

    // FR-005's own acceptance criterion: every id either machine handed out while offline is
    // unique, with no coordination between them at creation time.
    const overlap = aIds.filter((id) => bIds.includes(id));
    expect(overlap).toEqual([]);

    // Merging both directions must not throw a PRIMARY KEY collision and must preserve every row.
    harness.sync(harness.deviceB);
    harness.sync(harness.deviceA);

    const allIdsOnA = harness.as(harness.deviceA, () => listTodos().map((t) => t.id));
    const allIdsOnB = harness.as(harness.deviceB, () => listTodos().map((t) => t.id));
    expect(new Set(allIdsOnA).size).toBe(allIdsOnA.length); // no duplicate ids on A
    expect(new Set(allIdsOnB).size).toBe(allIdsOnB.length); // no duplicate ids on B
    for (const id of [aFirst.id, ...aIds, ...bIds]) {
      expect(allIdsOnA).toContain(id);
      expect(allIdsOnB).toContain(id);
    }
  });
});
