// Tests for the named pipe protocol in pipe-server.ts
// Exercises processLine directly so no real pipe is opened -- the pipe path is
// hardcoded and shared with the running app.

import { beforeEach, describe, expect, it, vi } from "vitest";

// pipe-server imports getMainWindow from index.ts, which pulls in electron.
vi.mock("../index.ts", () => ({
  getMainWindow: () => null,
}));

import {
  createTodoLabel,
  createTodoProject,
  findTodoStateByLabel,
  initDatabase,
  listNvimActivityByDate,
  listTodoLabels,
  listTodoProjects,
  listTodos,
  listTodoStates,
} from "../database.ts";
import { processLine } from "../pipe-server.ts";

/** Runs one line through the protocol and returns the parsed reply, if any. */
function send(message: unknown): Record<string, unknown> | null {
  const replies: string[] = [];
  processLine(JSON.stringify(message), (text) => replies.push(text));
  if (replies.length === 0) return null;
  return JSON.parse(replies[0]!) as Record<string, unknown>;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  initDatabase(":memory:");
});

// --- Legacy Neovim payloads ------------------------------------------------

describe("legacy Neovim payloads", () => {
  it("records activity and sends no reply", () => {
    const reply = send({ project: "LizMeter", file: "src/app.ts" });

    expect(reply).toBeNull();
    expect(listNvimActivityByDate(today()).records).toHaveLength(1);
  });

  it("still ignores an invalid legacy payload without replying", () => {
    expect(send({ project: "", file: "" })).toBeNull();
    expect(listNvimActivityByDate(today()).records).toHaveLength(0);
  });

  it("does not treat a legacy payload as a command", () => {
    send({ project: "LizMeter", file: "src/app.ts" });
    expect(listTodos()).toHaveLength(0);
  });
});

// --- Malformed input --------------------------------------------------------

describe("malformed input", () => {
  it("discards invalid JSON silently", () => {
    const replies: string[] = [];
    expect(() => processLine("{not json", (t) => replies.push(t))).not.toThrow();
    expect(replies).toHaveLength(0);
  });

  it("discards a JSON scalar silently", () => {
    const replies: string[] = [];
    processLine("42", (t) => replies.push(t));
    expect(replies).toHaveLength(0);
  });

  it("discards null silently", () => {
    const replies: string[] = [];
    processLine("null", (t) => replies.push(t));
    expect(replies).toHaveLength(0);
  });
});

// --- Reply framing ----------------------------------------------------------

describe("reply framing", () => {
  it("echoes the request id", () => {
    const reply = send({ id: 77, type: "ping" });
    expect(reply).toMatchObject({ id: 77, ok: true });
  });

  it("sends no reply for a command without an id", () => {
    expect(send({ type: "ping" })).toBeNull();
  });

  it("terminates the reply with a newline", () => {
    const replies: string[] = [];
    processLine(JSON.stringify({ id: 1, type: "ping" }), (t) => replies.push(t));
    expect(replies[0]!.endsWith("\n")).toBe(true);
  });

  it("reports an unknown command as a failed reply, not a throw", () => {
    const reply = send({ id: 2, type: "todo.explode" });
    expect(reply).toMatchObject({ id: 2, ok: false });
    expect(String(reply?.error)).toMatch(/Unknown command type/);
  });
});

// --- todo.add ---------------------------------------------------------------

describe("todo.add", () => {
  it("creates a todo and returns it", () => {
    const reply = send({ id: 1, type: "todo.add", title: "From the agent" });

    expect(reply?.ok).toBe(true);
    const result = reply?.result as { todo: { id: number; title: string; }; };
    expect(result.todo.title).toBe("From the agent");
    expect(listTodos()).toHaveLength(1);
  });

  it("always tags a piped todo as AI-written", () => {
    send({ id: 1, type: "todo.add", title: "x" });
    expect(listTodos()[0]?.source).toBe("ai");
  });

  it("records the agent label", () => {
    send({ id: 1, type: "todo.add", title: "x", agent: "claude-code" });
    expect(listTodos()[0]?.sourceLabel).toBe("claude-code");
  });

  it("stores notes", () => {
    send({ id: 1, type: "todo.add", title: "x", notes: "some detail" });
    expect(listTodos()[0]?.notes).toBe("some detail");
  });

  it("returns a failed reply for a missing title rather than writing", () => {
    const reply = send({ id: 1, type: "todo.add" });
    expect(reply?.ok).toBe(false);
    expect(listTodos()).toHaveLength(0);
  });
});

// --- todo.list --------------------------------------------------------------

describe("todo.list", () => {
  it("returns every todo by default", () => {
    send({ id: 1, type: "todo.add", title: "a" });
    send({ id: 2, type: "todo.add", title: "b" });

    const reply = send({ id: 3, type: "todo.list" });
    const result = reply?.result as { todos: unknown[]; };
    expect(result.todos).toHaveLength(2);
  });

  it("honours a valid filter", () => {
    send({ id: 1, type: "todo.add", title: "a" });
    const added = send({ id: 2, type: "todo.add", title: "b" });
    const id = (added?.result as { todo: { id: number; }; }).todo.id;
    send({ id: 3, type: "todo.complete", todoId: id });

    const reply = send({ id: 4, type: "todo.list", filter: "active" });
    const result = reply?.result as { todos: Array<{ title: string; }>; };
    expect(result.todos.map((t) => t.title)).toEqual(["a"]);
  });

  it("falls back to 'all' for an unrecognised filter", () => {
    send({ id: 1, type: "todo.add", title: "a" });

    const reply = send({ id: 2, type: "todo.list", filter: "bogus" });
    expect(reply?.ok).toBe(true);
    const result = reply?.result as { todos: unknown[]; };
    expect(result.todos).toHaveLength(1);
  });
});

// --- todo.complete ----------------------------------------------------------

describe("todo.complete", () => {
  it("marks the todo done", () => {
    const added = send({ id: 1, type: "todo.add", title: "finish me" });
    const id = (added?.result as { todo: { id: number; }; }).todo.id;

    const reply = send({ id: 2, type: "todo.complete", todoId: id });
    expect(reply?.ok).toBe(true);
    expect(listTodos()[0]?.state.isCompleted).toBe(true);
  });

  it("rejects a non-integer id", () => {
    const reply = send({ id: 1, type: "todo.complete", todoId: "abc" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/integer 'todoId'/);
  });

  it("reports an unknown id as a failed reply", () => {
    const reply = send({ id: 1, type: "todo.complete", todoId: 9999 });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/not found/);
  });
});

// --- todo.clear-completed ---------------------------------------------------

describe("todo.clear-completed", () => {
  it("removes completed todos and reports the count", () => {
    const added = send({ id: 1, type: "todo.add", title: "a" });
    send({ id: 2, type: "todo.add", title: "b" });
    const id = (added?.result as { todo: { id: number; }; }).todo.id;
    send({ id: 3, type: "todo.complete", todoId: id });

    const reply = send({ id: 4, type: "todo.clear-completed" });
    expect(reply?.result).toMatchObject({ removed: 1 });
    expect(listTodos()).toHaveLength(1);
  });
});

// --- New fields over the pipe ------------------------------------------------

describe("todo.add with the extended fields", () => {
  it("stores project, milestone, and dates", () => {
    createTodoProject({ name: "LizMeter" });
    send({
      id: 1,
      type: "todo.add",
      title: "x",
      project: "LizMeter",
      milestone: "v1.14",
      startDate: "2026-08-25",
      dueDate: "2026-08-30",
    });

    const todo = listTodos()[0]!;
    expect(todo.project?.name).toBe("LizMeter");
    expect(todo.milestone).toBe("v1.14");
    expect(todo.startDate).toBe("2026-08-25");
    expect(todo.dueDate).toBe("2026-08-30");
  });

  it("resolves a project by name, case-insensitively", () => {
    createTodoProject({ name: "LizMeter" });
    send({ id: 1, type: "todo.add", title: "x", project: "lizmeter" });

    expect(listTodos()[0]?.project?.name).toBe("LizMeter");
  });

  it("rejects an unknown project with the valid list", () => {
    createTodoProject({ name: "LizMeter" });
    const reply = send({ id: 1, type: "todo.add", title: "x", project: "Nope" });

    // Agents cannot invent a project the way the in-app picker can, so the error has to
    // teach the vocabulary in one round trip.
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid projects: LizMeter/);
  });

  it("says so when no projects exist at all", () => {
    const reply = send({ id: 1, type: "todo.add", title: "x", project: "Nope" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/No projects exist yet/);
  });

  it("attaches labels by name", () => {
    createTodoLabel({ name: "bug" });
    createTodoLabel({ name: "ui" });
    send({ id: 1, type: "todo.add", title: "x", labels: ["ui", "BUG"] });

    expect(listTodos()[0]?.labels.map((l) => l.name)).toEqual(["bug", "ui"]);
  });

  it("rejects an unknown label with the valid list", () => {
    createTodoLabel({ name: "bug" });
    const reply = send({ id: 1, type: "todo.add", title: "x", labels: ["nope"] });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid labels: bug/);
  });

  it("accepts a state by label, case-insensitively", () => {
    send({ id: 1, type: "todo.add", title: "x", state: "processing" });
    expect(listTodos()[0]?.state.label).toBe("Processing");
  });

  it("lands in the default state when no state is given", () => {
    send({ id: 1, type: "todo.add", title: "x" });
    expect(listTodos()[0]?.state.label).toBe("Todo");
  });

  it("lists the valid labels when the state is unknown", () => {
    const reply = send({ id: 1, type: "todo.add", title: "x", state: "inprogress" });

    expect(reply?.ok).toBe(false);
    const message = String(reply?.error);
    expect(message).toMatch(/Unknown state 'inprogress'/);
    expect(message).toMatch(/Backlog/);
    expect(message).toMatch(/Deprecated/);
    expect(listTodos()).toHaveLength(0);
  });

  it("rejects a malformed date", () => {
    const reply = send({ id: 1, type: "todo.add", title: "x", dueDate: "30-08-2026" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/YYYY-MM-DD/);
  });

  it("rejects a start date after the due date", () => {
    const reply = send({
      id: 1,
      type: "todo.add",
      title: "x",
      startDate: "2026-08-30",
      dueDate: "2026-08-25",
    });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/must not be after/);
  });
});

// --- todo.update -------------------------------------------------------------

describe("todo.update", () => {
  function addOne(): number {
    const added = send({ id: 1, type: "todo.add", title: "original" });
    return (added?.result as { todo: { id: number; }; }).todo.id;
  }

  it("moves a todo between states by label", () => {
    const todoId = addOne();
    const reply = send({ id: 2, type: "todo.update", todoId, state: "Testing" });

    expect(reply?.ok).toBe(true);
    expect(listTodos()[0]?.state.label).toBe("Testing");
  });

  it("changes only the fields passed", () => {
    createTodoProject({ name: "LizMeter" });
    const todoId = addOne();
    send({ id: 2, type: "todo.update", todoId, project: "LizMeter" });

    const todo = listTodos()[0]!;
    expect(todo.title).toBe("original");
    expect(todo.project?.name).toBe("LizMeter");
  });

  it("clears the project when null is passed", () => {
    const project = createTodoProject({ name: "LizMeter" });
    const todoId = addOne();
    send({ id: 2, type: "todo.update", todoId, project: project.name });
    send({ id: 3, type: "todo.update", todoId, project: null });

    expect(listTodos()[0]?.project).toBeNull();
  });

  it("replaces the whole label set", () => {
    const bug = createTodoLabel({ name: "bug" });
    createTodoLabel({ name: "ui" });
    const todoId = addOne();
    send({ id: 2, type: "todo.update", todoId, labels: [bug.name] });
    send({ id: 3, type: "todo.update", todoId, labels: ["ui"] });

    expect(listTodos()[0]?.labels.map((l) => l.name)).toEqual(["ui"]);
  });

  it("stamps completedAt when moved into the completed state", () => {
    const todoId = addOne();
    send({ id: 2, type: "todo.update", todoId, state: "Done" });

    const todo = listTodos()[0]!;
    expect(todo.state.isCompleted).toBe(true);
    expect(todo.completedAt).toBeTypeOf("string");
  });

  it("clears completedAt when moved back out", () => {
    const todoId = addOne();
    send({ id: 2, type: "todo.update", todoId, state: "Done" });
    send({ id: 3, type: "todo.update", todoId, state: "Todo" });

    expect(listTodos()[0]?.completedAt).toBeNull();
  });

  it("requires an integer todoId", () => {
    const reply = send({ id: 1, type: "todo.update", todoId: "abc", title: "x" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/integer 'todoId'/);
  });

  it("reports an unknown todo", () => {
    const reply = send({ id: 1, type: "todo.update", todoId: 9999, title: "x" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/not found/);
  });
});

// --- Filters -----------------------------------------------------------------

describe("todo.list filters", () => {
  beforeEach(() => {
    createTodoProject({ name: "LizMeter" });
    createTodoProject({ name: "Other" });
    createTodoLabel({ name: "bug" });
    send({ id: 1, type: "todo.add", title: "a", project: "LizMeter", state: "Testing", labels: ["bug"] });
    send({ id: 2, type: "todo.add", title: "b", project: "Other" });
  });

  it("filters by project", () => {
    const reply = send({ id: 3, type: "todo.list", project: "LizMeter" });
    const result = reply?.result as { todos: Array<{ title: string; }>; };
    expect(result.todos.map((t) => t.title)).toEqual(["a"]);
  });

  it("filters by label", () => {
    const reply = send({ id: 3, type: "todo.list", label: "bug" });
    const result = reply?.result as { todos: Array<{ title: string; }>; };
    expect(result.todos.map((t) => t.title)).toEqual(["a"]);
  });

  it("rejects an unknown project filter with the valid list", () => {
    const reply = send({ id: 3, type: "todo.list", project: "nope" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid projects:/);
  });

  it("filters by state label", () => {
    const reply = send({ id: 3, type: "todo.list", state: "Testing" });
    const result = reply?.result as { todos: Array<{ title: string; }>; };
    expect(result.todos.map((t) => t.title)).toEqual(["a"]);
  });

  it("rejects an unknown state filter with the valid list", () => {
    const reply = send({ id: 3, type: "todo.list", state: "nope" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid states:/);
  });
});

// --- todo.complete survives a rename -----------------------------------------

describe("todo.complete after renaming the completed state", () => {
  it("still resolves, because it keys off the flag not the label", () => {
    const added = send({ id: 1, type: "todo.add", title: "finish me" });
    const todoId = (added?.result as { todo: { id: number; }; }).todo.id;

    // Rename "Done" to something else entirely.
    const done = findTodoStateByLabel("Done")!;
    send({ id: 2, type: "todo.update", todoId, state: done.label });

    const reply = send({ id: 3, type: "todo.complete", todoId });
    expect(reply?.ok).toBe(true);
    expect(listTodos()[0]?.state.isCompleted).toBe(true);
  });
});

// --- Taxonomy: projects ------------------------------------------------------

/** Adds a todo through the pipe and returns its id, so a taxonomy test can check what moved. */
function addTodo(fields: Record<string, unknown>): number {
  const reply = send({ id: 99, type: "todo.add", title: "x", ...fields });
  return (reply?.result as { todo: { id: number; }; }).todo.id;
}

describe("todo.project.create", () => {
  it("creates a project the agent can then assign", () => {
    const reply = send({ id: 1, type: "todo.project.create", name: "LizMeter" });

    expect(reply?.ok).toBe(true);
    expect(listTodoProjects().map((p) => p.name)).toEqual(["LizMeter"]);
    expect(send({ id: 2, type: "todo.add", title: "x", project: "lizmeter" })?.ok).toBe(true);
  });

  it("rejects a duplicate name rather than making a second row", () => {
    createTodoProject({ name: "LizMeter" });
    const reply = send({ id: 1, type: "todo.project.create", name: "lizmeter" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/already exists/);
    expect(listTodoProjects()).toHaveLength(1);
  });

  it("requires a name", () => {
    const reply = send({ id: 1, type: "todo.project.create", name: "  " });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/'name' is required/);
  });

  it("rejects a colour outside the palette", () => {
    const reply = send({ id: 1, type: "todo.project.create", name: "LizMeter", color: "#123456" });
    expect(reply?.ok).toBe(false);
    expect(listTodoProjects()).toHaveLength(0);
  });
});

describe("todo.project.rename", () => {
  it("reaches every todo already in the project, because they hold an id not a name", () => {
    createTodoProject({ name: "Old" });
    addTodo({ project: "Old" });

    const reply = send({ id: 1, type: "todo.project.rename", name: "old", newName: "New" });

    expect(reply?.ok).toBe(true);
    expect(listTodos()[0]?.project?.name).toBe("New");
  });

  it("lists the valid projects when the old name is unknown", () => {
    createTodoProject({ name: "LizMeter" });
    const reply = send({ id: 1, type: "todo.project.rename", name: "Nope", newName: "New" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid projects: LizMeter/);
  });

  it("requires a newName", () => {
    createTodoProject({ name: "LizMeter" });
    const reply = send({ id: 1, type: "todo.project.rename", name: "LizMeter" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/'newName' is required/);
  });
});

describe("todo.project.delete", () => {
  it("refuses a project still on todos and says how many", () => {
    createTodoProject({ name: "LizMeter" });
    addTodo({ project: "LizMeter" });
    addTodo({ project: "LizMeter" });

    const reply = send({ id: 1, type: "todo.project.delete", name: "LizMeter" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/still on 2 todos/);
    expect(listTodoProjects()).toHaveLength(1);
  });

  it("goes ahead with force and reports what it detached", () => {
    createTodoProject({ name: "LizMeter" });
    addTodo({ project: "LizMeter" });

    const reply = send({ id: 1, type: "todo.project.delete", name: "LizMeter", force: true });

    expect(reply?.result).toEqual({ name: "LizMeter", detached: 1 });
    expect(listTodoProjects()).toHaveLength(0);
    // The todo survives the delete -- it only loses the grouping.
    expect(listTodos()).toHaveLength(1);
    expect(listTodos()[0]?.project).toBeNull();
  });

  it("needs no force when nothing is using it", () => {
    createTodoProject({ name: "Unused" });
    const reply = send({ id: 1, type: "todo.project.delete", name: "Unused" });

    expect(reply?.result).toEqual({ name: "Unused", detached: 0 });
    expect(listTodoProjects()).toHaveLength(0);
  });
});

// --- Taxonomy: labels --------------------------------------------------------

describe("todo.label.create", () => {
  it("creates a label and flags it as new", () => {
    const reply = send({ id: 1, type: "todo.label.create", name: "bug" });

    expect((reply?.result as { created: boolean; }).created).toBe(true);
    expect(listTodoLabels().map((l) => l.name)).toEqual(["bug"]);
  });

  it("reports an existing label as not created, matching the in-app picker", () => {
    createTodoLabel({ name: "bug" });
    const reply = send({ id: 1, type: "todo.label.create", name: "BUG" });

    expect(reply?.ok).toBe(true);
    expect((reply?.result as { created: boolean; }).created).toBe(false);
    expect(listTodoLabels()).toHaveLength(1);
  });
});

describe("todo.label.rename", () => {
  it("renames the label on every todo carrying it", () => {
    createTodoLabel({ name: "bug" });
    addTodo({ labels: ["bug"] });

    const reply = send({ id: 1, type: "todo.label.rename", name: "bug", newName: "defect" });

    expect(reply?.ok).toBe(true);
    expect(listTodos()[0]?.labels.map((l) => l.name)).toEqual(["defect"]);
  });

  it("lists the valid labels when the old name is unknown", () => {
    createTodoLabel({ name: "bug" });
    const reply = send({ id: 1, type: "todo.label.rename", name: "nope", newName: "defect" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid labels: bug/);
  });
});

describe("todo.label.delete", () => {
  it("refuses a label still on a todo and says how many", () => {
    createTodoLabel({ name: "bug" });
    addTodo({ labels: ["bug"] });

    const reply = send({ id: 1, type: "todo.label.delete", name: "bug" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/still on 1 todo\./);
    expect(listTodoLabels()).toHaveLength(1);
  });

  it("detaches and deletes with force", () => {
    createTodoLabel({ name: "bug" });
    addTodo({ labels: ["bug"] });

    const reply = send({ id: 1, type: "todo.label.delete", name: "bug", force: true });

    expect(reply?.result).toEqual({ name: "bug", detached: 1 });
    expect(listTodoLabels()).toHaveLength(0);
    expect(listTodos()[0]?.labels).toEqual([]);
  });
});

// --- Taxonomy: states --------------------------------------------------------

describe("todo.state.create", () => {
  it("creates an ordinary stage, neither the default nor the completed one", () => {
    const reply = send({ id: 1, type: "todo.state.create", name: "Blocked" });

    expect(reply?.ok).toBe(true);
    const created = listTodoStates().find((s) => s.label === "Blocked");
    expect(created?.isDefault).toBe(false);
    expect(created?.isCompleted).toBe(false);
    // The default is untouched, so new todos still land where they did before.
    expect(listTodoStates().find((s) => s.isDefault)?.label).toBe("Todo");
  });

  it("rejects a duplicate label", () => {
    const reply = send({ id: 1, type: "todo.state.create", name: "todo" });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/already exists/);
  });
});

describe("todo.state.rename", () => {
  it("renames the state without disturbing its flags", () => {
    const reply = send({ id: 1, type: "todo.state.rename", name: "Done", newName: "Shipped" });

    expect(reply?.ok).toBe(true);
    const renamed = listTodoStates().find((s) => s.label === "Shipped");
    expect(renamed?.isCompleted).toBe(true);
  });

  it("lists the valid states when the old label is unknown", () => {
    const reply = send({ id: 1, type: "todo.state.rename", name: "Nope", newName: "Shipped" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Valid states: /);
  });
});

describe("todo.state.delete", () => {
  it("needs a reassignTo, because todos are never deleted as a side effect", () => {
    const reply = send({ id: 1, type: "todo.state.delete", name: "Backlog" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/needs 'reassignTo'/);
    expect(listTodoStates().some((s) => s.label === "Backlog")).toBe(true);
  });

  it("moves every todo in the state to the target and reports the count", () => {
    addTodo({ state: "Backlog" });
    addTodo({ state: "Backlog" });

    const reply = send({ id: 1, type: "todo.state.delete", name: "backlog", reassignTo: "processing" });

    expect(reply?.result).toEqual({ name: "Backlog", reassignedTo: "Processing", moved: 2 });
    expect(listTodoStates().some((s) => s.label === "Backlog")).toBe(false);
    expect(listTodos().every((t) => t.state.label === "Processing")).toBe(true);
  });

  it("refuses the default state, which new todos depend on", () => {
    const reply = send({ id: 1, type: "todo.state.delete", name: "Todo", reassignTo: "Backlog" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/default/);
  });

  it("refuses the completed state, which todo.complete depends on", () => {
    const reply = send({ id: 1, type: "todo.state.delete", name: "Done", reassignTo: "Backlog" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/completed/);
  });

  it("lists the valid states when reassignTo is unknown", () => {
    const reply = send({ id: 1, type: "todo.state.delete", name: "Backlog", reassignTo: "Nope" });

    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toMatch(/Unknown state 'Nope'/);
    expect(listTodoStates().some((s) => s.label === "Backlog")).toBe(true);
  });
});
