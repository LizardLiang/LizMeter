// electron/main/sync/merge-pass.ts
// Reads every peer's oplog file from the shared folder and applies new entries to the local
// database. Called by the watcher (Milestone 5) on every filesystem event and periodic re-scan,
// and directly by tests via `src/test/two-device-harness.ts`.

import type Database from "better-sqlite3";
import fs from "node:fs";
import { applyOplogEntries, type ApplyResult } from "./merge-engine.ts";
import { getSyncDevicesDir, readOplogEntries, type OplogEntry } from "./oplog.ts";

/**
 * Reads every `*.oplog.jsonl` file in the shared folder except this device's own (a device
 * never reads its own file back as input) and applies whatever is new. Safe to call repeatedly:
 * idempotent by `opId` (Milestone 3).
 */
export function runMergePass(database: Database.Database, dataDir: string, ownDeviceId: string): ApplyResult {
  const dir = getSyncDevicesDir(dataDir);
  if (!fs.existsSync(dir)) return { applied: 0, skippedAlreadyApplied: 0, notices: 0 };

  const entries: OplogEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".oplog.jsonl")) continue;
    const deviceId = name.slice(0, -".oplog.jsonl".length);
    if (deviceId === ownDeviceId) continue;
    const { entries: fileEntries } = readOplogEntries(`${dir}/${name}`);
    entries.push(...fileEntries);
  }

  return applyOplogEntries(database, entries);
}
