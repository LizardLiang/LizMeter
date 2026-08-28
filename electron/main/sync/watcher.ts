// electron/main/sync/watcher.ts
// FR-013: watches the shared folder continuously, and re-scans it on a slower timer regardless
// of whether any filesystem event ever fires -- cloud-drive clients do not reliably emit clean
// events, so the periodic path is not a fallback for a rare failure, it is the mechanism that
// actually guarantees the PRD's 60-second target. Mirrors the existing `fs.watch` + fallback
// poll pattern already established in `claude-code-tracker.ts`, including its Windows caveat.

import fs from "node:fs";
import { getSyncDevicesDir } from "./oplog.ts";

/** Comfortably under the PRD's 60-second target, leaving margin for the cloud drive's own delay. */
const PERIODIC_RESCAN_MS = 30_000;

export interface SyncWatcher {
  stop(): void;
}

/**
 * Starts watching `<dataDir>/sync/devices/` and calls `onChange` on any event, plus once every
 * {@link PERIODIC_RESCAN_MS} regardless. `onChange` is expected to run its own merge pass and
 * must not throw for a routine "nothing new" result -- see sync-manager.ts's `runMergePassSafely`.
 */
export function startWatching(dataDir: string, onChange: () => void): SyncWatcher {
  const dir = getSyncDevicesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  let fsWatcher: fs.FSWatcher | null = null;
  try {
    fsWatcher = fs.watch(dir, () => onChange());
    fsWatcher.on("error", (err) => {
      console.warn("[sync] watcher error:", err);
    });
  } catch (err) {
    // fs.watch can throw outright on some platforms/filesystems -- the periodic re-scan below
    // still covers this device, just less promptly. This is exactly what FR-013 exists for.
    console.warn("[sync] fs.watch unavailable, relying on periodic re-scan:", err);
  }

  const interval = setInterval(() => onChange(), PERIODIC_RESCAN_MS);

  return {
    stop(): void {
      fsWatcher?.close();
      clearInterval(interval);
    },
  };
}
