// Tests for the named pipe protocol in pipe-server.ts
// Exercises processLine directly so no real pipe is opened -- the pipe path is
// hardcoded and shared with the running app.

import { beforeEach, describe, expect, it, vi } from "vitest";

// pipe-server imports getMainWindow from index.ts, which pulls in electron.
vi.mock("../index.ts", () => ({
  getMainWindow: () => null,
}));

import { findTodoStateByLabel, initDatabase, listNvimActivityByDate, listTodos } from "../database.ts";
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
    expect(todo.project).toBe("LizMeter");
    expect(todo.milestone).toBe("v1.14");
    expect(todo.startDate).toBe("2026-08-25");
    expect(todo.dueDate).toBe("2026-08-30");
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
    const todoId = addOne();
    send({ id: 2, type: "todo.update", todoId, project: "LizMeter" });

    const todo = listTodos()[0]!;
    expect(todo.title).toBe("original");
    expect(todo.project).toBe("LizMeter");
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
    send({ id: 1, type: "todo.add", title: "a", project: "LizMeter", state: "Testing" });
    send({ id: 2, type: "todo.add", title: "b", project: "Other" });
  });

  it("filters by project", () => {
    const reply = send({ id: 3, type: "todo.list", project: "LizMeter" });
    const result = reply?.result as { todos: Array<{ title: string; }>; };
    expect(result.todos.map((t) => t.title)).toEqual(["a"]);
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
