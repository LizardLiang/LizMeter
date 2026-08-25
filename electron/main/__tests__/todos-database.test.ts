// Tests for todo CRUD functions in database.ts
// Uses in-memory database (sql.js shim via vitest alias)

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompletedTodos,
  createTodo,
  deleteTodo,
  findTodoStateByLabel,
  initDatabase,
  listTodos,
  listTodoProjects,
  listTodoMilestones,
  updateTodo,
} from "../database.ts";

const doneState = () => findTodoStateByLabel("Done")!;
const complete = (id: number) => updateTodo({ id, stateId: doneState().id });

beforeEach(() => {
  initDatabase(":memory:");
});

// --- createTodo -------------------------------------------------------------

describe("createTodo", () => {
  it("creates a todo with user defaults", () => {
    const todo = createTodo({ title: "Write the spec" });

    expect(todo.id).toBeTypeOf("number");
    expect(todo.title).toBe("Write the spec");
    expect(todo.notes).toBeNull();
    expect(todo.state.isCompleted).toBe(false);
    expect(todo.source).toBe("user");
    expect(todo.state.label).toBe("Todo");
    expect(todo.sourceLabel).toBeNull();
    expect(todo.completedAt).toBeNull();
    expect(todo.createdAt).toBeTypeOf("string");
  });

  it("trims the title", () => {
    expect(createTodo({ title: "   padded   " }).title).toBe("padded");
  });

  it("stores notes and normalises blank notes to null", () => {
    expect(createTodo({ title: "a", notes: "  detail  " }).notes).toBe("detail");
    expect(createTodo({ title: "b", notes: "   " }).notes).toBeNull();
    expect(createTodo({ title: "c", notes: null }).notes).toBeNull();
  });

  it("records an AI source with its agent label", () => {
    const todo = createTodo({ title: "From the agent", source: "ai", sourceLabel: "claude-code" });
    expect(todo.source).toBe("ai");
    expect(todo.sourceLabel).toBe("claude-code");
  });

  it("drops a source label on user todos, since only AI todos are badged", () => {
    const todo = createTodo({ title: "Mine", source: "user", sourceLabel: "claude-code" });
    expect(todo.sourceLabel).toBeNull();
  });

  it("falls back to 'user' for an unrecognised source", () => {
    const todo = createTodo({ title: "x", source: "robot" as unknown as "ai" });
    expect(todo.source).toBe("user");
    expect(todo.state.label).toBe("Todo");
  });

  it("rejects an empty or whitespace-only title", () => {
    expect(() => createTodo({ title: "" })).toThrow();
    expect(() => createTodo({ title: "   " })).toThrow();
  });

  it("rejects an over-long title", () => {
    expect(() => createTodo({ title: "x".repeat(501) })).toThrow(/500 characters or fewer/);
  });

  it("rejects over-long notes", () => {
    expect(() => createTodo({ title: "ok", notes: "x".repeat(4001) })).toThrow(/4000 characters or fewer/);
  });

  it("truncates an over-long source label rather than failing the write", () => {
    const todo = createTodo({ title: "x", source: "ai", sourceLabel: "a".repeat(200) });
    expect(todo.sourceLabel).toHaveLength(64);
  });
});

// --- listTodos --------------------------------------------------------------

describe("listTodos", () => {
  it("returns an empty array when there are none", () => {
    expect(listTodos()).toEqual([]);
  });

  it("orders open todos before completed ones", () => {
    const first = createTodo({ title: "first" });
    createTodo({ title: "second" });
    updateTodo({ id: first.id, stateId: doneState().id });

    const titles = listTodos().map((todo) => todo.title);
    expect(titles).toEqual(["second", "first"]);
  });

  it("filters to active todos", () => {
    const done = createTodo({ title: "done one" });
    createTodo({ title: "open one" });
    updateTodo({ id: done.id, stateId: doneState().id });

    expect(listTodos({ filter: "active" }).map((t) => t.title)).toEqual(["open one"]);
  });

  it("filters to completed todos", () => {
    const done = createTodo({ title: "done one" });
    createTodo({ title: "open one" });
    updateTodo({ id: done.id, stateId: doneState().id });

    expect(listTodos({ filter: "done" }).map((t) => t.title)).toEqual(["done one"]);
  });

  it("filters to AI-written todos", () => {
    createTodo({ title: "mine" });
    createTodo({ title: "theirs", source: "ai", sourceLabel: "claude-code" });

    const aiTodos = listTodos({ filter: "ai" });
    expect(aiTodos).toHaveLength(1);
    expect(aiTodos[0]?.title).toBe("theirs");
  });
});

// --- updateTodo -------------------------------------------------------------

describe("updateTodo", () => {
  it("marks a todo done and stamps completedAt", () => {
    const todo = createTodo({ title: "finish me" });
    const updated = updateTodo({ id: todo.id, stateId: doneState().id });

    expect(updated.state.isCompleted).toBe(true);
    expect(updated.completedAt).toBeTypeOf("string");
  });

  it("clears completedAt when a todo is reopened", () => {
    const todo = createTodo({ title: "reopen me" });
    updateTodo({ id: todo.id, stateId: doneState().id });
    const reopened = updateTodo({ id: todo.id, stateId: findTodoStateByLabel("Todo")!.id });

    expect(reopened.state.isCompleted).toBe(false);
    expect(reopened.completedAt).toBeNull();
  });

  it("keeps the original completedAt when editing an already-done todo", () => {
    const todo = createTodo({ title: "edit me" });
    const done = updateTodo({ id: todo.id, stateId: doneState().id });
    const edited = updateTodo({ id: todo.id, title: "edited" });

    expect(edited.title).toBe("edited");
    expect(edited.state.isCompleted).toBe(true);
    expect(edited.completedAt).toBe(done.completedAt);
  });

  it("leaves omitted fields untouched", () => {
    const todo = createTodo({ title: "keep", notes: "my notes" });
    const updated = updateTodo({ id: todo.id, stateId: doneState().id });

    expect(updated.title).toBe("keep");
    expect(updated.notes).toBe("my notes");
  });

  it("does not let an update change the source", () => {
    const todo = createTodo({ title: "ai one", source: "ai", sourceLabel: "claude-code" });
    const updated = updateTodo({ id: todo.id, title: "renamed" });

    expect(updated.source).toBe("ai");
    expect(updated.sourceLabel).toBe("claude-code");
  });

  it("throws for an unknown id", () => {
    expect(() => updateTodo({ id: 9999, stateId: doneState().id })).toThrow(/not found/);
  });

  it("rejects an invalid new title", () => {
    const todo = createTodo({ title: "valid" });
    expect(() => updateTodo({ id: todo.id, title: "  " })).toThrow();
  });
});

// --- deleteTodo -------------------------------------------------------------

describe("deleteTodo", () => {
  it("removes the todo", () => {
    const todo = createTodo({ title: "delete me" });
    deleteTodo(todo.id);
    expect(listTodos()).toEqual([]);
  });

  it("is a no-op for an unknown id", () => {
    createTodo({ title: "keep me" });
    expect(() => deleteTodo(9999)).not.toThrow();
    expect(listTodos()).toHaveLength(1);
  });
});

// --- clearCompletedTodos ----------------------------------------------------

describe("clearCompletedTodos", () => {
  it("removes only completed todos and reports the count", () => {
    const a = createTodo({ title: "a" });
    const b = createTodo({ title: "b" });
    createTodo({ title: "c" });
    updateTodo({ id: a.id, stateId: doneState().id });
    updateTodo({ id: b.id, stateId: doneState().id });

    expect(clearCompletedTodos()).toBe(2);
    expect(listTodos().map((t) => t.title)).toEqual(["c"]);
  });

  it("returns 0 when nothing is completed", () => {
    createTodo({ title: "open" });
    expect(clearCompletedTodos()).toBe(0);
  });
});

// --- New fields --------------------------------------------------------------

describe("project, milestone, and dates", () => {
  it("stores and trims them", () => {
    const todo = createTodo({
      title: "x",
      project: "  LizMeter  ",
      milestone: " v1.14 ",
      startDate: "2026-08-25",
      dueDate: "2026-08-30",
    });

    expect(todo.project).toBe("LizMeter");
    expect(todo.milestone).toBe("v1.14");
    expect(todo.startDate).toBe("2026-08-25");
    expect(todo.dueDate).toBe("2026-08-30");
  });

  it("normalises blank text fields to null", () => {
    const todo = createTodo({ title: "x", project: "   ", milestone: "" });
    expect(todo.project).toBeNull();
    expect(todo.milestone).toBeNull();
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() => createTodo({ title: "x", dueDate: "Aug 30" })).toThrow(/YYYY-MM-DD/);
  });

  it("rejects an impossible date", () => {
    expect(() => createTodo({ title: "x", dueDate: "2026-13-45" })).toThrow();
  });

  it("rejects a start date after the due date", () => {
    expect(() => createTodo({ title: "x", startDate: "2026-08-30", dueDate: "2026-08-25" }))
      .toThrow(/must not be after/);
  });

  it("rejects an over-long project name", () => {
    expect(() => createTodo({ title: "x", project: "p".repeat(121) })).toThrow(/120 characters/);
  });

  it("clears a field when null is passed to update", () => {
    const todo = createTodo({ title: "x", project: "LizMeter" });
    expect(updateTodo({ id: todo.id, project: null }).project).toBeNull();
  });
});

// --- Ordering ----------------------------------------------------------------

describe("listTodos ordering", () => {
  it("puts dated todos before undated ones, soonest first", () => {
    createTodo({ title: "undated" });
    createTodo({ title: "later", dueDate: "2026-09-10" });
    createTodo({ title: "sooner", dueDate: "2026-09-01" });

    expect(listTodos().map((t) => t.title)).toEqual(["sooner", "later", "undated"]);
  });

  it("sinks completed todos to the bottom regardless of due date", () => {
    const urgent = createTodo({ title: "urgent but done", dueDate: "2026-01-01" });
    createTodo({ title: "open" });
    complete(urgent.id);

    expect(listTodos().map((t) => t.title)).toEqual(["open", "urgent but done"]);
  });
});

// --- Filtering ---------------------------------------------------------------

describe("listTodos filtering", () => {
  it("filters by project, case-insensitively", () => {
    createTodo({ title: "a", project: "LizMeter" });
    createTodo({ title: "b", project: "Other" });

    expect(listTodos({ project: "lizmeter" }).map((t) => t.title)).toEqual(["a"]);
  });

  it("filters by state id", () => {
    const testing = findTodoStateByLabel("Testing")!;
    createTodo({ title: "a", stateId: testing.id });
    createTodo({ title: "b" });

    expect(listTodos({ stateId: testing.id }).map((t) => t.title)).toEqual(["a"]);
  });

  it("combines a filter with a project", () => {
    const done = createTodo({ title: "a", project: "LizMeter" });
    createTodo({ title: "b", project: "LizMeter" });
    complete(done.id);

    expect(listTodos({ filter: "active", project: "LizMeter" }).map((t) => t.title)).toEqual(["b"]);
  });
});

// --- Autocomplete sources ----------------------------------------------------

describe("listTodoProjects / listTodoMilestones", () => {
  it("returns distinct non-null values", () => {
    createTodo({ title: "a", project: "LizMeter", milestone: "v1.14" });
    createTodo({ title: "b", project: "LizMeter", milestone: "v1.15" });
    createTodo({ title: "c" });

    expect(listTodoProjects()).toEqual(["LizMeter"]);
    expect(listTodoMilestones()).toEqual(["v1.14", "v1.15"]);
  });

  it("returns empty arrays when nothing is set", () => {
    createTodo({ title: "a" });
    expect(listTodoProjects()).toEqual([]);
    expect(listTodoMilestones()).toEqual([]);
  });
});
