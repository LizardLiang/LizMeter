// electron/main/sync/device-identity.ts
// Machine identity for multi-writer sync: a permanent per-device UUID, independent of any data
// folder move, plus the counter this device hands out todo numbers from.
//
// Todo numbers are DENSE and sequential (1, 2, 3...) on every machine, not carved into per-device
// blocks. Two machines creating todos while unable to see each other will therefore claim the same
// number, and that is expected: the collision is resolved at merge time (see merge-engine.ts's
// `resolveTodoIdCollision`), because a todo's id is the handle the user references it by and a
// 15-digit block-allocated number is not usable as one. The block scheme this replaced produced
// ids like 473829100000001 on every machine except the one that originated the shared folder.
//
// The device id lives in device-identity.json next to data-location.json, in Electron's own
// userData folder -- never the (possibly shared, possibly moved) data folder. Identity must
// survive a data-folder move; the pointer to *where the data is* must not decide *who this
// machine is*.
//
// Deliberately free of a `database.ts` import: every function here takes the already-open
// `Database.Database` handle and reads/writes the `settings` / `sync_devices` tables directly,
// so this module has no circular dependency on database.ts (which calls into this module).

import { app } from "electron";
import type Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSyncDevicesDir } from "./oplog.ts";

type DbHandle = Database.Database;

const IDENTITY_FILE_NAME = "device-identity.json";

const DEVICE_NUMBER_KEY = "sync.deviceNumber";
const NEXT_TODO_ID_KEY = "sync.nextTodoId";

/**
 * The stride the retired block scheme used: an id at or above this could only ever have been
 * handed out as `deviceNumber * stride + counter`. Kept solely so the one-time renumber
 * (`renumberBlockAllocatedTodoIds`) can recognize the ids it must fold into the dense run --
 * nothing allocates against it any more.
 */
export const LEGACY_TODO_ID_BLOCK_STRIDE = 100_000_000;

/**
 * Exclusive upper bound for a randomly drawn device number. Device 0 is reserved -- see below.
 *
 * The tactical plan's own draft used `4_000_000_000`, reasoned as "roughly 4.29 x 10^17
 * addressable ids overall." That arithmetic assumed unlimited-precision integers; a todo id is a
 * plain JS `number`, safe only up to `Number.MAX_SAFE_INTEGER` (~9.007 x 10^15). A test caught
 * this: `4e9 * 1e8` silently loses precision and can produce two different counters that stringify
 * to the same id. `1e7` keeps the worst case (`(1e7 - 1) * 1e8 + (1e8 - 1)` ~= 1.000000001e15)
 * comfortably inside the safe range, while still leaving ten million device slots -- far beyond
 * the PRD's stated scale of 2-3 personal machines (NFR: Scalability).
 */
const RANDOM_DEVICE_NUMBER_MAX = 10_000_000;

let cachedDeviceId: string | null = null;

function identityFilePath(): string {
  return path.join(app.getPath("userData"), IDENTITY_FILE_NAME);
}

/**
 * This machine's permanent identity. Generated once with `crypto.randomUUID()` and persisted
 * forever -- every oplog entry this device ever writes is stamped with it, so it must never
 * change once assigned.
 */
export function getDeviceId(): string {
  if (cachedDeviceId !== null) return cachedDeviceId;

  const file = identityFilePath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { deviceId?: unknown };
    if (typeof parsed.deviceId === "string" && parsed.deviceId.trim() !== "") {
      cachedDeviceId = parsed.deviceId;
      return cachedDeviceId;
    }
  } catch {
    // No file yet, or it is unreadable -- either way, mint a fresh identity below.
  }

  const deviceId = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ deviceId }, null, 2)}\n`, "utf8");
  cachedDeviceId = deviceId;
  return deviceId;
}

/** Test-only: forgets the cached id so a test can point `app.getPath` at a fresh folder. */
export function invalidateDeviceIdCache(): void {
  cachedDeviceId = null;
}

function readSetting(database: DbHandle, key: string): string | null {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(database: DbHandle, key: string, value: string): void {
  database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

/**
 * True when `dataDir`'s shared sync folder holds no device's oplog file yet -- the only signal
 * that may award device number 0 (see {@link getOrAssignDeviceNumber}'s header comment for why
 * local row count is not that signal). A folder a device is only now about to publish into for
 * the first time reads as virgin; a folder any peer has ever written to, even one this device has
 * never synced with before, does not.
 */
function isVirginSyncFolder(dataDir: string): boolean {
  const dir = getSyncDevicesDir(dataDir);
  if (!fs.existsSync(dir)) return true;
  return !fs.readdirSync(dir).some((name) => name.endsWith(".oplog.jsonl"));
}

/**
 * The integer this device hands out todo numbers from. Read from `settings` (machine-local per
 * FR-003) and assigned exactly once, lazily, the first time it is needed.
 *
 * Device number 0 is reserved for the one device that *creates* a shared sync folder -- the one
 * whose first sync-enabling act finds no peer's oplog file there yet (`dataDir` provided, and
 * {@link isVirginSyncFolder} true). This used to be inferred from whether this device's own local
 * `todos` table already held rows, on the reasoning that a populated database must be the
 * pre-existing "legacy" machine (FR-016). That inference broke the moment any device's working
 * database could legitimately be non-empty independent of sync history -- which is exactly what
 * moving every device's live database to a private per-machine location (see data-location.ts's
 * `getDbDir`) makes routine: an adopting device that used LizMeter standalone for months before
 * ever touching sync has a very populated local database and must still draw a random block, not
 * block 0, because another device already originated the shared folder it is joining. Every case
 * other than "this device is originating a brand-new shared folder" draws a random block,
 * collision-checked against every peer this device has ever seen in `sync_devices` -- including a
 * device that has plenty of its own local data but is joining a shared folder for the first time.
 *
 * `dataDir` is omitted by every call site except the two that ever perform a first-ever
 * assignment (migration.ts's `runSyncMigration`, sync-manager.ts's adopt branch) -- every other
 * caller (merge-engine.ts, snapshot.ts, sync-writer.ts) only ever runs once sync is already
 * enabled, meaning a number was necessarily assigned already and `stored !== null` returns before
 * this parameter would matter. Omitting it always falls back to drawing at random rather than
 * ever assuming "0", since 0 is a one-time-only reservation that must never be inferred by
 * omission.
 */
export function getOrAssignDeviceNumber(database: DbHandle, dataDir?: string): number {
  const stored = readSetting(database, DEVICE_NUMBER_KEY);
  if (stored !== null) {
    const parsed = Number.parseInt(stored, 10);
    if (Number.isInteger(parsed)) return parsed;
  }

  const deviceNumber = dataDir !== undefined && isVirginSyncFolder(dataDir)
    ? 0
    : drawUnusedDeviceNumber(database);

  writeSetting(database, DEVICE_NUMBER_KEY, String(deviceNumber));
  return deviceNumber;
}

function drawUnusedDeviceNumber(database: DbHandle): number {
  const taken = new Set(
    (database.prepare("SELECT device_number FROM sync_devices").all() as Array<{ device_number: number }>)
      .map((r) => r.device_number),
  );
  // Collision odds against a 4-billion-wide draw are astronomically low at the PRD's stated
  // scale of 2-3 machines; the loop exists purely so a hit is provably handled, not ignored.
  let candidate = crypto.randomInt(1, RANDOM_DEVICE_NUMBER_MAX);
  while (taken.has(candidate)) {
    candidate = crypto.randomInt(1, RANDOM_DEVICE_NUMBER_MAX);
  }
  return candidate;
}

/**
 * The next todo id this device may hand out. Persists the incremented counter *before* returning,
 * so a crash between allocating and inserting loses at most one number and never reuses one.
 *
 * A high-water mark rather than `MAX(id) + 1`: deleting the newest todo must not free its number
 * for the next one. A number that has been issued is the handle the user references that todo by,
 * and handing it to a different todo later would silently repoint an existing reference -- the one
 * failure the dense-id design exists to prevent.
 */
export function allocateNextTodoId(database: DbHandle): number {
  const current = readTodoIdWatermark(database);
  writeSetting(database, NEXT_TODO_ID_KEY, String(current + 1));
  return current;
}

/** The watermark's current value, seeded from the existing rows the first time it is read. */
function readTodoIdWatermark(database: DbHandle): number {
  const stored = readSetting(database, NEXT_TODO_ID_KEY);
  const parsed = stored !== null ? Number.parseInt(stored, 10) : Number.NaN;
  if (Number.isInteger(parsed)) return parsed;

  // Unset: this device is either enabling sync over an existing database or has just rebuilt from
  // a peer's snapshot. Either way its current rows are the floor.
  const { maxId } = database.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos").get() as { maxId: number };
  return maxId + 1;
}

/**
 * Raises this device's watermark above every todo id a merge just applied, so a machine returning
 * from an offline window stops walking straight back into numbers its peer already used. Without
 * this, every todo the returning machine creates collides and has to be bumped -- correct, but
 * needless churn the user would see as their numbers moving.
 */
export function advanceTodoIdWatermark(database: DbHandle, seenMaxId: number): void {
  if (!Number.isInteger(seenMaxId) || seenMaxId <= 0) return;
  const current = readTodoIdWatermark(database);
  if (seenMaxId < current) return;
  writeSetting(database, NEXT_TODO_ID_KEY, String(seenMaxId + 1));
}

/** Registers (or refreshes) this device in the local peer registry. Idempotent. */
export function registerDevice(database: DbHandle, deviceId: string, deviceNumber: number): void {
  const now = new Date().toISOString();
  const existing = database.prepare("SELECT device_id FROM sync_devices WHERE device_id = ?").get(deviceId) as
    | { device_id: string }
    | undefined;
  if (existing) {
    database.prepare("UPDATE sync_devices SET last_seen_at = ? WHERE device_id = ?").run(now, deviceId);
    return;
  }
  database
    .prepare(
      "INSERT INTO sync_devices (device_id, device_number, first_seen_at, last_seen_at, last_applied_seq) VALUES (?, ?, ?, ?, 0)",
    )
    .run(deviceId, deviceNumber, now, now);
}
