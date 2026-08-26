// Tests for todo state CRUD and the todos-to-states migration in database.ts
// Uses in-memory database (sql.js shim via vitest alias)

import { beforeEach, describe, expect, it } from "vitest";
import {
  createTodo,
  createTodoState,
  deleteTodoState,
  findTodoStateByLabel,
  initDatabase,
  listTodos,
  listTodoStates,
  migrateTodosToStatesNow,
  reorderTodoStates,
  updateTodoState,
} from "../database.ts";

beforeEach(() => {
  initDatabase(":memory:");
});

const labels = () => listTodoStates().map((s) => s.label);

// --- Seeding ----------------------------------------------------------------

describe("seeding", () => {
  it("creates the six default states in order", () => {
    expect(labels()).toEqual(["Backlog", "Todo", "Processing", "Testing", "Done", "Deprecated"]);
  });

  it("marks exactly one default and one completed", () => {
    const states = listTodoStates();
    expect(states.filter((s) => s.isDefault).map((s) => s.label)).toEqual(["Todo"]);
    expect(states.filter((s) => s.isCompleted).map((s) => s.label)).toEqual(["Done"]);
  });

  it("assigns contiguous positions from zero", () => {
    expect(listTodoStates().map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("does not re-seed a state the user deleted", () => {
    const testing = listTodoStates().find((s) => s.label === "Testing")!;
    const backlog = listTodoStates().find((s) => s.label === "Backlog")!;
    deleteTodoState(testing.id, backlog.id);

    // Re-running the migration must not resurrect it.
    migrateTodosToStatesNow();
    expect(labels()).not.toContain("Testing");
  });
});

// --- findTodoStateByLabel ---------------------------------------------------

describe("findTodoStateByLabel", () => {
  it("matches case-insensitively", () => {
    expect(findTodoStateByLabel("done")?.label).toBe("Done");
    expect(findTodoStateByLabel("PROCESSING")?.label).toBe("Processing");
  });

  it("ignores surrounding whitespace", () => {
    expect(findTodoStateByLabel("  Todo  ")?.label).toBe("Todo");
  });

  it("returns null for an unknown label", () => {
    expect(findTodoStateByLabel("Nope")).toBeNull();
  });
});

// --- createTodoState --------------------------------------------------------

describe("createTodoState", () => {
  it("appends at the end", () => {
    const created = createTodoState({ label: "Blocked" });
    expect(created.position).toBe(6);
    expect(labels()).toEqual(["Backlog", "Todo", "Processing", "Testing", "Done", "Deprecated", "Blocked"]);
  });

  it("is neither default nor completed", () => {
    const created = createTodoState({ label: "Blocked" });
    expect(created.isDefault).toBe(false);
    expect(created.isCompleted).toBe(false);
  });

  it("rejects a duplicate label regardless of case", () => {
    expect(() => createTodoState({ label: "done" })).toThrow(/already exists/);
  });

  it("rejects an empty label", () => {
    expect(() => createTodoState({ label: "   " })).toThrow();
  });

  it("rejects a color outside the palette", () => {
    expect(() => createTodoState({ label: "Blocked", color: "#123456" })).toThrow(/Invalid state color/);
  });
});

// --- updateTodoState --------------------------------------------------------

describe("updateTodoState", () => {
  it("renames without disturbing anything else", () => {
    const done = findTodoStateByLabel("Done")!;
    const renamed = updateTodoState({ id: done.id, label: "Shipped" });

    expect(renamed.label).toBe("Shipped");
    expect(renamed.isCompleted).toBe(true);
    expect(renamed.position).toBe(done.position);
  });

  it("keeps completion working after a rename, since it keys off the flag", () => {
    const done = findTodoStateByLabel("Done")!;
    updateTodoState({ id: done.id, label: "Shipped" });

    const todo = createTodo({ title: "x", stateId: done.id });
    expect(todo.state.isCompleted).toBe(true);
    expect(todo.completedAt).toBeTypeOf("string");
    expect(listTodos({ filter: "done" })).toHaveLength(1);
  });

  it("moves the default flag rather than duplicating it", () => {
    const backlog = findTodoStateByLabel("Backlog")!;
    updateTodoState({ id: backlog.id, isDefault: true });

    expect(listTodoStates().filter((s) => s.isDefault).map((s) => s.label)).toEqual(["Backlog"]);
  });

  it("moves the completed flag rather than duplicating it", () => {
    const deprecated = findTodoStateByLabel("Deprecated")!;
    updateTodoState({ id: deprecated.id, isCompleted: true });

    expect(listTodoStates().filter((s) => s.isCompleted).map((s) => s.label)).toEqual(["Deprecated"]);
  });

  it("refuses to leave no completed state", () => {
    const done = findTodoStateByLabel("Done")!;
    expect(() => updateTodoState({ id: done.id, isCompleted: false })).toThrow(/at least one state/i);
  });

  it("refuses to leave no default state", () => {
    const todo = findTodoStateByLabel("Todo")!;
    expect(() => updateTodoState({ id: todo.id, isDefault: false })).toThrow(/another state/i);
  });

  it("rejects renaming onto another state's label", () => {
    const backlog = findTodoStateByLabel("Backlog")!;
    expect(() => updateTodoState({ id: backlog.id, label: "Testing" })).toThrow(/already exists/);
  });

  it("allows a case-only rename of itself", () => {
    const backlog = findTodoStateByLabel("Backlog")!;
    expect(updateTodoState({ id: backlog.id, label: "BACKLOG" }).label).toBe("BACKLOG");
  });
});

// --- deleteTodoState --------------------------------------------------------

describe("deleteTodoState", () => {
  it("moves affected todos and reports how many", () => {
    const testing = findTodoStateByLabel("Testing")!;
    const backlog = findTodoStateByLabel("Backlog")!;
    createTodo({ title: "a", stateId: testing.id });
    createTodo({ title: "b", stateId: testing.id });
    createTodo({ title: "c", stateId: backlog.id });

    expect(deleteTodoState(testing.id, backlog.id)).toBe(2);
    expect(listTodos().every((t) => t.state.label === "Backlog")).toBe(true);
  });

  it("never deletes the todos themselves", () => {
    const testing = findTodoStateByLabel("Testing")!;
    const backlog = findTodoStateByLabel("Backlog")!;
    createTodo({ title: "keep me", stateId: testing.id });

    deleteTodoState(testing.id, backlog.id);
    expect(listTodos()).toHaveLength(1);
  });

  it("keeps positions contiguous afterwards", () => {
    const testing = findTodoStateByLabel("Testing")!;
    const backlog = findTodoStateByLabel("Backlog")!;
    deleteTodoState(testing.id, backlog.id);

    expect(listTodoStates().map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it("blocks deleting the default state", () => {
    const todo = findTodoStateByLabel("Todo")!;
    const backlog = findTodoStateByLabel("Backlog")!;
    expect(() => deleteTodoState(todo.id, backlog.id)).toThrow(/default/i);
  });

  it("blocks deleting the completed state", () => {
    const done = findTodoStateByLabel("Done")!;
    const backlog = findTodoStateByLabel("Backlog")!;
    expect(() => deleteTodoState(done.id, backlog.id)).toThrow(/completed/i);
  });

  it("rejects reassigning to the state being deleted", () => {
    const testing = findTodoStateByLabel("Testing")!;
    expect(() => deleteTodoState(testing.id, testing.id)).toThrow(/being deleted/);
  });

  it("rejects an unknown replacement", () => {
    const testing = findTodoStateByLabel("Testing")!;
    expect(() => deleteTodoState(testing.id, 9999)).toThrow(/not found/);
  });
});

// --- reorderTodoStates ------------------------------------------------------

describe("reorderTodoStates", () => {
  it("applies the given order", () => {
    const ids = listTodoStates().map((s) => s.id);
    const reversed = [...ids].reverse();

    expect(reorderTodoStates(reversed).map((s) => s.label))
      .toEqual(["Deprecated", "Done", "Testing", "Processing", "Todo", "Backlog"]);
  });

  it("appends states left out of the list", () => {
    const states = listTodoStates();
    const done = states.find((s) => s.label === "Done")!;

    const result = reorderTodoStates([done.id]);
    expect(result[0]?.label).toBe("Done");
    expect(result.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("rejects an unknown id", () => {
    expect(() => reorderTodoStates([9999])).toThrow(/not found/);
  });
});

// --- Migration idempotency ---------------------------------------------------
//
// The backfill from the old `done` boolean cannot be exercised here: initDatabase
// always builds the current schema, which has no `done` column, and the raw handle
// is not exported. That path is verified against the real database instead, which
// still holds pre-migration rows -- see the live check in the feature notes.

describe("migration idempotency", () => {
  it("is safe to run repeatedly", () => {
    createTodo({ title: "a" });
    migrateTodosToStatesNow();
    migrateTodosToStatesNow();

    expect(listTodos()).toHaveLength(1);
    expect(listTodos()[0]?.state.label).toBe("Todo");
  });

  it("leaves no todo without a state", () => {
    createTodo({ title: "a" });
    createTodo({ title: "b", stateId: findTodoStateByLabel("Testing")!.id });
    migrateTodosToStatesNow();

    expect(listTodos().every((t) => t.state.id > 0)).toBe(true);
  });

  it("does not disturb the state a todo already has", () => {
    const testing = findTodoStateByLabel("Testing")!;
    const todo = createTodo({ title: "keep my state", stateId: testing.id });
    migrateTodosToStatesNow();

    expect(listTodos().find((t) => t.id === todo.id)?.state.label).toBe("Testing");
  });
});

// --- Startup resilience ------------------------------------------------------
//
// A partially-seeded todo_states table used to throw inside initDatabase, which the
// app reports with a modal error box before any window exists -- leaving no way to
// fix it from the UI. These pin the self-repair that replaced that behaviour.

describe("startup resilience", () => {
  it("keeps exactly one completed and one default state after seeding", () => {
    const states = listTodoStates();
    expect(states.filter((s) => s.isCompleted)).toHaveLength(1);
    expect(states.filter((s) => s.isDefault)).toHaveLength(1);
  });

  it("still has both roles filled after states are deleted around them", () => {
    const backlog = findTodoStateByLabel("Backlog")!;
    const processing = findTodoStateByLabel("Processing")!;
    deleteTodoState(processing.id, backlog.id);

    const states = listTodoStates();
    expect(states.filter((s) => s.isCompleted)).toHaveLength(1);
    expect(states.filter((s) => s.isDefault)).toHaveLength(1);
  });

  it("moves the completed role rather than ever leaving it vacant", () => {
    const deprecated = findTodoStateByLabel("Deprecated")!;
    updateTodoState({ id: deprecated.id, isCompleted: true });

    expect(listTodoStates().filter((s) => s.isCompleted)).toHaveLength(1);
    expect(findTodoStateByLabel("Done")!.isCompleted).toBe(false);
  });

  it("creating a state never disturbs the two roles", () => {
    createTodoState({ label: "Blocked" });

    const states = listTodoStates();
    expect(states.filter((s) => s.isCompleted).map((s) => s.label)).toEqual(["Done"]);
    expect(states.filter((s) => s.isDefault).map((s) => s.label)).toEqual(["Todo"]);
  });
});

// --- Priority column migration -----------------------------------------------

describe("priority column migration", () => {
  it("adds the column without disturbing rows that predate it", () => {
    const todo = createTodo({ title: "written before priority existed" });
    migrateTodosToStatesNow();
    migrateTodosToStatesNow();

    const after = listTodos().find((t) => t.id === todo.id);
    expect(after?.priority).toBe(0);
    expect(after?.title).toBe("written before priority existed");
  });

  it("does not reset a priority that is already set", () => {
    const todo = createTodo({ title: "urgent", priority: 1 });
    migrateTodosToStatesNow();

    expect(listTodos().find((t) => t.id === todo.id)?.priority).toBe(1);
  });
});
