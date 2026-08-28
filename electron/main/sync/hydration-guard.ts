// electron/main/sync/hydration-guard.ts
// FR-014: refuses to trust a shared-folder file that OneDrive Files-On-Demand has not fully
// downloaded yet. A not-yet-hydrated placeholder reads as truncated -- a dated 2026 report
// (anthropics/claude-code#62140) describes a 258 KB file reading back as 24 KB, silently.
//
// Deliberately platform-agnostic: this does not depend on a Windows reparse-point check (which
// would need a native addon). It verifies what was actually read against what the filesystem
// claims the file's size is, immediately before the read -- the exact symptom the cited case
// described, on any OS or cloud-drive client.

import fs from "node:fs";

/** Thrown by {@link readFileGuarded} when a file reads back shorter than `fs.statSync` reported. */
export class NotFullyHydratedError extends Error {
  constructor(public readonly filePath: string, public readonly expectedBytes: number, public readonly actualBytes: number) {
    super(
      `"${filePath}" is not fully downloaded (expected ${expectedBytes} bytes, read ${actualBytes}). ` +
        `Mark the shared folder "Always keep on this device" and try again.`,
    );
    this.name = "NotFullyHydratedError";
  }
}

/**
 * Reads a file's full bytes, refusing to hand back a partial read.
 *
 * The size is taken immediately before the read (not cached) since a placeholder can finish
 * hydrating between calls -- this function does not assume that once truncated, always
 * truncated. Any other read error (missing file, permission denied) propagates as-is; only a
 * short read gets the dedicated error type, since that is the one case a caller must react to
 * by halting the whole sync pass rather than treating the file as absent.
 */
export function readFileGuarded(filePath: string): Buffer {
  const expectedBytes = fs.statSync(filePath).size;
  const buf = fs.readFileSync(filePath);
  if (buf.length !== expectedBytes) {
    throw new NotFullyHydratedError(filePath, expectedBytes, buf.length);
  }
  return buf;
}
