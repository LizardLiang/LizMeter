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
// A device that adopted another machine's shared history (FR-017) must never open its working
// database at a path inside the (possibly shared) data folder -- see the tactical plan's
// Milestone 6 correction in implementation-notes.md: if it did, and the user's Data Location
// also names the same shared cloud folder, a second machine's rebuild would silently overwrite
// the first machine's live database file at the exact same path, reproducing the corruption
// this feature exists to prevent. The marker lives in userData, next to device-identity.json,
// so it survives every future data-folder move.

const ADOPTED_MARKER_FILE_NAME = "sync-adopted.json";

function adoptedMarkerPath(): string {
  return path.join(getDefaultDataDir(), ADOPTED_MARKER_FILE_NAME);
}

/** True once this device has adopted another machine's shared sync history (FR-017). */
export function isAdoptedDevice(): boolean {
  return fs.existsSync(adoptedMarkerPath());
}

/**
 * Marks this device as an adopter. Must be called before the very first `initDatabase()` of the
 * process that completes an adoption -- {@link getDbDir} changes what it returns immediately, so
 * the database that gets opened next is the private one, never one already sitting in the
 * shared folder.
 */
export function markDeviceAsAdopted(): void {
  fs.writeFileSync(adoptedMarkerPath(), `${JSON.stringify({ adoptedAt: new Date().toISOString() }, null, 2)}
`, "utf8");
}

/**
 * Where `lizmeter.db` itself lives. Identical to {@link getDataDir} for every device that has
 * never adopted -- zero behavior change for the existing single-writer case and for the first
 * machine that turns sync on (its db legitimately continues living in its chosen folder, safe
 * because no other device ever opens that exact path). An adopted device's working database
 * lives in Electron's own userData instead, private to this machine.
 */
export function getDbDir(): string {
  return isAdoptedDevice() ? getDefaultDataDir() : getDataDir();
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
 */
export function moveDataTo(targetDir: string, options: { useExisting?: boolean } = {}): MoveDataResult {
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

  const targetDb = path.join(target, DB_FILE_NAME);
  const targetHasData = fs.existsSync(targetDb);
  if (targetHasData && options.useExisting !== true) {
    return {
      ok: false,
      code: "TARGET_HAS_DATA",
      message: "That folder already holds a LizMeter database.",
    };
  }

  if (!targetHasData) {
    try {
      copyDataInto(source, target);
    } catch (err) {
      return {
        ok: false,
        code: "COPY_FAILED",
        message: `Could not copy the data: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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

function copyDataInto(source: string, target: string): void {
  for (const name of MOVED_FILES) {
    const from = path.join(source, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(target, name));
  }

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
