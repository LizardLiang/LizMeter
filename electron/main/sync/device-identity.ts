// electron/main/sync/device-identity.ts
// Machine identity for multi-writer sync: a permanent per-device UUID, independent of any data
// folder move, plus the per-device "block" used to hand out permanent todo numbers (FR-004,
// FR-005) without coordination between machines.
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

type DbHandle = Database.Database;

const IDENTITY_FILE_NAME = "device-identity.json";

const DEVICE_NUMBER_KEY = "sync.deviceNumber";
const NEXT_LOCAL_COUNTER_KEY = "sync.nextLocalCounter";

/** Every synced todo id lives in `deviceNumber * TODO_ID_BLOCK_STRIDE + localCounter`. */
export const TODO_ID_BLOCK_STRIDE = 100_000_000;

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
 * The integer this device hands out todo numbers from. Read from `settings` (machine-local per
 * FR-003) and assigned exactly once, lazily, the first time it is needed.
 *
 * A database that already holds todos when this is first called is treated as the pre-existing
 * "legacy" machine and gets block 0 -- its existing ids 1..N already ARE `0 * stride + n`, so no
 * renumbering is needed (FR-016). Every other machine draws a random block, collision-checked
 * against every peer this device has ever seen in `sync_devices`.
 */
export function getOrAssignDeviceNumber(database: DbHandle): number {
  const stored = readSetting(database, DEVICE_NUMBER_KEY);
  if (stored !== null) {
    const parsed = Number.parseInt(stored, 10);
    if (Number.isInteger(parsed)) return parsed;
  }

  const { count } = database.prepare("SELECT COUNT(*) AS count FROM todos").get() as { count: number };
  const deviceNumber = count > 0 ? 0 : drawUnusedDeviceNumber(database);

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
 * The next permanent todo id this device may hand out. Persists the incremented counter before
 * returning, so a crash between allocating and inserting loses at most one number and never
 * reuses one.
 */
export function allocateNextTodoId(database: DbHandle): number {
  const deviceNumber = getOrAssignDeviceNumber(database);
  const stored = readSetting(database, NEXT_LOCAL_COUNTER_KEY);
  const parsedStored = stored !== null ? Number.parseInt(stored, 10) : Number.NaN;
  const current = Number.isInteger(parsedStored) ? parsedStored : initialLocalCounter(database, deviceNumber);

  writeSetting(database, NEXT_LOCAL_COUNTER_KEY, String(current + 1));
  return deviceNumber * TODO_ID_BLOCK_STRIDE + current;
}

/**
 * Seeds the counter so device 0 (the legacy machine) continues exactly where its existing
 * AUTOINCREMENT ids left off, and every other device starts its block at 1.
 */
function initialLocalCounter(database: DbHandle, deviceNumber: number): number {
  if (deviceNumber !== 0) return 1;
  const { maxId } = database.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos").get() as {
    maxId: number;
  };
  return maxId + 1;
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
