// electron/main/sync/merge-engine.ts
// Applies oplog entries read from every peer's file into this device's local database
// (FR-007, FR-008, FR-009, FR-010, FR-011). Called by the watcher (Milestone 5) whenever new
// entries are read.
//
// Every apply runs inside one transaction, matching the existing transaction discipline already
// used elsewhere in database.ts (`reorderTodoStates`, `seedTodoStates`) -- this is what gives
// field-level LWW its correctness, and it means a merge can never be observed half-applied by a
// concurrent MCP write on the same connection, since better-sqlite3 is synchronous and a
// transaction blocks the connection for its duration.

import type Database from "better-sqlite3";
import { collectAttachmentBlobs } from "../attachment-store.ts";
import { getOrAssignDeviceNumber } from "./device-identity.ts";
import { compareHlc, receive, type Hlc } from "./hlc.ts";
import { generateOrderedKeys } from "./lexorank.ts";
import type { OplogEntry, OplogFieldValue, OplogUpsertEntry } from "./oplog.ts";
import { foreignKeyByFieldName } from "./row-codec.ts";

type DbHandle = Database.Database;

/** The five tables that carry their own permanent `uuid` column (Milestone 1). */
export type UuidTable = "todos" | "tags" | "todo_labels" | "todo_states" | "todo_projects";

/** Tables whose rows converge on a shared name (FR-010) -- all four carry `UNIQUE(name COLLATE NOCASE)`. */
const NAME_UNIQUE_FIELD: Partial<Record<UuidTable, string>> = {
  tags: "name",
  todo_labels: "name",
  todo_projects: "name",
  todo_states: "label",
};

// Note: convergence never needs to repoint dependent foreign keys (todo_label_links.label_id,
// todos.project_id/state_id, session_tags.tag_id). Whichever row survives keeps its own local
// numeric id in every case below -- only its `uuid` column ever moves -- so every existing local
// reference by numeric id stays valid without touching a single dependent row.

export interface ApplyResult {
  applied: number;
  skippedAlreadyApplied: number;
  notices: number;
}

function isAlreadyApplied(database: DbHandle, opId: string): boolean {
  return database.prepare("SELECT 1 FROM sync_applied_ops WHERE op_id = ?").get(opId) !== undefined;
}

function markApplied(database: DbHandle, opId: string, hlc: Hlc): void {
  database
    .prepare("INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, applied_at) VALUES (?, ?, ?)")
    .run(opId, String(hlc.deviceNumber), new Date().toISOString());
}

function addNotice(database: DbHandle, kind: string, message: string, detail?: string): void {
  database
    .prepare("INSERT INTO sync_notices (kind, message, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, message, detail ?? null, new Date().toISOString());
}

/** Follows old_uuid -> new_uuid chains left by name-unique convergence, to the final live uuid. */
function resolveAlias(database: DbHandle, table: string, uuid: string): string {
  let current = uuid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current; // defensive: a cycle should never exist
    seen.add(current);
    const row = database
      .prepare("SELECT new_uuid FROM sync_id_aliases WHERE table_name = ? AND old_uuid = ?")
      .get(table, current) as { new_uuid: string } | undefined;
    if (!row) return current;
    current = row.new_uuid;
  }
}

function isTombstoned(database: DbHandle, table: string, rowUuid: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sync_tombstones WHERE table_name = ? AND row_uuid = ?").get(table, rowUuid)
      !== undefined
  );
}

function localIdByUuid(database: DbHandle, table: UuidTable, uuid: string): number | null {
  const row = database.prepare(`SELECT id FROM ${table} WHERE uuid = ?`).get(uuid) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Applies every entry not already recorded in `sync_applied_ops`, in HLC order, inside one
 * transaction. Safe to call repeatedly with overlapping or duplicate entries -- idempotent by
 * `opId` (Milestone 3).
 */
export function applyOplogEntries(database: DbHandle, entries: readonly OplogEntry[]): ApplyResult {
  const pending = entries.filter((e) => !isAlreadyApplied(database, e.opId));
  const sorted = [...pending].sort((a, b) => compareHlc(a.hlc, b.hlc));

  let applied = 0;
  let notices = 0;
  const deviceNumber = getOrAssignDeviceNumber(database);

  const run = database.transaction(() => {
    for (const entry of sorted) {
      const { clamped } = receive(database, deviceNumber, entry.hlc);
      if (clamped) {
        addNotice(
          database,
          "clock-drift",
          `A change from device ${entry.hlc.deviceNumber} arrived with a clock far ahead of this one and was clamped`,
          `entry ${entry.opId}, table ${entry.table}`,
        );
        notices += 1;
      }

      if (entry.op === "delete") {
        applyDelete(database, entry.table, entry.rowUuid, entry.hlc);
      } else if (entry.op === "upsert") {
        if (applyUpsert(database, entry)) notices += 1;
      } else {
        applyLink(database, entry.table, entry.op, entry.fields.fromUuid, entry.fields.toUuid);
      }

      markApplied(database, entry.opId, entry.hlc);
      applied += 1;
    }

    recomputeLocalPositionFromSyncOrder(database, "todo_states");
    recomputeLocalPositionFromSyncOrder(database, "todo_projects");
  });
  run();

  return { applied, skippedAlreadyApplied: entries.length - pending.length, notices };
}

// --- Delete (FR-007) ---

function applyDelete(database: DbHandle, table: OplogEntry["table"], rowUuid: string, hlc: Hlc): void {
  const canonicalUuid = table === "todo_attachments" ? rowUuid : resolveAlias(database, table, rowUuid);

  database
    .prepare(
      `INSERT OR REPLACE INTO sync_tombstones
         (table_name, row_uuid, deleted_at, hlc_physical_ms, hlc_counter, hlc_device_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(table, canonicalUuid, new Date().toISOString(), hlc.physicalMs, hlc.counter, hlc.deviceNumber);
  database.prepare("DELETE FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ?").run(table, canonicalUuid);

  if (table === "sessions") {
    database.prepare("DELETE FROM sessions WHERE id = ?").run(canonicalUuid);
    return;
  }
  if (table === "todo_attachments") {
    const [todoUuid, sha256] = splitAttachmentKey(canonicalUuid);
    const row = database
      .prepare(`SELECT a.id FROM todo_attachments a INNER JOIN todos t ON t.id = a.todo_id WHERE t.uuid = ? AND a.sha256 = ?`)
      .get(todoUuid, sha256) as { id: number } | undefined;
    if (row) database.prepare("DELETE FROM todo_attachments WHERE id = ?").run(row.id);
    collectAttachmentBlobs([sha256]);
    return;
  }

  const localId = localIdByUuid(database, table as UuidTable, canonicalUuid);
  if (localId === null) return;

  if (table === "todos") {
    const shas = database
      .prepare("SELECT sha256 FROM todo_attachments WHERE todo_id = ?")
      .all(localId)
      .map((r) => (r as { sha256: string }).sha256);
    database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId);
    collectAttachmentBlobs(shas);
    return;
  }

  if (table === "todo_states") {
    // Unlike `project_id` (ON DELETE SET NULL in the schema), `state_id` has no delete action --
    // a bare DELETE would violate the foreign key while a todo still points at this state, since
    // `foreign_keys = ON`. Reassign to another state first, mirroring what `deleteTodoState`
    // already does for a local delete.
    const fallback = database
      .prepare("SELECT id FROM todo_states WHERE id != ? AND is_default = 1 LIMIT 1")
      .get(localId) as { id: number } | undefined
      ?? database.prepare("SELECT id FROM todo_states WHERE id != ? ORDER BY position ASC LIMIT 1").get(localId) as
        | { id: number }
        | undefined;
    database.prepare("UPDATE todos SET state_id = ? WHERE state_id = ?").run(fallback?.id ?? null, localId);
  }

  database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId);
}

function splitAttachmentKey(key: string): [string, string] {
  const idx = key.lastIndexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// --- Link / unlink ---

function applyLink(database: DbHandle, table: OplogEntry["table"], op: "link" | "unlink", fromUuid: string, toUuid: string): void {
  if (table === "todo_label_links") {
    const todoId = localIdByUuid(database, "todos", resolveAlias(database, "todos", fromUuid));
    const labelId = localIdByUuid(database, "todo_labels", resolveAlias(database, "todo_labels", toUuid));
    if (todoId === null || labelId === null) return; // referenced row has not arrived yet -- see notes in row-codec.ts
    if (op === "link") {
      database.prepare("INSERT OR IGNORE INTO todo_label_links (todo_id, label_id) VALUES (?, ?)").run(todoId, labelId);
    } else {
      database.prepare("DELETE FROM todo_label_links WHERE todo_id = ? AND label_id = ?").run(todoId, labelId);
    }
    return;
  }

  if (table === "session_tags") {
    const tagId = localIdByUuid(database, "tags", resolveAlias(database, "tags", toUuid));
    if (tagId === null) return;
    const sessionExists = database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(fromUuid) !== undefined;
    if (!sessionExists) return;
    if (op === "link") {
      database.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)").run(fromUuid, tagId);
    } else {
      database.prepare("DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?").run(fromUuid, tagId);
    }
  }
}

// --- Upsert (FR-008, FR-010) ---

/** Returns true when a discard notice was raised (an edit to an already-deleted record). */
function applyUpsert(database: DbHandle, entry: OplogUpsertEntry): boolean {
  if (entry.table === "todo_attachments") {
    return applyAttachmentUpsert(database, entry);
  }
  if (entry.table === "sessions") {
    return applySessionUpsert(database, entry);
  }

  const table = entry.table as UuidTable;
  const canonicalUuid = resolveAlias(database, table, entry.rowUuid);

  if (isTombstoned(database, table, canonicalUuid)) {
    addNotice(
      database,
      "discard-after-delete",
      `An edit to a deleted ${table} record was discarded`,
      `row ${canonicalUuid}, fields ${Object.keys(entry.fields).join(", ")}, from device ${entry.hlc.deviceNumber}`,
    );
    return true;
  }

  let localId = localIdByUuid(database, table, canonicalUuid);
  let effectiveUuid = canonicalUuid;

  if (localId === null) {
    const converged = convergeOnName(database, table, canonicalUuid, entry);
    if (converged) {
      localId = converged.localId;
      effectiveUuid = converged.uuid;
    } else {
      // A todo's numeric id is globally meaningful (FR-004, FR-005) and must be replicated
      // verbatim rather than left to this device's own AUTOINCREMENT -- every other synced
      // table's local id is device-specific and is never carried through the oplog.
      const explicitId = table === "todos" && typeof entry.fields["id"]?.value === "number"
        ? entry.fields["id"]!.value as number
        : null;
      localId = insertPlaceholderRow(database, table, canonicalUuid, explicitId);
    }
  }

  applyFieldsLww(database, table, effectiveUuid, localId, entry.fields);
  return false;
}

/**
 * Name-unique convergence (FR-010): if a row with the same normalized name already exists
 * locally under a different uuid, exactly one of the two survives. The row created earlier
 * (compared by its `created_at` field, with the uuid as a final deterministic tie-break so both
 * devices land on the same winner) is canonical; the other's uuid becomes an alias.
 */
function convergeOnName(
  database: DbHandle,
  table: UuidTable,
  incomingUuid: string,
  entry: OplogUpsertEntry,
): { localId: number; uuid: string } | null {
  const nameField = NAME_UNIQUE_FIELD[table];
  if (nameField === undefined) return null;

  const incomingName = entry.fields[nameField]?.value;
  if (typeof incomingName !== "string") return null;

  const existing = database
    .prepare(`SELECT id, uuid, created_at FROM ${table} WHERE ${nameField} = ? COLLATE NOCASE`)
    .get(incomingName) as { id: number; uuid: string | null; created_at: string } | undefined;
  if (!existing || existing.uuid === null || existing.uuid === incomingUuid) return null;

  const incomingCreatedAt = typeof entry.fields["created_at"]?.value === "string"
    ? (entry.fields["created_at"]!.value as string)
    : new Date(entry.hlc.physicalMs).toISOString();

  const incomingIsEarlier = incomingCreatedAt < existing.created_at
    || (incomingCreatedAt === existing.created_at && incomingUuid < existing.uuid);

  if (incomingIsEarlier) {
    // The incoming row is actually the canonical one. The existing local row keeps its numeric
    // id (every local reference already points at it) but its uuid moves to the incoming one,
    // and the old uuid becomes the alias.
    database
      .prepare("INSERT OR REPLACE INTO sync_id_aliases (table_name, old_uuid, new_uuid, created_at) VALUES (?, ?, ?, ?)")
      .run(table, existing.uuid, incomingUuid, new Date().toISOString());
    database.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`).run(incomingUuid, existing.id);
    database
      .prepare("UPDATE sync_field_clocks SET row_uuid = ? WHERE table_name = ? AND row_uuid = ?")
      .run(incomingUuid, table, existing.uuid);
    return { localId: existing.id, uuid: incomingUuid };
  }

  // The existing local row is canonical; the incoming row loses. Alias it, and apply its fields
  // onto the survivor via the normal field-LWW path below.
  database
    .prepare("INSERT OR REPLACE INTO sync_id_aliases (table_name, old_uuid, new_uuid, created_at) VALUES (?, ?, ?, ?)")
    .run(table, incomingUuid, existing.uuid, new Date().toISOString());
  return { localId: existing.id, uuid: existing.uuid };
}

function placeholderText(uuid: string): string {
  return `(unnamed ${uuid.slice(0, 8)})`;
}

function lastInsertRowid(database: DbHandle): number {
  const { id } = database.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
  return id;
}

/**
 * Inserts a minimal row satisfying schema constraints; `applyFieldsLww` fills in real values
 * right after. `explicitId` is only ever set for `todos` -- see the comment at this function's
 * call site.
 */
function insertPlaceholderRow(database: DbHandle, table: UuidTable, uuid: string, explicitId: number | null = null): number {
  // `last_insert_rowid()` read via a follow-up SELECT rather than the statement result's
  // `lastInsertRowid`: the same statement then works under both better-sqlite3 and the sql.js
  // test shim, which does not populate that field -- matching the convention already
  // established everywhere else in database.ts's own create functions.
  const now = new Date().toISOString();
  switch (table) {
    case "todos": {
      const defaultState = database.prepare("SELECT id FROM todo_states ORDER BY position ASC LIMIT 1").get() as
        | { id: number }
        | undefined;
      if (explicitId !== null) {
        database
          .prepare("INSERT INTO todos (id, title, state_id, source, created_at, uuid) VALUES (?, ?, ?, 'user', ?, ?)")
          .run(explicitId, "", defaultState?.id ?? null, now, uuid);
        return explicitId;
      }
      database
        .prepare("INSERT INTO todos (title, state_id, source, created_at, uuid) VALUES (?, ?, 'user', ?, ?)")
        .run("", defaultState?.id ?? null, now, uuid);
      return lastInsertRowid(database);
    }
    case "tags": {
      database
        .prepare("INSERT INTO tags (name, created_at, uuid) VALUES (?, ?, ?)")
        .run(placeholderText(uuid), now, uuid);
      return lastInsertRowid(database);
    }
    case "todo_labels": {
      database
        .prepare("INSERT INTO todo_labels (name, created_at, uuid) VALUES (?, ?, ?)")
        .run(placeholderText(uuid), now, uuid);
      return lastInsertRowid(database);
    }
    case "todo_states": {
      const { next } = database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_states").get() as
        { next: number };
      database
        .prepare("INSERT INTO todo_states (label, position, created_at, uuid) VALUES (?, ?, ?, ?)")
        .run(placeholderText(uuid), next, now, uuid);
      return lastInsertRowid(database);
    }
    case "todo_projects": {
      const { next } = database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects").get() as
        { next: number };
      database
        .prepare("INSERT INTO todo_projects (name, position, created_at, uuid) VALUES (?, ?, ?, ?)")
        .run(placeholderText(uuid), next, now, uuid);
      return lastInsertRowid(database);
    }
  }
}

/**
 * Field-level LWW (FR-008): for each field the entry touches, compares against the persisted
 * high-water mark in `sync_field_clocks` and applies only when the incoming value is newer.
 * Foreign key fields (`state_uuid`, `project_uuid`, `parent_uuid`) are resolved back to a local
 * numeric id through the alias table; an unresolvable reference (the referenced row has not
 * synced to this device yet) is skipped for now rather than blocking the rest of the entry --
 * see row-codec.ts's header comment.
 */
function applyFieldsLww(
  database: DbHandle,
  table: UuidTable,
  rowUuid: string,
  localId: number,
  fields: Record<string, { value: OplogFieldValue; hlc: Hlc }>,
): void {
  const fkByFieldName = foreignKeyByFieldName(table);
  const getClock = database.prepare(
    "SELECT hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ? AND field_name = ?",
  );
  const setClock = database.prepare(
    `INSERT OR REPLACE INTO sync_field_clocks
       (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const [fieldName, change] of Object.entries(fields)) {
    // `id` (todos only) is consumed once, at insert time, by the caller -- it is never a
    // column to UPDATE, and it has no LWW clock of its own since it never changes.
    if (fieldName === "id") continue;

    const existingClock = getClock.get(table, rowUuid, fieldName) as
      | { hlc_physical_ms: number; hlc_counter: number; hlc_device_number: number }
      | undefined;
    if (existingClock) {
      const existingHlc: Hlc = {
        physicalMs: existingClock.hlc_physical_ms,
        counter: existingClock.hlc_counter,
        deviceNumber: existingClock.hlc_device_number,
      };
      if (compareHlc(change.hlc, existingHlc) <= 0) continue; // not newer -- this field keeps its current value
    }

    const fk = fkByFieldName[fieldName];
    if (fk) {
      if (change.value === null) {
        database.prepare(`UPDATE ${table} SET ${fk.column} = NULL WHERE id = ?`).run(localId);
      } else if (typeof change.value === "string") {
        const refId = localIdByUuid(database, fk.refTable, resolveAlias(database, fk.refTable, change.value));
        if (refId === null) continue; // referenced row not synced yet -- retried on the next pass this entry's opId is NOT the blocker for, since only this field is skipped
        database.prepare(`UPDATE ${table} SET ${fk.column} = ? WHERE id = ?`).run(refId, localId);
      } else {
        continue;
      }
    } else {
      database.prepare(`UPDATE ${table} SET ${fieldName} = ? WHERE id = ?`).run(change.value, localId);
    }

    setClock.run(table, rowUuid, fieldName, change.hlc.physicalMs, change.hlc.counter, change.hlc.deviceNumber);
  }
}

function applySessionUpsert(database: DbHandle, entry: OplogUpsertEntry): boolean {
  const sessionId = entry.rowUuid;
  if (isTombstoned(database, "sessions", sessionId)) {
    addNotice(database, "discard-after-delete", "An edit to a deleted session was discarded", `session ${sessionId}`);
    return true;
  }

  const exists = database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) !== undefined;
  if (!exists) {
    database
      .prepare(
        "INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at) VALUES (?, '', 'work', 0, 0, ?)",
      )
      .run(sessionId, new Date().toISOString());
  }

  const getClock = database.prepare(
    "SELECT hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks WHERE table_name = 'sessions' AND row_uuid = ? AND field_name = ?",
  );
  const setClock = database.prepare(
    "INSERT OR REPLACE INTO sync_field_clocks (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number) VALUES ('sessions', ?, ?, ?, ?, ?)",
  );

  for (const [fieldName, change] of Object.entries(entry.fields)) {
    const existingClock = getClock.get(sessionId, fieldName) as
      | { hlc_physical_ms: number; hlc_counter: number; hlc_device_number: number }
      | undefined;
    if (existingClock) {
      const existingHlc: Hlc = {
        physicalMs: existingClock.hlc_physical_ms,
        counter: existingClock.hlc_counter,
        deviceNumber: existingClock.hlc_device_number,
      };
      if (compareHlc(change.hlc, existingHlc) <= 0) continue;
    }
    database.prepare(`UPDATE sessions SET ${fieldName} = ? WHERE id = ?`).run(change.value, sessionId);
    setClock.run(sessionId, fieldName, change.hlc.physicalMs, change.hlc.counter, change.hlc.deviceNumber);
  }
  return false;
}

function applyAttachmentUpsert(database: DbHandle, entry: OplogUpsertEntry): boolean {
  const [todoUuid, sha256] = splitAttachmentKey(entry.rowUuid);
  if (isTombstoned(database, "todo_attachments", entry.rowUuid)) return true;

  const todoId = localIdByUuid(database, "todos", resolveAlias(database, "todos", todoUuid));
  if (todoId === null) return false; // parent todo has not synced yet -- retried whenever this file is re-read

  const existing = database
    .prepare("SELECT id FROM todo_attachments WHERE todo_id = ? AND sha256 = ?")
    .get(todoId, sha256) as { id: number } | undefined;
  if (existing) return false; // content-addressed: identical bytes already recorded, nothing to update

  const fileName = typeof entry.fields["file_name"]?.value === "string" ? entry.fields["file_name"]!.value as string : sha256;
  const mimeType = typeof entry.fields["mime_type"]?.value === "string"
    ? entry.fields["mime_type"]!.value as string
    : "application/octet-stream";
  const sizeBytes = typeof entry.fields["size_bytes"]?.value === "number" ? entry.fields["size_bytes"]!.value : 0;
  const kind = typeof entry.fields["kind"]?.value === "string" ? entry.fields["kind"]!.value as string : "file";

  database
    .prepare(
      "INSERT OR IGNORE INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(todoId, sha256, fileName, mimeType, sizeBytes, kind, new Date().toISOString());
  return false;
}

// --- Ordering convergence (FR-011) ---

/**
 * After a merge brings in new `sync_order` values, sorts every row by that key and rewrites the
 * dense integer `position` column 0..N-1 -- reusing the exact shape `reorderTodoStates` /
 * `reorderTodoProjects` already produce, so the rendering code and its existing tests need no
 * changes. Rows without a `sync_order` yet (never touched by a synced reorder) sort after every
 * row that has one, keeping their existing relative order among themselves.
 */
export function recomputeLocalPositionFromSyncOrder(database: DbHandle, table: "todo_states" | "todo_projects"): void {
  const rows = database.prepare(`SELECT id, sync_order, position FROM ${table} ORDER BY position ASC`).all() as Array<
    { id: number; sync_order: string | null; position: number }
  >;
  if (rows.length === 0) return;
  if (rows.every((r) => r.sync_order === null)) return; // nothing has ever synced an order -- leave local positions untouched

  const sorted = [...rows].sort((a, b) => {
    if (a.sync_order === null && b.sync_order === null) return a.position - b.position;
    if (a.sync_order === null) return 1;
    if (b.sync_order === null) return -1;
    return a.sync_order < b.sync_order ? -1 : a.sync_order > b.sync_order ? 1 : 0;
  });

  const setPosition = database.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
  sorted.forEach((row, index) => {
    if (row.position !== index) setPosition.run(index, row.id);
  });
}

/**
 * Generates a brand new set of `sync_order` values for a full local reorder, one call per
 * `reorderTodoStates`/`reorderTodoProjects` call -- see sync-writer.ts's `recordReorder`.
 */
export function generateSyncOrderForReorder(count: number): string[] {
  return generateOrderedKeys(count);
}
