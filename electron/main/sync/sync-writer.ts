// electron/main/sync/sync-writer.ts
// The local write-path hook (Milestone 3): after a synced table's local write commits inside
// database.ts, these functions append one oplog entry describing exactly what changed.
//
// Every function here is a deliberate no-op when sync has never been turned on for this device
// (`settings['sync.enabled']` unset or "false") -- so a database that never syncs behaves
// exactly as it did before this feature shipped: no oplog files, no device-number surprises, no
// change to how todo ids are assigned. This is what lets `uuid` generation stay unconditional
// (harmless, and ready the moment sync is later turned on) while the synced todo-id counter and
// oplog writing stay strictly opt-in.

import type Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import { getDataDir } from "../data-location.ts";
import { allocateNextTodoId, getDeviceId, getOrAssignDeviceNumber } from "./device-identity.ts";
import { tick } from "./hlc.ts";
import { generateOrderedKeys } from "./lexorank.ts";
import { clearPublishPendingNotice, setPublishPendingNotice } from "./notices.ts";
import {
  buildDeleteEntry,
  buildLinkEntry,
  buildUpsertEntry,
  getOplogFilePath,
  getSyncDevicesDir,
  type OplogEntry,
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
 *
 * Both paths produce the same shape of number -- small and sequential. The synced path only needs
 * its own counter because `AUTOINCREMENT` cannot be told about ids this device learned from a peer
 * (see `advanceTodoIdWatermark`).
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

/**
 * Queues one oplog line in the local `sync_outbox` table. The insert joins the caller's open
 * transaction, so the line exists if and only if the row change it describes committed.
 * {@link flushOutbox} appends queued lines to the shared oplog file after the commit.
 */
function enqueueOplogEntry(database: DbHandle, entry: OplogEntry): void {
  database
    .prepare("INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)")
    .run(JSON.stringify(entry), new Date().toISOString());
}

/** How long a failed publish waits before the next attempt while lines are still queued. */
export const OUTBOX_RETRY_MS = 30_000;

let retryTimer: ReturnType<typeof setTimeout> | null = null;

function stopOutboxRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleOutboxRetry(database: DbHandle): void {
  if (retryTimer !== null) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (database.open) flushOutbox(database);
  }, OUTBOX_RETRY_MS);
  retryTimer.unref?.();
}

/** Cancels a pending retry. Called when the sync manager stops. */
export function cancelOutboxRetry(): void {
  stopOutboxRetry();
}

/**
 * Appends every queued line to this device's oplog file in one write, then removes the queue rows.
 * Never throws: a failed append keeps the rows, raises one "publish pending" notice with the
 * count, and schedules a retry. A crash between the append and the delete re-sends the same
 * lines later, which peers ignore by `opId`.
 */
export function flushOutbox(database: DbHandle): void {
  try {
    const rows = database.prepare("SELECT seq, line FROM sync_outbox ORDER BY seq").all() as Array<
      { seq: number; line: string }
    >;
    if (rows.length === 0) {
      stopOutboxRetry();
      clearPublishPendingNotice(database);
      return;
    }

    try {
      const dataDir = getDataDir();
      fs.mkdirSync(getSyncDevicesDir(dataDir), { recursive: true });
      const filePath = getOplogFilePath(dataDir, getDeviceId());
      let text = rows.map((r) => `${r.line}\n`).join("");
      if (endsWithPartialLine(filePath)) text = `\n${text}`;
      fs.appendFileSync(filePath, text, "utf8");
    } catch (err) {
      setPublishPendingNotice(database, rows.length, err instanceof Error ? err.message : String(err));
      scheduleOutboxRetry(database);
      return;
    }

    database.prepare("DELETE FROM sync_outbox WHERE seq <= ?").run(rows[rows.length - 1]!.seq);
    stopOutboxRetry();
    clearPublishPendingNotice(database);
  } catch (err) {
    console.warn("[sync] outbox flush failed:", err);
  }
}

/** True when the file is non-empty and its last byte is not a newline (a torn last line). */
function endsWithPartialLine(filePath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs `fn` in a transaction, so every record* call inside commits or rolls back with the row
 * change, then flushes the outbox once the outermost transaction has committed (sync on only). Nests safely:
 * inside an open transaction it becomes a savepoint and the outer caller flushes.
 */
export function withSyncTransaction<T>(database: DbHandle, fn: () => T): T {
  const nested = database.inTransaction;
  const result = database.transaction(fn)();
  if (!nested && isSyncEnabled(database)) flushOutbox(database);
  return result;
}

function currentHlc(database: DbHandle) {
  const deviceNumber = getOrAssignDeviceNumber(database);
  return tick(database, deviceNumber);
}

/** Queues an upsert entry naming only the fields that actually changed. No-op when sync is off. */
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
  enqueueOplogEntry(database, buildUpsertEntry(hlc, table, rowUuid, fieldChanges));

  // A local write competes with a remote one for the same field just as much as two remote
  // writes do, so it needs the same high-water mark the merge engine reads (see
  // sync_field_clocks in database.ts) -- otherwise a remote edit that is actually older than
  // this local one could still overwrite it on the next merge pass.
  const setClock = database.prepare(
    `INSERT OR REPLACE INTO sync_field_clocks
       (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // `id` (todos only) gets a clock like every other field. It used to be skipped here on the
  // reasoning that an id is "consumed once at insert time, never a real LWW field" -- true under
  // the retired block scheme, where two devices could not possibly claim the same number. Dense
  // ids collide by design, so an id genuinely does change (once, when a merge bumps the losing
  // claimant), and that change has to win or lose against a peer's on exactly the same LWW terms
  // as any other field. Without a clock here, a device's own bump could be silently undone by the
  // older entry it was resolving.
  for (const field of Object.keys(fields)) {
    setClock.run(table, rowUuid, field, hlc.physicalMs, hlc.counter, hlc.deviceNumber);
  }
}

/** Queues a tombstone, and records it locally so this device's own delete always-wins too. No-op when sync is off. */
export function recordDelete(database: DbHandle, table: OplogUpsertEntry["table"], rowUuid: string): void {
  if (!isSyncEnabled(database)) return;
  const hlc = currentHlc(database);
  enqueueOplogEntry(database, buildDeleteEntry(hlc, table, rowUuid));

  database
    .prepare(
      `INSERT OR REPLACE INTO sync_tombstones
         (table_name, row_uuid, deleted_at, hlc_physical_ms, hlc_counter, hlc_device_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(table, rowUuid, new Date().toISOString(), hlc.physicalMs, hlc.counter, hlc.deviceNumber);

  // Mirrors applyDelete's own cleanup in merge-engine.ts -- a deleted row's per-field high-water
  // marks have nothing left to guard once the row is gone, and leaving them behind is dead
  // weight that a local delete must clear exactly as a remote-applied delete already does.
  database.prepare("DELETE FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ?").run(table, rowUuid);
}

/** Queues a link/unlink entry for a join table. No-op when sync is off. */
export function recordLink(
  database: DbHandle,
  table: SyncedLinkTable,
  op: "link" | "unlink",
  fromUuid: string,
  toUuid: string,
): void {
  if (!isSyncEnabled(database)) return;
  const hlc = currentHlc(database);
  enqueueOplogEntry(database, buildLinkEntry(hlc, table, op, fromUuid, toUuid));
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
