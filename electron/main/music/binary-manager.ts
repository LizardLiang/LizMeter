// electron/main/music/binary-manager.ts
// Detect, download, verify, and manage yt-dlp and ffmpeg binaries.
// Binaries are stored in userData/bin/ and downloaded on first use.

import { app } from "electron";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BinaryDownloadProgress, BinaryInfo, BinaryStatus } from "../../../src/shared/types.ts";
import { MusicError } from "./music-error.ts";

const execFileAsync = promisify(execFile);

// Module-level idempotency guard (v2.0 -- MAJOR-06 fix)
let isDownloading = false;

// Cached binary status — reset after downloadBinaries completes
let cachedStatus: BinaryStatus | null = null;

// GitHub API endpoints for binary releases
const YT_DLP_API_URL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const FFMPEG_API_URL = "https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest";

// User-Agent required by GitHub API
const GITHUB_USER_AGENT = "LizMeter/1.0";

/**
 * Returns the directory where binaries are stored.
 * Creates the directory if it does not exist.
 */
export function getBinDir(): string {
  const dir = path.join(app.getPath("userData"), "bin");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the full path to the yt-dlp binary (includes .exe on Windows).
 */
export function getYtDlpPath(): string {
  const filename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return path.join(getBinDir(), filename);
}

/**
 * Returns the full path to the ffmpeg binary (includes .exe on Windows).
 */
export function getFfmpegPath(): string {
  const filename = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(getBinDir(), filename);
}

/**
 * Check whether yt-dlp and ffmpeg are installed.
 * Extracts yt-dlp version via subprocess call.
 * Result is cached until downloadBinaries() resets it.
 * v2.0: made async (MINOR-06 fix)
 */
export async function checkBinaries(): Promise<BinaryStatus> {
  if (cachedStatus !== null) return cachedStatus;

  const ytDlpPath = getYtDlpPath();
  const ffmpegPath = getFfmpegPath();

  // Phase 1: existence check
  let ytDlpInstalled = fs.existsSync(ytDlpPath);
  let ffmpegInstalled = fs.existsSync(ffmpegPath);

  // Phase 2: health check — actually execute each binary.
  // A file-exists check is not enough: a shared-build ffmpeg (missing DLLs) or a
  // wrong-architecture binary passes the existence check but crashes on launch.
  // If execution fails we delete the broken file so the next download is clean.
  let ytDlpVersion: string | null = null;
  if (ytDlpInstalled) {
    try {
      const { stdout } = await execFileAsync(ytDlpPath, ["--version"], { timeout: 5000 });
      ytDlpVersion = stdout.trim() || null;
    } catch {
      // Exists but broken — remove so download can replace it atomically
      ytDlpInstalled = false;
      try { fs.unlinkSync(ytDlpPath); } catch { /* ignore */ }
    }
  }

  if (ffmpegInstalled) {
    try {
      await execFileAsync(ffmpegPath, ["-version"], { timeout: 5000 });
    } catch {
      // Exists but broken (e.g. shared build missing DLLs, wrong arch)
      ffmpegInstalled = false;
      try { fs.unlinkSync(ffmpegPath); } catch { /* ignore */ }
    }
  }

  cachedStatus = {
    ytDlpInstalled,
    ffmpegInstalled,
    ytDlpVersion,
  };

  return cachedStatus;
}

/**
 * Fetch download metadata from GitHub Releases API.
 * v2.0 (MAJOR-05 fix): On network failure, returns partial BinaryInfo with
 * nullable fields set to null and error field populated.
 */
export async function getBinaryInfo(): Promise<BinaryInfo> {
  const binDir = getBinDir();
  const ytDlpFilename = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const ffmpegFilename = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  const staticFields = {
    storagePath: binDir,
    ytDlpFilename,
    ffmpegFilename,
  };

  try {
    const [ytDlpRelease, ffmpegRelease] = await Promise.all([
      fetchGitHubRelease(YT_DLP_API_URL),
      fetchGitHubRelease(FFMPEG_API_URL),
    ]);

    const ytDlpAsset = selectYtDlpAsset(ytDlpRelease.assets);
    const ffmpegAsset = selectFfmpegAsset(ffmpegRelease.assets);

    return {
      ...staticFields,
      ytDlpSize: ytDlpAsset?.size ?? null,
      ffmpegSize: ffmpegAsset?.size ?? null,
      ytDlpUrl: ytDlpAsset?.browser_download_url ?? null,
      ffmpegUrl: ffmpegAsset?.browser_download_url ?? null,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...staticFields,
      ytDlpSize: null,
      ffmpegSize: null,
      ytDlpUrl: null,
      ffmpegUrl: null,
      error: `Failed to fetch binary info: ${message}`,
    };
  }
}

/**
 * Download yt-dlp and ffmpeg binaries with SHA256 verification.
 * Uses .tmp rename pattern for atomic writes.
 * Calls onProgress approximately every 100ms.
 * v2.0 (MAJOR-06): module-level isDownloading guard.
 * v2.0 (MINOR-03 + MINOR-07): dual checksum verification + ffmpeg zip extraction.
 */
export async function downloadBinaries(
  onProgress: (progress: BinaryDownloadProgress) => void,
): Promise<void> {
  if (isDownloading) {
    throw new MusicError("Download already in progress", "DOWNLOAD_IN_PROGRESS");
  }

  isDownloading = true;
  // Reset cached status so next checkBinaries() re-checks
  cachedStatus = null;

  const binDir = getBinDir();
  const ytDlpFinalPath = getYtDlpPath();
  const ffmpegFinalPath = getFfmpegPath();
  const ytDlpTmpPath = ytDlpFinalPath + ".tmp";
  const ffmpegArchiveTmpPath = path.join(binDir, "ffmpeg-archive.tmp");
  const ffmpegBinTmpPath = ffmpegFinalPath + ".tmp";

  try {
    // === Download yt-dlp ===
    const info = await getBinaryInfo();

    if (!info.ytDlpUrl || !info.ffmpegUrl) {
      throw new MusicError(
        info.error ?? "Could not determine download URLs. Check network connection.",
        "NETWORK_ERROR",
      );
    }

    // Download yt-dlp binary
    await downloadFile(info.ytDlpUrl, ytDlpTmpPath, (progress) => {
      onProgress({ ...progress, binary: "yt-dlp" });
    });

    // Verify yt-dlp SHA256
    await verifyYtDlpChecksum(info.ytDlpUrl, ytDlpTmpPath);

    // Atomic rename
    fs.renameSync(ytDlpTmpPath, ytDlpFinalPath);
    if (process.platform !== "win32") {
      fs.chmodSync(ytDlpFinalPath, 0o755);
    }

    // === Download ffmpeg ===
    await downloadFile(info.ffmpegUrl, ffmpegArchiveTmpPath, (progress) => {
      onProgress({ ...progress, binary: "ffmpeg" });
    });

    // Verify ffmpeg archive SHA256
    await verifyFfmpegChecksum(info.ffmpegUrl, ffmpegArchiveTmpPath);

    // Extract ffmpeg binary from archive
    await extractFfmpegBinary(ffmpegArchiveTmpPath, ffmpegBinTmpPath);

    // Atomic rename
    fs.renameSync(ffmpegBinTmpPath, ffmpegFinalPath);
    if (process.platform !== "win32") {
      fs.chmodSync(ffmpegFinalPath, 0o755);
    }
  } catch (err) {
    // Clean up any partial downloads
    for (const tmpPath of [ytDlpTmpPath, ffmpegArchiveTmpPath, ffmpegBinTmpPath]) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (err instanceof MusicError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new MusicError(`Binary download failed: ${message}`, "BINARY_DOWNLOAD_FAILED");
  } finally {
    isDownloading = false;
    // Clean up archive temp file regardless of success/failure
    try {
      if (fs.existsSync(ffmpegArchiveTmpPath)) fs.unlinkSync(ffmpegArchiveTmpPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// --- Internal helpers ---

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

interface GitHubRelease {
  assets: GitHubAsset[];
}

function fetchGitHubRelease(url: string): Promise<GitHubRelease> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": GITHUB_USER_AGENT,
          "Accept": "application/vnd.github+json",
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            reject(new Error(`Redirect with no location header`));
            return;
          }
          res.resume();
          fetchGitHubRelease(redirectUrl).then(resolve).catch(reject);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API returned status ${res.statusCode ?? "unknown"}`));
          res.resume();
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as GitHubRelease;
            resolve(json);
          } catch (e) {
            reject(new Error(`Failed to parse GitHub API response: ${String(e)}`));
          }
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("GitHub API request timed out"));
    });
    req.on("error", reject);
  });
}

function selectYtDlpAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  if (process.platform === "win32") {
    return assets.find((a) => a.name === "yt-dlp.exe");
  }
  if (process.platform === "darwin") {
    return assets.find((a) => a.name === "yt-dlp_macos");
  }
  return assets.find((a) => a.name === "yt-dlp");
}

function selectFfmpegAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
  if (process.platform === "win32") {
    // Must be the static build (no "shared" suffix) — shared builds require separate DLLs not present on disk.
    // yt-dlp/FFmpeg-Builds releases both ffmpeg-n*-win64-lgpl-*.zip (static, ~80 MB)
    // and ffmpeg-n*-win64-lgpl-shared-*.zip (shared, ~0.5 MB); we must pick the static one.
    return assets.find(
      (a) =>
        a.name.endsWith(".zip") &&
        a.name.includes("win64") &&
        !a.name.includes("shared") &&
        !a.name.includes("sha256"),
    );
  }
  if (process.platform === "darwin") {
    return assets.find(
      (a) =>
        a.name.includes("macos") &&
        a.name.endsWith(".tar.xz") &&
        !a.name.includes("shared") &&
        !a.name.includes("sha256"),
    );
  }
  // Linux
  return assets.find(
    (a) =>
      a.name.includes("linux64") &&
      a.name.endsWith(".tar.xz") &&
      !a.name.includes("shared") &&
      !a.name.includes("sha256"),
  );
}

/**
 * Download a file via HTTPS with redirect following and progress reporting.
 * Writes to destPath. Calls onProgress every ~100ms.
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (progress: Omit<BinaryDownloadProgress, "binary">) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const doDownload = (downloadUrl: string) => {
      const req = https.get(downloadUrl, { timeout: 60000 }, (res) => {
        // Follow redirects (GitHub asset downloads redirect to S3)
        if (
          res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 307 ||
          res.statusCode === 308
        ) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            reject(new Error(`Redirect with no location header from ${downloadUrl}`));
            return;
          }
          res.resume();
          doDownload(redirectUrl);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Download returned HTTP ${res.statusCode ?? "unknown"} for ${downloadUrl}`));
          res.resume();
          return;
        }

        const totalBytes = parseInt(res.headers["content-length"] ?? "0", 10) || 0;
        let bytesDownloaded = 0;
        let lastProgressTime = Date.now();
        let speedBytesAccum = 0;
        let lastSpeedTime = Date.now();
        let speed = 0;

        const writeStream = fs.createWriteStream(destPath);

        res.on("data", (chunk: Buffer) => {
          bytesDownloaded += chunk.length;
          speedBytesAccum += chunk.length;

          const now = Date.now();
          if (now - lastSpeedTime >= 500) {
            speed = Math.round((speedBytesAccum / (now - lastSpeedTime)) * 1000);
            speedBytesAccum = 0;
            lastSpeedTime = now;
          }

          if (now - lastProgressTime >= 100) {
            const percent = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0;
            onProgress({ percent, bytesDownloaded, totalBytes, speed });
            lastProgressTime = now;
          }
        });

        writeStream.on("error", (err) => {
          res.destroy();
          reject(err);
        });

        res.pipe(writeStream);
        writeStream.on("finish", () => {
          // Final progress report
          const percent = totalBytes > 0 ? 100 : 0;
          onProgress({ percent, bytesDownloaded, totalBytes, speed });
          resolve();
        });

        res.on("error", (err) => {
          writeStream.destroy();
          reject(err);
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Download timed out for ${downloadUrl}`));
      });
      req.on("error", reject);
    };

    doDownload(url);
  });
}

/**
 * Fetch the SHA2-256SUMS file for yt-dlp and verify the downloaded binary.
 * v2.0 (MINOR-03 fix): explicit dual-checksum verification.
 */
async function verifyYtDlpChecksum(binaryUrl: string, filePath: string): Promise<void> {
  // The checksum file is always at the same release — derive from binary URL
  const checksumUrl = binaryUrl.replace(/\/[^/]+$/, "/SHA2-256SUMS");

  let checksumContent: string;
  try {
    checksumContent = await fetchText(checksumUrl);
  } catch {
    // If checksum file is not available, skip verification (soft fail)
    return;
  }

  // The tmp file is named e.g. "yt-dlp.exe.tmp" but the checksum file has entries
  // for "yt-dlp.exe" — strip the .tmp suffix to match the correct entry.
  const binaryFilename = path.basename(filePath).replace(/\.tmp$/, "");
  const expectedHash = parseChecksumFile(checksumContent, binaryFilename);
  if (!expectedHash) {
    // Checksum entry not found for this binary — skip verification
    return;
  }

  const actualHash = computeSha256(filePath);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    fs.unlinkSync(filePath);
    throw new MusicError(
      `SHA256 hash mismatch for yt-dlp: expected ${expectedHash}, got ${actualHash}`,
      "HASH_MISMATCH",
    );
  }
}

/**
 * Fetch the checksum file for the ffmpeg archive and verify it.
 * v2.0 (MINOR-03 fix): explicit dual-checksum verification.
 */
async function verifyFfmpegChecksum(archiveUrl: string, archivePath: string): Promise<void> {
  // FFmpeg-Builds provides a separate checksum file alongside each archive
  // The checksum file has the same name as the archive + ".sha256"
  const checksumUrl = archiveUrl + ".sha256";

  let checksumContent: string;
  try {
    checksumContent = await fetchText(checksumUrl);
  } catch {
    // If checksum file is not available, skip verification (soft fail)
    return;
  }

  // FFmpeg checksum files typically contain: <hash>  <filename>
  const archiveFilename = path.basename(archivePath);
  const expectedHash = parseChecksumFile(checksumContent, archiveFilename)
    ?? checksumContent.split(/\s/)[0]?.trim(); // fallback: first token

  if (!expectedHash) return;

  const actualHash = computeSha256(archivePath);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    fs.unlinkSync(archivePath);
    throw new MusicError(
      `SHA256 hash mismatch for ffmpeg archive: expected ${expectedHash}, got ${actualHash}`,
      "HASH_MISMATCH",
    );
  }
}

/**
 * Extract the ffmpeg binary from the downloaded archive.
 * v2.0 (MINOR-07 fix): handles .zip on Windows, .tar.xz on POSIX.
 */
async function extractFfmpegBinary(archivePath: string, destPath: string): Promise<void> {
  if (process.platform === "win32") {
    await extractFfmpegFromZip(archivePath, destPath);
  } else {
    await extractFfmpegFromTarXz(archivePath, destPath);
  }
}

async function extractFfmpegFromZip(zipPath: string, destPath: string): Promise<void> {
  // Use adm-zip (pure JS, no native deps) to extract ffmpeg.exe from the zip
  let AdmZip: typeof import("adm-zip");
  try {
    AdmZip = (await import("adm-zip")).default;
  } catch {
    throw new MusicError(
      "adm-zip package is required for ffmpeg extraction on Windows. Run: bun add adm-zip",
      "BINARY_DOWNLOAD_FAILED",
    );
  }

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  // Find the ffmpeg.exe entry (it may be nested inside a directory)
  const ffmpegEntry = entries.find((e) => e.entryName.endsWith("ffmpeg.exe") && !e.isDirectory);
  if (!ffmpegEntry) {
    throw new MusicError("ffmpeg.exe not found in downloaded archive", "BINARY_DOWNLOAD_FAILED");
  }

  const data = ffmpegEntry.getData();
  fs.writeFileSync(destPath, data);
}

async function extractFfmpegFromTarXz(archivePath: string, destPath: string): Promise<void> {
  // On POSIX, use built-in tar command (universally available)
  const binDir = path.dirname(destPath);
  const extractDir = path.join(binDir, "ffmpeg-extract-tmp");

  try {
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Extract archive to temp directory
    await execFileAsync("tar", ["xf", archivePath, "--strip-components=2", "-C", extractDir], {
      timeout: 60000,
    });

    // Find the ffmpeg binary in the extracted directory
    const files = fs.readdirSync(extractDir, { recursive: true }) as string[];
    const ffmpegFile = files.find((f) => path.basename(f) === "ffmpeg");
    if (!ffmpegFile) {
      throw new MusicError("ffmpeg binary not found in extracted archive", "BINARY_DOWNLOAD_FAILED");
    }

    const ffmpegSrc = path.join(extractDir, ffmpegFile);
    fs.renameSync(ffmpegSrc, destPath);
  } finally {
    // Clean up extraction directory
    try {
      if (fs.existsSync(extractDir)) {
        fs.rmSync(extractDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const doFetch = (fetchUrl: string) => {
      const req = https.get(
        fetchUrl,
        {
          headers: { "User-Agent": GITHUB_USER_AGENT },
          timeout: 10000,
        },
        (res) => {
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307 ||
            res.statusCode === 308
          ) {
            const redirectUrl = res.headers.location;
            if (!redirectUrl) {
              reject(new Error("Redirect with no location header"));
              return;
            }
            res.resume();
            doFetch(redirectUrl);
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode ?? "unknown"}`));
            res.resume();
            return;
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", reject);
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
      req.on("error", reject);
    };

    doFetch(url);
  });
}

/**
 * Parse a checksums file (format: "<hash>  <filename>" per line) and return
 * the hash for the given filename, or null if not found.
 */
function parseChecksumFile(content: string, filename: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const hash = parts[0]!;
      const name = parts[parts.length - 1]!;
      if (name === filename || name.endsWith(`/${filename}`)) {
        return hash;
      }
    }
  }
  return null;
}

/**
 * Compute the SHA256 hex digest of a file.
 */
function computeSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}
