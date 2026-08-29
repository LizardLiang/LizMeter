// electron/main/sync/pending-action.ts
// A move-then-relaunch cannot carry JS state across the process boundary, so the decision of
// *what kind* of sync setup a folder move should trigger is written to a small marker file in
// Electron's own userData folder (never the data folder itself) right before `app.relaunch()`,
// and consumed once, synchronously, at the very start of the next `app.whenReady()`.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const MARKER_FILE_NAME = "pending-sync-action.json";

export type PendingSyncAction =
  | { action: "enable" }
  | { action: "adopt"; targetDir: string };

function markerPath(): string {
  return path.join(app.getPath("userData"), MARKER_FILE_NAME);
}

export function writePendingSyncAction(action: PendingSyncAction): void {
  fs.writeFileSync(markerPath(), `${JSON.stringify(action, null, 2)}\n`, "utf8");
}

/** Reads and deletes the marker in one call -- a crash between the two would otherwise replay
 *  a stale action forever. */
export function consumePendingSyncAction(): PendingSyncAction | null {
  const file = markerPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No marker file -- the ordinary case on every launch that isn't the one right after a
    // move. Not an error worth logging.
    return null;
  }

  fs.rmSync(file, { force: true });

  try {
    const parsed = JSON.parse(raw) as PendingSyncAction;
    if (parsed.action === "enable" || parsed.action === "adopt") return parsed;
    return null;
  } catch (err) {
    console.warn("[sync] ignoring unreadable pending-sync-action.json:", err);
    return null;
  }
}

/**
 * Discards the marker without acting on it (H-004). Used by the `data-location:move` handler
 * when a marker was written in anticipation of a move that then failed -- the action it
 * authorizes has nothing to act on (the folder was never actually repointed), so leaving the
 * marker in place would make the next launch retry a move that was refused, not interrupted.
 */
export function clearPendingSyncAction(): void {
  fs.rmSync(markerPath(), { force: true });
}
