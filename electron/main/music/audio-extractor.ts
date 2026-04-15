// electron/main/music/audio-extractor.ts
// Interface with yt-dlp for metadata extraction and audio streaming.
// All yt-dlp invocations go through process-manager (no raw spawn).
// v2.0: --no-playlist included on all single-track commands (MAJOR-02 fix).
// v2.0: Concurrent keyed processes for stream + metadata (CRIT-02 fix).

import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import { spawnYtDlp, killProcess } from "./process-manager.ts";
import { getFfmpegPath } from "./binary-manager.ts";
import { MusicError } from "./music-error.ts";

export interface TrackMetadata {
  title: string;
  artist: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  sourceId: string;
  sourceSite: string;
  sourceUrl: string; // webpage_url (canonical)
  isLive: boolean; // true for live streams
}

interface ExtractAudioOptions {
  spawnMetadata?: boolean;
}

// Max tracks to import from a playlist before hard-capping
const PLAYLIST_IMPORT_CAP = 500;

// Timeout for playlist detection (shorter than normal — just need 1-2 entries)
const DETECT_TIMEOUT_MS = 10_000;

/**
 * Validate a URL before passing it to yt-dlp.
 * Throws MusicError("INVALID_URL") if the URL is not well-formed.
 */
function validateUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new MusicError(`Invalid URL: ${url}`, "INVALID_URL");
  }
}

/**
 * Collect all stdout data from a Readable stream into a string.
 */
function collectStdout(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

/**
 * Collect stderr output from a Readable stream into a string.
 */
function collectStderr(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

/**
 * Wait for a process to exit and return its exit code.
 */
function waitForExit(proc: import("node:child_process").ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    proc.on("exit", (code) => resolve(code));
    proc.on("error", () => resolve(null));
  });
}

/**
 * Parse yt-dlp's --dump-json output into a TrackMetadata object.
 * Handles missing/null fields gracefully.
 */
function parseYtDlpJson(raw: string, inputUrl: string): TrackMetadata {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.trim()) as Record<string, unknown>;
  } catch {
    throw new MusicError("Failed to parse yt-dlp metadata output", "EXTRACTION_FAILED");
  }

  const title = typeof data["title"] === "string" ? data["title"] : "Unknown title";

  // Artist: prefer "uploader" then "channel" then null
  let artist: string | null = null;
  if (typeof data["uploader"] === "string" && data["uploader"]) {
    artist = data["uploader"];
  } else if (typeof data["channel"] === "string" && data["channel"]) {
    artist = data["channel"];
  }

  const durationSeconds = typeof data["duration"] === "number" ? Math.round(data["duration"]) : null;
  const thumbnailUrl = typeof data["thumbnail"] === "string" ? data["thumbnail"] : null;
  const sourceId = typeof data["id"] === "string" ? data["id"] : "";
  // yt-dlp uses "extractor_key" for the capitalized extractor name
  const sourceSite = typeof data["extractor_key"] === "string"
    ? data["extractor_key"].toLowerCase()
    : (typeof data["extractor"] === "string" ? data["extractor"] : "unknown");
  // webpage_url is the canonical URL; fall back to input url
  const sourceUrl = typeof data["webpage_url"] === "string" ? data["webpage_url"] : inputUrl;
  // Live stream detection: yt-dlp sets is_live=true for ongoing streams
  const isLive = data["is_live"] === true;

  return { title, artist, durationSeconds, thumbnailUrl, sourceId, sourceSite, sourceUrl, isLive };
}

/**
 * Build the base args for yt-dlp invocations that need ffmpeg.
 * --ffmpeg-location is always included when the ffmpeg binary is available.
 */
function getFfmpegArgs(): string[] {
  const ffmpegPath = getFfmpegPath();
  return ["--ffmpeg-location", ffmpegPath];
}

/**
 * Extract metadata for a single URL.
 * Runs: yt-dlp --dump-json --no-download <url>
 * (--no-playlist is automatically prepended by process-manager)
 */
export async function extractMetadata(url: string): Promise<TrackMetadata> {
  validateUrl(url);

  const key = `metadata:${url}`;
  const { stdout, stderr, process: proc } = spawnYtDlp(key, [
    "--dump-json",
    "--no-download",
    url,
  ]);

  const [rawOutput, stderrOutput, exitCode] = await Promise.all([
    collectStdout(stdout),
    collectStderr(stderr),
    waitForExit(proc),
  ]);

  if (exitCode !== 0 && exitCode !== null) {
    const errorMsg = stderrOutput.trim() || "yt-dlp exited with non-zero code";
    throw new MusicError(`Metadata extraction failed: ${errorMsg}`, "EXTRACTION_FAILED");
  }

  if (!rawOutput.trim()) {
    throw new MusicError("yt-dlp produced no output for metadata extraction", "EXTRACTION_FAILED");
  }

  return parseYtDlpJson(rawOutput, url);
}

/**
 * Extract audio stream from a URL.
 * Returns the stdout stream immediately (for piping to the HTTP server)
 * plus an optional metadata promise when the caller wants a parallel --dump-json.
 *
 * Runs two concurrent yt-dlp processes with different keys when metadata is enabled:
 *   - "stream:<url>": produces the audio stream
 *   - "metadata:<url>": produces metadata (--dump-json, runs in parallel)
 *
 * Format: M4A preferred; falls back to opus if m4a fails.
 */
export function extractAudio(
  url: string,
  options: ExtractAudioOptions = {},
): { stream: Readable; metadata: Promise<TrackMetadata | null> } {
  validateUrl(url);

  const ffmpegArgs = getFfmpegArgs();
  const streamKey = `stream:${url}`;
  const shouldSpawnMetadata = options.spawnMetadata !== false;

  // Spawn audio stream process
  const streamResult = spawnYtDlp(streamKey, [
    "-f", "bestaudio[ext=m4a]/bestaudio",
    "--audio-format", "m4a",
    ...ffmpegArgs,
    "-o", "-",
    url,
  ]);

  const metadata: Promise<TrackMetadata | null> = shouldSpawnMetadata
    ? (async () => {
      const metaKey = `metadata:${url}`;
      const metaResult = spawnYtDlp(metaKey, [
        "--dump-json",
        "--no-download",
        url,
      ]);

      const [rawOutput, stderrOutput, exitCode] = await Promise.all([
        collectStdout(metaResult.stdout),
        collectStderr(metaResult.stderr),
        waitForExit(metaResult.process),
      ]);

      if (exitCode !== 0 && exitCode !== null) {
        const errorMsg = stderrOutput.trim() || "yt-dlp metadata extraction failed";
        throw new MusicError(`Metadata extraction failed: ${errorMsg}`, "EXTRACTION_FAILED");
      }

      if (!rawOutput.trim()) {
        throw new MusicError("yt-dlp produced no metadata output", "EXTRACTION_FAILED");
      }

      return parseYtDlpJson(rawOutput, url);
    })()
    : Promise.resolve(null);

  // Handle M4A stream failure with opus fallback
  // We wrap the stream in a proxy that handles the exit code
  const stream = streamResult.stdout;
  const streamProcess = streamResult.process;
  const streamStderr = streamResult.stderr;

  // We collect stderr from the stream process to use in error messages
  const stderrCollector = collectStderr(streamStderr);

  // Set up format fallback on stream process failure
  // The stream is returned immediately; the fallback is transparent to the caller
  const outputStream = new PassThrough();

  // Pipe initial stream to passthrough
  stream.pipe(outputStream, { end: false });

  streamProcess.on("exit", async (code) => {
    if (code === 0) {
      // Success — end the output stream
      outputStream.end();
      return;
    }

    // Failure — try opus fallback
    const stderrMsg = (await stderrCollector).trim();
    console.warn("[audio-extractor] M4A extraction failed, trying opus fallback:", stderrMsg);

    try {
      const fallbackResult = spawnYtDlp(streamKey, [
        "-f", "bestaudio",
        "--audio-format", "opus",
        ...ffmpegArgs,
        "-o", "-",
        url,
      ]);

      const fallbackStderrCollector = collectStderr(fallbackResult.stderr);
      fallbackResult.stdout.pipe(outputStream, { end: false });

      fallbackResult.process.on("exit", async (fallbackCode) => {
        if (fallbackCode === 0) {
          outputStream.end();
        } else {
          const fallbackStderrMsg = (await fallbackStderrCollector).trim();
          const errorMsg = fallbackStderrMsg || stderrMsg || "All audio formats failed";
          outputStream.destroy(new MusicError(`Audio extraction failed: ${errorMsg}`, "FORMAT_ERROR"));
        }
      });

      fallbackResult.process.on("error", (err) => {
        outputStream.destroy(new MusicError(`Opus fallback spawn failed: ${err.message}`, "FORMAT_ERROR"));
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputStream.destroy(new MusicError(`Audio extraction failed: ${msg}`, "FORMAT_ERROR"));
    }
  });

  streamProcess.on("error", (err) => {
    outputStream.destroy(new MusicError(`yt-dlp stream process error: ${err.message}`, "EXTRACTION_FAILED"));
  });

  return { stream: outputStream, metadata };
}

/**
 * Detect whether a URL points to a playlist or a single track.
 * Runs yt-dlp with --flat-playlist --playlist-items 1:2 and checks if >1 JSON line is output.
 * Returns false on error (treats as single track — safer default).
 */
export async function detectPlaylist(url: string): Promise<boolean> {
  validateUrl(url);

  const key = `detect:${url}`;

  try {
    const { stdout, process: proc } = spawnYtDlp(
      key,
      ["--flat-playlist", "--dump-json", "--playlist-items", "1:2", url],
      { noPlaylist: false, timeoutMs: DETECT_TIMEOUT_MS },
    );

    const [rawOutput] = await Promise.all([
      collectStdout(stdout),
      waitForExit(proc),
    ]);

    // Count non-empty JSON lines
    const lines = rawOutput.split("\n").filter((l) => l.trim().length > 0);
    return lines.length > 1;
  } catch {
    // On any error (timeout, network, etc.), treat as single track
    return false;
  }
}

/**
 * Extract metadata for all tracks in a playlist.
 * Runs: yt-dlp --flat-playlist --dump-json <url>
 * (noPlaylist: false — this is intentionally a playlist command)
 *
 * Calls onTrack for each track as it is parsed from the NDJSON stream.
 * Hard cap: stops after PLAYLIST_IMPORT_CAP (500) tracks.
 * Respects AbortSignal for cancellation.
 */
export async function extractPlaylistMetadata(
  url: string,
  onTrack: (meta: TrackMetadata, index: number) => void,
  signal: AbortSignal,
): Promise<{ total: number }> {
  validateUrl(url);

  const key = `import:${url}`;

  // Register abort handler before spawning
  const handleAbort = () => {
    killProcess(key);
  };
  signal.addEventListener("abort", handleAbort, { once: true });

  let trackCount = 0;

  try {
    const { stdout, process: proc } = spawnYtDlp(
      key,
      ["--flat-playlist", "--dump-json", url],
      { noPlaylist: false },
    );

    // Parse NDJSON line-by-line from stdout
    await new Promise<void>((resolve, reject) => {
      let buffer = "";

      stdout.on("data", (chunk: Buffer) => {
        if (signal.aborted) return;

        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const data = JSON.parse(trimmed) as Record<string, unknown>;

            // Build minimal metadata from flat-playlist output
            // --flat-playlist produces simplified entries (url, title, duration)
            const title = typeof data["title"] === "string" ? data["title"] : "Unknown";
            const artist: string | null = typeof data["uploader"] === "string" ? data["uploader"] : null;
            const durationSeconds = typeof data["duration"] === "number" ? Math.round(data["duration"]) : null;
            const thumbnailUrl = typeof data["thumbnail"] === "string" ? data["thumbnail"] : null;
            const sourceId = typeof data["id"] === "string" ? data["id"] : "";
            const sourceSite = typeof data["ie_key"] === "string"
              ? data["ie_key"].toLowerCase()
              : (typeof data["extractor"] === "string" ? data["extractor"] : "unknown");
            // For flat-playlist, "url" is the track URL
            const sourceUrl = typeof data["url"] === "string"
              ? data["url"]
              : (typeof data["webpage_url"] === "string" ? data["webpage_url"] : url);

            const meta: TrackMetadata = {
              title,
              artist,
              durationSeconds,
              thumbnailUrl,
              sourceId,
              sourceSite,
              sourceUrl,
              isLive: data["is_live"] === true,
            };

            onTrack(meta, trackCount);
            trackCount++;

            // Enforce 500-track cap
            if (trackCount >= PLAYLIST_IMPORT_CAP) {
              killProcess(key);
              resolve();
              return;
            }
          } catch {
            // Skip malformed lines
          }
        }
      });

      stdout.on("end", () => {
        // Process any remaining buffered content
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer.trim()) as Record<string, unknown>;
            const title = typeof data["title"] === "string" ? data["title"] : "Unknown";
            const artist: string | null = typeof data["uploader"] === "string" ? data["uploader"] : null;
            const durationSeconds = typeof data["duration"] === "number" ? Math.round(data["duration"]) : null;
            const thumbnailUrl = typeof data["thumbnail"] === "string" ? data["thumbnail"] : null;
            const sourceId = typeof data["id"] === "string" ? data["id"] : "";
            const sourceSite = typeof data["ie_key"] === "string"
              ? data["ie_key"].toLowerCase()
              : "unknown";
            const sourceUrl = typeof data["url"] === "string" ? data["url"] : url;

            if (trackCount < PLAYLIST_IMPORT_CAP) {
              onTrack({ title, artist, durationSeconds, thumbnailUrl, sourceId, sourceSite, sourceUrl, isLive: data["is_live"] === true }, trackCount);
              trackCount++;
            }
          } catch {
            // Ignore malformed trailing data
          }
        }
        resolve();
      });

      stdout.on("error", (err) => {
        // MusicError from timeout surfaces as a stream error
        if (err instanceof MusicError) {
          reject(err);
        } else {
          reject(new MusicError(`Playlist extraction stream error: ${err.message}`, "EXTRACTION_FAILED"));
        }
      });

      proc.on("error", (err) => {
        reject(new MusicError(`Playlist extraction process error: ${err.message}`, "EXTRACTION_FAILED"));
      });
    });

    return { total: trackCount };
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
}
