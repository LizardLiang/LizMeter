// electron/main/music/cache-manager.ts
// LRU cache manager for music audio files.
// Responsibilities:
//   - Determine cache directory (userData/music-cache/)
//   - Track cache size via DB (sum of cache_size_bytes)
//   - Enforce configurable max via LRU eviction (ordered by last_played_at ASC)
//   - Protect currently-playing track and all playlist-referenced tracks from eviction
//   - getCacheStats(), clearAllCache(), setMaxBytes(n), evictIfNeeded(currentlyPlayingTrackId)
//
// This module extracts the inline evictIfNeeded() that existed in music-ipc.ts (Phase 1 dev debt).

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  getCacheUsage,
  clearAllCachedTracks,
  getEvictionCandidates,
  updateTrackCache,
  getSettingValue,
  setSettingValue,
} from "../database.ts";
import type { CacheStats } from "../../../src/shared/types.ts";

// ---- Constants ----

export const DEFAULT_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// ---- Cache directory ----

export function getCacheDir(): string {
  const dir = path.join(app.getPath("userData"), "music-cache");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getCacheFilePath(trackId: string): string {
  return path.join(getCacheDir(), `${trackId}.m4a`);
}

// ---- Cache limit helpers ----

export function getCacheMaxBytes(): number {
  const raw = getSettingValue("music.cacheMaxBytes");
  if (!raw) return DEFAULT_CACHE_MAX_BYTES;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? DEFAULT_CACHE_MAX_BYTES : parsed;
}

export function setMaxBytes(maxBytes: number): void {
  setSettingValue("music.cacheMaxBytes", String(maxBytes));
}

// ---- getCacheStats ----

export function getCacheStats(): CacheStats {
  const { currentBytes, trackCount } = getCacheUsage();
  return {
    currentBytes,
    maxBytes: getCacheMaxBytes(),
    trackCount,
  };
}

// ---- clearAllCache ----

export function clearAllCache(): void {
  const cacheDir = getCacheDir();
  try {
    const files = fs.readdirSync(cacheDir);
    for (const file of files) {
      if (file.endsWith(".m4a") || file.endsWith(".tmp")) {
        try {
          fs.unlinkSync(path.join(cacheDir, file));
        } catch {
          // Log but continue with other files
          console.warn("[cache-manager] Failed to delete cache file:", file);
        }
      }
    }
  } catch {
    // Directory may not exist — that's fine
  }
  clearAllCachedTracks();
}

// ---- evictIfNeeded ----
//
// LRU eviction: evict oldest tracks by last_played_at until cache is under maxBytes.
// Protected tracks (never evicted):
//   1. currentlyPlayingTrackId — the track currently in the audio element
//   2. All tracks referenced in playlist_tracks (they should stay available offline)
//      — handled by getEvictionCandidates(excludeIds) which queries the DB for these
//
// Note: getEvictionCandidates in database.ts already handles excluding tracks that
// are in any playlist. We pass the currentlyPlayingTrackId as an additional exclusion.

export function evictIfNeeded(currentlyPlayingTrackId: string | null): void {
  const { currentBytes } = getCacheUsage();
  const maxBytes = getCacheMaxBytes();

  if (currentBytes <= maxBytes) return;

  const excludeIds: string[] = [];
  if (currentlyPlayingTrackId) {
    excludeIds.push(currentlyPlayingTrackId);
  }

  const candidates = getEvictionCandidates(excludeIds);

  let remaining = currentBytes - maxBytes;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    if (!candidate.cached_file_path) continue;

    try {
      if (fs.existsSync(candidate.cached_file_path)) {
        fs.unlinkSync(candidate.cached_file_path);
      }
    } catch {
      // Ignore eviction file errors — continue to next candidate
    }

    // Null out DB cache fields regardless of file delete success
    updateTrackCache(candidate.id, null, null);
    remaining -= candidate.cache_size_bytes ?? 0;
  }
}
