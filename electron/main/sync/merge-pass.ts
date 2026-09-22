// electron/main/sync/merge-pass.ts
// Reads every peer's oplog file from the shared folder and applies new entries to the local
// database. Called by the watcher (Milestone 5) on every filesystem event and periodic re-scan,
// and directly by tests via `src/test/two-device-harness.ts`.

import type Database from "better-sqlite3";
import fs from "node:fs";
import { applyOplogEntries, type ApplyResult } from "./merge-engine.ts";
import { addSyncNotice } from "./notices.ts";
import { getSyncDevicesDir, readOplogEntries, type OplogEntry } from "./oplog.ts";

interface SkippedOplogFile {
  name: string;
  count: number;
}

/**
 * Persists one Settings notice for each distinct observed set of unreadable peer entries. The
 * same append-only oplog is scanned every 30 seconds, so including dismissed notices in this
 * lookup prevents an unchanged peer file from creating an endless stream of duplicates.
 */
function reportSkippedEntries(database: Database.Database, files: SkippedOplogFile[]): void {
  if (files.length === 0) return;

  const sortedFiles = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const total = sortedFiles.reduce((sum, file) => sum + file.count, 0);
  const detail = sortedFiles.map((file) => `${file.name}: ${file.count} skipped`).join("; ");
  const alreadyReported = database
    .prepare("SELECT 1 FROM sync_notices WHERE kind = 'oplog-entry-skipped' AND detail = ?")
    .get(detail) !== undefined;
  if (alreadyReported) return;

  const entryNoun = total === 1 ? "entry" : "entries";
  const logNoun = sortedFiles.length === 1 ? "a peer sync log" : `${sortedFiles.length} peer sync logs`;
  const verb = total === 1 ? "was" : "were";
  addSyncNotice(
    database,
    "oplog-entry-skipped",
    `${total} ${entryNoun} in ${logNoun} ${verb} skipped because this version of LizMeter could not read them.`,
    detail,
  );
}

/**
 * Reads every `*.oplog.jsonl` file in the shared folder except this device's own (a device
 * never reads its own file back as input) and applies whatever is new. Safe to call repeatedly:
 * idempotent by `opId` (Milestone 3).
 */
export function runMergePass(database: Database.Database, dataDir: string, ownDeviceId: string): ApplyResult {
  const dir = getSyncDevicesDir(dataDir);
  if (!fs.existsSync(dir)) return { applied: 0, skippedAlreadyApplied: 0, notices: 0 };

  const entries: OplogEntry[] = [];
  const skippedFiles: SkippedOplogFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".oplog.jsonl")) continue;
    const deviceId = name.slice(0, -".oplog.jsonl".length);
    if (deviceId === ownDeviceId) continue;
    const { entries: fileEntries, skipped } = readOplogEntries(`${dir}/${name}`);
    entries.push(...fileEntries);
    if (skipped > 0) skippedFiles.push({ name, count: skipped });
  }

  reportSkippedEntries(database, skippedFiles);
  return applyOplogEntries(database, entries);
}
