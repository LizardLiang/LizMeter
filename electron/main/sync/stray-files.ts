// electron/main/sync/stray-files.ts
// FR-032: reports any file in the shared sync folder that this app did not itself write, most
// notably a cloud-drive "conflicted copy" rename -- the exact "silent fork" scenario the PRD's
// own Executive Summary names as a cause of today's data loss. The reserved `"stray-file"`
// notice kind (notices.ts) existed since Milestone 8 but nothing ever constructed one; this is
// that missing scan.
//
// Deliberately conservative: a file this app does not recognize is reported, never deleted or
// otherwise touched. Idempotent-by-`opId` merging already limits how badly a same-content fork
// can corrupt state, so silence -- not destructive cleanup -- was always the named risk to close.

import type Database from "better-sqlite3";
import fs from "node:fs";
import { getSyncDevicesDir } from "./oplog.ts";
import { addSyncNotice } from "./notices.ts";

type DbHandle = Database.Database;

const OPLOG_SUFFIX = ".oplog.jsonl";
const SNAPSHOT_SUFFIX = ".snapshot.json";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isExpectedName(name: string): boolean {
  if (name.endsWith(OPLOG_SUFFIX)) return UUID_RE.test(name.slice(0, -OPLOG_SUFFIX.length));
  if (name.endsWith(SNAPSHOT_SUFFIX)) return UUID_RE.test(name.slice(0, -SNAPSHOT_SUFFIX.length));
  return false;
}

/** True once a stray-file notice already exists for this exact filename, dismissed or not --
 *  the scan runs on every merge pass (as often as every 30 seconds), so without this a single
 *  conflicted-copy file would otherwise spam a fresh notice on every pass forever. */
function alreadyNoticed(database: DbHandle, name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sync_notices WHERE kind = 'stray-file' AND detail = ?").get(name) !== undefined
  );
}

/**
 * Scans `<dataDir>/sync/devices/` for any filename that is not a device's own
 * `<uuid>.oplog.jsonl` or `<uuid>.snapshot.json`, and raises one `sync_notices` row (kind
 * `"stray-file"`) per unrecognized name the first time it is seen.
 */
export function scanForStrayFiles(database: DbHandle, dataDir: string): void {
  const dir = getSyncDevicesDir(dataDir);
  if (!fs.existsSync(dir)) return;

  for (const name of fs.readdirSync(dir)) {
    if (isExpectedName(name)) continue;
    if (alreadyNoticed(database, name)) continue;
    addSyncNotice(
      database,
      "stray-file",
      "An unexpected file was found in the sync folder. It was left in place -- check whether your cloud drive created a conflicted copy.",
      name,
    );
  }
}
