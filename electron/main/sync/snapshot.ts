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

// A real (not type-only) import: H3-B1's markBackupAsRestorable and H3-B2's shared backup helper
// both need to open a database connection at runtime, not just refer to its type.
import Database from "better-sqlite3";
import fs from "node:fs";
import { getCurrentDbPath } from "../database.ts";
import { backupDbWithSiblings } from "../data-location.ts";
import { getOrAssignDeviceNumber } from "./device-identity.ts";
import { tick, type Hlc } from "./hlc.ts";
import { applyOplogEntries } from "./merge-engine.ts";
import { addSyncNotice } from "./notices.ts";
import {
  attachmentRowKey,
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

  // H3-B1: todo_attachments is a synced table (FR-002), but before this it emitted no entries of
  // its own here at all -- only its tombstones (below) ever reached a snapshot. `wipe()`'s
  // `DELETE FROM todos` cascades away every attachment row (todo_attachments.todo_id ON DELETE
  // CASCADE), so without this a rebuild silently lost every still-attached file's row (the blob
  // itself survives unreferenced on disk; only the row pointing at it is gone). Keyed the same way
  // `createTodoAttachment`/`deleteTodoAttachment` already publish it to a live oplog
  // (`attachmentRowKey(todoUuid, sha256)`), so `applyAttachmentUpsert` needs no changes to accept
  // these entries during a rebuild's replay.
  const attachmentRows = database
    .prepare(
      `SELECT t.uuid AS todo_uuid, a.sha256, a.file_name, a.mime_type, a.size_bytes, a.kind
       FROM todo_attachments a
       INNER JOIN todos t ON t.id = a.todo_id
       WHERE t.uuid IS NOT NULL`,
    )
    .all() as Array<
      { todo_uuid: string; sha256: string; file_name: string; mime_type: string; size_bytes: number; kind: string }
    >;
  for (const row of attachmentRows) {
    const fields: Record<string, { value: OplogFieldValue; hlc: Hlc }> = {
      file_name: { value: row.file_name, hlc: snapshotHlc },
      mime_type: { value: row.mime_type, hlc: snapshotHlc },
      size_bytes: { value: row.size_bytes, hlc: snapshotHlc },
      kind: { value: row.kind, hlc: snapshotHlc },
    };
    entries.push(
      buildUpsertEntry(snapshotHlc, "todo_attachments", attachmentRowKey(row.todo_uuid, row.sha256), fields),
    );
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
 * Thrown by {@link backupBeforeRebuild} when the pre-wipe safety copy itself cannot be written
 * (disk full, permission denied) -- distinguished from any other error so `runMergePassSafely`
 * (M-006) can give a persistent backup failure on the automatic FR-019 path the same dedicated,
 * user-visible treatment `NotFullyHydratedError` already gets, instead of falling into the
 * generic `console.warn` bucket silently and indefinitely on every watcher retry.
 */
export class RebuildBackupFailedError extends Error {
  constructor(cause: unknown) {
    super(`could not write the pre-rebuild backup: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RebuildBackupFailedError";
  }
}

/**
 * H3-B1: without this, restoring a `.pre-rebuild-*.bak` in place of the live database is a trap,
 * not a safety net -- the backup carries the same stale `sync.lastSyncedAt` that made `isStale()`
 * true in the first place, so the very next merge pass calls `rebuildFromSnapshot` again and wipes
 * the just-restored data right back out (a recovery loop). Opening the backup once here and
 * marking it "synced now" means a restored copy resumes ordinary incremental merging with peers
 * (`runMergePass` re-reads every peer's currently-retained oplog on every pass regardless of
 * `lastSyncedAt` -- see merge-pass.ts) instead of repeating the same destructive full rebuild.
 * This never touches the live database or the wipe transaction below; a failure here is logged
 * and does not block the backup from existing -- the byte-for-byte copy is still there, only the
 * "resume without re-wiping" property is unconfirmed. (No VACUUM/auto_vacuum runs anywhere in
 * this codebase, so this patch does not, and is not expected to, shrink the backup file.)
 */
function markBackupAsRestorable(backupPath: string): void {
  let conn: Database.Database | null = null;
  try {
    conn = new Database(backupPath);
    conn.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      LAST_SYNCED_AT_KEY,
      new Date().toISOString(),
    );
  } catch (err) {
    console.warn(`[sync] could not mark pre-rebuild backup ${backupPath} as restorable:`, err);
  } finally {
    try {
      conn?.close();
    } catch {
      // best-effort cleanup only -- the backup file itself is unaffected either way
    }
  }
}

/**
 * Timestamped backup before {@link rebuildFromSnapshot}'s destructive wipe (R2-B3/R2-W7). Thin
 * wrapper over `data-location.ts`'s shared {@link backupDbWithSiblings} (H3-B2) -- copies the db
 * file plus its `-wal`/`-shm` siblings, when present, then (H3-B1) marks the copy as
 * genuinely restorable. `dbPath === ":memory:"` or a missing path is a safe no-op, exactly like
 * the two backup helpers this one shares its implementation with. Without this, fixing the R2-B3
 * foreign-key ordering below would let `wipe()` actually commit for the first time -- turning what
 * was a caught, rolled-back no-op into live data loss the moment the repopulate step that follows
 * it throws (`prd.md:134`: "No destructive step runs without a recoverable backup first").
 *
 * A copy failure throws {@link RebuildBackupFailedError} (M-006) rather than a raw `fs` error, so
 * the caller can distinguish "the safety backup itself could not be written" from any other
 * failure -- this happens before the wipe transaction below ever opens, so a throw here is
 * correctly fail-safe: the destructive step never starts.
 */
export function backupBeforeRebuild(dbPath: string): string | null {
  let backupPath: string | null;
  try {
    backupPath = backupDbWithSiblings(dbPath, "rebuild", "copy");
  } catch (err) {
    throw new RebuildBackupFailedError(err);
  }
  if (backupPath !== null) markBackupAsRestorable(backupPath);
  return backupPath;
}

/**
 * H3-B1: `claude_code_sessions` and `claude_code_idle_periods` are FR-003 machine-local tables --
 * sync must never read or write them (`grep -rn "claude_code" electron/main/sync/` returns zero
 * matches, deliberately). But `DELETE FROM sessions` inside {@link rebuildFromSnapshot}'s wipe
 * cascades into both (`claude_code_sessions.session_id` and, transitively,
 * `claude_code_idle_periods.cc_session_id`, both `ON DELETE CASCADE`), so a bare wipe silently
 * destroyed them even though nothing else ever puts them back. Reads every row of both tables
 * before the wipe runs, so {@link restoreClaudeCodeActivity} can re-insert them afterward for
 * every session id that survives the rebuild.
 */
function preserveClaudeCodeActivity(database: DbHandle): {
  sessions: Array<Record<string, unknown>>;
  idlePeriods: Array<Record<string, unknown>>;
} {
  return {
    sessions: database.prepare("SELECT * FROM claude_code_sessions").all() as Array<Record<string, unknown>>,
    idlePeriods: database.prepare("SELECT * FROM claude_code_idle_periods").all() as Array<Record<string, unknown>>,
  };
}

/**
 * Re-inserts whatever {@link preserveClaudeCodeActivity} read, but only for a `session_id` that
 * still exists after the rebuild -- `sessions` is itself a synced table (its id survives a
 * rebuild unchanged, since `buildSnapshotEntries` uses `row["id"]` directly as its rowUuid and
 * `applySessionUpsert` inserts with that same id), so a session captured by *any* device's
 * snapshot/oplog has somewhere for its activity rows to re-link to. A session that only ever
 * existed in this device's own discarded stale history does not survive either, so there is
 * nothing left for its activity rows to reference -- consistent with FR-019's own "discards its
 * own stale history" contract, not a new loss. Returns how many `claude_code_sessions` rows could
 * not be restored, so the caller can name that residual loss in the rebuild notice (Transparency,
 * `prd.md:133`) instead of leaving it undisclosed.
 */
function restoreClaudeCodeActivity(
  database: DbHandle,
  preserved: { sessions: Array<Record<string, unknown>>; idlePeriods: Array<Record<string, unknown>> },
): number {
  if (preserved.sessions.length === 0) return 0;

  const survivingSessionIds = new Set(
    (database.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map((r) => r.id),
  );
  const survivingSessions = preserved.sessions.filter((row) => survivingSessionIds.has(row["session_id"] as string));
  const survivingCcSessionIds = new Set(survivingSessions.map((row) => row["id"] as string));

  const restore = database.transaction(() => {
    for (const row of survivingSessions) {
      const columns = Object.keys(row);
      database
        .prepare(`INSERT INTO claude_code_sessions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((c) => row[c]));
    }
    for (const row of preserved.idlePeriods) {
      if (!survivingCcSessionIds.has(row["cc_session_id"] as string)) continue;
      const columns = Object.keys(row);
      database
        .prepare(
          `INSERT INTO claude_code_idle_periods (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .run(...columns.map((c) => row[c]));
    }
  });
  restore();

  return preserved.sessions.length - survivingSessions.length;
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
  // H3-B1: read before the wipe -- see preserveClaudeCodeActivity's own doc comment for why this
  // machine-local activity would otherwise be silently cascaded away by `DELETE FROM sessions`.
  const preservedActivity = preserveClaudeCodeActivity(database);

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

  // H3-B1: re-link every claude_code_sessions/idle_periods row whose parent session survived.
  const droppedActivityCount = restoreClaudeCodeActivity(database, preservedActivity);

  markSyncedNow(database, now);
  addSyncNotice(
    database,
    "stale-machine-rebuild",
    "This machine was offline for more than 90 days, so it rebuilt from the latest snapshot instead of replaying its own stale history.",
    `snapshot from ${snapshot.deviceId} created ${snapshot.createdAt}`
      + (backupPath !== null ? `; pre-rebuild backup at ${backupPath}` : "")
      // H3-B1 (prd.md:133 Transparency): name what was lost, in the rare case a Claude Code
      // session's own parent session did not survive the rebuild (only this device's own
      // discarded stale history, never published anywhere -- see restoreClaudeCodeActivity).
      + (droppedActivityCount > 0
        ? `; ${droppedActivityCount} local Claude Code session record(s) could not be restored (their parent session did not survive the rebuild)`
        : ""),
  );
  return true;
}
