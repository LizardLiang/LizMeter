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
const SERVER_VERSION = "1.1.0";
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
    description:
      "Optional project name, e.g. 'LizMeter' (case-insensitive). Projects are user-defined rows, not "
      + "free text: an unknown name is rejected here and the error lists every valid one. Call "
      + "todo_projects to see them, or todo_projects with action 'create' to add the one you need "
      + "first. Pass null to clear the project.",
  },
  labels: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional label names, e.g. ['bug', 'ui'] (case-insensitive). Like projects these must already "
      + "exist -- an unknown name is rejected here and the error lists the valid ones. Call todo_labels "
      + "to see them, or todo_labels with action 'create' to add the one you need first. On "
      + "todo_update this REPLACES the whole set, so pass every label the todo should end up with, and "
      + "[] to remove them all.",
  },
  milestone: {
    type: "string",
    description: "Optional milestone name, e.g. 'v1.14'. Free text.",
  },
  priority: {
    type: "number",
    description:
      "Optional priority: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low. Note that 0 means "
      + "unset rather than lowest, and 4 is the lowest. Omit it unless the user signalled urgency.",
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
      + "so do not assume a fixed set -- call todo_states to see them. If you pass an unknown one the "
      + "error lists every valid label. Omit it to use the user's default state.",
  },
  parentId: {
    type: ["number", "null"],
    description:
      "Optional numeric id of the todo this one nests under, making it a sub-issue. Get ids from "
      + "todo_list. Nesting has no depth limit, but a todo cannot be placed inside its own subtree. "
      + "Pass null to lift it back to the top level. Completing or deleting a parent leaves its "
      + "children untouched, so break work down freely.",
  },
};

/**
 * Builds the shared input schema for the three taxonomy tools (projects, labels, states).
 *
 * They are one shape on purpose: no arguments lists, an action changes the set. An agent that has
 * learned one has learned all three, and the tool list stays at seven entries instead of fifteen.
 */
function taxonomySchema(noun, extra = {}) {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "rename", "delete"],
        description: "What to do. Defaults to 'list', which is also what passing no arguments gives you.",
      },
      name: {
        type: "string",
        description: "The " + noun + "'s name, matched case-insensitively. Required for create, rename, and delete.",
      },
      newName: {
        type: "string",
        description: "The new name. Required for rename. Renaming reaches every todo at once, since todos "
          + "point at the " + noun + " by id rather than holding a copy of its name.",
      },
      color: {
        type: "string",
        description:
          "Optional hex colour for create, e.g. '#7aa2f7'. It must come from LizMeter's palette -- an "
          + "unknown value is rejected and the error lists the valid ones. Omit it to take the default.",
      },
      ...extra,
    },
  };
}

const TOOLS = [
  {
    name: "todo_add",
    description:
      "Add a todo to the user's LizMeter todo list. Use this when the user asks you to remember, "
      + "track, or note down something to do later. The todo is tagged as AI-written so the user "
      + "can tell it apart from ones they typed themselves. Pass parentId to file it as a sub-issue "
      + "of an existing todo, which is how you break a large task into steps.",
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
          description: "Optional: only todos in this project, by name. An unknown name lists the valid ones.",
        },
        label: {
          type: "string",
          description: "Optional: only todos carrying this label, by name. An unknown name lists the valid ones.",
        },
        state: {
          type: "string",
          description: "Optional: only todos in this state, by label. An unknown label lists the valid ones.",
        },
        parentId: {
          type: "number",
          description: "Optional: only the direct sub-issues of this todo id.",
        },
      },
    },
  },
  {
    name: "todo_update",
    description:
      "Change an existing LizMeter todo: move it between states, set a due date or priority, assign a "
      + "project or milestone, re-file it under a different parent, or edit its text. Only the fields "
      + "you pass are changed. Get ids from todo_list.",
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
    name: "todo_projects",
    description:
      "List, create, rename, or delete the projects defined in LizMeter. Call it with no arguments "
      + "to list them, which you should do before assigning a project with todo_add or todo_update: "
      + "those reject an unknown name rather than creating it. Use action 'create' when the user "
      + "names a project that does not exist yet. Deleting a project never deletes its todos -- they "
      + "only lose the grouping -- but you must pass force: true if any still hold it.",
    inputSchema: taxonomySchema("project", {
      force: {
        type: "boolean",
        description:
          "Pass true to delete a project that is still on todos. Without it the delete is refused "
          + "and the error tells you how many todos would be affected.",
      },
    }),
  },
  {
    name: "todo_labels",
    description:
      "List, create, rename, or delete the labels defined in LizMeter. Call it with no arguments to "
      + "list them, which you should do before attaching labels with todo_add or todo_update: those "
      + "reject an unknown name rather than creating it. Creating a label that already exists is a "
      + "no-op and says so. Deleting a label detaches it from every todo that carried it, so you "
      + "must pass force: true if any still do.",
    inputSchema: taxonomySchema("label", {
      force: {
        type: "boolean",
        description:
          "Pass true to delete a label that is still on todos. Without it the delete is refused and "
          + "the error tells you how many todos would be affected.",
      },
    }),
  },
  {
    name: "todo_states",
    description:
      "List, create, rename, or delete LizMeter's workflow states -- the stages a todo moves "
      + "through. Call it with no arguments to list them; the listing marks which state new todos "
      + "land in and which one means finished. States are user-defined and renameable, so never "
      + "assume a fixed set. Deleting a state requires reassignTo: every todo sitting in it moves "
      + "there instead, because todos are work items and are never deleted as a side effect. New "
      + "states are created as ordinary stages -- which one is the default and which one means "
      + "finished stay the user's choice, made in the app.",
    inputSchema: taxonomySchema("state", {
      reassignTo: {
        type: "string",
        description:
          "Required for delete: the state every todo currently sitting in the deleted one moves to. "
          + "The default state and the completed state cannot be deleted at all.",
      },
    }),
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

const TAXONOMY_ACTIONS = new Set(["list", "create", "rename", "delete"]);

/** Reads the action off a taxonomy call. No action at all means the read, which is the safe default. */
function taxonomyAction(args) {
  const action = args.action ?? "list";
  if (!TAXONOMY_ACTIONS.has(action)) {
    throw new Error("Unknown action '" + action + "'. Use list, create, rename, or delete.");
  }
  return action;
}

/** Rejects a missing argument here rather than sending a half-formed command to the app. */
function requireArg(args, key, action) {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("'" + key + "' is required for action '" + action + "'");
  }
  return value.trim();
}

/** Says what a project or label delete cost, so the agent can report it without guessing. */
function detachSuffix(count) {
  if (!count) return " It was not on any todo.";
  return " Removed from " + count + (count === 1 ? " todo." : " todos.");
}

/**
 * Renders one state, flagging the two that carry meaning.
 * Neither flag can be read off the label -- the user is free to rename "Done" to anything.
 */
function formatState(state) {
  const flags = [];
  if (state.isDefault) flags.push("default for new todos");
  if (state.isCompleted) flags.push("means completed");
  return "- " + state.label + (flags.length > 0 ? " (" + flags.join(", ") + ")" : "");
}

/** Collects the optional shared fields, leaving absent ones absent so updates stay partial. */
function fieldArgs(args) {
  const out = {};
  for (const key of ["project", "labels", "milestone", "priority", "startDate", "dueDate", "state", "parentId"]) {
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

const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

function formatNames(list) {
  return (list ?? []).map((entry) => entry.name).join(", ");
}

/**
 * The uuid each todo had the last time this process listed it, keyed by the number it was listed
 * under. A merge can renumber todos between a list and a write, so a write replays the identity it
 * saw and the app refuses it if the number now means a different todo. Without this the write lands
 * silently on whichever todo inherited the number.
 *
 * Deliberately not surfaced in the tool output: numbers stay the way the user and the model talk
 * about todos, and the uuid is only ever machinery.
 */
const lastSeenUuidById = new Map();

function rememberListedTodos(todos) {
  lastSeenUuidById.clear();
  for (const todo of todos) {
    if (typeof todo.uuid === "string" && todo.uuid !== "") lastSeenUuidById.set(todo.id, todo.uuid);
  }
}

/** Adds the identity guard to a write payload, when this process has listed that todo. */
function withIdentityGuard(payload, id) {
  const uuid = lastSeenUuidById.get(id);
  if (uuid !== undefined) payload.expectUuid = uuid;
  return payload;
}

function formatTodo(todo) {
  const box = todo.state && todo.state.isCompleted ? "[x]" : "[ ]";

  const meta = [];
  if (todo.state) meta.push(todo.state.label);
  // 0 is "unset", so it carries no information worth a line in the listing.
  if (todo.priority) meta.push(PRIORITY_LABELS[todo.priority] ?? "priority " + todo.priority);
  if (todo.project) meta.push(todo.project.name);
  if (todo.labels && todo.labels.length > 0) meta.push(formatNames(todo.labels));
  if (todo.milestone) meta.push(todo.milestone);
  const dates = formatDateRange(todo);
  if (dates) meta.push(dates);
  if (todo.parentId) meta.push("sub-issue of #" + todo.parentId + " " + (todo.parentTitle ?? ""));
  if (todo.childCount) meta.push(todo.childCount + " sub-issue" + (todo.childCount === 1 ? "" : "s"));
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
      if (args.label !== undefined) payload.label = args.label;
      if (args.state !== undefined) payload.state = args.state;
      if (args.parentId !== undefined) payload.parentId = args.parentId;
      const result = await sendCommand("todo.list", payload);
      const todos = result.todos ?? [];
      rememberListedTodos(todos);
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
      const result = await sendCommand("todo.update", withIdentityGuard(payload, args.id));
      return "Updated todo #" + result.todo.id + ": " + result.todo.title
        + " [" + result.todo.state.label + "]";
    }

    case "todo_projects": {
      const action = taxonomyAction(args);
      if (action === "list") {
        const result = await sendCommand("todo.projects", {});
        const projects = result.projects ?? [];
        if (projects.length === 0) return "No projects defined yet.";
        return projects.map((project) => "- " + project.name).join("\n");
      }
      if (action === "create") {
        const result = await sendCommand("todo.project.create", {
          name: requireArg(args, "name", action),
          color: args.color,
        });
        return "Created project '" + result.project.name + "'.";
      }
      if (action === "rename") {
        const from = requireArg(args, "name", action);
        const result = await sendCommand("todo.project.rename", {
          name: from,
          newName: requireArg(args, "newName", action),
        });
        return "Renamed project '" + from + "' to '" + result.project.name + "'.";
      }
      const result = await sendCommand("todo.project.delete", {
        name: requireArg(args, "name", action),
        force: args.force === true,
      });
      return "Deleted project '" + result.name + "'." + detachSuffix(result.detached);
    }

    case "todo_labels": {
      const action = taxonomyAction(args);
      if (action === "list") {
        const result = await sendCommand("todo.labels", {});
        const labels = result.labels ?? [];
        if (labels.length === 0) return "No labels defined yet.";
        return labels.map((label) => "- " + label.name).join("\n");
      }
      if (action === "create") {
        const result = await sendCommand("todo.label.create", {
          name: requireArg(args, "name", action),
          color: args.color,
        });
        return result.created
          ? "Created label '" + result.label.name + "'."
          : "Label '" + result.label.name + "' already exists -- nothing to do.";
      }
      if (action === "rename") {
        const from = requireArg(args, "name", action);
        const result = await sendCommand("todo.label.rename", {
          name: from,
          newName: requireArg(args, "newName", action),
        });
        return "Renamed label '" + from + "' to '" + result.label.name + "'.";
      }
      const result = await sendCommand("todo.label.delete", {
        name: requireArg(args, "name", action),
        force: args.force === true,
      });
      return "Deleted label '" + result.name + "'." + detachSuffix(result.detached);
    }

    case "todo_states": {
      const action = taxonomyAction(args);
      if (action === "list") {
        const result = await sendCommand("todo.states", {});
        const states = result.states ?? [];
        if (states.length === 0) return "No states defined yet.";
        return states.map(formatState).join("\n");
      }
      if (action === "create") {
        const result = await sendCommand("todo.state.create", {
          name: requireArg(args, "name", action),
          color: args.color,
        });
        return "Created state '" + result.state.label + "'.";
      }
      if (action === "rename") {
        const from = requireArg(args, "name", action);
        const result = await sendCommand("todo.state.rename", {
          name: from,
          newName: requireArg(args, "newName", action),
        });
        return "Renamed state '" + from + "' to '" + result.state.label + "'.";
      }
      const result = await sendCommand("todo.state.delete", {
        name: requireArg(args, "name", action),
        reassignTo: requireArg(args, "reassignTo", action),
      });
      const moved = result.moved === 0
        ? "No todos were in it."
        : "Moved " + result.moved + (result.moved === 1 ? " todo" : " todos") + " to '" + result.reassignedTo + "'.";
      return "Deleted state '" + result.name + "'. " + moved;
    }

    case "todo_complete": {
      if (typeof args.id !== "number" || !Number.isInteger(args.id)) {
        throw new Error("'id' is required and must be an integer");
      }
      const result = await sendCommand("todo.complete", withIdentityGuard({ todoId: args.id }, args.id));
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
