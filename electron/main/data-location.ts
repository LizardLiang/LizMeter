// electron/main/data-location.ts
// Resolves where LizMeter keeps the user's data, and moves it when the user picks a new folder.
//
// The pointer to a custom folder cannot live in the database or the settings table — those are
// the very things being moved. It lives in `data-location.json` inside Electron's own userData
// folder, which never moves.
//
// Deliberately free of `ipcMain`, `dialog` and `database.ts`: the IPC surface lives in
// ipc-handlers.ts, and database.ts imports `getDataDir` from here, so an import back the other
// way would be a cycle.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** Basename of the SQLite file inside the data directory. */
export const DB_FILE_NAME = "lizmeter.db";

/** Subdirectory holding content-addressed attachment blobs. */
export const ATTACHMENTS_DIR_NAME = "attachments";

/** Name of the pointer file. Always read from and written to Electron's real userData folder. */
const POINTER_FILE_NAME = "data-location.json";

/**
 * The files a move carries over.
 *
 * Avatars, provider tokens, the yt-dlp binary and the music cache stay behind on purpose:
 * avatar paths are stored in the settings table as absolute paths and would break, tokens are
 * machine-bound secrets that have no business on a synced drive, and the rest is regenerable.
 *
 * The `-wal` and `-shm` siblings are normally gone after a checkpoint and close, but they are
 * copied when present so a move still carries every committed row if one survives.
 */
const MOVED_FILES = [DB_FILE_NAME, `${DB_FILE_NAME}-wal`, `${DB_FILE_NAME}-shm`] as const;

/** Why a move was refused. Mirrors `DataLocationMoveErrorCode` in src/shared/types.ts. */
export type MoveErrorCode = "SAME_DIR" | "NESTED" | "NOT_WRITABLE" | "TARGET_HAS_DATA" | "COPY_FAILED";

export type MoveDataResult =
  | { ok: true; dataDir: string }
  | { ok: false; code: MoveErrorCode; message: string };

export interface DataDirStatus {
  dataDir: string;
  defaultDataDir: string;
  isCustom: boolean;
  available: boolean;
}

/**
 * Resolved once per process. A successful move relaunches the app rather than repointing a live
 * connection, so nothing can invalidate this mid-run except `clearCustomDataDir` on the startup
 * recovery path — which resets it explicitly.
 */
let cachedDataDir: string | null = null;

/** Electron's per-user folder. Where the data lives unless the user moved it. */
export function getDefaultDataDir(): string {
  return app.getPath("userData");
}

function getPointerFilePath(): string {
  return path.join(getDefaultDataDir(), POINTER_FILE_NAME);
}

/** The custom folder recorded on disk, or null when the user never moved the data. */
function readPointer(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(getPointerFilePath(), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { dataDir?: unknown };
    const dir = parsed.dataDir;
    // A corrupt pointer is treated as absent rather than fatal: falling back to the default
    // folder keeps the app startable, and the user can just set the folder again.
    if (typeof dir !== "string" || dir.trim() === "") return null;
    return path.resolve(dir);
  } catch (err) {
    console.warn("[data-location] ignoring unreadable pointer file:", err);
    return null;
  }
}

function writePointer(dir: string | null): void {
  const file = getPointerFilePath();
  if (dir === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, `${JSON.stringify({ dataDir: dir }, null, 2)}\n`, "utf8");
}

/**
 * Where the database and attachments live.
 *
 * Never throws, and never silently falls back when the pointer names a folder that is missing —
 * returning the default there would open a fresh empty database and read as total data loss.
 * The caller that cares is the startup guard in index.ts, via {@link getDataDirStatus}.
 */
export function getDataDir(): string {
  if (cachedDataDir === null) {
    cachedDataDir = readPointer() ?? getDefaultDataDir();
  }
  return cachedDataDir;
}

/** Drops the cached resolution. Only the startup recovery path and tests need this. */
export function invalidateDataDirCache(): void {
  cachedDataDir = null;
}

/** Everything the Settings page and the startup guard need, in one non-throwing call. */
export function getDataDirStatus(): DataDirStatus {
  const dataDir = getDataDir();
  const defaultDataDir = getDefaultDataDir();
  return {
    dataDir,
    defaultDataDir,
    isCustom: path.resolve(dataDir) !== path.resolve(defaultDataDir),
    available: fs.existsSync(dataDir),
  };
}

/** Forgets the custom folder and goes back to the default. Leaves every file where it is. */
export function clearCustomDataDir(): void {
  writePointer(null);
  invalidateDataDirCache();
}

// --- Multi-writer sync: where this device's own lizmeter.db actually lives ---
//
// No device's live `lizmeter.db` (+ `-wal`/`-shm`) may ever sit inside the shared, cloud-synced
// folder -- not an adopting device, and not the first ("original") device that turns sync on
// either. That first-device gap was Milestone 6's own flagged shortcoming (see
// implementation-notes.md's Fix Round section): the correction below moves *every* device's
// working database into Electron's own private `userData` folder the moment sync is enabled on
// it, by whichever path (adopting a shared folder, or being the one that creates it). Before
// sync is ever turned on, nothing here is consulted and the database colocates with attachments
// at {@link getDataDir}, exactly as it did before this feature existed -- zero behavior change
// for a user who never enables sync. The markers live in userData, next to device-identity.json,
// so they survive every future data-folder move.

const ADOPTED_MARKER_FILE_NAME = "sync-adopted.json";
const PRIVATE_DB_MARKER_FILE_NAME = "sync-private-db.json";

function adoptedMarkerPath(): string {
  return path.join(getDefaultDataDir(), ADOPTED_MARKER_FILE_NAME);
}

function privateDbMarkerPath(): string {
  return path.join(getDefaultDataDir(), PRIVATE_DB_MARKER_FILE_NAME);
}

/** True once this device has adopted another machine's shared sync history (FR-017). Informational --
 *  {@link hasPrivateDb} is what actually governs where the database opens; every adopter also has
 *  a private db, but a device can have a private db without ever having adopted (see the "enable
 *  sync on the first machine" path in migration.ts). */
export function isAdoptedDevice(): boolean {
  return fs.existsSync(adoptedMarkerPath());
}

/**
 * Marks this device as an adopter, and implies {@link markPrivateDb}. Must be called before the
 * very first `initDatabase()` of the process that completes an adoption -- {@link getDbDir}
 * changes what it returns immediately, so the database that gets opened next is the private one,
 * never one already sitting in the shared folder.
 */
export function markDeviceAsAdopted(): void {
  fs.writeFileSync(adoptedMarkerPath(), `${JSON.stringify({ adoptedAt: new Date().toISOString() }, null, 2)}
`, "utf8");
  markPrivateDb();
}

/**
 * True once this device's live database lives privately in userData rather than the (possibly
 * shared) data folder -- set the moment sync is enabled on this device, by either path. Every
 * adopter satisfies this via {@link isAdoptedDevice}; the first device to turn sync on satisfies
 * it via its own explicit marker instead, since it did not adopt anyone else's history.
 */
export function hasPrivateDb(): boolean {
  return isAdoptedDevice() || fs.existsSync(privateDbMarkerPath());
}

/**
 * Marks this device's database as private without claiming it adopted anything. Called by the
 * "enable sync on an already-populated machine" path (migration.ts), before the very first
 * `initDatabase()` after the user pointed Data Location at a shared folder -- same ordering
 * requirement as {@link markDeviceAsAdopted}.
 */
export function markPrivateDb(): void {
  if (fs.existsSync(privateDbMarkerPath())) return;
  fs.writeFileSync(privateDbMarkerPath(), `${JSON.stringify({ privateSince: new Date().toISOString() }, null, 2)}
`, "utf8");
}

/**
 * Timestamped backup of a SQLite database plus its `-wal`/`-shm` siblings, when present (H3-B2).
 * Shared by every destructive-step backup in this feature: {@link backupExistingPrivateDbBeforeAdopt}
 * below, `migration.ts`'s `backupBeforeSyncMigration`, and `snapshot.ts`'s `backupBeforeRebuild`.
 * Before this, each had its own byte-for-byte copy of the same "timestamp, transfer three files,
 * return the path" logic -- a correctness invariant (the `-wal`/`-shm` siblings must travel
 * together, or a WAL-mode backup is inconsistent), not boilerplate, so a future fix to this
 * mechanic (e.g. checkpointing before the copy) needed to land in three places to actually apply
 * everywhere.
 *
 * `mode: "copy"` leaves the original in place (the sync-migration and stale-rebuild backups,
 * whose caller keeps using the original afterward); `mode: "move"` renames the original away (the
 * pre-adopt backup, whose caller is about to open a fresh file at that exact path).
 *
 * Returns `null`, doing nothing, for `:memory:` or a path that does not currently exist -- every
 * caller treats "nothing to back up" as a safe no-op, not a failure.
 */
export function backupDbWithSiblings(dbPath: string, tag: string, mode: "copy" | "move"): string | null {
  if (dbPath === ":memory:" || !fs.existsSync(dbPath)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-${tag}-${stamp}.bak`;
  const transfer = mode === "copy" ? fs.copyFileSync : fs.renameSync;
  transfer(dbPath, backupPath);
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${dbPath}${suffix}`;
    if (fs.existsSync(side)) transfer(side, `${backupPath}${suffix}`);
  }
  return backupPath;
}

/**
 * Renames any database already sitting at this device's private db location out of the way,
 * before it is about to be adopted-into (FR-017's "rebuild a fresh local database").
 *
 * Without this, a device that used LizMeter standalone for months before ever touching sync
 * would have `initDatabase()` open -- and `rebuildFromSnapshot` then wipe -- its own real
 * history: its private db location (`userData`) is exactly where that pre-existing database
 * already lives, since every device's database sits there by default until it is deliberately
 * moved. Must be called after {@link markDeviceAsAdopted} and before the very first
 * `initDatabase()` of the process completing the adoption. Returns the backup's path (for
 * FR-017's "surface the old file's location"), or `null` when there was nothing there to move.
 */
export function backupExistingPrivateDbBeforeAdopt(): string | null {
  const dbPath = path.join(getDefaultDataDir(), DB_FILE_NAME);
  return backupDbWithSiblings(dbPath, "adopt", "move");
}

/**
 * Where `lizmeter.db` itself lives. Identical to {@link getDataDir} for every device that has
 * never enabled sync -- zero behavior change for the existing single-writer case. Once sync is
 * enabled, by any path, the database lives in Electron's own userData instead, private to this
 * machine; only oplogs, snapshots, and attachments ever live in the shared folder from that point
 * on (see {@link relocateDbToPrivateStorage} for the one-time move that makes this true for the
 * device that *creates* a shared folder, and the adopt path in sync-manager.ts for the device
 * that joins one).
 */
export function getDbDir(): string {
  return hasPrivateDb() ? getDefaultDataDir() : getDataDir();
}

/**
 * Copies this device's own `lizmeter.db` (+ `-wal`/`-shm`, when present) from `sourceDir` into
 * its private per-machine location (Electron's userData folder), if it is not already there.
 *
 * Used exactly once per device, the moment it turns sync on via the "first machine" path
 * (migration.ts's `enableSyncOnExistingMachine`): the live database must move out of whatever
 * folder Data Location was pointing at *before* that folder is repointed at (or already is) a
 * shared cloud folder, or it reproduces the exact corruption this feature exists to prevent. The
 * caller must checkpoint and close the database before calling, exactly like {@link moveDataTo}.
 * The old copy at `sourceDir` is left in place -- same "leave the original, the user can delete
 * it" convention {@link moveDataTo} already follows.
 */
export function relocateDbToPrivateStorage(sourceDir: string): void {
  const source = path.resolve(sourceDir);
  const target = path.resolve(getDefaultDataDir());
  if (source === target) return; // already private -- nothing to move

  for (const name of MOVED_FILES) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(target, name));
  }
}

/** True when `child` is `parent` or sits underneath it. Case-insensitive on Windows. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Proves the process can actually write into `dir`, which `fs.access` cannot on Windows. */
function isWritable(dir: string): boolean {
  const probe = path.join(dir, `.lizmeter-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Points LizMeter at `targetDir`, copying the database and attachments there first.
 *
 * The caller must checkpoint and close the database before calling — copying an open SQLite file
 * can capture a half-written page. On success the caller relaunches; nothing here reopens
 * anything.
 *
 * `useExisting` skips the copy and adopts whatever database already sits in `targetDir`. Without
 * it a populated target is refused with `TARGET_HAS_DATA` so a move can never silently overwrite
 * one set of todos with another.
 *
 * `copyDb` (default `true`) and `copyAttachments` (default `true`) let a sync-aware caller
 * (sync-manager.ts's pending-action handling in ipc-handlers.ts) split the two. A device turning
 * sync on must never let its database land inside the newly-shared `targetDir` — see
 * {@link relocateDbToPrivateStorage} for where its db actually goes instead — so that caller
 * passes `copyDb: false`. An adopting device additionally passes `copyAttachments: false`: it is
 * about to discard its own local rows wholesale (FR-017), so its own local attachments have
 * nothing to contribute to the shared pool and copying them in would only orphan them there.
 *
 * The db-file portion sources from {@link getDbDir}, not unconditionally from {@link getDataDir}
 * — once this device already has a private database (`hasPrivateDb()`), that private folder is
 * where its *live* database actually is, and `getDataDir()` no longer holds a database file at
 * all. Sourcing from `getDataDir()` unconditionally would either silently copy nothing (once no
 * device's db lives there any more) or, before this fix, could copy a peer's live database that
 * a stale assumption placed there. Attachments always source from `getDataDir()` — they are
 * correctly shared there for every device, synced or not.
 */
export function moveDataTo(
  targetDir: string,
  options: { useExisting?: boolean; copyDb?: boolean; copyAttachments?: boolean } = {},
): MoveDataResult {
  const copyDb = options.copyDb ?? true;
  const copyAttachments = options.copyAttachments ?? true;
  const source = path.resolve(getDataDir());
  const target = path.resolve(targetDir);

  if (source === target) {
    return { ok: false, code: "SAME_DIR", message: "That is already the current data folder." };
  }

  // Copying a folder into itself would recurse. The other direction is fine: the old copy just
  // ends up sitting inside the new folder, where the user can see and delete it.
  if (isInside(target, source)) {
    return {
      ok: false,
      code: "NESTED",
      message: "Pick a folder outside the current data folder.",
    };
  }

  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      code: "NOT_WRITABLE",
      message: `Could not create that folder: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isWritable(target)) {
    return { ok: false, code: "NOT_WRITABLE", message: "That folder is not writable." };
  }

  // The refusal only makes sense when this call might actually place a db file in `target` --
  // a sync enable/adopt caller with `copyDb: false` has already made its own placement decision
  // and this check would otherwise false-negative once no device's db lives in a shared folder
  // any more (see this function's own header comment).
  const targetDb = path.join(target, DB_FILE_NAME);
  const targetHasData = copyDb && fs.existsSync(targetDb);
  if (targetHasData && options.useExisting !== true) {
    return {
      ok: false,
      code: "TARGET_HAS_DATA",
      message: "That folder already holds a LizMeter database.",
    };
  }

  try {
    if (copyDb && !targetHasData) {
      copyDbInto(getDbDir(), target);
    }
    if (copyAttachments) {
      copyAttachmentsInto(source, target);
    }
  } catch (err) {
    return {
      ok: false,
      code: "COPY_FAILED",
      message: `Could not copy the data: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // The pointer is written last. A crash mid-copy therefore leaves the app pointed at the intact
  // original, with a partial copy in the target that the next attempt overwrites.
  try {
    writePointer(path.resolve(target) === path.resolve(getDefaultDataDir()) ? null : target);
  } catch (err) {
    return {
      ok: false,
      code: "COPY_FAILED",
      message: `Copied the data but could not record the new location: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  cachedDataDir = target;
  return { ok: true, dataDir: target };
}

function copyDbInto(source: string, target: string): void {
  for (const name of MOVED_FILES) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(target, name));
  }
}

function copyAttachmentsInto(source: string, target: string): void {
  const attachmentsFrom = path.join(source, ATTACHMENTS_DIR_NAME);
  if (!fs.existsSync(attachmentsFrom)) return;
  // Blobs are named by their own sha256, so a file already present in the target is byte-identical.
  // `force: false` merges instead of overwriting, which keeps the copy cheap on a retry.
  fs.cpSync(attachmentsFrom, path.join(target, ATTACHMENTS_DIR_NAME), {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}
