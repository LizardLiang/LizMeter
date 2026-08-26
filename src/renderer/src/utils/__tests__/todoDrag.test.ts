import { describe, expect, it } from "vitest";
import type { Todo, TodoState } from "../../../../shared/types.ts";
import { droppedStateId, stateDropId, todosToMove } from "../todoDrag.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeState(id: number, label: string): TodoState {
  return {
    id,
    label,
    color: "#7aa2f7",
    position: id,
    isCompleted: false,
    isDefault: id === 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const todoState = makeState(1, "Todo");
const backlogState = makeState(2, "Backlog");

function makeTodo(id: number, state: TodoState): Todo {
  return {
    id,
    title: `Todo ${id}`,
    notes: null,
    state,
    project: null,
    labels: [],
    milestone: null,
    priority: 0,
    startDate: null,
    dueDate: null,
    source: "user",
    sourceLabel: null,
    parentId: null,
    parentTitle: null,
    childCount: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
  };
}

const todos: Todo[] = [
  makeTodo(10, todoState),
  makeTodo(11, todoState),
  makeTodo(20, backlogState),
];

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("stateDropId / droppedStateId", () => {
  it("round-trips a state id", () => {
    expect(droppedStateId({ id: stateDropId(7) })).toBe(7);
  });

  it("returns null when the drag was released over nothing", () => {
    expect(droppedStateId(null)).toBeNull();
    expect(droppedStateId(undefined)).toBeNull();
  });

  it("ignores a droppable that is not a group", () => {
    // A todo's own draggable id is a bare number, which must never read as a state.
    expect(droppedStateId({ id: 152 })).toBeNull();
    expect(droppedStateId({ id: "project:3" })).toBeNull();
  });

  it("returns null for a group id with a non-numeric suffix", () => {
    expect(droppedStateId({ id: "state:abc" })).toBeNull();
  });
});

describe("todosToMove", () => {
  it("returns the dragged row when it changes state", () => {
    expect(todosToMove([10], todos, backlogState.id)).toEqual([10]);
  });

  it("drops rows already in the target, so a drop on the source group is a no-op", () => {
    expect(todosToMove([10, 11], todos, todoState.id)).toEqual([]);
  });

  it("keeps only the rows that actually move out of a mixed selection", () => {
    expect(todosToMove([10, 11, 20], todos, backlogState.id)).toEqual([10, 11]);
  });

  it("skips ids that no longer exist", () => {
    // The MCP server can delete a todo while the pointer is still down.
    expect(todosToMove([10, 999], todos, backlogState.id)).toEqual([10]);
  });

  it("preserves the given order", () => {
    expect(todosToMove([11, 10], todos, backlogState.id)).toEqual([11, 10]);
  });
});
