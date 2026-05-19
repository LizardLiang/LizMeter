// electron/main/music/integrity-checker.ts
// Detect damaged/truncated cached audio files and support repair (re-download).
// Uses ffmpeg (already bundled) to probe cached .m4a files:
//   1. Read container-reported duration via `ffmpeg -i <file>`
//   2. Verify audio data exists near the end via `ffmpeg -ss <near_end> -t 1 -f null`
// Repair = delete cache file + clear DB fields → track re-streams on next play.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import type { DamagedTrackInfo, IntegrityCheckResult } from "../../../src/shared/types.ts";
import { getFfmpegPath } from "./binary-manager.ts";
import { getAllCachedTracks, updateTrackCache } from "../database.ts";
import { toRendererTrack } from "./internal-types.ts";
import type { InternalTrackRecord } from "./internal-types.ts";

const execFileAsync = promisify(execFile);

// Concurrency guard — prevents duplicate scans from overlapping ffmpeg spawns
let isRunning = false;

const FFMPEG_FINALIZE_TIMEOUT_MS = 60000;
const FFMPEG_BULK_PROBE_TIMEOUT_MS = 20000;

/**
 * Get the container-reported duration from an audio file.
 * Uses `ffmpeg -i <file> -hide_banner` — always exits non-zero (no output specified)
 * but prints file info including Duration to stderr.
 */
async function getContainerDuration(filePath: string, ffmpegPath: string, timeoutMs: number): Promise<number | null> {
  try {
    await execFileAsync(ffmpegPath, ["-i", filePath, "-hide_banner"], { timeout: timeoutMs });
    return null; // Should not reach here (ffmpeg exits 1 with no output)
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const match = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr);
    if (!match) return null;

    const hours = parseInt(match[1]!, 10);
    const minutes = parseInt(match[2]!, 10);
    const seconds = parseInt(match[3]!, 10);
    const centis = parseInt(match[4]!, 10);
    return hours * 3600 + minutes * 60 + seconds + centis / 100;
  }
}

/**
 * Try to decode a 1-second chunk at the given seek point.
 * Returns true if ffmpeg can decode audio at that position without errors.
 * For truncated files where moov atom references non-existent data, this fails.
 */
async function canDecodeAt(filePath: string, ffmpegPath: string, seekSeconds: number, timeoutMs: number): Promise<boolean> {
  try {
    const { stderr } = await execFileAsync(ffmpegPath, [
      "-v", "error",
      "-ss", String(Math.max(0, Math.floor(seekSeconds))),
      "-i", filePath,
      "-t", "1",
      "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ], { timeout: timeoutMs });

    return (stderr ?? "").trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Probe a single cached track for integrity.
 * Returns a DamagedTrackInfo if the track is damaged, or null if OK.
 */
export async function probeTrack(
  track: InternalTrackRecord,
  ffmpegPath: string,
  timeoutMs: number = FFMPEG_BULK_PROBE_TIMEOUT_MS,
): Promise<DamagedTrackInfo | null> {
  const filePath = track.cached_file_path;
  if (!filePath) return null;

  // Check file exists on disk
  if (!fs.existsSync(filePath)) {
    return {
      track: toRendererTrack(track),
      reason: "missing",
      detail: "Cache file no longer exists on disk",
      containerDuration: null,
      expectedDuration: track.duration_seconds,
    };
  }

  // Check file size is reasonable (>1KB)
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 1024) {
      return {
        track: toRendererTrack(track),
        reason: "empty",
        detail: `File is only ${stat.size} bytes`,
        containerDuration: null,
        expectedDuration: track.duration_seconds,
      };
    }
  } catch {
    return {
      track: toRendererTrack(track),
      reason: "unreadable",
      detail: "Cannot read cache file",
      containerDuration: null,
      expectedDuration: track.duration_seconds,
    };
  }

  // Get container-reported duration
  const containerDuration = await getContainerDuration(filePath, ffmpegPath, timeoutMs);

  if (containerDuration === null) {
    return {
      track: toRendererTrack(track),
      reason: "corrupt",
      detail: "Cannot read audio metadata (missing moov atom or invalid container)",
      containerDuration: null,
      expectedDuration: track.duration_seconds,
    };
  }

  // Compare container duration with expected (from yt-dlp metadata)
  const expected = track.duration_seconds;
  if (expected !== null && expected > 0) {
    const ratio = containerDuration / expected;
    if (ratio < 0.85) {
      return {
        track: toRendererTrack(track),
        reason: "truncated",
        detail: `Container duration ${Math.round(containerDuration)}s vs expected ${expected}s (${Math.round(ratio * 100)}%)`,
        containerDuration: Math.round(containerDuration),
        expectedDuration: expected,
      };
    }
  }

  // Verify audio data near the end (catches truncated data with intact moov atom)
  // This is the key check for the "stops halfway" symptom
  const refDuration = expected ?? containerDuration;
  if (refDuration > 10) {
    const seekPoint = refDuration - 5;
    const ok = await canDecodeAt(filePath, ffmpegPath, seekPoint, timeoutMs);
    if (!ok) {
      return {
        track: toRendererTrack(track),
        reason: "truncated",
        detail: `Audio data ends before expected (cannot decode at ${Math.round(seekPoint)}s / ${Math.round(refDuration)}s)`,
        containerDuration: Math.round(containerDuration),
        expectedDuration: expected,
      };
    }
  }

  return null; // Track is OK
}

/**
 * Validate one cached track before serving it from disk.
 * Returns null when the cache file is healthy, otherwise the damage details.
 */
export async function checkTrackIntegrity(track: InternalTrackRecord): Promise<DamagedTrackInfo | null> {
  const ffmpegPath = getFfmpegPath();
  if (!fs.existsSync(ffmpegPath)) {
    return null;
  }

  return probeTrack(track, ffmpegPath, FFMPEG_FINALIZE_TIMEOUT_MS);
}

/**
 * Check integrity of all cached tracks.
 * Probes each file with ffmpeg and returns damaged tracks.
 * Calls onProgress for UI updates during the scan.
 */
export async function checkIntegrity(
  onProgress?: (current: number, total: number, title: string) => void,
): Promise<IntegrityCheckResult> {
  if (isRunning) {
    return { damaged: [], checked: 0, total: 0, error: "Integrity check already in progress" };
  }

  isRunning = true;
  try {
    const ffmpegPath = getFfmpegPath();
    if (!fs.existsSync(ffmpegPath)) {
      return { damaged: [], checked: 0, total: 0, error: "ffmpeg is not installed" };
    }

    const cachedTracks = getAllCachedTracks();
    const total = cachedTracks.length;

    if (total === 0) {
      return { damaged: [], checked: 0, total: 0, error: null };
    }

    const damaged: DamagedTrackInfo[] = [];

    for (let i = 0; i < cachedTracks.length; i++) {
      const track = cachedTracks[i]!;
      onProgress?.(i + 1, total, track.title);

      const result = await probeTrack(track, ffmpegPath);
      if (result !== null) {
        damaged.push(result);
      }
    }

    return { damaged, checked: total, total, error: null };
  } finally {
    isRunning = false;
  }
}

/**
 * Repair damaged tracks by deleting cache files and clearing DB fields.
 * Repaired tracks will re-stream from source on next play.
 * Returns the number of tracks successfully repaired.
 */
export function repairTracks(trackIds: string[]): number {
  const cachedTracks = getAllCachedTracks();
  let repaired = 0;

  for (const trackId of trackIds) {
    const track = cachedTracks.find((t) => t.id === trackId);
    if (!track) continue;

    if (track.cached_file_path) {
      try {
        fs.unlinkSync(track.cached_file_path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn("[integrity-checker] Failed to delete cache file:", track.cached_file_path);
        }
      }
    }

    // Clear DB cache fields (track metadata is preserved)
    updateTrackCache(trackId, null, null);
    repaired++;
  }

  return repaired;
}
