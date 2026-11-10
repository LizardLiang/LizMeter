// usage: node mcp-smoke.mjs <pipe-path> [out.txt]
// Runs mcp/lizmeter-todo-mcp.mjs (unchanged) over stdio against the server on <pipe-path>, calling
// every tool, and prints each call with its reply text. The pipe path goes to the MCP server through
// its own LIZMETER_PIPE_PATH override; the default pipe is refused here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const [pipePath, outFile] = process.argv.slice(2);
if (!pipePath) throw new Error("usage: mcp-smoke.mjs <pipe-path> [out.txt]");
if (/\\pipe\\lizmeter(-dev)?$/i.test(pipePath)) throw new Error("refusing the default pipe path");

const here = path.dirname(fileURLToPath(import.meta.url));
const mcp = path.resolve(here, "..", "..", "..", "mcp", "lizmeter-todo-mcp.mjs");
const child = spawn(process.execPath, [mcp], {
  env: { ...process.env, LIZMETER_PIPE_PATH: pipePath },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

let nextId = 0;
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const lines = [];
let failures = 0;
async function call(name, args = {}, { expectError = false } = {}) {
  const reply = await rpc("tools/call", { name, arguments: args });
  const text = reply.result.content.map((c) => c.text).join("\n");
  const isError = reply.result.isError === true;
  const verdict = isError === expectError ? "ok" : "UNEXPECTED";
  if (verdict !== "ok") failures++;
  lines.push(`## ${name} ${JSON.stringify(args)}${isError ? " (error)" : ""}\n${text}\n`);
  if (verdict !== "ok") console.log(`UNEXPECTED ${isError ? "error" : "success"}: ${name} ${JSON.stringify(args)}\n${text}`);
}

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
lines.push(`# server ${init.result.serverInfo.name} ${init.result.serverInfo.version}\n`);
const listed = await rpc("tools/list", {});
lines.push(`# tools: ${listed.result.tools.map((t) => t.name).join(", ")}\n`);

// Reads on the seeded database.
await call("todo_states");
await call("todo_projects");
await call("todo_labels");
// Taxonomy: create, duplicate, bad colour.
await call("todo_projects", { action: "create", name: "LizMeter" });
await call("todo_projects", { action: "create", name: "lizmeter" }, { expectError: true });
await call("todo_projects", { action: "create", name: "Bad", color: "#123456" }, { expectError: true });
await call("todo_labels", { action: "create", name: "bug" });
await call("todo_labels", { action: "create", name: "BUG" });
await call("todo_labels", { action: "create", name: "ui", color: "#9ece6a" });
await call("todo_states", { action: "create", name: "Blocked" });
// Add, list, update, complete.
await call("todo_add", { title: "first", notes: "# Notes\n- a\n- b", project: "lizmeter", labels: ["bug", "UI"], state: "Testing", priority: 2, startDate: "2026-08-25", dueDate: "2026-08-30", agent: "mcp-smoke" });
await call("todo_add", { title: "second" });
await call("todo_add", { title: "child of first", parentId: 1 });
await call("todo_add", { title: "bad", project: "Nope" }, { expectError: true });
await call("todo_add", { title: "bad", state: "inprogress" }, { expectError: true });
await call("todo_list");
await call("todo_list", { filter: "active" });
await call("todo_list", { project: "LizMeter" });
await call("todo_list", { label: "bug" });
await call("todo_list", { state: "Testing" });
await call("todo_list", { id: 1 });
await call("todo_list", { id: 999 }, { expectError: true });
await call("todo_list", { limit: 1, offset: 1 });
await call("todo_update", { id: 2, title: "second, renamed", state: "Processing", labels: ["ui"], priority: 3 });
await call("todo_update", { id: 2, project: "LizMeter" });
await call("todo_update", { id: 2, project: null });
await call("todo_update", { id: 999, title: "x" }, { expectError: true });
await call("todo_complete", { id: 2 });
await call("todo_list", { filter: "done" });
// Rename, then guarded deletes.
await call("todo_projects", { action: "rename", name: "lizmeter", newName: "LM" });
await call("todo_labels", { action: "rename", name: "bug", newName: "defect" });
await call("todo_states", { action: "rename", name: "Blocked", newName: "Stuck" });
await call("todo_projects");
await call("todo_labels");
await call("todo_states");
await call("todo_projects", { action: "delete", name: "LM" }, { expectError: true });
await call("todo_projects", { action: "delete", name: "LM", force: true });
await call("todo_labels", { action: "delete", name: "defect" }, { expectError: true });
await call("todo_labels", { action: "delete", name: "defect", force: true });
await call("todo_states", { action: "delete", name: "Stuck" }, { expectError: true });
await call("todo_states", { action: "delete", name: "Stuck", reassignTo: "Backlog" });
await call("todo_states", { action: "delete", name: "Todo", reassignTo: "Backlog" }, { expectError: true });
// Delete with confirmation, then clear.
await call("todo_delete", { id: 1, confirmTitle: "wrong" }, { expectError: true });
await call("todo_delete", { id: 1, confirmTitle: "first" });
await call("todo_list");
await call("todo_delete", { id: 2, confirmTitle: "second, renamed" });
await call("todo_list");

child.stdin.end();
const text = lines.join("\n");
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
console.log(failures === 0 ? "MCP SMOKE OK" : `MCP SMOKE: ${failures} unexpected result(s)`);
process.exit(failures === 0 ? 0 : 1);
