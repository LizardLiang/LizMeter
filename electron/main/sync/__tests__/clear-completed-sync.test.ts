// @vitest-environment node
// "Clear N done" must publish one tombstone per cleared todo, exactly like deleteTodo does.

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
  clearCompletedTodos,
  createTodo,
  listTodoStates,
  listTodos,
  updateTodo,
} from "../../database.ts";
import { buildSnapshotEntries } from "../snapshot.ts";
import { createTwoDeviceHarness, type TwoDeviceHarness } from "../../../../src/test/two-device-harness.ts";

let harness: TwoDeviceHarness;

beforeEach(() => {
  harness = createTwoDeviceHarness(mockPaths);
});

afterEach(() => {
  harness.cleanup();
});

function completedStateId(): number {
  const state = listTodoStates().find((s) => s.isCompleted);
  if (!state) throw new Error("no completed state");
  return state.id;
}

describe("clearCompletedTodos publishes deletes", () => {
  it("removes the cleared todos on the other machine and keeps the open ones", () => {
    const done1 = harness.as(harness.deviceA, () => createTodo({ title: "Done one" }));
    const done2 = harness.as(harness.deviceA, () => createTodo({ title: "Done two" }));
    harness.as(harness.deviceA, () => createTodo({ title: "Still open" }));
    harness.sync(harness.deviceB);
    expect(harness.as(harness.deviceB, () => listTodos().length)).toBe(3);

    harness.as(harness.deviceA, () => {
      const stateId = completedStateId();
      updateTodo({ id: done1.id, stateId });
      updateTodo({ id: done2.id, stateId });
    });
    harness.sync(harness.deviceB);
    const cleared = harness.as(harness.deviceA, () => clearCompletedTodos());
    expect(cleared.count).toBe(2);

    harness.sync(harness.deviceB);
    const titlesOnB = harness.as(harness.deviceB, () => listTodos().map((t) => t.title));
    expect(titlesOnB).toEqual(["Still open"]);
  });

  it("keeps the deletes in a snapshot built on the clearing machine, so a rebuild cannot resurrect", () => {
    const done = harness.as(harness.deviceA, () => createTodo({ title: "Done one" }));
    harness.as(harness.deviceA, () => updateTodo({ id: done.id, stateId: completedStateId() }));
    harness.as(harness.deviceA, () => clearCompletedTodos());

    const entries = harness.as(harness.deviceA, () => buildSnapshotEntries(harness.deviceA.db));
    const todoOps = entries.filter((e) => e.table === "todos").map((e) => e.op);
    expect(todoOps).toContain("delete");
    expect(todoOps).not.toContain("upsert");
  });

  it("lifts children of a cleared parent to the top level on both machines", () => {
    const parent = harness.as(harness.deviceA, () => createTodo({ title: "Parent" }));
    const child = harness.as(harness.deviceA, () => createTodo({ title: "Child", parentId: parent.id }));
    harness.as(harness.deviceA, () => updateTodo({ id: parent.id, stateId: completedStateId() }));
    harness.sync(harness.deviceB);

    harness.as(harness.deviceA, () => clearCompletedTodos());
    harness.sync(harness.deviceB);

    for (const device of [harness.deviceA, harness.deviceB]) {
      const todos = harness.as(device, () => listTodos());
      expect(todos.map((t) => t.title)).toEqual(["Child"]);
      expect(todos[0]?.parentId ?? null).toBeNull();
      expect(todos[0]?.id).toBe(child.id);
    }
  });
});
