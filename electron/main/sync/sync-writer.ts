// electron/main/sync/sync-writer.ts
// The local write-path hook (Milestone 3): after a synced table's local write commits inside
// database.ts, these functions append one oplog entry describing exactly what changed.
//
// Every function here is a deliberate no-op when sync has never been turned on for this device
// (`settings['sync.enabled']` unset or "false") -- so a database that never syncs behaves
// exactly as it did before this feature shipped: no oplog files, no device-number surprises, no
// change to how todo ids are assigned. This is what lets `uuid` generation stay unconditional
// (harmless, and ready the moment sync is later turned on) while todo-id block allocation and
// oplog writing stay strictly opt-in.

import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { getDataDir } from "../data-location.ts";
import { allocateNextTodoId, getDeviceId, getOrAssignDeviceNumber } from "./device-identity.ts";
import { tick } from "./hlc.ts";
import { generateOrderedKeys } from "./lexorank.ts";
import {
  appendOplogEntry,
  buildDeleteEntry,
  buildLinkEntry,
  buildUpsertEntry,
  type OplogFieldValue,
  type OplogUpsertEntry,
  type SyncedLinkTable,
} from "./oplog.ts";

type DbHandle = Database.Database;

const SYNC_ENABLED_KEY = "sync.enabled";

export function isSyncEnabled(database: DbHandle): boolean {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(SYNC_ENABLED_KEY) as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

export function setSyncEnabled(database: DbHandle, enabled: boolean): void {
  database
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(SYNC_ENABLED_KEY, enabled ? "true" : "false");
}

/** A fresh row identity. Generated unconditionally at insert time -- cheap, and ready the moment sync turns on. */
export function newUuid(): string {
  return crypto.randomUUID();
}

/**
 * The explicit numeric id a synced `todos` insert must use, or `null` when sync is off and the
 * table's own `AUTOINCREMENT` should assign the id exactly as it always has.
 */
export function allocateTodoIdIfSyncEnabled(database: DbHandle): number | null {
  if (!isSyncEnabled(database)) return null;
  return allocateNextTodoId(database);
}

/** Backfills a uuid for a row that predates this column, e.g. a row from an upgraded database. */
export function ensureUuid(database: DbHandle, table: OplogUpsertEntry["table"], id: number): string {
  const row = database.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id) as
    | { uuid: string | null }
    | undefined;
  if (row?.uuid) return row.uuid;
  const uuid = newUuid();
  database.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`).run(uuid, id);
  return uuid;
}

function currentHlc(database: DbHandle) {
  const deviceNumber = getOrAssignDeviceNumber(database);
  return tick(database, deviceNumber);
}

/** Appends an upsert entry naming only the fields that actually changed. No-op when sync is off. */
export function recordUpsert(
  database: DbHandle,
  table: OplogUpsertEntry["table"],
  rowUuid: string,
  fields: Record<string, OplogFieldValue>,
): void {
  if (!isSyncEnabled(database)) return;
  if (Object.keys(fields).length === 0) return;

  const hlc = currentHlc(database);
  const fieldChanges: OplogUpsertEntry["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    fieldChanges[key] = { value, hlc };
  }
  appendOplogEntry(getDataDir(), getDeviceId(), buildUpsertEntry(hlc, table, rowUuid, fieldChanges));

  // A local write competes with a remote one for the same field just as much as two remote
  // writes do, so it needs the same high-water mark the merge engine reads (see
  // sync_field_clocks in database.ts) -- otherwise a remote edit that is actually older than
  // this local one could still overwrite it on the next merge pass.
  const setClock = database.prepare(
    `INSERT OR REPLACE INTO sync_field_clocks
       (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const field of Object.keys(fields)) {
    if (field === "id") continue; // todos-only: consumed once at insert time, never a real LWW field
    setClock.run(table, rowUuid, field, hlc.physicalMs, hlc.counter, hlc.deviceNumber);
  }
}

/** Appends a tombstone, and records it locally so this device's own delete always-wins too. No-op when sync is off. */
export function recordDelete(database: DbHandle, table: OplogUpsertEntry["table"], rowUuid: string): void {
  if (!isSyncEnabled(database)) return;
  const hlc = currentHlc(database);
  appendOplogEntry(getDataDir(), getDeviceId(), buildDeleteEntry(hlc, table, rowUuid));

  database
    .prepare(
      `INSERT OR REPLACE INTO sync_tombstones
         (table_name, row_uuid, deleted_at, hlc_physical_ms, hlc_counter, hlc_device_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(table, rowUuid, new Date().toISOString(), hlc.physicalMs, hlc.counter, hlc.deviceNumber);
}

/** Appends a link/unlink entry for a join table. No-op when sync is off. */
export function recordLink(
  database: DbHandle,
  table: SyncedLinkTable,
  op: "link" | "unlink",
  fromUuid: string,
  toUuid: string,
): void {
  if (!isSyncEnabled(database)) return;
  const hlc = currentHlc(database);
  appendOplogEntry(getDataDir(), getDeviceId(), buildLinkEntry(hlc, table, op, fromUuid, toUuid));
}

/**
 * Gives a freshly reordered list a brand new set of `sync_order` values and records each as an
 * oplog upsert -- a thin wrapper called right after `reorderTodoStates`/`reorderTodoProjects`
 * return, per the tactical plan's Milestone 4: those two functions are not modified themselves.
 * No-op when sync is off, so `position` stays the only ordering column until sync is turned on.
 */
export function recordReorder(
  database: DbHandle,
  table: "todo_states" | "todo_projects",
  orderedIds: readonly number[],
): void {
  if (!isSyncEnabled(database)) return;
  if (orderedIds.length === 0) return;

  const keys = generateOrderedKeys(orderedIds.length);
  const setOrder = database.prepare(`UPDATE ${table} SET sync_order = ? WHERE id = ?`);
  const getUuid = database.prepare(`SELECT uuid FROM ${table} WHERE id = ?`);

  orderedIds.forEach((id, index) => {
    const key = keys[index]!;
    setOrder.run(key, id);
    const row = getUuid.get(id) as { uuid: string | null } | undefined;
    const rowUuid = row?.uuid ?? ensureUuid(database, table, id);
    recordUpsert(database, table, rowUuid, { sync_order: key });
  });
}
