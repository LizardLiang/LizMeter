// electron/main/music/internal-types.ts
// Main-process-only types that include sensitive fields (like filesystem paths)
// that must never cross the IPC boundary.
// This file is imported only by other electron/main/music/ modules and database.ts.

import type { MusicTrack } from "../../../src/shared/types.ts";

/**
 * Raw database row shape for the tracks table.
 * Contains cached_file_path (absolute OS path) which is NEVER sent to the renderer.
 */
export interface InternalTrackRecord {
  id: string;
  source_url: string;
  source_id: string;
  source_site: string;
  title: string;
  artist: string | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  cached_file_path: string | null; // Absolute OS path -- NEVER sent to renderer
  cache_size_bytes: number | null;
  play_count: number;
  last_played_at: string | null;
  added_at: string;
}

/**
 * Convert an internal DB record to a renderer-safe MusicTrack.
 * Maps cached_file_path to the boolean isCached to prevent filesystem path leaks.
 */
export function toRendererTrack(row: InternalTrackRecord): MusicTrack {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    sourceId: row.source_id,
    sourceSite: row.source_site,
    title: row.title,
    artist: row.artist,
    durationSeconds: row.duration_seconds,
    thumbnailUrl: row.thumbnail_url,
    isCached: row.cached_file_path !== null,
    cacheSizeBytes: row.cache_size_bytes,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at,
    addedAt: row.added_at,
  };
}
