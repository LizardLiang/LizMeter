// electron/main/music/music-ipc.ts
// Register all music:* IPC handlers and push events.
// Called from ipc-handlers.ts (registerMusicIpcHandlers).
// cleanupMusicResources() is called from app.on("before-quit").

import { ipcMain } from "electron";
import fs from "node:fs";
import crypto from "node:crypto";
import type {
  MusicLibraryListInput,
  MusicPlayRequest,
  MusicPlayResult,
  MusicMetaResult,
  PlaylistAddTrackInput,
} from "../../../src/shared/types.ts";
import { MusicError } from "./music-error.ts";
import { checkBinaries, getBinaryInfo, downloadBinaries, getBinDir } from "./binary-manager.ts";
import { killAll, killByPrefix, killByPrefixAsync } from "./process-manager.ts";
import {
  startServer,
  setCurrentTrack,
  clearCurrentTrack,
  stopServer,
  finalizeCacheFile,
  didCacheWriteFail,
  getCurrentTrackId,
  closeCacheReadStreams,
} from "./stream-server.ts";
import { extractAudio, extractMetadata, detectPlaylist, extractPlaylistMetadata } from "./audio-extractor.ts";
import { toRendererTrack } from "./internal-types.ts";
import {
  getTrackBySourceUrl,
  getTrackById,
  upsertTrack,
  incrementTrackPlayCount,
  updateTrackCache,
  deleteTrack,
  deleteAllTracks,
  listMusicTracks,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  listPlaylists,
  getPlaylistById,
  getPlaylistTracks,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTrack,
} from "../database.ts";
import {
  getCacheDir,
  getCacheFilePath,
  getCacheStats,
  clearAllCache,
  setMaxBytes,
  evictIfNeeded,
} from "./cache-manager.ts";
import { checkIntegrity, checkTrackIntegrity, repairTracks } from "./integrity-checker.ts";
import { getMainWindow } from "../index.ts";

// --- Active import state ---

// AbortController used to cancel in-flight playlist imports
let activeImportAbortController: AbortController | null = null;

// --- Shared cache-file unlink helper ---

// Delay before retrying an EBUSY unlink once — gives Windows a moment to
// release a handle that was just closed (stream kill / read-stream destroy
// are not always synchronous with the OS releasing the lock).
const UNLINK_RETRY_DELAY_MS = 250;

// Deletes a cache file, retrying once on EBUSY (Windows holds a file lock for
// a brief moment after a handle closes). Throws MusicError if the file is
// still busy or fails to delete for any other reason — callers must not
// proceed to remove the DB row on failure, or the file is orphaned forever.
async function unlinkWithRetry(filePath: string): Promise<void> {
  try {
    fs.unlinkSync(filePath);
    return;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;

    if (err.code === "EBUSY") {
      await new Promise((resolve) => setTimeout(resolve, UNLINK_RETRY_DELAY_MS));
      try {
        fs.unlinkSync(filePath);
        return;
      } catch (e2) {
        const err2 = e2 as NodeJS.ErrnoException;
        if (err2.code === "ENOENT") return;
        console.error("[music-ipc] Cache file still busy after retry:", filePath, err2);
        throw new MusicError(`Cache file is still in use: ${filePath}`, "CACHE_FILE_BUSY");
      }
    }

    console.error("[music-ipc] Failed to delete cache file:", filePath, err);
    throw new MusicError(`Failed to delete cache file: ${filePath}`, "CACHE_FILE_BUSY");
  }
}

// --- Shared stream-end finalize helper ---

async function handleStreamFinalize(trackId: string, cacheFilePath: string): Promise<void> {
  try {
    if (didCacheWriteFail()) return;

    const fileSize = finalizeCacheFile(cacheFilePath);
    if (fileSize === null) return;

    // Capture the active track ID before the long integrity probe so we can
    // detect if the user switched tracks during the await.
    const ownerTrackId = getCurrentTrackId();

    const baseRow = getTrackById(trackId);
    if (baseRow !== null) {
      const integrityResult = await checkTrackIntegrity({ ...baseRow, cached_file_path: cacheFilePath });
      if (integrityResult !== null) {
        console.error(`[music-ipc] Integrity check failed for ${trackId}: ${integrityResult.reason} — ${integrityResult.detail}`);
        try {
          fs.unlinkSync(cacheFilePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            console.warn("[music-ipc] Failed to delete corrupt cache file:", cacheFilePath);
          }
        }
        return;
      }
    }

    // If the active track changed while integrity was probing, do not commit —
    // the new stream owns the server slot and we must not clobber it.
    if (getCurrentTrackId() !== ownerTrackId) return;

    updateTrackCache(trackId, cacheFilePath, fileSize);

    if (getCurrentTrackId() === trackId) {
      setCurrentTrack(trackId, { type: "cache", filePath: cacheFilePath });
    }

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("music:stream:cached", { trackId });
    }

    evictIfNeeded(trackId);
  } catch (err) {
    console.error(`[music-ipc] Stream end-finalize failed for ${trackId}:`, err);
  }
}

// --- IPC handler registration ---

export function registerMusicIpcHandlers(): void {
  // music:binary:status — check yt-dlp/ffmpeg installation
  ipcMain.handle("music:binary:status", async () => {
    return checkBinaries();
  });

  // music:binary:info — get download metadata from GitHub Releases
  ipcMain.handle("music:binary:info", async () => {
    return getBinaryInfo();
  });

  // music:binary:download — download yt-dlp and ffmpeg with progress push events
  ipcMain.handle("music:binary:download", async (event) => {
    await downloadBinaries((progress) => {
      event.sender.send("music:binary:download-progress", progress);
    });
  });

  // music:play — the main orchestration handler
  // Detects playlist URLs and routes to playlist import if needed.
  ipcMain.handle("music:play", async (event, input: MusicPlayRequest): Promise<MusicPlayResult> => {
    const { url } = input;

    // 1. Validate URL
    try {
      new URL(url);
    } catch {
      throw new MusicError(`Invalid URL: ${url}`, "INVALID_URL");
    }

    // 2. Check binaries
    const status = await checkBinaries();
    if (!status.ytDlpInstalled || !status.ffmpegInstalled) {
      throw new MusicError("yt-dlp or ffmpeg is not installed", "BINARY_MISSING");
    }

    // 3. Detect playlist URL (T2.7: playlist import routing)
    const isPlaylist = await detectPlaylist(url);
    if (isPlaylist) {
      // Playlist import: enqueue all tracks, play first one
      return handlePlaylistImport(event, url);
    }

    // 4. Check if track is already in DB by source URL and has a valid cache
    const existingRow = getTrackBySourceUrl(url);
    if (existingRow && existingRow.cached_file_path && fs.existsSync(existingRow.cached_file_path)) {
      const damaged = await checkTrackIntegrity(existingRow);
      if (damaged === null) {
        // Serve from cache immediately (full Range support)
        const port = await startServer();
        setCurrentTrack(existingRow.id, { type: "cache", filePath: existingRow.cached_file_path });
        incrementTrackPlayCount(existingRow.id);
        const updatedRow = getTrackById(existingRow.id) ?? existingRow;
        return {
          streamUrl: `http://127.0.0.1:${port}/audio/${existingRow.id}`,
          track: toRendererTrack(updatedRow),
          fromCache: true,
        };
      }

      repairTracks([existingRow.id]);
    }

    // 5. Pre-check: fetch metadata first to detect live streams
    //    Live streams produce infinite audio and would fill the disk / crash the app.
    const preMeta = await extractMetadata(url);
    if (preMeta.isLive) {
      throw new MusicError(
        "Live streams are not supported. Please use a regular video or audio URL.",
        "EXTRACTION_FAILED",
      );
    }

    // 6. Ensure stream server is started (lazy)
    const port = await startServer();

    // 7. Extract audio stream
    const { stream } = extractAudio(url, { spawnMetadata: false });

    // 8. Generate track ID and cache file path
    // Reuse existing DB row ID if we have one (e.g. not-cached case after previous play)
    const trackId = existingRow?.id ?? crypto.randomUUID();
    const cacheFilePath = getCacheFilePath(trackId);

    // 9. Register current track on stream server
    // stream-server will tee-write to cacheFilePath + ".tmp" during streaming
    setCurrentTrack(trackId, { type: "stream", stream, cacheFilePath });

    // 10. Wire up async cache completion
    stream.once("end", () => {
      void handleStreamFinalize(trackId, cacheFilePath);
    });

    // 11. Upsert track in DB using pre-fetched metadata
    const now = new Date().toISOString();
    const row = upsertTrack({
      id: trackId,
      source_url: preMeta.sourceUrl,
      source_id: preMeta.sourceId,
      source_site: preMeta.sourceSite,
      title: preMeta.title,
      artist: preMeta.artist,
      duration_seconds: preMeta.durationSeconds,
      thumbnail_url: preMeta.thumbnailUrl,
      cached_file_path: null,
      cache_size_bytes: null,
      added_at: existingRow?.added_at ?? now,
    });

    // 12. Increment play count
    incrementTrackPlayCount(row.id);
    const playedRow = getTrackById(row.id) ?? row;

    // 13. Return stream URL and renderer-safe track metadata
    return {
      streamUrl: `http://127.0.0.1:${port}/audio/${trackId}`,
      track: toRendererTrack(playedRow),
      fromCache: false,
    };
  });

  // music:stop — kill stream processes only, not metadata extractions
  ipcMain.handle("music:stop", () => {
    clearCurrentTrack();
    killByPrefix("stream:");
  });

  // music:meta — metadata-only extraction (no audio stream)
  ipcMain.handle("music:meta", async (_event, input: { url: string }): Promise<MusicMetaResult> => {
    const { url } = input;

    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new MusicError(`Invalid URL: ${url}`, "INVALID_URL");
    }

    // Check binaries
    const status = await checkBinaries();
    if (!status.ytDlpInstalled) {
      throw new MusicError("yt-dlp is not installed", "BINARY_MISSING");
    }

    // Extract metadata only (no audio stream spawned)
    const meta = await extractMetadata(url);

    // Build a transient MusicTrack without persisting it
    const transientId = crypto.randomUUID();
    const now = new Date().toISOString();
    const track = toRendererTrack({
      id: transientId,
      source_url: meta.sourceUrl,
      source_id: meta.sourceId,
      source_site: meta.sourceSite,
      title: meta.title,
      artist: meta.artist,
      duration_seconds: meta.durationSeconds,
      thumbnail_url: meta.thumbnailUrl,
      cached_file_path: null,
      cache_size_bytes: null,
      play_count: 0,
      last_played_at: null,
      added_at: now,
    });

    return { track };
  });

  // music:library:list — list tracks in the library (T2.2)
  ipcMain.handle("music:library:list", (_event, input: MusicLibraryListInput) => {
    return listMusicTracks(input ?? {});
  });

  // music:library:delete — remove a track from the library (and its cache file) (T2.2)
  ipcMain.handle("music:library:delete", async (_event, trackId: string) => {
    const row = getTrackById(trackId);
    if (!row) {
      throw new MusicError(`Track not found: ${trackId}`, "TRACK_NOT_FOUND");
    }
    if (getCurrentTrackId() === trackId) {
      // Stop every hold on this file before unlinking it — otherwise Windows
      // returns EBUSY for a file that's actively being served. Two distinct
      // handles can be open: a yt-dlp stream process (type "stream", killed via
      // killByPrefixAsync) and/or an in-flight HTTP read of the cached file
      // itself (type "cache", served by serveCachedFile — clearCurrentTrack()
      // never touches this one, so it must be torn down separately). Both are
      // awaited so the unlink below sees a released handle.
      await closeCacheReadStreams(trackId);
      clearCurrentTrack();
      await killByPrefixAsync("stream:");
    }
    if (row.cached_file_path) {
      // Do not delete the DB row on failure — that would orphan the file on
      // disk forever with no way to retry the delete.
      await unlinkWithRetry(row.cached_file_path);
    }
    deleteTrack(trackId);
  });

  // music:library:clear — wipe every track + cached file. Playlists survive as
  // empty shells (playlist_tracks cascades on tracks delete).
  ipcMain.handle("music:library:clear", async () => {
    const currentId = getCurrentTrackId();
    if (currentId) {
      await closeCacheReadStreams(currentId);
    }
    clearCurrentTrack();
    await killByPrefixAsync("stream:");
    clearAllCache();
    deleteAllTracks();
  });

  // music:cache:stats — current cache size + configured limit (T2.2)
  ipcMain.handle("music:cache:stats", () => {
    return getCacheStats();
  });

  // music:cache:clear — delete all cached files and reset DB fields (T2.2)
  ipcMain.handle("music:cache:clear", () => {
    clearAllCache();
  });

  // music:cache:set-limit — update the cache size limit setting (T2.2)
  ipcMain.handle("music:cache:set-limit", (_event, maxBytes: number) => {
    setMaxBytes(maxBytes);
    // Run eviction in case current cache now exceeds the new limit
    evictIfNeeded(getCurrentTrackId());
  });

  // music:playlist:create — create a new playlist (optionally with initial track IDs)
  ipcMain.handle("music:playlist:create", (_event, input: { name: string; trackIds?: string[] }) => {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error("Playlist name cannot be empty");
    }
    const playlist = createPlaylist(input.name);
    if (input.trackIds && input.trackIds.length > 0) {
      for (const tid of input.trackIds) {
        try {
          addTrackToPlaylist(playlist.id, tid);
        } catch {
          // Skip missing/invalid tracks silently
        }
      }
    }
    return getPlaylistById(playlist.id) ?? playlist;
  });

  // music:playlist:rename — rename an existing playlist
  ipcMain.handle("music:playlist:rename", (_event, input: { id: number; name: string }) => {
    try {
      renamePlaylist(input.id, input.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MusicError(msg, "PLAYLIST_NOT_FOUND");
    }
  });

  // music:playlist:delete — delete a playlist (tracks themselves are preserved)
  ipcMain.handle("music:playlist:delete", (_event, id: number) => {
    try {
      deletePlaylist(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MusicError(msg, "PLAYLIST_NOT_FOUND");
    }
  });

  // music:playlist:list — list all playlists
  ipcMain.handle("music:playlist:list", () => {
    return listPlaylists();
  });

  // music:playlist:tracks — get the tracks for a specific playlist
  ipcMain.handle("music:playlist:tracks", (_event, playlistId: number) => {
    const playlist = getPlaylistById(playlistId);
    if (!playlist) {
      throw new MusicError(`Playlist not found: ${playlistId}`, "PLAYLIST_NOT_FOUND");
    }
    return getPlaylistTracks(playlistId);
  });

  // music:playlist:add-track — add a track (by ID or URL) to a playlist
  ipcMain.handle("music:playlist:add-track", async (_event, input: PlaylistAddTrackInput) => {
    const playlist = getPlaylistById(input.playlistId);
    if (!playlist) {
      throw new MusicError(`Playlist not found: ${input.playlistId}`, "PLAYLIST_NOT_FOUND");
    }

    let trackId: string;

    if ("trackId" in input && input.trackId) {
      const row = getTrackById(input.trackId);
      if (!row) {
        throw new MusicError(`Track not found: ${input.trackId}`, "TRACK_NOT_FOUND");
      }
      trackId = input.trackId;
    } else if ("url" in input && input.url) {
      // Check binaries before metadata extraction
      const binStatus = await checkBinaries();
      if (!binStatus.ytDlpInstalled) {
        throw new MusicError("yt-dlp is not installed", "BINARY_MISSING");
      }
      const existing = getTrackBySourceUrl(input.url);
      if (existing) {
        trackId = existing.id;
      } else {
        const meta = await extractMetadata(input.url);
        const now = new Date().toISOString();
        const newId = crypto.randomUUID();
        const row = upsertTrack({
          id: newId,
          source_url: meta.sourceUrl,
          source_id: meta.sourceId,
          source_site: meta.sourceSite,
          title: meta.title,
          artist: meta.artist,
          duration_seconds: meta.durationSeconds,
          thumbnail_url: meta.thumbnailUrl,
          cached_file_path: null,
          cache_size_bytes: null,
          added_at: now,
        });
        trackId = row.id;
      }
    } else {
      throw new MusicError("Invalid playlist add-track input: must provide trackId or url", "TRACK_NOT_FOUND");
    }

    return addTrackToPlaylist(input.playlistId, trackId);
  });

  // music:playlist:remove-track — remove a track entry from a playlist by playlist_tracks.id
  ipcMain.handle("music:playlist:remove-track", (_event, playlistTrackId: number) => {
    try {
      removeTrackFromPlaylist(playlistTrackId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MusicError(msg, "TRACK_NOT_FOUND");
    }
  });

  // music:playlist:reorder — move a track entry to a new position within a playlist
  ipcMain.handle(
    "music:playlist:reorder",
    (_event, input: { playlistId: number; trackEntryId: number; toPosition: number }) => {
      const playlist = getPlaylistById(input.playlistId);
      if (!playlist) {
        throw new MusicError(`Playlist not found: ${input.playlistId}`, "PLAYLIST_NOT_FOUND");
      }
      try {
        reorderPlaylistTrack(input.playlistId, input.trackEntryId, input.toPosition);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new MusicError(msg, "TRACK_NOT_FOUND");
      }
    },
  );

  // music:integrity:check — scan all cached tracks for damage
  ipcMain.handle("music:integrity:check", async (event) => {
    return checkIntegrity((current, total, title) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("music:integrity:progress", { current, total, title });
      }
    });
  });

  // music:integrity:repair — delete damaged cache files so tracks re-stream on next play
  ipcMain.handle("music:integrity:repair", (_event, trackIds: string[]) => {
    return repairTracks(trackIds);
  });

  // music:import:cancel — cancel active playlist import (T2.7)
  ipcMain.handle("music:import:cancel", () => {
    if (activeImportAbortController) {
      activeImportAbortController.abort();
      activeImportAbortController = null;
    }
  });

  // music:reset — delete all music data, optionally delete binaries too
  ipcMain.handle("music:reset", (_event, input: { deleteBinaries: boolean }) => {
    // Clear cache directory via cache-manager
    clearAllCache();

    if (input.deleteBinaries) {
      const binDir = getBinDir();
      try {
        if (fs.existsSync(binDir)) {
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      } catch (err) {
        console.error("[music-ipc] Failed to delete bin directory:", err);
      }
    }
  });
}

// --- Playlist import handler (T2.7) ---
//
// Called from music:play when detectPlaylist returns true.
// Spawns yt-dlp --flat-playlist --dump-json, parses NDJSON line-by-line,
// pushes music:import:progress events to the renderer, enforces 500-track cap.
// Returns the first track's play result so the renderer can start playback immediately.

async function handlePlaylistImport(
  event: Electron.IpcMainInvokeEvent,
  playlistUrl: string,
): Promise<MusicPlayResult> {
  // Cancel any previous import in flight
  if (activeImportAbortController) {
    activeImportAbortController.abort();
  }
  activeImportAbortController = new AbortController();
  const signal = activeImportAbortController.signal;

  const now = new Date().toISOString();
  const collectedTracks: Array<{
    id: string;
    sourceUrl: string;
    title: string;
    artist: string | null;
    durationSeconds: number | null;
    thumbnailUrl: string | null;
    sourceId: string;
    sourceSite: string;
  }> = [];

  let importDone = false;

  try {
    await extractPlaylistMetadata(
      playlistUrl,
      (meta, index) => {
        if (signal.aborted) return;

        // Upsert each track as we receive metadata (no audio download)
        const existing = getTrackBySourceUrl(meta.sourceUrl);
        const trackId = existing?.id ?? crypto.randomUUID();
        upsertTrack({
          id: trackId,
          source_url: meta.sourceUrl,
          source_id: meta.sourceId,
          source_site: meta.sourceSite,
          title: meta.title,
          artist: meta.artist,
          duration_seconds: meta.durationSeconds,
          thumbnail_url: meta.thumbnailUrl,
          cached_file_path: existing?.cached_file_path ?? null,
          cache_size_bytes: existing?.cache_size_bytes ?? null,
          added_at: existing?.added_at ?? now,
        });

        collectedTracks.push({
          id: trackId,
          sourceUrl: meta.sourceUrl,
          title: meta.title,
          artist: meta.artist,
          durationSeconds: meta.durationSeconds,
          thumbnailUrl: meta.thumbnailUrl,
          sourceId: meta.sourceId,
          sourceSite: meta.sourceSite,
        });

        // Push progress event to renderer
        if (!event.sender.isDestroyed()) {
          event.sender.send("music:import:progress", {
            total: null, // yt-dlp flat-playlist doesn't always know total upfront
            current: index + 1,
            title: meta.title,
          });
        }
      },
      signal,
    );
    importDone = true;
  } catch (err) {
    // If aborted by user, that's OK — we still play what we've collected
    if (!signal.aborted) {
      // Real error — re-throw if we have nothing collected
      if (collectedTracks.length === 0) {
        throw new MusicError(
          `Playlist import failed: ${err instanceof Error ? err.message : String(err)}`,
          "EXTRACTION_FAILED",
        );
      }
      // Otherwise fall through and play what we have
    }
  }

  if (collectedTracks.length === 0) {
    throw new MusicError("No tracks found in playlist", "EXTRACTION_FAILED");
  }

  // Signal completion to renderer (total = number actually collected)
  if (!event.sender.isDestroyed()) {
    event.sender.send("music:import:progress", {
      total: collectedTracks.length,
      current: collectedTracks.length,
      title: importDone ? "Import complete" : "Import cancelled",
    });
  }

  // Push remaining tracks (index 1+) to the renderer BEFORE playing the first
  if (!event.sender.isDestroyed() && collectedTracks.length > 1) {
    const remainingTracks = collectedTracks.slice(1).map((t) => {
      const row = getTrackById(t.id);
      return row ? toRendererTrack(row) : {
        id: t.id,
        sourceUrl: t.sourceUrl,
        sourceId: t.sourceId,
        sourceSite: t.sourceSite,
        title: t.title,
        artist: t.artist,
        durationSeconds: t.durationSeconds,
        thumbnailUrl: t.thumbnailUrl,
        isCached: false,
        cacheSizeBytes: null,
        playCount: 0,
        lastPlayedAt: null,
        addedAt: now,
      };
    });
    event.sender.send("music:playlist:imported", {
      tracks: remainingTracks,
    });
  }

  // Play the first track immediately — this is the return value of music:play
  const firstTrack = collectedTracks[0]!;
  const binStatus = await checkBinaries();
  if (!binStatus.ytDlpInstalled || !binStatus.ffmpegInstalled) {
    throw new MusicError("yt-dlp or ffmpeg is not installed", "BINARY_MISSING");
  }

  const firstRow = getTrackById(firstTrack.id);
  if (firstRow && firstRow.cached_file_path && fs.existsSync(firstRow.cached_file_path)) {
    const port = await startServer();
    setCurrentTrack(firstRow.id, { type: "cache", filePath: firstRow.cached_file_path });
    incrementTrackPlayCount(firstRow.id);
    const updatedRow = getTrackById(firstRow.id) ?? firstRow;
    activeImportAbortController = null;
    return {
      streamUrl: `http://127.0.0.1:${port}/audio/${firstRow.id}`,
      track: toRendererTrack(updatedRow),
      fromCache: true,
    };
  }

  const preMeta = await extractMetadata(firstTrack.sourceUrl);
  const port = await startServer();
  const { stream } = extractAudio(firstTrack.sourceUrl, { spawnMetadata: false });
  const trackId = firstTrack.id;
  const cacheFilePath = getCacheFilePath(trackId);

  setCurrentTrack(trackId, { type: "stream", stream, cacheFilePath });

  stream.once("end", () => {
    void handleStreamFinalize(trackId, cacheFilePath);
  });

  const upsertedRow = upsertTrack({
    id: trackId,
    source_url: preMeta.sourceUrl,
    source_id: preMeta.sourceId,
    source_site: preMeta.sourceSite,
    title: preMeta.title,
    artist: preMeta.artist,
    duration_seconds: preMeta.durationSeconds,
    thumbnail_url: preMeta.thumbnailUrl,
    cached_file_path: null,
    cache_size_bytes: null,
    added_at: firstRow?.added_at ?? now,
  });

  incrementTrackPlayCount(upsertedRow.id);
  const playedRow = getTrackById(upsertedRow.id) ?? upsertedRow;

  activeImportAbortController = null;
  return {
    streamUrl: `http://127.0.0.1:${port}/audio/${trackId}`,
    track: toRendererTrack(playedRow),
    fromCache: false,
  };
}

// --- Cleanup on app quit ---

export function cleanupMusicResources(): void {
  // Cancel any active import
  if (activeImportAbortController) {
    activeImportAbortController.abort();
    activeImportAbortController = null;
  }
  killAll();
  stopServer();
}

// Re-export getCacheDir for backward compat (used in music:reset indirectly via clearAllCache)
export { getCacheDir };
