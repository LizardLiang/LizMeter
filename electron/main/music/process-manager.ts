// electron/main/music/process-manager.ts
// Manage yt-dlp child process lifecycle with concurrent keyed tracking and cleanup.
// v2.0: Redesigned for concurrent keyed processes (CRIT-02 fix).
// Uses spawn with argument arrays (no shell interpolation) for security.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { MusicError } from "./music-error.ts";
import { getYtDlpPath } from "./binary-manager.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface SpawnResult {
  process: ChildProcess;
  stdout: Readable;
  stderr: Readable;
}

export interface SpawnOptions {
  timeoutMs?: number;
  // v2.0 (MAJOR-02 fix): --no-playlist is prepended by default.
  // Set noPlaylist: false only for playlist-aware commands (detectPlaylist, extractPlaylistMetadata).
  noPlaylist?: boolean;
}

// Map<key, ChildProcess>: tracks all active yt-dlp processes by purpose key.
// Example keys: "stream:<trackId>", "metadata:<url>", "import:<url>", "detect:<url>"
const activeProcesses = new Map<string, ChildProcess>();

// Map<key, NodeJS.Timeout>: tracks timeout handles for cleanup on process exit.
const timeoutHandles = new Map<string, NodeJS.Timeout>();

/**
 * Spawn a yt-dlp process with the given argument array.
 *
 * Key semantics (v2.0 CRIT-02): If a process with the same key already exists,
 * it is killed first (replacement semantics). Processes with different keys run
 * concurrently without mutual interference.
 *
 * --no-playlist is automatically prepended unless options.noPlaylist === false.
 * This prevents accidental playlist downloads when a URL contains a ?list= parameter.
 */
export function spawnYtDlp(key: string, args: string[], options?: SpawnOptions): SpawnResult {
  const ytDlpPath = getYtDlpPath();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const noPlaylist = options?.noPlaylist !== false; // default true

  // Kill existing process for this key (replacement semantics)
  killProcess(key);

  // Prepend --no-playlist unless explicitly disabled
  const finalArgs = noPlaylist ? ["--no-playlist", ...args] : args;

  let child: ChildProcess;
  try {
    child = spawn(ytDlpPath, finalArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // Never shell: true — security requirement
      shell: false,
      windowsHide: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MusicError(`Failed to spawn yt-dlp: ${message}`, "EXTRACTION_FAILED");
  }

  if (!child.pid) {
    throw new MusicError("yt-dlp process failed to start (no PID)", "EXTRACTION_FAILED");
  }

  // Register in the active map
  activeProcesses.set(key, child);

  // Set up timeout
  const timeoutHandle = setTimeout(() => {
    if (activeProcesses.has(key) && activeProcesses.get(key) === child) {
      activeProcesses.delete(key);
      timeoutHandles.delete(key);
      // Mark this child as timed out so the exit handler can surface the error
      (child as ChildProcess & { __timedOut?: boolean }).__timedOut = true;
      killChildProcess(child);
    }
  }, timeoutMs);
  timeoutHandles.set(key, timeoutHandle);

  // Clean up map entry when process exits
  child.on("exit", () => {
    if (activeProcesses.get(key) === child) {
      activeProcesses.delete(key);
    }
    const handle = timeoutHandles.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      timeoutHandles.delete(key);
    }
  });

  child.on("error", (err) => {
    if (activeProcesses.get(key) === child) {
      activeProcesses.delete(key);
    }
    const handle = timeoutHandles.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      timeoutHandles.delete(key);
    }
    // Propagate to stderr stream so callers can observe it
    (child.stderr as Readable).destroy(err);
  });

  return {
    process: child,
    stdout: child.stdout as Readable,
    stderr: child.stderr as Readable,
  };
}

/**
 * Kill the process associated with the given key.
 * No-op if the key is not found.
 */
export function killProcess(key: string): void {
  const child = activeProcesses.get(key);
  if (!child) return;

  activeProcesses.delete(key);

  const handle = timeoutHandles.get(key);
  if (handle !== undefined) {
    clearTimeout(handle);
    timeoutHandles.delete(key);
  }

  killChildProcess(child);
}

/**
 * Kill all tracked processes.
 * Called from app.on("before-quit") for clean shutdown.
 */
export function killAll(): void {
  for (const [key, child] of activeProcesses) {
    activeProcesses.delete(key);

    const handle = timeoutHandles.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      timeoutHandles.delete(key);
    }

    killChildProcess(child);
  }
}

/**
 * Kill all processes whose key starts with the given prefix.
 * Used by music:stop to kill stream processes without killing metadata extractions.
 */
export function killByPrefix(prefix: string): void {
  for (const [key] of activeProcesses) {
    if (key.startsWith(prefix)) {
      killProcess(key);
    }
  }
}

/**
 * Awaitable variant of killByPrefix. Resolves once every matched process's kill
 * signal has actually been delivered (Windows: the `taskkill` helper process has
 * exited; POSIX: the child has exited or a short grace period has elapsed).
 * Callers that must not proceed until the OS-level file handles are released
 * (e.g. unlinking a cache file right after stopping the stream that serves it)
 * should await this instead of the fire-and-forget killByPrefix.
 */
export function killByPrefixAsync(prefix: string): Promise<void> {
  const waits: Promise<void>[] = [];

  for (const [key, child] of activeProcesses) {
    if (!key.startsWith(prefix)) continue;

    activeProcesses.delete(key);

    const handle = timeoutHandles.get(key);
    if (handle !== undefined) {
      clearTimeout(handle);
      timeoutHandles.delete(key);
    }

    waits.push(killChildProcessAwait(child));
  }

  return Promise.all(waits).then(() => undefined);
}

/**
 * Returns the number of currently active processes.
 * Useful for diagnostics and testing.
 */
export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

// --- Internal helpers ---

/**
 * Platform-aware process kill.
 * Windows: taskkill /pid <PID> /T /F (kills entire process tree including ffmpeg subprocesses)
 * POSIX: SIGKILL (immediate termination)
 */
function killChildProcess(child: ChildProcess): void {
  if (!child.pid) return;

  try {
    if (process.platform === "win32") {
      // taskkill /T kills the entire process tree, /F forces immediate termination.
      // child.kill() on Windows only kills the root process, leaving zombie ffmpeg processes.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Ignore errors during kill — process may have already exited
  }
}

// Grace period to wait for a POSIX child's "exit" event after SIGKILL before
// giving up and resolving anyway — SIGKILL is not synchronous.
const POSIX_KILL_GRACE_MS = 500;

/**
 * Same platform-aware kill as killChildProcess, but resolves only once the kill
 * has actually taken effect: on Windows, once the `taskkill` helper process
 * exits; on POSIX, once the child's own "exit" event fires (bounded by a short
 * grace period so a hung child can't stall callers forever).
 */
function killChildProcessAwait(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();

  return new Promise((resolve) => {
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          shell: false,
          windowsHide: true,
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
        return;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }

      const timer = setTimeout(() => resolve(), POSIX_KILL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGKILL");
    } catch {
      // Ignore errors during kill — process may have already exited
      resolve();
    }
  });
}
