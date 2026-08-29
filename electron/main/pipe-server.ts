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
  createTodoLabel,
  createTodoProject,
  createTodoState,
  deleteTodoLabel,
  deleteTodoProject,
  deleteTodoState,
  findTodoLabelByName,
  findTodoProjectByName,
  findTodoStateByLabel,
  insertNvimActivity,
  isDuplicateNvimActivity,
  listTodoLabels,
  listTodoProjects,
  listTodos,
  listTodoStates,
  updateTodo,
  updateTodoLabel,
  updateTodoProject,
  updateTodoState,
} from "./database.ts";
import { collectAttachmentBlobs } from "./attachment-store.ts";
import { getMainWindow } from "./index.ts";
import type { TodoFilter, TodoLabel, TodoProject, TodoState } from "../../src/shared/types.ts";

// --- Constants ---

// LIZMETER_PIPE_PATH lets a test (or a second app instance) use another pipe.
//
// In dev (VITE_DEV_SERVER_URL set), the pipe name gets a "-dev" suffix so a `bun run dev`
// instance does not steal the pipe from an already-running installed build. Production
// values below are unchanged when the env var is absent.
const IS_DEV = Boolean(process.env["VITE_DEV_SERVER_URL"]);

const DEFAULT_PIPE_PATH = IS_DEV
  ? (process.platform === "win32" ? "\\\\.\\pipe\\lizmeter-dev" : "/tmp/lizmeter-dev.sock")
  : (process.platform === "win32" ? "\\\\.\\pipe\\lizmeter" : "/tmp/lizmeter.sock");

const PIPE_PATH = process.env.LIZMETER_PIPE_PATH || DEFAULT_PIPE_PATH;

// A todo may carry up to NOTES_MAX_LENGTH (32 000) characters of markdown notes. At 64 KB a
// note that long could overflow this buffer once JSON escaping is applied and the write would
// fail silently, so the ceiling is 256 KB.
const MAX_BUFFER_SIZE = 262_144;

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

/**
 * Resolves a project name to its id, the same contract as {@link resolveStateLabel}.
 *
 * Returns `undefined` for an absent field and `null` for an explicit null, so an update can
 * distinguish "leave the project alone" from "clear it".
 *
 * Unknown names are rejected rather than created, even though `todo.project.create` exists. The
 * picker in the app creates a project by typing one, but that is a person confirming a new
 * grouping on screen; an agent typo here would quietly fragment the user's projects. Creating
 * stays a deliberate, separate call.
 */
function resolveProjectName(name: unknown): number | null | undefined {
  if (name === undefined) return undefined;
  if (name === null) return null;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("'project' must be a non-empty string or null");
  }
  const project = findTodoProjectByName(name);
  if (project) return project.id;

  const valid = listTodoProjects().map((p) => p.name).join(", ");
  throw new Error(
    valid.length > 0
      ? `Unknown project '${name.trim()}'. Valid projects: ${valid}`
      : `Unknown project '${name.trim()}'. No projects exist yet -- create one before assigning it.`,
  );
}

/** Resolves label names to ids. Unknown names are rejected, for the same reason as projects. */
function resolveLabelNames(value: unknown, field: string): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`'${field}' must be an array of label names`);

  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`'${field}' must contain non-empty strings`);
    }
    const label = findTodoLabelByName(entry);
    if (!label) {
      const valid = listTodoLabels().map((l) => l.name).join(", ");
      throw new Error(
        valid.length > 0
          ? `Unknown label '${entry.trim()}'. Valid labels: ${valid}`
          : `Unknown label '${entry.trim()}'. No labels exist yet -- create one before attaching it.`,
      );
    }
    ids.push(label.id);
  }
  return ids;
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`'${field}' must be a string or null`);
  return value;
}

/**
 * Reads an optional numeric field. Absent leaves the value alone on an update; explicit null
 * clears it. Anything else is rejected rather than coerced, so a typo cannot silently unlink.
 */
function optionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`'${field}' must be an integer or null`);
  }
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

// --- Taxonomy commands ---
//
// Projects, labels and states are the vocabulary every other todo command resolves against, so an
// agent that cannot create them is stuck the moment the user names something new. Reads stay
// permissive. Writes are blunt -- a delete rewrites every todo holding the thing -- so each one is
// keyed by name, reports what it touched, and refuses to strip todos without an explicit go-ahead.

/** Reads a required non-empty name, so a missing one fails here rather than inside the database. */
function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`'${field}' is required and must be a non-empty string`);
  }
  return value.trim();
}

/** Optional palette colour. Absent means "let the database pick its default". */
function optionalColor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("'color' must be a string");
  return value;
}

/**
 * Refuses a detaching delete that would touch todos unless the caller passed `force`.
 *
 * Deleting a project or a label silently rewrites every todo holding it and the agent cannot undo
 * that. One rejected round trip naming the count turns a mis-aimed call into a decision the agent
 * has to make twice.
 */
function requireForce(inUse: number, kind: string, name: string, force: unknown): void {
  if (inUse === 0 || force === true) return;
  const todos = inUse === 1 ? "1 todo" : `${inUse} todos`;
  throw new Error(
    `${kind} '${name}' is still on ${todos}. Deleting it removes it from ${
      inUse === 1 ? "that todo" : "those todos"
    }. Pass force: true to go ahead.`,
  );
}

/** Resolves a project for a write. On a miss the error enumerates the valid names. */
function projectByName(value: unknown): TodoProject {
  const wanted = requireName(value, "name");
  const project = findTodoProjectByName(wanted);
  if (project) return project;

  const valid = listTodoProjects().map((p) => p.name).join(", ");
  throw new Error(
    valid.length > 0
      ? `Unknown project '${wanted}'. Valid projects: ${valid}`
      : `Unknown project '${wanted}'. No projects exist yet.`,
  );
}

/** Resolves a label for a write, the same contract as {@link projectByName}. */
function labelByName(value: unknown): TodoLabel {
  const wanted = requireName(value, "name");
  const label = findTodoLabelByName(wanted);
  if (label) return label;

  const valid = listTodoLabels().map((l) => l.name).join(", ");
  throw new Error(
    valid.length > 0
      ? `Unknown label '${wanted}'. Valid labels: ${valid}`
      : `Unknown label '${wanted}'. No labels exist yet.`,
  );
}

/** Resolves a state for a write, the same contract as {@link projectByName}. */
function stateByName(value: unknown, field = "name"): TodoState {
  const wanted = requireName(value, field);
  const state = findTodoStateByLabel(wanted);
  if (state) return state;

  const valid = listTodoStates().map((s) => s.label).join(", ");
  throw new Error(`Unknown state '${wanted}'. Valid states: ${valid}`);
}

function dispatchCommand(type: string, data: Record<string, unknown>): unknown {
  switch (type) {
    case "ping":
      return { pong: true };

    case "todo.states":
      return { states: listTodoStates() };

    case "todo.projects":
      return { projects: listTodoProjects() };

    case "todo.labels":
      return { labels: listTodoLabels() };

    case "todo.add": {
      const todo = createTodo({
        title: data.title as string,
        notes: optionalString(data.notes, "notes") ?? null,
        stateId: resolveStateLabel(data.state),
        projectId: resolveProjectName(data.project) ?? null,
        labelIds: resolveLabelNames(data.labels, "labels"),
        milestone: optionalString(data.milestone, "milestone") ?? null,
        priority: optionalNumber(data.priority, "priority") ?? undefined,
        startDate: optionalString(data.startDate, "startDate") ?? null,
        dueDate: optionalString(data.dueDate, "dueDate") ?? null,
        parentId: optionalNumber(data.parentId, "parentId") ?? null,
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
        projectId: resolveProjectName(data.project),
        labelIds: resolveLabelNames(data.labels, "labels"),
        milestone: optionalString(data.milestone, "milestone"),
        priority: optionalNumber(data.priority, "priority") ?? undefined,
        startDate: optionalString(data.startDate, "startDate"),
        dueDate: optionalString(data.dueDate, "dueDate"),
        parentId: optionalNumber(data.parentId, "parentId"),
      });
      notifyTodosChanged();
      return { todo };
    }

    case "todo.list": {
      const raw = data.filter;
      const filter = typeof raw === "string" && VALID_TODO_FILTERS.has(raw as TodoFilter)
        ? (raw as TodoFilter)
        : "all";
      const projectId = resolveProjectName(data.project) ?? undefined;
      const labelIds = resolveLabelNames(data.label === undefined ? undefined : [data.label], "label");
      const stateId = resolveStateLabel(data.state);
      const parentId = optionalNumber(data.parentId, "parentId") ?? undefined;
      return { todos: listTodos({ filter, projectId, labelId: labelIds?.[0], stateId, parentId }) };
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
      const { count, deletedShas } = clearCompletedTodos();
      collectAttachmentBlobs(deletedShas);
      notifyTodosChanged();
      return { removed: count };
    }

    // Taxonomy writes. Each is keyed by name rather than id: names are what the read commands
    // hand out and what the user says out loud, and they are unique case-insensitively anyway.

    case "todo.project.create": {
      const project = createTodoProject({
        name: requireName(data.name, "name"),
        color: optionalColor(data.color),
      });
      notifyTodosChanged();
      return { project };
    }

    case "todo.project.rename": {
      const existing = projectByName(data.name);
      const project = updateTodoProject({ id: existing.id, name: requireName(data.newName, "newName") });
      notifyTodosChanged();
      return { project };
    }

    case "todo.project.delete": {
      const existing = projectByName(data.name);
      requireForce(listTodos({ projectId: existing.id }).length, "Project", existing.name, data.force);
      const detached = deleteTodoProject(existing.id);
      notifyTodosChanged();
      return { name: existing.name, detached };
    }

    case "todo.label.create": {
      const name = requireName(data.name, "name");
      // createTodoLabel is get-or-create, matching the in-app picker. Report which one happened
      // so the agent does not announce a creation that was really a no-op.
      const existing = findTodoLabelByName(name);
      const label = createTodoLabel({ name, color: optionalColor(data.color) });
      notifyTodosChanged();
      return { label, created: existing === null };
    }

    case "todo.label.rename": {
      const existing = labelByName(data.name);
      const label = updateTodoLabel({ id: existing.id, name: requireName(data.newName, "newName") });
      notifyTodosChanged();
      return { label };
    }

    case "todo.label.delete": {
      const existing = labelByName(data.name);
      requireForce(listTodos({ labelId: existing.id }).length, "Label", existing.name, data.force);
      const detached = deleteTodoLabel(existing.id);
      notifyTodosChanged();
      return { name: existing.name, detached };
    }

    case "todo.state.create": {
      // New states land non-default and non-completed. Which state new todos fall into, and which
      // one means finished, are workflow decisions the user makes in the app -- not an agent's.
      const state = createTodoState({
        label: requireName(data.name, "name"),
        color: optionalColor(data.color),
      });
      notifyTodosChanged();
      return { state };
    }

    case "todo.state.rename": {
      const existing = stateByName(data.name);
      const state = updateTodoState({ id: existing.id, label: requireName(data.newName, "newName") });
      notifyTodosChanged();
      return { state };
    }

    case "todo.state.delete": {
      const existing = stateByName(data.name);
      // No force flag here: todos are moved rather than stripped, so naming the destination is
      // the safeguard. deleteTodoState separately refuses the default and the completed state.
      if (data.reassignTo === undefined || data.reassignTo === null) {
        throw new Error(
          `Deleting state '${existing.label}' needs 'reassignTo': the state every todo sitting in it moves to.`,
        );
      }
      const target = stateByName(data.reassignTo, "reassignTo");
      const moved = deleteTodoState(existing.id, target.id);
      notifyTodosChanged();
      return { name: existing.label, reassignedTo: target.label, moved };
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
