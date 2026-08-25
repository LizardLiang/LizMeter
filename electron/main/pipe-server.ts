// electron/main/pipe-server.ts
// Named pipe server for external integrations.
//
// Two protocols share one pipe:
//   1. Legacy Neovim activity  -- { project, file }, fire-and-forget, no reply.
//      This shape is already installed in the user's editor and must keep working.
//   2. Typed commands          -- { id, type, ... }, replied to on the same socket
//      as { id, ok: true, result } or { id, ok: false, error }.
//
// The todo commands exist so an MCP server (a separate process) can write into the
// running app rather than opening the SQLite file behind the app's back.

import net from "node:net";
import fs from "node:fs";
import {
  clearCompletedTodos,
  createTodo,
  findTodoStateByLabel,
  insertNvimActivity,
  isDuplicateNvimActivity,
  listTodos,
  listTodoStates,
  updateTodo,
} from "./database.ts";
import { getMainWindow } from "./index.ts";
import type { TodoFilter } from "../../src/shared/types.ts";

// --- Constants ---

// LIZMETER_PIPE_PATH lets a test (or a second app instance) use another pipe.
const DEFAULT_PIPE_PATH =
  process.platform === "win32" ? "\\\\.\\pipe\\lizmeter" : "/tmp/lizmeter.sock";

const PIPE_PATH = process.env.LIZMETER_PIPE_PATH || DEFAULT_PIPE_PATH;

// Raised from the original 4 KB: a todo may carry up to 4 000 characters of notes.
const MAX_BUFFER_SIZE = 65_536;

const VALID_TODO_FILTERS = new Set<TodoFilter>(["all", "active", "done", "ai"]);

// --- Module-level singleton state ---

let pipeServer: net.Server | null = null;

// --- Renderer notification ---

/** Tells the renderer to refresh its todo list after an out-of-band write. */
function notifyTodosChanged(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("todo:changed");
  }
}

// --- Legacy Neovim payload ---

function validateNvimPayload(data: Record<string, unknown>): { project: string; file: string } | null {
  const project = data.project;
  const file = data.file;

  if (typeof project !== "string" || typeof file !== "string") return null;

  const trimmedProject = project.trim();
  const trimmedFile = file.trim();

  if (trimmedProject.length === 0 || trimmedFile.length === 0) return null;
  if (trimmedProject.length > 1000 || trimmedFile.length > 1000) return null;

  return { project: trimmedProject, file: trimmedFile };
}

function handleNvimActivity(data: Record<string, unknown>): void {
  const validated = validateNvimPayload(data);
  if (!validated) return;

  // Dedup check: skip if same (project, file) was recorded within last 60 seconds
  if (isDuplicateNvimActivity(validated.project, validated.file)) return;

  insertNvimActivity(validated.project, validated.file);
}

// --- Command dispatch ---

/**
 * Resolves a state label to its id, case-insensitively.
 *
 * State labels are user-editable, so an agent cannot be expected to know them.
 * On a miss the error enumerates the valid labels -- one round trip and the agent
 * has learned the vocabulary, without needing a separate tool to read it.
 */
function resolveStateLabel(label: unknown): number | undefined {
  if (label === undefined || label === null) return undefined;
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error("'state' must be a non-empty string");
  }
  const state = findTodoStateByLabel(label);
  if (state) return state.id;

  const valid = listTodoStates().map((s) => s.label).join(", ");
  throw new Error(`Unknown state '${label.trim()}'. Valid states: ${valid}`);
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`'${field}' must be a string or null`);
  return value;
}

function requireTodoId(data: Record<string, unknown>, command: string): number {
  // 'todoId', not 'id': 'id' is the request envelope's correlation field and
  // a payload key of the same name would silently overwrite it.
  const id = data.todoId;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new Error(`${command} requires an integer 'todoId'`);
  }
  return id;
}

function dispatchCommand(type: string, data: Record<string, unknown>): unknown {
  switch (type) {
    case "ping":
      return { pong: true };

    case "todo.states":
      return { states: listTodoStates() };

    case "todo.add": {
      const todo = createTodo({
        title: data.title as string,
        notes: optionalString(data.notes, "notes") ?? null,
        stateId: resolveStateLabel(data.state),
        project: optionalString(data.project, "project") ?? null,
        milestone: optionalString(data.milestone, "milestone") ?? null,
        startDate: optionalString(data.startDate, "startDate") ?? null,
        dueDate: optionalString(data.dueDate, "dueDate") ?? null,
        // Anything arriving over the pipe is by definition not typed by the user.
        source: "ai",
        sourceLabel: (data.agent as string | null | undefined) ?? null,
      });
      notifyTodosChanged();
      return { todo };
    }

    case "todo.update": {
      const id = requireTodoId(data, "todo.update");
      const todo = updateTodo({
        id,
        title: data.title === undefined ? undefined : (data.title as string),
        notes: optionalString(data.notes, "notes"),
        stateId: resolveStateLabel(data.state),
        project: optionalString(data.project, "project"),
        milestone: optionalString(data.milestone, "milestone"),
        startDate: optionalString(data.startDate, "startDate"),
        dueDate: optionalString(data.dueDate, "dueDate"),
      });
      notifyTodosChanged();
      return { todo };
    }

    case "todo.list": {
      const raw = data.filter;
      const filter = typeof raw === "string" && VALID_TODO_FILTERS.has(raw as TodoFilter)
        ? (raw as TodoFilter)
        : "all";
      const project = optionalString(data.project, "project") ?? undefined;
      const stateId = resolveStateLabel(data.state);
      return { todos: listTodos({ filter, project, stateId }) };
    }

    case "todo.complete": {
      const id = requireTodoId(data, "todo.complete");
      // Resolved through the is_completed flag, never a label, so renaming "Done" is safe.
      const completed = listTodoStates().find((s) => s.isCompleted);
      if (!completed) throw new Error("No state is marked as completed");
      const todo = updateTodo({ id, stateId: completed.id });
      notifyTodosChanged();
      return { todo };
    }

    case "todo.clear-completed": {
      const removed = clearCompletedTodos();
      notifyTodosChanged();
      return { removed };
    }

    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

// --- Message routing ---

/**
 * Handles one newline-delimited message and, for typed commands carrying an id,
 * hands the reply line to `reply`.
 *
 * Exported so the protocol can be tested without opening a real pipe -- the
 * hardcoded pipe path is shared with the running app.
 */
export function processLine(line: string, reply: (text: string) => void): void {
  let payload: unknown;
  try {
    payload = JSON.parse(line) as unknown;
  } catch {
    // Malformed JSON -- discard silently, matching the original behaviour.
    return;
  }

  if (typeof payload !== "object" || payload === null) return;
  const data = payload as Record<string, unknown>;

  // No 'type' field means the legacy Neovim shape.
  if (typeof data.type !== "string") {
    try {
      handleNvimActivity(data);
    } catch {
      // DB error -- silently discard, as before.
    }
    return;
  }

  const id = data.id;
  try {
    const result = dispatchCommand(data.type, data);
    if (id !== undefined) {
      reply(JSON.stringify({ id, ok: true, result }) + "\n");
    }
  } catch (err) {
    if (id !== undefined) {
      const message = err instanceof Error ? err.message : String(err);
      reply(JSON.stringify({ id, ok: false, error: message }) + "\n");
    }
  }
}

// --- Connection Handler ---

function handleConnection(socket: net.Socket): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    // Guard against oversized payloads
    if (buffer.length > MAX_BUFFER_SIZE) {
      socket.destroy();
      return;
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      processLine(trimmed, (text) => socket.write(text));
    }
  });

  socket.on("end", () => {
    // Process any remaining buffered data when the connection closes
    const trimmed = buffer.trim();
    if (!trimmed) return;
    processLine(trimmed, (text) => socket.write(text));
  });

  socket.on("error", () => {
    // Client disconnected abruptly -- ignore
  });
}

// --- Stale Socket Cleanup (Unix only) ---

function cleanupStaleSocket(): void {
  if (process.platform === "win32") return;

  try {
    fs.unlinkSync(PIPE_PATH);
  } catch {
    // File doesn't exist or can't be removed -- fine either way
  }
}

// --- Public API ---

export function startPipeServer(): void {
  if (pipeServer) {
    console.warn("[pipe] Server already running");
    return;
  }

  cleanupStaleSocket();

  pipeServer = net.createServer(handleConnection);

  pipeServer.on("error", (err) => {
    console.error("[pipe] Server error:", err);
  });

  pipeServer.listen(PIPE_PATH, () => {
    console.log(`[pipe] Listening on ${PIPE_PATH}`);
  });
}

export function destroyPipeServer(): void {
  if (!pipeServer) return;

  const server = pipeServer;
  pipeServer = null;

  // Prevent the server from keeping the process alive during shutdown
  server.unref();

  try {
    server.close(() => {
      cleanupStaleSocket();
    });
  } catch {
    // If close throws synchronously, still attempt cleanup
    cleanupStaleSocket();
  }
}
