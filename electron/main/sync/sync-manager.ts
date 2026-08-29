// electron/main/sync/sync-manager.ts
// The top-level sync orchestrator (Milestone 5): starts the watcher and periodic re-scan on app
// ready, exposes status/enable/disable for the IPC surface (Milestone 8), and wires the Data
// Location "Change Folder..." flow to sync setup (Milestone 6) via a pending-action marker that
// survives the existing move-then-relaunch flow.

import type Database from "better-sqlite3";
import { Notification } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getCurrentDbPath, getDb } from "../database.ts";
import { getDataDir } from "../data-location.ts";
import { getDeviceId, getOrAssignDeviceNumber, registerDevice } from "./device-identity.ts";
import { NotFullyHydratedError } from "./hydration-guard.ts";
import { runMergePass } from "./merge-pass.ts";
import { enableSyncOnExistingMachine } from "./migration.ts";
import { addSyncNotice, listSyncNotices, dismissSyncNotice, type SyncNoticeRow } from "./notices.ts";
import {
  clearPendingSyncAction,
  consumePendingSyncAction,
  writePendingSyncAction,
  type PendingSyncAction,
} from "./pending-action.ts";
import { getLastSyncedAt, isStale, markSyncedNow, rebuildFromSnapshot, writeSnapshotIfDue } from "./snapshot.ts";
import { scanForStrayFiles } from "./stray-files.ts";
import { isSyncEnabled, setSyncEnabled } from "./sync-writer.ts";
import { startWatching, type SyncWatcher } from "./watcher.ts";
import type { SyncDeviceInfo, SyncStatus } from "../../../src/shared/types.ts";

type DbHandle = Database.Database;

let watcher: SyncWatcher | null = null;
let lastSyncedAt: string | null = null;
let haltedReason: string | null = null;

/** A callback the caller (index.ts) wires up once, so this module never imports index.ts directly. */
let onTodosChanged: (() => void) | null = null;

export function setTodosChangedCallback(callback: () => void): void {
  onTodosChanged = callback;
}

/** FR-031: quiet by default, one OS notification for exactly the cases the user must act on. */
function notifyUser(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function runMergePassSafely(): void {
  const database = getDb();
  if (!isSyncEnabled(database)) return;

  const dataDir = getDataDir();
  const deviceId = getDeviceId();

  try {
    // FR-032: reported, never blocking -- a stray file (most commonly a cloud-drive conflicted
    // copy) must not stop the rest of this pass from running.
    scanForStrayFiles(database, dataDir);

    if (isStale(database)) {
      const rebuilt = rebuildFromSnapshot(database, dataDir, deviceId);
      if (rebuilt) {
        notifyUser(
          "LizMeter sync",
          "This machine was offline for a long time and rebuilt from the latest snapshot. Check Settings for details.",
        );
      }
    } else {
      const result = runMergePass(database, dataDir, deviceId);
      if (result.applied > 0) onTodosChanged?.();
      if (result.notices > 0) {
        notifyUser(
          "LizMeter sync",
          result.notices === 1
            ? "One edit was discarded during sync. Check Settings for details."
            : `${result.notices} edits were discarded during sync. Check Settings for details.`,
        );
      }
    }
    markSyncedNow(database);
    writeSnapshotIfDue(database, dataDir, deviceId);

    if (haltedReason !== null) haltedReason = null; // recovered from a previous halt
    lastSyncedAt = new Date().toISOString();
  } catch (err) {
    if (err instanceof NotFullyHydratedError) {
      const isNewHalt = haltedReason === null;
      haltedReason = err.message;
      // Only raise a notice (and notify) on the transition into "halted", not on every
      // 30-second retry while still blocked -- FR-031 wants silence except when the user must
      // act, not a repeat alarm.
      if (isNewHalt) {
        addSyncNotice(database, "placeholder-blocked", err.message);
        notifyUser("LizMeter sync paused", err.message);
      }
      return;
    }
    console.warn("[sync] merge pass failed:", err);
  }
}

/** Starts the watcher and periodic re-scan. A strict no-op when sync has never been turned on. */
export function startSyncManager(): void {
  const database = getDb();
  if (!isSyncEnabled(database)) return;

  runMergePassSafely();
  watcher = startWatching(getDataDir(), runMergePassSafely);
}

export function stopSyncManager(): void {
  watcher?.stop();
  watcher = null;
}

// SyncDeviceInfo / SyncStatus are declared once, in src/shared/types.ts -- this main-process
// module and the renderer both need the exact same shape, and declaring it twice let the two
// definitions drift apart silently (caught only by luck, since nothing re-checked them against
// each other).

export function getSyncStatus(): SyncStatus {
  const database = getDb();
  const devices = database
    .prepare("SELECT device_id, device_number, last_seen_at FROM sync_devices ORDER BY first_seen_at ASC")
    .all() as Array<{ device_id: string; device_number: number; last_seen_at: string }>;

  return {
    enabled: isSyncEnabled(database),
    // Falls back to the persisted setting once the in-process value has never been set this
    // run (e.g. right after a restart, before the first merge pass completes) -- see
    // getLastSyncedAt's doc comment.
    lastSyncedAt: lastSyncedAt ?? getLastSyncedAt(database),
    halted: haltedReason !== null ? { reason: haltedReason } : null,
    devices: devices.map((d): SyncDeviceInfo => ({
      deviceId: d.device_id,
      deviceNumber: d.device_number,
      lastSeenAt: d.last_seen_at,
    })),
  };
}

export function listNotices(includeDismissed = false): SyncNoticeRow[] {
  return listSyncNotices(getDb(), includeDismissed);
}

export function dismissNotice(id: number): void {
  dismissSyncNotice(getDb(), id);
}

export function disableSync(): void {
  stopSyncManager();
  setSyncEnabled(getDb(), false);
}

// --- Milestone 6: wiring the Data Location move flow to sync setup ---

/** Todos and sessions are the "does this machine have real work worth protecting" signal --
 *  todo_states/todo_projects always hold seeded defaults even on a brand new install. */
function hasAnySyncableLocalData(database: DbHandle): boolean {
  for (const table of ["todos", "sessions"] as const) {
    const { count } = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    if (count > 0) return true;
  }
  return false;
}

/** True when `targetDir` already holds another device's oplog -- the FR-017 onboarding trigger. */
function targetHasOtherDevicesData(targetDir: string): boolean {
  const dir = path.join(targetDir, "sync", "devices");
  if (!fs.existsSync(dir)) return false;
  const myId = getDeviceId();
  return fs.readdirSync(dir).some((name) => name.endsWith(".oplog.jsonl") && !name.startsWith(myId));
}

/**
 * Called by the `data-location:move` IPC handler before `moveDataTo` runs, so the decision is
 * captured while this process still has its (about-to-close) database open. Returns `null` for
 * an ordinary relocate with nothing sync-relevant to do -- the existing Data Location behavior,
 * completely unchanged.
 */
export function decidePendingSyncAction(targetDir: string): PendingSyncAction | null {
  if (targetHasOtherDevicesData(targetDir)) {
    return { action: "adopt", targetDir };
  }
  const database = getDb();
  if (hasAnySyncableLocalData(database) && !isSyncEnabled(database)) {
    return { action: "enable" };
  }
  return null;
}

export { clearPendingSyncAction, writePendingSyncAction };

/**
 * R2-B1: the refusal that guards adoption. Picking a folder that holds another machine's synced
 * history must never be enough by itself to discard this device's own working set -- the user's
 * original decision ("backup + adopt, machine 2 adopts rather than merges") explicitly expects a
 * confirmation step, the same way `TARGET_HAS_DATA`/`SYNC_ENABLED_CONFIRM_REQUIRED` already work.
 * Extracted as its own pure function (rather than inlined in the `data-location:move` handler) so
 * the decision itself is unit-testable without standing up ipc-handlers.ts's full IPC surface,
 * which has no test file in this codebase.
 */
export function requiresAdoptConfirmation(
  pendingSyncAction: PendingSyncAction | null,
  confirmAdopt: boolean,
): boolean {
  return pendingSyncAction?.action === "adopt" && confirmAdopt !== true;
}

/**
 * Step 1 of 2, called at the very start of `app.whenReady()`, before `initDatabase()`. Marking
 * this device's database as private here (not after) is what makes {@link getDbDir} in
 * data-location.ts resolve to the private userData folder for the very first `initDatabase()`
 * call of this process -- see implementation-notes.md's Fix Round for why this ordering matters,
 * for both the "adopt" and "enable" actions.
 */
export function consumePendingSyncActionBeforeInit(): PendingSyncAction | null {
  return consumePendingSyncAction();
}

/** Step 2 of 2, called right after `initDatabase()` succeeds. */
export function applyPendingSyncActionAfterInit(pending: PendingSyncAction | null): void {
  if (pending === null) return;
  const database = getDb();

  if (pending.action === "enable") {
    // This machine's live database has already been relocated to its private location by the
    // data-location:move handler (relocateDbToPrivateStorage), before this process relaunched
    // into this step -- getDataDir() here names the *shared* folder it is publishing into, not
    // where its own database lives.
    const result = enableSyncOnExistingMachine(database, getCurrentDbPath(), getDataDir());
    // Without this, isStale() reads lastSyncedAt as null forever (a null-safe "never synced
    // yet, so not stale" per its own doc comment) whenever the very first merge pass throws
    // before reaching its own markSyncedNow call -- this machine could then never be recognized
    // as eligible for a stale-machine rebuild later, even if genuinely warranted.
    markSyncedNow(database);
    console.log(
      `[sync] enabled on this machine as device ${result.deviceNumber}` +
        (result.backupPath ? `, backup written to ${result.backupPath}` : ""),
    );
    return;
  }

  // pending.action === "adopt". By this point index.ts has already: marked this device as
  // adopted (private db), renamed any pre-existing database out of the way
  // (backupExistingPrivateDbBeforeAdopt), and initDatabase() has opened a genuinely fresh private
  // database as a result -- so rebuildFromSnapshot below has nothing of this device's own to lose.
  setSyncEnabled(database, true);

  const dataDir = getDataDir();
  const rebuilt = rebuildFromSnapshot(database, dataDir, getDeviceId());
  if (!rebuilt) {
    // No snapshot published anywhere yet -- fall back to replaying every peer's full oplog.
    runMergePass(database, dataDir, getDeviceId());
  }

  // B-2: `dataDir` is passed here (unlike merge-engine.ts's own internal calls, which never
  // have a first-assignment reason to), but in practice the actual draw already happened inside
  // rebuildFromSnapshot/runMergePass above -- applying entries needs a device number for HLC
  // tracking before this line ever runs. That is harmless precisely because an adopt's target
  // is never virgin (targetHasOtherDevicesData is what triggered "adopt" in the first place), so
  // omitting dataDir there still falls through to a random draw, never 0 -- the same outcome
  // this line's own dataDir argument would produce. This call's real job is simply reading back
  // whatever number got assigned, so registerDevice below can record it.
  const deviceNumber = getOrAssignDeviceNumber(database, dataDir);
  registerDevice(database, getDeviceId(), deviceNumber);
  markSyncedNow(database);
  console.log(`[sync] adopted shared data from ${pending.targetDir} as device ${deviceNumber}`);
}
