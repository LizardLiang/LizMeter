// Tests for todo_attachments CRUD in database.ts
// Uses the in-memory database (sql.js shim via the vitest alias).

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCompletedTodos,
  countAttachmentsBySha,
  createTodo,
  createTodoAttachment,
  deleteTodo,
  deleteTodoAttachment,
  findTodoStateByLabel,
  getTodoAttachment,
  initDatabase,
  listAllAttachmentShas,
  listTodoAttachments,
  updateTodo,
} from "../database.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const attach = (todoId: number, sha256: string, fileName = "shot.png") =>
  createTodoAttachment({
    todoId,
    sha256,
    fileName,
    mimeType: "image/png",
    sizeBytes: 1024,
  });

beforeEach(() => {
  initDatabase(":memory:");
});

// --- createTodoAttachment / listTodoAttachments -----------------------------

describe("createTodoAttachment", () => {
  it("inserts a row and lists it back", () => {
    const todo = createTodo({ title: "with a screenshot" });
    const created = attach(todo.id, SHA_A, "Design.PNG");

    expect(created.id).toBeTypeOf("number");
    expect(created.todoId).toBe(todo.id);
    expect(created.sha256).toBe(SHA_A);
    expect(created.fileName).toBe("Design.PNG");
    expect(created.mimeType).toBe("image/png");
    expect(created.sizeBytes).toBe(1024);
    expect(created.kind).toBe("image");
    expect(created.url).toBe(`app-media://attachments/${SHA_A}.png`);
    expect(created.createdAt).toBeTypeOf("string");

    expect(listTodoAttachments(todo.id)).toEqual([created]);
  });

  it("classifies a non-image extension as a document", () => {
    const todo = createTodo({ title: "with a pdf" });
    const created = createTodoAttachment({
      todoId: todo.id,
      sha256: SHA_B,
      fileName: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });

    expect(created.kind).toBe("file");
    expect(created.url).toBe(`app-media://attachments/${SHA_B}.pdf`);
  });

  it("is a no-op when the same file is attached to the same todo twice", () => {
    const todo = createTodo({ title: "double paste" });
    const first = attach(todo.id, SHA_A);
    const second = attach(todo.id, SHA_A, "a-different-display-name.png");

    expect(second.id).toBe(first.id);
    expect(second.fileName).toBe("shot.png"); // the original row wins
    expect(listTodoAttachments(todo.id)).toHaveLength(1);
    expect(countAttachmentsBySha(SHA_A)).toBe(1);
  });

  it("lets two todos share one blob", () => {
    const one = createTodo({ title: "one" });
    const two = createTodo({ title: "two" });
    attach(one.id, SHA_A);
    attach(two.id, SHA_A);

    expect(listTodoAttachments(one.id)).toHaveLength(1);
    expect(listTodoAttachments(two.id)).toHaveLength(1);
    expect(countAttachmentsBySha(SHA_A)).toBe(2);
    expect(listAllAttachmentShas()).toEqual([SHA_A]);
  });

  it("rejects an unknown todo id", () => {
    expect(() => attach(9999, SHA_A)).toThrow(/todo/i);
  });
});

// --- getTodoAttachment ------------------------------------------------------

describe("getTodoAttachment", () => {
  it("returns the row by id", () => {
    const todo = createTodo({ title: "get me" });
    const created = attach(todo.id, SHA_A);

    expect(getTodoAttachment(created.id)).toEqual(created);
  });

  it("returns null for an unknown id", () => {
    expect(getTodoAttachment(9999)).toBeNull();
  });
});

// --- deleteTodoAttachment ---------------------------------------------------

describe("deleteTodoAttachment", () => {
  it("removes the row and hands back what it deleted", () => {
    const todo = createTodo({ title: "remove me" });
    const created = attach(todo.id, SHA_A);

    expect(deleteTodoAttachment(created.id)).toEqual(created);
    expect(listTodoAttachments(todo.id)).toEqual([]);
    expect(countAttachmentsBySha(SHA_A)).toBe(0);
  });

  it("returns null for an unknown id", () => {
    expect(deleteTodoAttachment(9999)).toBeNull();
  });
});

// --- countAttachmentsBySha (the refcount that guards a shared blob) ---------

describe("countAttachmentsBySha", () => {
  it("reaches 0 only after the last row referencing the sha is gone", () => {
    const one = createTodo({ title: "one" });
    const two = createTodo({ title: "two" });
    const a = attach(one.id, SHA_A);
    const b = attach(two.id, SHA_A);

    expect(countAttachmentsBySha(SHA_A)).toBe(2);

    deleteTodoAttachment(a.id);
    expect(countAttachmentsBySha(SHA_A)).toBe(1);

    deleteTodoAttachment(b.id);
    expect(countAttachmentsBySha(SHA_A)).toBe(0);
  });

  it("is 0 for a sha that was never stored", () => {
    expect(countAttachmentsBySha(SHA_B)).toBe(0);
  });
});

// --- deleteTodo -------------------------------------------------------------

describe("deleteTodo with attachments", () => {
  it("removes the attachment rows and returns their shas", () => {
    const todo = createTodo({ title: "doomed" });
    attach(todo.id, SHA_A);
    attach(todo.id, SHA_B, "spec.pdf");

    const shas = deleteTodo(todo.id);

    expect(shas.slice().sort()).toEqual([SHA_A, SHA_B]);
    expect(listTodoAttachments(todo.id)).toEqual([]);
    expect(listAllAttachmentShas()).toEqual([]);
  });

  it("returns an empty list for a todo with no attachments", () => {
    const todo = createTodo({ title: "plain" });
    expect(deleteTodo(todo.id)).toEqual([]);
  });

  it("leaves a shared blob referenced by the surviving todo", () => {
    const doomed = createTodo({ title: "doomed" });
    const keeper = createTodo({ title: "keeper" });
    attach(doomed.id, SHA_A);
    attach(keeper.id, SHA_A);

    expect(deleteTodo(doomed.id)).toEqual([SHA_A]);
    // The sha comes back so the caller can *ask*; the refcount is what says no.
    expect(countAttachmentsBySha(SHA_A)).toBe(1);
  });

  it("does not take a child todo's attachments with it", () => {
    const parent = createTodo({ title: "parent" });
    const child = createTodo({ title: "child", parentId: parent.id });
    attach(parent.id, SHA_A);
    attach(child.id, SHA_B, "spec.pdf");

    expect(deleteTodo(parent.id)).toEqual([SHA_A]);
    expect(listTodoAttachments(child.id)).toHaveLength(1);
  });
});

// --- clearCompletedTodos ----------------------------------------------------

describe("clearCompletedTodos with attachments", () => {
  it("reports the count and every sha it swept", () => {
    const done = findTodoStateByLabel("Done")!;
    const a = createTodo({ title: "a" });
    const b = createTodo({ title: "b" });
    const open = createTodo({ title: "still open" });
    attach(a.id, SHA_A);
    attach(b.id, SHA_B, "spec.pdf");
    attach(open.id, SHA_A);
    updateTodo({ id: a.id, stateId: done.id });
    updateTodo({ id: b.id, stateId: done.id });

    const result = clearCompletedTodos();

    expect(result.count).toBe(2);
    expect(result.deletedShas.slice().sort()).toEqual([SHA_A, SHA_B]);
    // SHA_A still has a live reference on the open todo.
    expect(countAttachmentsBySha(SHA_A)).toBe(1);
    expect(countAttachmentsBySha(SHA_B)).toBe(0);
  });

  it("returns an empty sha list when nothing is completed", () => {
    createTodo({ title: "open" });
    expect(clearCompletedTodos()).toEqual({ count: 0, deletedShas: [] });
  });
});
