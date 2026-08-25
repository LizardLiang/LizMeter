#!/usr/bin/env node
// mcp/lizmeter-todo-mcp.mjs
//
// MCP stdio server exposing LizMeter's todo list to an AI agent.
//
// It does NOT touch the SQLite file. It forwards every call to the running
// LizMeter app over the same named pipe the Neovim integration uses, so the
// app's UI updates live and there is only ever one writer to the database.
//
// Zero dependencies: the MCP surface needed here is small enough to implement
// directly over JSON-RPC 2.0, which keeps it out of the Electron bundle.

import net from "node:net";
import readline from "node:readline";

// LIZMETER_PIPE_PATH lets a test (or a second app instance) point at another pipe.
const DEFAULT_PIPE_PATH = process.platform === "win32" ? "\\\\.\\pipe\\lizmeter" : "/tmp/lizmeter.sock";
const PIPE_PATH = process.env.LIZMETER_PIPE_PATH || DEFAULT_PIPE_PATH;
const REQUEST_TIMEOUT_MS = 5000;
const SERVER_NAME = "lizmeter-todo";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

// --- Pipe client ---

let requestCounter = 0;

/**
 * Sends one command to the running app and resolves with its result.
 * Opens a connection per request: the app replies on the same socket, then we close.
 */
function sendCommand(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestCounter;
    const socket = net.createConnection(PIPE_PATH);
    let buffer = "";
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error("LizMeter did not respond within " + REQUEST_TIMEOUT_MS + "ms"));
    }, REQUEST_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(JSON.stringify({ id, type, ...payload }) + "\n");
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) return;

      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        finish(reject, new Error("LizMeter sent a malformed reply"));
        return;
      }

      if (reply.ok) finish(resolve, reply.result);
      else finish(reject, new Error(reply.error ?? "Unknown error from LizMeter"));
    });

    socket.on("error", (err) => {
      const hint = err.code === "ENOENT" || err.code === "ECONNREFUSED"
        ? "LizMeter does not appear to be running. Start the app and try again."
        : "Could not reach LizMeter: " + err.message;
      finish(reject, new Error(hint));
    });

    socket.on("close", () => {
      finish(reject, new Error("LizMeter closed the connection without replying"));
    });
  });
}

// --- Tool definitions ---

const FIELD_PROPERTIES = {
  project: {
    type: "string",
    description: "Optional project name, e.g. 'LizMeter'. Free text; reuse an existing name to group todos.",
  },
  milestone: {
    type: "string",
    description: "Optional milestone name, e.g. 'v1.14'. Free text.",
  },
  startDate: {
    type: "string",
    description: "Optional start date as YYYY-MM-DD.",
  },
  dueDate: {
    type: "string",
    description: "Optional due date as YYYY-MM-DD. Must not be earlier than startDate.",
  },
  state: {
    type: "string",
    description:
      "Optional workflow state, by label (case-insensitive). Labels are user-defined and can be renamed, "
      + "so do not assume a fixed set. If you pass an unknown one the error lists every valid label. "
      + "Omit it to use the user's default state.",
  },
};

const TOOLS = [
  {
    name: "todo_add",
    description:
      "Add a todo to the user's LizMeter todo list. Use this when the user asks you to remember, "
      + "track, or note down something to do later. The todo is tagged as AI-written so the user "
      + "can tell it apart from ones they typed themselves.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The todo text. Keep it to one actionable line, 500 characters or fewer.",
        },
        notes: {
          type: "string",
          description: "Optional longer detail, context, or a link. 4000 characters or fewer.",
        },
        agent: {
          type: "string",
          description:
            "Optional short label for which agent is adding this, e.g. 'claude-code'. Shown as a badge in the UI.",
        },
        ...FIELD_PROPERTIES,
      },
      required: ["title"],
    },
  },
  {
    name: "todo_list",
    description:
      "List the user's LizMeter todos. Use this before adding a todo to avoid duplicates, when the "
      + "user asks what is on their list, or to discover which state labels exist.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "active", "done", "ai"],
          description:
            "Which todos to return. 'active' = not in a completed state, 'ai' = only ones added by an AI. "
            + "Defaults to 'all'.",
        },
        project: {
          type: "string",
          description: "Optional: only todos in this project.",
        },
        state: {
          type: "string",
          description: "Optional: only todos in this state, by label. An unknown label lists the valid ones.",
        },
      },
    },
  },
  {
    name: "todo_update",
    description:
      "Change an existing LizMeter todo: move it between states, set a due date, assign a project or "
      + "milestone, or edit its text. Only the fields you pass are changed. Get ids from todo_list.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The todo's numeric id." },
        title: { type: "string", description: "Optional new title." },
        notes: { type: "string", description: "Optional new notes. Pass an empty string to clear them." },
        ...FIELD_PROPERTIES,
      },
      required: ["id"],
    },
  },
  {
    name: "todo_complete",
    description:
      "Mark one LizMeter todo as done, by its numeric id. This moves it to whichever state the user has "
      + "marked as the completed one, so it keeps working even if they rename it. Get ids from todo_list.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The todo's numeric id." },
      },
      required: ["id"],
    },
  },
];

// --- Tool execution ---

/** Collects the optional shared fields, leaving absent ones absent so updates stay partial. */
function fieldArgs(args) {
  const out = {};
  for (const key of ["project", "milestone", "startDate", "dueDate", "state"]) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

function formatDateRange(todo) {
  if (todo.startDate && todo.dueDate) return todo.startDate + " -> " + todo.dueDate;
  if (todo.dueDate) return "due " + todo.dueDate;
  if (todo.startDate) return "from " + todo.startDate;
  return null;
}

function formatTodo(todo) {
  const box = todo.state && todo.state.isCompleted ? "[x]" : "[ ]";

  const meta = [];
  if (todo.state) meta.push(todo.state.label);
  if (todo.project) meta.push(todo.project);
  if (todo.milestone) meta.push(todo.milestone);
  const dates = formatDateRange(todo);
  if (dates) meta.push(dates);
  if (todo.source === "ai") meta.push(todo.sourceLabel ? "ai: " + todo.sourceLabel : "ai");

  const metaLine = meta.length > 0 ? "\n      " + meta.join(" | ") : "";
  const notes = todo.notes ? "\n      " + todo.notes.replace(/\n/g, "\n      ") : "";
  return box + " #" + todo.id + " " + todo.title + metaLine + notes;
}

async function callTool(name, args = {}) {
  switch (name) {
    case "todo_add": {
      if (typeof args.title !== "string" || args.title.trim().length === 0) {
        throw new Error("'title' is required and must be a non-empty string");
      }
      const result = await sendCommand("todo.add", {
        title: args.title,
        notes: args.notes ?? null,
        agent: args.agent ?? null,
        ...fieldArgs(args),
      });
      return "Added todo #" + result.todo.id + ": " + result.todo.title
        + " [" + result.todo.state.label + "]";
    }

    case "todo_list": {
      const payload = { filter: args.filter ?? "all" };
      if (args.project !== undefined) payload.project = args.project;
      if (args.state !== undefined) payload.state = args.state;
      const result = await sendCommand("todo.list", payload);
      const todos = result.todos ?? [];
      if (todos.length === 0) return "No todos match that filter.";
      return todos.map(formatTodo).join("\n");
    }

    case "todo_update": {
      if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
        throw new Error("'id' is required and must be an integer");
      }
      const payload = { todoId: args.id, ...fieldArgs(args) };
      if (args.title !== undefined) payload.title = args.title;
      if (args.notes !== undefined) payload.notes = args.notes;

      if (Object.keys(payload).length === 1) {
        throw new Error("Pass at least one field to change besides 'id'");
      }
      const result = await sendCommand("todo.update", payload);
      return "Updated todo #" + result.todo.id + ": " + result.todo.title
        + " [" + result.todo.state.label + "]";
    }

    case "todo_complete": {
      if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
        throw new Error("'id' is required and must be an integer");
      }
      const result = await sendCommand("todo.complete", { todoId: args.id });
      return "Completed todo #" + result.todo.id + ": " + result.todo.title;
    }

    default:
      throw new Error("Unknown tool: " + name);
  }
}

// --- JSON-RPC plumbing ---

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(request) {
  const { id, method, params } = request;

  // Notifications carry no id and must not be answered.
  if (id === undefined || id === null) return;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;

    case "ping":
      respond(id, {});
      return;

    case "tools/list":
      respond(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const toolName = params?.name;
      try {
        const text = await callTool(toolName, params?.arguments ?? {});
        respond(id, { content: [{ type: "text", text }] });
      } catch (err) {
        // Tool failures are reported in-band so the model can read and react to them.
        respond(id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
      return;
    }

    default:
      respondError(id, -32601, "Method not found: " + method);
  }
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }

  void handleRequest(request);
});

rl.on("close", () => {
  process.exit(0);
});
