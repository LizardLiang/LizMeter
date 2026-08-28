// electron/main/sync/hlc.ts
// Hybrid Logical Clock: keeps causal order across devices correct while staying close to
// wall-clock time, which matters for retention (Milestone 7's 90-day window) and for reading
// the oplog by eye. Actual Budget -- the closest real analog researched for this feature --
// uses exactly this instead of a plain Lamport clock.
//
// An HLC value compares as the tuple (physicalMs, counter, deviceNumber) in that order: a later
// physicalMs always wins, a tie on physicalMs falls to counter, and a tie on both falls to
// deviceNumber as the final deterministic tie-break -- two distinct devices can never produce
// values that compare equal.

import type Database from "better-sqlite3";

type DbHandle = Database.Database;

export interface Hlc {
  physicalMs: number;
  counter: number;
  deviceNumber: number;
}

const PHYSICAL_MS_KEY = "sync.hlcPhysicalMs";
const COUNTER_KEY = "sync.hlcCounter";

/** A remote clock more than this far ahead of ours is clamped rather than trusted (FR-033). */
export const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000;

function readState(database: DbHandle): { physicalMs: number; counter: number } {
  const rows = database
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
    .all(PHYSICAL_MS_KEY, COUNTER_KEY) as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const physicalMs = Number.parseInt(map.get(PHYSICAL_MS_KEY) ?? "0", 10);
  const counter = Number.parseInt(map.get(COUNTER_KEY) ?? "0", 10);
  return {
    physicalMs: Number.isInteger(physicalMs) ? physicalMs : 0,
    counter: Number.isInteger(counter) ? counter : 0,
  };
}

function writeState(database: DbHandle, physicalMs: number, counter: number): void {
  database
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(PHYSICAL_MS_KEY, String(physicalMs));
  database
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(COUNTER_KEY, String(counter));
}

/**
 * Ticks the clock for a local write. Persisted after every tick, so a restart never regresses
 * time: `physicalMs` always moves forward even across a system clock that runs backward.
 */
export function tick(database: DbHandle, deviceNumber: number, now: number = Date.now()): Hlc {
  const { physicalMs: lastPhysicalMs, counter: lastCounter } = readState(database);
  const physicalMs = Math.max(now, lastPhysicalMs);
  const counter = physicalMs === lastPhysicalMs ? lastCounter + 1 : 0;
  writeState(database, physicalMs, counter);
  return { physicalMs, counter, deviceNumber };
}

export interface ReceiveResult {
  hlc: Hlc;
  /** True when the remote clock was implausibly far ahead and got clamped (FR-033). */
  clamped: boolean;
}

/**
 * Merges a remote HLC value on ingest -- the standard HLC merge rule, applied whenever this
 * device applies an oplog entry from a peer. A remote clock more than {@link MAX_CLOCK_DRIFT_MS}
 * ahead of local wall-clock time is clamped to `now + MAX_CLOCK_DRIFT_MS` rather than trusted
 * outright, so one bad clock cannot poison this device's own future ordering without bound.
 */
export function receive(
  database: DbHandle,
  deviceNumber: number,
  remote: Hlc,
  now: number = Date.now(),
): ReceiveResult {
  const clamped = remote.physicalMs - now > MAX_CLOCK_DRIFT_MS;
  const effectiveRemoteMs = clamped ? now + MAX_CLOCK_DRIFT_MS : remote.physicalMs;

  const { physicalMs: lastPhysicalMs, counter: lastCounter } = readState(database);
  const physicalMs = Math.max(lastPhysicalMs, effectiveRemoteMs, now);

  let counter: number;
  if (physicalMs === lastPhysicalMs && physicalMs === effectiveRemoteMs) {
    counter = Math.max(lastCounter, remote.counter) + 1;
  } else if (physicalMs === lastPhysicalMs) {
    counter = lastCounter + 1;
  } else if (physicalMs === effectiveRemoteMs) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }

  writeState(database, physicalMs, counter);
  return { hlc: { physicalMs, counter, deviceNumber }, clamped };
}

/** Tuple compare: physicalMs, then counter, then deviceNumber as the final deterministic tie-break. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.physicalMs !== b.physicalMs) return a.physicalMs - b.physicalMs;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.deviceNumber - b.deviceNumber;
}

/** True when `a` is strictly later than `b`. */
export function hlcAfter(a: Hlc, b: Hlc): boolean {
  return compareHlc(a, b) > 0;
}
