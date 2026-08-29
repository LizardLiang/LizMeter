// electron/main/sync/migration.ts
// Milestone 6: the one-time steps that turn an existing populated database into device 0 of a
// synced set (FR-015, FR-016), and the initial publication of its existing rows once sync is
// actually turned on for the first time.

import type Database from "better-sqlite3";
import { backupDbWithSiblings } from "../data-location.ts";
import {
  getDeviceId,
  getOrAssignDeviceNumber,
  LEGACY_TODO_ID_BLOCK_STRIDE,
  registerDevice,
} from "./device-identity.ts";
import { moveTodoRowId } from "./merge-engine.ts";
import { addSyncNotice } from "./notices.ts";
import { allColumnsFor, encodeRowFields } from "./row-codec.ts";
import { newUuid, recordUpsert, setSyncEnabled } from "./sync-writer.ts";

type DbHandle = Database.Database;

const SYNC_ROW_TABLES = ["todos", "tags", "todo_labels", "todo_states", "todo_projects"] as const;

/**
 * Timestamped backup before the one-way step, matching the convention already used elsewhere in
 * the data folder (`.pre-nesting-*`, `.pre-states-*`). Thin wrapper over `data-location.ts`'s
 * shared {@link backupDbWithSiblings} (H3-B2) -- returns `null`, doing nothing, for `:memory:` or
 * a path that does not exist, which lets `runSyncMigration` below call this unconditionally
 * instead of duplicating that guard at its own call site.
 */
export function backupBeforeSyncMigration(dbPath: string): string | null {
  return backupDbWithSiblings(dbPath, "sync", "copy");
}

/** Adds a uuid to every row of every synced table that predates this column. */
export function backfillUuids(database: DbHandle): void {
  for (const table of SYNC_ROW_TABLES) {
    const rows = database.prepare(`SELECT id FROM ${table} WHERE uuid IS NULL`).all() as Array<{ id: number }>;
    if (rows.length === 0) continue;
    const update = database.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`);
    const run = database.transaction(() => {
      for (const row of rows) update.run(newUuid(), row.id);
    });
    run();
  }
}

export interface SyncMigrationResult {
  backupPath: string | null;
  deviceNumber: number;
}

/**
 * Runs once, when the user turns on sync for the first time on a machine that already has data
 * (FR-015, FR-016). Takes a backup, backfills every missing uuid, and registers this machine's
 * device number -- 0 when this device is the one *originating* the shared folder (see
 * `getOrAssignDeviceNumber`'s header comment for why that is decided from the shared folder's own
 * contents, `dataDir`, rather than from whether this database already has data). Its existing ids
 * 1..N already satisfy `0 * stride + n` when it draws 0, so nothing is renumbered.
 */
export function runSyncMigration(database: DbHandle, dbPath: string | undefined, dataDir: string): SyncMigrationResult {
  // H3-B2: the ":memory:"/existsSync guard now lives inside backupBeforeSyncMigration itself
  // (via the shared backupDbWithSiblings), not duplicated here.
  const backupPath = dbPath !== undefined ? backupBeforeSyncMigration(dbPath) : null;

  backfillUuids(database);

  const deviceNumber = getOrAssignDeviceNumber(database, dataDir);
  registerDevice(database, getDeviceId(), deviceNumber);

  return { backupPath, deviceNumber };
}

/**
 * Publishes every existing row across the synced tables as one initial `upsert` oplog entry
 * each -- the "first machine publishes its existing data" step (Milestone 6 item 2), distinct
 * from `moveDataTo`'s file copy, which moves the SQLite file itself.
 */
export function publishExistingData(database: DbHandle): void {
  for (const table of SYNC_ROW_TABLES) {
    const columns = allColumnsFor(database, table);
    const rows = database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

    for (const row of rows) {
      const rowUuid = row["uuid"] as string | null;
      if (!rowUuid) continue;

      const fields = encodeRowFields(database, table, row, columns);
      // A todo's numeric id is globally meaningful -- it is the handle the user references the
      // todo by -- so it is published like any other field. Every other synced table's local id is
      // device-specific and stays behind.
      if (table === "todos") fields["id"] = row["id"] as number;

      recordUpsert(database, table, rowUuid, fields);
    }
  }
}

export interface RenumberResult {
  backupPath: string | null;
  renumbered: Array<{ from: number; to: number }>;
}

/** How many todos still carry a number the retired block scheme handed out. */
export function countBlockAllocatedTodos(database: DbHandle): number {
  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todos WHERE id >= ?")
    .get(LEGACY_TODO_ID_BLOCK_STRIDE) as { count: number };
  return count;
}

/**
 * The one-time fold of block-allocated ids into the dense run (user-initiated, from Settings).
 *
 * Deliberately narrow: a todo whose number is below the legacy stride was issued by the machine
 * that originated the shared folder, and is therefore a number the user may already have written
 * into a note or passed to the MCP tools -- those never move. Only the unusable 15-digit ids are
 * reassigned, taking the next numbers after the highest untouched one, in creation order.
 *
 * The new number is written to `claimed_id` as well as `id` and published, so the peer adopts the
 * same assignment through the ordinary derivation path rather than needing a migration of its own.
 *
 * Idempotent: a second run finds nothing at or above the stride and does nothing.
 */
export function renumberBlockAllocatedTodoIds(database: DbHandle, dbPath?: string): RenumberResult {
  const legacy = database
    .prepare("SELECT id, uuid FROM todos WHERE id >= ? ORDER BY created_at ASC, uuid ASC, id ASC")
    .all(LEGACY_TODO_ID_BLOCK_STRIDE) as Array<{ id: number; uuid: string | null }>;
  if (legacy.length === 0) return { backupPath: null, renumbered: [] };

  // Same convention as every other one-way step in this codebase (.pre-sync-*, .pre-nesting-*).
  const backupPath = dbPath !== undefined ? backupDbWithSiblings(dbPath, "renumber", "copy") : null;

  const { maxId } = database
    .prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos WHERE id < ?")
    .get(LEGACY_TODO_ID_BLOCK_STRIDE) as { maxId: number };

  const renumbered: Array<{ from: number; to: number }> = [];
  const run = database.transaction(() => {
    let next = maxId + 1;
    for (const row of legacy) {
      // No two-phase dance needed here, unlike reconcileTodoIds: every target sits below the
      // stride and above the highest number already in use there, so it cannot be occupied.
      moveTodoRowId(database, row.id, next);
      database.prepare("UPDATE todos SET claimed_id = ? WHERE id = ?").run(next, next);
      if (row.uuid !== null) recordUpsert(database, "todos", row.uuid, { claimed_id: next });
      renumbered.push({ from: row.id, to: next });
      next += 1;
    }
    addSyncNotice(
      database,
      "todo-id-reassigned",
      `${renumbered.length} todo(s) were renumbered into the normal sequence.`,
      renumbered.map((r) => `#${r.from} -> #${r.to}`).join(", "),
    );
  });
  run();

  return { backupPath, renumbered };
}

/**
 * Turns sync on for the first time on this (already-populated) machine: migrates identity,
 * flips the enabled flag, then publishes the existing rows so peers have something to merge.
 *
 * `dataDir` is the shared folder this machine is publishing into -- by the time this runs, its
 * live database has already been relocated out of that folder into its own private storage (see
 * data-location.ts's `relocateDbToPrivateStorage`, called by the `data-location:move` IPC handler
 * before this machine relaunches into this migration step).
 */
export function enableSyncOnExistingMachine(
  database: DbHandle,
  dbPath: string | undefined,
  dataDir: string,
): SyncMigrationResult {
  const result = runSyncMigration(database, dbPath, dataDir);
  setSyncEnabled(database, true);
  publishExistingData(database);
  return result;
}
