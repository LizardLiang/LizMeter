import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTodoState, getDb, initDatabase } from "../electron/main/database.ts";
import { applyOplogEntries, reconcileTodoIds } from "../electron/main/sync/merge-engine.ts";
import { buildUpsertEntry } from "../electron/main/sync/oplog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-real-db-"));
process.env.LIZMETER_REAL_DB_USER_DATA = root;

try {
  initDatabase(":memory:");
  const database = getDb();
  const hlc = { physicalMs: Date.now(), counter: 0, deviceNumber: 941 };

  const state = createTodoState({ label: "Real driver", color: "#7aa2f7" });
  const stateRow = database.prepare("SELECT uuid FROM todo_states WHERE id = ?").get(state.id) as { uuid: string };
  const stateEntry = buildUpsertEntry(hlc, "todo_states", stateRow.uuid, {
    is_completed: { value: true, hlc },
  });
  assert.doesNotThrow(() => applyOplogEntries(database, [stateEntry]));
  assert.equal(
    (database.prepare("SELECT is_completed FROM todo_states WHERE id = ?").get(state.id) as { is_completed: number })
      .is_completed,
    1,
  );
  console.log("PASS applyFieldsLww coerces a boolean for real better-sqlite3");

  const sessionId = "real-driver-session";
  const sessionHlc = { ...hlc, counter: 1 };
  const sessionEntry = buildUpsertEntry(sessionHlc, "sessions", sessionId, {
    planned_duration_seconds: { value: true, hlc: sessionHlc },
  });
  assert.doesNotThrow(() => applyOplogEntries(database, [sessionEntry]));
  assert.equal(
    (database.prepare("SELECT planned_duration_seconds FROM sessions WHERE id = ?").get(sessionId) as {
      planned_duration_seconds: number;
    }).planned_duration_seconds,
    1,
  );
  console.log("PASS applySessionUpsert coerces a boolean for real better-sqlite3");

  database.prepare(
    "INSERT INTO todos (id, title, source, created_at, uuid, claimed_id) VALUES (?, ?, 'user', ?, ?, ?)",
  ).run(1, "Move to two", "2026-01-01T00:00:00.000Z", "real-swap-a", 2);
  database.prepare(
    "INSERT INTO todos (id, title, source, created_at, uuid, claimed_id) VALUES (?, ?, 'user', ?, ?, ?)",
  ).run(2, "Move to one", "2026-01-02T00:00:00.000Z", "real-swap-b", 1);

  assert.equal(reconcileTodoIds(database), 2);
  const moved = database.prepare("SELECT id, uuid FROM todos WHERE uuid LIKE 'real-swap-%' ORDER BY uuid").all() as Array<{
    id: number;
    uuid: string;
  }>;
  assert.deepEqual(moved, [
    { id: 2, uuid: "real-swap-a" },
    { id: 1, uuid: "real-swap-b" },
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM todos WHERE id < 0").get().count, 0);
  console.log("PASS reconcileTodoIds completes a two-phase negative-id swap");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
