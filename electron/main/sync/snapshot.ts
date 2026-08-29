// electron/main/sync/snapshot.ts
// Milestone 7: retention, compaction, and stale-machine rebuild (FR-018, FR-019).
//
// Every device writes its own daily snapshot of the fully-merged state it currently holds, then
// trims its own oplog file down to the retention window. A device that has been offline longer
// than that window does not trust its own stale local history -- it discards it and rebuilds
// from the most recent snapshot among all devices, then replays anything newer.
//
// A snapshot is expressed as a list of the same OplogEntry shapes the live oplog already uses
// (upsert/delete/link), so rebuilding from one is just "feed these into the existing, already
// -tested applyOplogEntries" -- no parallel apply path to get subtly wrong.

import type Database from "better-sqlite3";
import fs from "node:fs";
import { getCurrentDbPath } from "../database.ts";
import { getOrAssignDeviceNumber } from "./device-identity.ts";
import { tick, type Hlc } from "./hlc.ts";
import { applyOplogEntries } from "./merge-engine.ts";
import { addSyncNotice } from "./notices.ts";
import {
  buildDeleteEntry,
  buildLinkEntry,
  buildUpsertEntry,
  CURRENT_OPLOG_VERSION,
  getSnapshotFilePath,
  getSyncDevicesDir,
  isPlausibleEntry,
  readOplogEntries,
  type OplogDeleteEntry,
  type OplogEntry,
  type OplogFieldValue,
  type SyncedRowTable,
} from "./oplog.ts";
import { readFileGuarded } from "./hydration-guard.ts";
import { allColumnsFor, encodeRowFields } from "./row-codec.ts";

type DbHandle = Database.Database;

// Order matters: every snapshot entry shares one identical HLC (see buildSnapshotEntries), so
// applyOplogEntries's stable HLC sort falls back to this array's insertion order among them.
// todo_states/todo_projects must be applied before todos, since todos' state_uuid/project_uuid
// fields can only resolve to a local row that already exists -- unlike live sync, where two
// entries almost never share the exact same HLC, a snapshot's uniform HLC makes this ordering
// load-bearing rather than incidental.
const SNAPSHOT_ROW_TABLES: readonly SyncedRowTable[] = [
  "todo_states",
  "todo_projects",
  "todo_labels",
  "tags",
  "todos",
  "sessions",
];

/** History and tombstones older than this are compacted away (FR-018). */
export const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const LAST_SNAPSHOT_AT_KEY = "sync.lastSnapshotAt";
const LAST_SYNCED_AT_KEY = "sync.lastSyncedAt";

function readSetting(database: DbHandle, key: string): string | null {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(database: DbHandle, key: string, value: string): void {
  database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

/** Records that a sync pass completed successfully just now -- read back by the stale-rejoin check. */
export function markSyncedNow(database: DbHandle, now: number = Date.now()): void {
  writeSetting(database, LAST_SYNCED_AT_KEY, new Date(now).toISOString());
}

/**
 * The persisted "last synced" timestamp, surviving a restart -- unlike sync-manager.ts's own
 * `lastSyncedAt` module variable, which resets to `null` every time the process starts and stays
 * that way until the first merge pass completes. `getSyncStatus()` reads this as a fallback so
 * Settings shows the real last-sync time instead of "Waiting for the first sync pass" after
 * every ordinary app restart.
 */
export function getLastSyncedAt(database: DbHandle): string | null {
  return readSetting(database, LAST_SYNCED_AT_KEY);
}

/**
 * Builds the full contents of this device's own snapshot: one upsert entry per row across every
 * synced table, one delete entry per tombstone still inside the retention window (preserving its
 * original HLC, since delete-wins is unconditional and never depends on relative timing), and one
 * link entry per join-table row.
 *
 * `now` bounds which tombstones are included (H-002): without a cutoff here, a daily snapshot
 * embeds every delete this device has ever applied or recorded, forever, defeating FR-018's own
 * acceptance criterion that the shared folder hold "at most 90 days of raw history plus a
 * snapshot" -- `trimOwnOplog` already bounds the raw oplog *file*, but the snapshot is what is
 * supposed to *replace* old history, not accumulate it. See {@link pruneOldTombstones} for the
 * matching local-table prune this same cutoff also drives.
 */
export function buildSnapshotEntries(database: DbHandle, now: number = Date.now()): OplogEntry[] {
  const deviceNumber = getOrAssignDeviceNumber(database);
  const snapshotHlc = tick(database, deviceNumber);
  const entries: OplogEntry[] = [];
  const cutoff = now - RETENTION_MS;

  for (const table of SNAPSHOT_ROW_TABLES) {
    if (table === "sessions") {
      const rows = database.prepare("SELECT * FROM sessions").all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const fields: Record<string, { value: OplogFieldValue; hlc: Hlc }> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key === "id") continue;
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
            fields[key] = { value, hlc: snapshotHlc };
          }
        }
        entries.push(buildUpsertEntry(snapshotHlc, "sessions", row["id"] as string, fields));
      }
      continue;
    }

    const columns = allColumnsFor(database, table);
    const rows = database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const rowUuid = row["uuid"] as string | null;
      if (!rowUuid) continue;
      const encoded = encodeRowFields(database, table, row, columns);
      const fields: Record<string, { value: OplogFieldValue; hlc: Hlc }> = {};
      for (const [key, value] of Object.entries(encoded)) fields[key] = { value, hlc: snapshotHlc };
      if (table === "todos") fields["id"] = { value: row["id"] as number, hlc: snapshotHlc };
      entries.push(buildUpsertEntry(snapshotHlc, table, rowUuid, fields));
    }
  }

  const tombstones = database
    .prepare(
      "SELECT table_name, row_uuid, hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_tombstones WHERE hlc_physical_ms >= ?",
    )
    .all(cutoff) as Array<
      { table_name: string; row_uuid: string; hlc_physical_ms: number; hlc_counter: number; hlc_device_number: number }
    >;
  for (const t of tombstones) {
    const hlc: Hlc = { physicalMs: t.hlc_physical_ms, counter: t.hlc_counter, deviceNumber: t.hlc_device_number };
    entries.push(buildDeleteEntry(hlc, t.table_name as OplogDeleteEntry["table"], t.row_uuid));
  }

  const labelLinks = database
    .prepare(
      `SELECT t.uuid AS todo_uuid, l.uuid AS label_uuid
       FROM todo_label_links k
       INNER JOIN todos t ON t.id = k.todo_id
       INNER JOIN todo_labels l ON l.id = k.label_id`,
    )
    .all() as Array<{ todo_uuid: string; label_uuid: string }>;
  for (const link of labelLinks) {
    entries.push(buildLinkEntry(snapshotHlc, "todo_label_links", "link", link.todo_uuid, link.label_uuid));
  }

  const sessionTagLinks = database
    .prepare(
      `SELECT st.session_id AS session_id, t.uuid AS tag_uuid
       FROM session_tags st
       INNER JOIN tags t ON t.id = st.tag_id`,
    )
    .all() as Array<{ session_id: string; tag_uuid: string }>;
  for (const link of sessionTagLinks) {
    entries.push(buildLinkEntry(snapshotHlc, "session_tags", "link", link.session_id, link.tag_uuid));
  }

  return entries;
}

/**
 * Writes this device's snapshot file and trims its own oplog to the retention window, at most
 * once per calendar day. Never touches a peer's file -- a device only ever writes its own.
 */
export function writeSnapshotIfDue(
  database: DbHandle,
  dataDir: string,
  deviceId: string,
  now: number = Date.now(),
): boolean {
  const last = readSetting(database, LAST_SNAPSHOT_AT_KEY);
  if (last !== null && now - Date.parse(last) < 24 * 60 * 60 * 1000) return false;

  const entries = buildSnapshotEntries(database, now);
  const snapshot = { v: CURRENT_OPLOG_VERSION, deviceId, createdAt: new Date(now).toISOString(), entries };

  const dir = getSyncDevicesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getSnapshotFilePath(dataDir, deviceId), `${JSON.stringify(snapshot)}\n`);

  trimOwnOplog(dataDir, deviceId, now);
  // H-002: prune this device's own tombstone table on the same cadence as the oplog file trim,
  // using the same cutoff buildSnapshotEntries just applied -- otherwise the table (and every
  // future snapshot embedding it) grows without bound for as long as the app is used, which is
  // exactly the "single most-cited regret" FR-018 was written to avoid.
  pruneOldTombstones(database, now);
  writeSetting(database, LAST_SNAPSHOT_AT_KEY, new Date(now).toISOString());
  return true;
}

/**
 * Deletes tombstones older than the retention window from `sync_tombstones` (H-002).
 *
 * Safe to run at any time, independent of the oplog file trim: a tombstone's only job is to
 * outlive a straggling edit from an offline peer for the retention window, per FR-018's own
 * reasoning ("90 days is comfortably longer than any realistic offline period"). Once a
 * tombstone ages out, {@link isTombstoned} no longer needing to know about it is the intended
 * behavior, not a gap -- unlike `sync_field_clocks`, which must never be age-pruned (it has no
 * death timestamp of its own, and pruning it would delete a live row's high-water mark and cause
 * a genuinely lost update on the next merge).
 */
function pruneOldTombstones(database: DbHandle, now: number): void {
  const cutoff = now - RETENTION_MS;
  database.prepare("DELETE FROM sync_tombstones WHERE hlc_physical_ms < ?").run(cutoff);
}

/** Rewrites this device's own oplog file to entries newer than the retention window (FR-018). */
function trimOwnOplog(dataDir: string, deviceId: string, now: number): void {
  const filePath = `${getSyncDevicesDir(dataDir)}/${deviceId}.oplog.jsonl`;
  if (!fs.existsSync(filePath)) return;

  const { entries } = readOplogEntries(filePath);
  const cutoff = now - RETENTION_MS;
  const kept = entries.filter((e) => e.hlc.physicalMs >= cutoff);
  if (kept.length === entries.length) return; // nothing to trim

  const lines = kept.map((e) => JSON.stringify(e)).join("\n");
  atomicWriteFileSync(filePath, kept.length > 0 ? `${lines}\n` : "");
}

/**
 * Writes `data` to `filePath` via a temp file in the same directory plus `renameSync`, rather
 * than a bare `writeFileSync`. A crash mid-write to the real path would otherwise truncate or
 * corrupt this device's own oplog or snapshot file -- up to 90 days of published history, in the
 * oplog case -- whereas a rename is atomic on the same filesystem, so the file at `filePath`
 * always ends up either the old complete contents or the new complete contents, never a partial
 * write.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, data, "utf8");
  fs.renameSync(tempPath, filePath);
}

interface SnapshotFile {
  v: number;
  deviceId: string;
  createdAt: string;
  entries: OplogEntry[];
}

/**
 * Reads and parses a peer's (or this device's own) snapshot file, applying the hydration guard
 * first, then filtering `entries` through the same `isPlausibleEntry` gate a live oplog file's
 * lines pass through (B-1) -- a snapshot file is just as much untrusted peer-authored content
 * sitting in the shared folder as an oplog file, and its entries reach the same
 * `applyOplogEntries` -> SQL template literal path in merge-engine.ts.
 */
function readSnapshotFile(filePath: string): SnapshotFile | null {
  if (!fs.existsSync(filePath)) return null;
  const buf = readFileGuarded(filePath);
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as SnapshotFile;
    if (!Array.isArray(parsed.entries)) return null;
    return { ...parsed, entries: parsed.entries.filter(isPlausibleEntry) };
  } catch (err) {
    console.warn(`[sync] ignoring unparseable snapshot ${filePath}:`, err);
    return null;
  }
}

/** The most recently created snapshot among every device that has ever published one. */
function findMostRecentSnapshot(dataDir: string): SnapshotFile | null {
  const dir = getSyncDevicesDir(dataDir);
  if (!fs.existsSync(dir)) return null;

  let best: SnapshotFile | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".snapshot.json")) continue;
    const snapshot = readSnapshotFile(`${dir}/${name}`);
    if (snapshot === null) continue;
    if (best === null || Date.parse(snapshot.createdAt) > Date.parse(best.createdAt)) best = snapshot;
  }
  return best;
}

/**
 * True when this device's last successful sync was longer ago than the retention window --
 * meaning its own unsynced local history may already have been compacted away on every peer,
 * and replaying it as "new" work would risk resurrecting something legitimately deleted.
 */
export function isStale(database: DbHandle, now: number = Date.now()): boolean {
  const last = readSetting(database, LAST_SYNCED_AT_KEY);
  if (last === null) return false; // never synced yet -- not "stale", just new
  return now - Date.parse(last) > RETENTION_MS;
}

/**
 * Timestamped backup before {@link rebuildFromSnapshot}'s destructive wipe (R2-B3/R2-W7), mirroring
 * `migration.ts`'s `backupBeforeSyncMigration` and `data-location.ts`'s
 * `backupExistingPrivateDbBeforeAdopt` -- copies the db file plus its `-wal`/`-shm` siblings, when
 * present. `getCurrentDbPath()` only names the real on-disk path for the production flow (it does
 * not know about a test's `initDatabase(":memory:")` override); `fs.existsSync` below is what
 * makes this a safe no-op under every existing test, exactly like the two backup helpers it
 * mirrors. Without this, fixing the R2-B3 foreign-key ordering below would let `wipe()` actually
 * commit for the first time -- turning what is today a caught, rolled-back no-op into live data
 * loss the moment the repopulate step that follows it throws (`prd.md:134`: "No destructive step
 * runs without a recoverable backup first").
 */
export function backupBeforeRebuild(dbPath: string): string | null {
  if (dbPath === ":memory:" || !fs.existsSync(dbPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-rebuild-${stamp}.bak`;
  fs.copyFileSync(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${dbPath}${suffix}`;
    if (fs.existsSync(side)) fs.copyFileSync(side, `${backupPath}${suffix}`);
  }
  return backupPath;
}

/**
 * FR-019: discards this device's local working state for every synced table and rebuilds from
 * the most recent snapshot among all devices, then replays every oplog entry newer than that
 * snapshot. Writes a notice so the user is told this happened, per FR-019's acceptance
 * criterion. Returns false (a no-op) when no snapshot exists yet anywhere -- nothing to rebuild
 * from, so the safest thing is to leave local state untouched rather than delete it for nothing.
 */
export function rebuildFromSnapshot(
  database: DbHandle,
  dataDir: string,
  ownDeviceId: string,
  now: number = Date.now(),
): boolean {
  const snapshot = findMostRecentSnapshot(dataDir);
  if (snapshot === null) return false;

  const backupPath = backupBeforeRebuild(getCurrentDbPath());

  const wipe = database.transaction(() => {
    // R2-B3: todos.state_id references todo_states(id) with no ON DELETE action (deliberately --
    // see the next table's ON DELETE SET NULL for the contrast), and foreign_keys = ON, so a bare
    // `DELETE FROM todo_states` throws FOREIGN KEY constraint failed on any machine that has any
    // todos, rolling back the whole wipe -- silently, since the caller only ever sees a
    // console.warn (sync-manager.ts). Both tables are wiped in this same transaction moments
    // later, so nulling the reference first (mirroring merge-engine.ts's identical fix for a
    // single-row delete) is safe: nothing downstream ever reads this now-orphaned NULL, since the
    // very next statements delete every row that could have.
    database.exec("UPDATE todos SET state_id = NULL");
    for (const table of SNAPSHOT_ROW_TABLES) database.exec(`DELETE FROM ${table}`);
    database.exec("DELETE FROM todo_label_links");
    database.exec("DELETE FROM session_tags");
    database.exec("DELETE FROM sync_field_clocks");
    database.exec("DELETE FROM sync_tombstones");
    database.exec("DELETE FROM sync_id_aliases");
    database.exec("DELETE FROM sync_applied_ops");
  });
  wipe();

  applyOplogEntries(database, snapshot.entries);

  const dir = getSyncDevicesDir(dataDir);
  const newerEntries: OplogEntry[] = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".oplog.jsonl")) continue;
      const deviceId = name.slice(0, -".oplog.jsonl".length);
      if (deviceId === ownDeviceId) continue;
      const { entries } = readOplogEntries(`${dir}/${name}`);
      for (const entry of entries) {
        if (Date.parse(snapshot.createdAt) <= entry.hlc.physicalMs) newerEntries.push(entry);
      }
    }
  }
  applyOplogEntries(database, newerEntries);

  markSyncedNow(database, now);
  addSyncNotice(
    database,
    "stale-machine-rebuild",
    "This machine was offline for more than 90 days, so it rebuilt from the latest snapshot instead of replaying its own stale history.",
    `snapshot from ${snapshot.deviceId} created ${snapshot.createdAt}`
      + (backupPath !== null ? `; pre-rebuild backup at ${backupPath}` : ""),
  );
  return true;
}
