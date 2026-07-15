// electron/main/music/stream-server.ts
// Local HTTP server for audio streaming (yt-dlp stdout) and cached file serving.
// v2.0: Single dynamic /audio/:trackId route pattern (MAJOR-01 + MAJOR-03 redesign).
// No CORS headers (MINOR-05 fix). Binds to 127.0.0.1:0 (OS-assigned port).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { MusicError } from "./music-error.ts";
import { getTrackById } from "../database.ts";

type CurrentTrackState =
  | { id: string; type: "stream"; stream: Readable; cacheFilePath: string }
  | { id: string; type: "cache"; filePath: string };

let server: http.Server | null = null;
let assignedPort: number | null = null;
let currentTrack: CurrentTrackState | null = null;

// In-flight cache-file read streams (serveCachedFile), keyed by the trackId they
// serve. Windows holds an exclusive-ish lock on an open file handle, so a caller
// that wants to unlink a cache file (e.g. deleting a track from the library)
// must destroy any read stream still serving it first — see closeCacheReadStreams.
const activeCacheReadStreams = new Map<string, Set<fs.ReadStream>>();

// Tracks whether the tee-write to disk failed (disk full, permissions, etc.)
// Used to skip cache-completion logic in music-ipc.ts
let cacheWriteFailed = false;

/**
 * Returns the ID of the track currently being served, or null if none.
 * Used by music-ipc.ts to guard against stale stream "end" callbacks.
 */
export function getCurrentTrackId(): string | null {
  return currentTrack?.id ?? null;
}

/**
 * Start the HTTP server lazily on first music:play request.
 * Binds to 127.0.0.1:0 — OS assigns an available port.
 * Returns the assigned port number.
 */
export function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server !== null && assignedPort !== null) {
      resolve(assignedPort);
      return;
    }

    const srv = http.createServer(handleRequest);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new MusicError("Failed to start audio server: could not determine bound port", "EXTRACTION_FAILED"));
        return;
      }
      server = srv;
      assignedPort = addr.port;
      resolve(addr.port);
    });

    srv.on("error", (err) => {
      reject(new MusicError(`Failed to start audio server: ${err.message}`, "EXTRACTION_FAILED"));
    });
  });
}

/**
 * Returns the assigned port. Throws if the server has not been started yet.
 */
export function getPort(): number {
  if (assignedPort === null) {
    throw new MusicError("Audio server not started yet", "EXTRACTION_FAILED");
  }
  return assignedPort;
}

/**
 * Set the current track source.
 * v2.0 (MAJOR-01 + MAJOR-03): Replaces previous track state.
 * If the previous track was streaming (type: "stream"), its in-progress
 * cache file write is cleaned up here. The previous track is NOT accessible
 * via the current-track path after this call — but cached tracks remain
 * servable via the database fallback path in the request handler.
 */
export function setCurrentTrack(
  id: string,
  source:
    | { type: "stream"; stream: Readable; cacheFilePath: string }
    | { type: "cache"; filePath: string },
): void {
  // Clean up previous streaming track's incomplete cache file
  if (currentTrack?.type === "stream") {
    const previousCachePath = currentTrack.cacheFilePath;
    // Destroy the stream to stop any ongoing piping
    currentTrack.stream.destroy();
    // Delete the incomplete .tmp cache file if it exists
    const tmpPath = previousCachePath + ".tmp";
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  cacheWriteFailed = false;

  if (source.type === "stream") {
    currentTrack = { id, type: "stream", stream: source.stream, cacheFilePath: source.cacheFilePath };
  } else {
    currentTrack = { id, type: "cache", filePath: source.filePath };
  }
}

/**
 * Clear the current track state (called when playback stops).
 */
export function clearCurrentTrack(): void {
  if (currentTrack?.type === "stream") {
    currentTrack.stream.destroy();
    // Clean up any incomplete .tmp file
    const tmpPath = currentTrack.cacheFilePath + ".tmp";
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore
    }
  }
  currentTrack = null;
}

/**
 * Stop the HTTP server. Called from app.on("before-quit").
 */
export function stopServer(): void {
  clearCurrentTrack();
  if (server) {
    server.close();
    server = null;
    assignedPort = null;
  }
}

/**
 * Returns whether the cache write for the current streaming track failed.
 * music-ipc.ts reads this to decide whether to update the DB with cached_file_path.
 */
export function didCacheWriteFail(): boolean {
  return cacheWriteFailed;
}

/**
 * Register an in-flight cache-file read stream so it can be forcibly closed
 * later (see closeCacheReadStreams). Removes itself from tracking once it
 * closes on its own (request finished / client disconnected).
 */
function registerCacheReadStream(trackId: string, stream: fs.ReadStream): void {
  let set = activeCacheReadStreams.get(trackId);
  if (!set) {
    set = new Set();
    activeCacheReadStreams.set(trackId, set);
  }
  set.add(stream);
  stream.on("close", () => {
    set!.delete(stream);
    if (set!.size === 0) {
      activeCacheReadStreams.delete(trackId);
    }
  });
}

/**
 * Destroy every in-flight cache-file read stream serving the given trackId and
 * wait for them to actually close. Must be awaited before unlinking that
 * track's cache file — otherwise Windows returns EBUSY for the still-open
 * handle (the stream-process kill alone does not touch these; they belong to
 * this HTTP server, not to a yt-dlp child process).
 */
export function closeCacheReadStreams(trackId: string): Promise<void> {
  const set = activeCacheReadStreams.get(trackId);
  if (!set || set.size === 0) return Promise.resolve();

  const streams = Array.from(set);
  return Promise.all(
    streams.map((stream) =>
      new Promise<void>((resolve) => {
        if (stream.destroyed) {
          resolve();
          return;
        }
        stream.once("close", () => resolve());
        stream.destroy();
      })
    ),
  ).then(() => undefined);
}

// --- Internal HTTP request handler ---

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "";

  // Only handle /audio/:trackId — 404 everything else
  const match = /^\/audio\/([^/]+)$/.exec(url);
  if (!match || !match[1]) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const trackId = match[1];

  // --- Case 1: trackId matches current track ---
  if (currentTrack && currentTrack.id === trackId) {
    if (currentTrack.type === "stream") {
      serveStream(req, res, currentTrack.stream, currentTrack.cacheFilePath);
    } else {
      serveCachedFile(req, res, currentTrack.filePath, currentTrack.id);
    }
    return;
  }

  // --- Case 2: trackId does NOT match current track ---
  // Look up in database for previously-cached tracks (old track still playing in audio element)
  try {
    const track = getTrackById(trackId);
    if (track && track.cached_file_path && fs.existsSync(track.cached_file_path)) {
      serveCachedFile(req, res, track.cached_file_path, trackId);
      return;
    }
  } catch {
    // Database errors — fall through to 404
  }

  res.writeHead(404);
  res.end("Track not found or not cached");
}

/**
 * Stream yt-dlp stdout to the HTTP response while tee-writing to a cache file.
 * Uses a .tmp file during write, which music-ipc.ts renames to final on completion.
 * No Range support (sequential stream only — seekability requires the full file).
 */
function serveStream(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  stream: Readable,
  cacheFilePath: string,
): void {
  res.writeHead(200, {
    "Content-Type": "audio/mp4",
    "Transfer-Encoding": "chunked",
    "Cache-Control": "no-cache",
  });

  const tmpPath = cacheFilePath + ".tmp";
  const tee = new PassThrough();

  // Set up cache file write stream
  let writeStream: fs.WriteStream | null = null;
  try {
    writeStream = fs.createWriteStream(tmpPath);
    writeStream.on("error", (err) => {
      console.error("[stream-server] Cache write error (continuing stream):", err.message);
      cacheWriteFailed = true;
      // Continue serving the stream even if cache write fails
      writeStream = null;
    });
  } catch (err) {
    console.error("[stream-server] Failed to create cache write stream:", err);
    cacheWriteFailed = true;
  }

  // Tee: write to both response and cache file
  tee.on("data", (chunk: Buffer) => {
    if (writeStream && !writeStream.destroyed) {
      writeStream.write(chunk);
    }
  });

  tee.on("end", () => {
    if (writeStream && !writeStream.destroyed) {
      writeStream.end();
    }
    // Note: do NOT call res.end() here — tee.pipe(res) on the last line of
    // this function already propagates the "end" event to the response.
  });

  tee.on("error", (err) => {
    if (writeStream && !writeStream.destroyed) {
      writeStream.destroy();
    }
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
    // Delete incomplete .tmp file on stream error
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore
    }
    console.error("[stream-server] Stream error:", err.message);
  });

  // Pipe yt-dlp stdout through tee to response + cache
  stream.on("error", (err) => {
    tee.destroy(err);
  });

  stream.pipe(tee);
  tee.pipe(res);

  // Handle client disconnect (browser navigates away, track changes)
  res.on("close", () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  });
}

/**
 * Serve a cached .m4a file with full HTTP Range request support.
 * Supports 206 Partial Content for seekability.
 */
function serveCachedFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  trackId: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end("Cached file not found");
    return;
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.range;

  if (!rangeHeader) {
    // No Range header — serve full file
    res.writeHead(200, {
      "Content-Type": "audio/mp4",
      "Content-Length": String(fileSize),
      "Accept-Ranges": "bytes",
    });
    const readStream = fs.createReadStream(filePath);
    registerCacheReadStream(trackId, readStream);
    readStream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
    readStream.pipe(res);
    return;
  }

  // Parse Range header: "bytes=<start>-<end>"
  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!rangeMatch) {
    res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    res.end("Invalid range");
    return;
  }

  const startStr = rangeMatch[1];
  const endStr = rangeMatch[2];

  let start: number;
  let end: number;

  if (!startStr && !endStr) {
    res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    res.end("Invalid range");
    return;
  }

  if (!startStr) {
    // Suffix range: bytes=-N (last N bytes)
    const suffixLen = parseInt(endStr!, 10);
    start = Math.max(0, fileSize - suffixLen);
    end = fileSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : fileSize - 1;
  }

  // Clamp end to file bounds
  end = Math.min(end, fileSize - 1);

  if (start > end || start >= fileSize) {
    res.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
    res.end("Requested range not satisfiable");
    return;
  }

  const chunkSize = end - start + 1;
  res.writeHead(206, {
    "Content-Type": "audio/mp4",
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": String(chunkSize),
  });

  const readStream = fs.createReadStream(filePath, { start, end });
  registerCacheReadStream(trackId, readStream);
  readStream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
  readStream.pipe(res);

  res.on("close", () => {
    if (!readStream.destroyed) {
      readStream.destroy();
    }
  });
}

/**
 * Returns the cache file path for the .tmp file that stream-server writes to.
 * Used by music-ipc.ts to rename the .tmp file after stream completion.
 */
export function getCacheTmpPath(cacheFilePath: string): string {
  return cacheFilePath + ".tmp";
}

/**
 * Complete the cache write for a track: rename .tmp to final path.
 * Called by music-ipc.ts when the tee stream ends successfully.
 * Returns the final file size, or null if the rename fails.
 */
export function finalizeCacheFile(cacheFilePath: string): number | null {
  const tmpPath = cacheFilePath + ".tmp";
  try {
    if (!fs.existsSync(tmpPath)) return null;
    fs.renameSync(tmpPath, cacheFilePath);
    const stat = fs.statSync(cacheFilePath);
    return stat.size;
  } catch (err) {
    console.error("[stream-server] Failed to finalize cache file:", err);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    return null;
  }
}

/**
 * Get the basename without extension from a cache file path.
 * Used by music-ipc.ts to get the trackId from the cache file path.
 */
export function getTrackIdFromCachePath(cacheFilePath: string): string {
  return path.basename(cacheFilePath, ".m4a");
}
