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
