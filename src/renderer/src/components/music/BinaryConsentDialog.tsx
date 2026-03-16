// src/renderer/src/components/music/BinaryConsentDialog.tsx
// Consent dialog shown when music binaries (yt-dlp, ffmpeg) are missing.
// Fetches binary metadata, shows sizes/paths/links, handles download progress.

import { useEffect, useRef, useState } from "react";
import type { BinaryDownloadProgress, BinaryInfo } from "../../../../shared/types.ts";
import styles from "./BinaryConsentDialog.module.scss";

interface BinaryConsentDialogProps {
  /** Called after a successful binary download completes. */
  onAccept: () => void;
  /** Called when the user declines or closes the dialog. */
  onCancel: () => void;
}

type Phase = "loading" | "consent" | "downloading" | "done" | "error";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

// Open an external URL via shell (falls back gracefully if API not available)
function openExternal(url: string): void {
  if (window.electronAPI?.shell?.openExternal) {
    void window.electronAPI.shell.openExternal(url);
  }
}

export function BinaryConsentDialog({ onAccept, onCancel }: BinaryConsentDialogProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [binaryInfo, setBinaryInfo] = useState<BinaryInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Track per-binary download progress
  const [ytDlpProgress, setYtDlpProgress] = useState<BinaryDownloadProgress | null>(null);
  const [ffmpegProgress, setFfmpegProgress] = useState<BinaryDownloadProgress | null>(null);

  // Track which binaries have completed (ref only — used in progress callback)
  const ytDlpDoneRef = useRef(false);
  const ffmpegDoneRef = useRef(false);

  // Unsubscribe ref to clean up push event listener
  const unsubRef = useRef<(() => void) | null>(null);

  // Fetch binary info on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const info = await window.electronAPI.music.binaryInfo();
        if (!cancelled) {
          setBinaryInfo(info);
          setPhase("consent");
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to fetch binary information.");
          setPhase("error");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on Escape (only when not downloading)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "downloading") {
        onCancel();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [phase, onCancel]);

  // Clean up progress listener on unmount
  useEffect(() => {
    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, []);

  const handleDownload = async () => {
    setPhase("downloading");
    setDownloadError(null);
    setYtDlpProgress(null);
    setFfmpegProgress(null);
    ytDlpDoneRef.current = false;
    ffmpegDoneRef.current = false;

    // Subscribe to push events BEFORE initiating download
    unsubRef.current = window.electronAPI.music.onDownloadProgress((progress) => {
      if (progress.binary === "yt-dlp") {
        setYtDlpProgress(progress);
        if (progress.percent >= 100) {
          ytDlpDoneRef.current = true;
        }
      } else {
        setFfmpegProgress(progress);
        if (progress.percent >= 100) {
          ffmpegDoneRef.current = true;
        }
      }
    });

    try {
      await window.electronAPI.music.binaryDownload();
      // Download resolved — show done state briefly, then call onAccept
      ytDlpDoneRef.current = true;
      ffmpegDoneRef.current = true;
      // Force a final progress paint at 100% for both if events didn't arrive
      setYtDlpProgress((prev) => prev ? { ...prev, percent: 100 } : null);
      setFfmpegProgress((prev) => prev ? { ...prev, percent: 100 } : null);
      setPhase("done");
      setTimeout(() => {
        onAccept();
      }, 800);
    } catch (err) {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      setDownloadError(err instanceof Error ? err.message : "Download failed. Please try again.");
      setPhase("consent");
    }
  };

  const isWindows = window.electronAPI?.platform === "win32";

  // Determine filename labels with .exe on Windows
  const ytDlpFilename = binaryInfo?.ytDlpFilename ?? (isWindows ? "yt-dlp.exe" : "yt-dlp");
  const ffmpegFilename = binaryInfo?.ffmpegFilename ?? (isWindows ? "ffmpeg.exe" : "ffmpeg");

  return (
    <div className={styles.overlay} onClick={phase !== "downloading" ? onCancel : undefined}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true">&#9836;</span>
          <h3 className={styles.title}>Music Setup Required</h3>
        </div>

        {/* Loading phase */}
        {phase === "loading" && (
          <div className={styles.loadingState}>
            <span className={styles.spinner} aria-hidden="true" />
            Fetching binary information...
          </div>
        )}

        {/* Error loading binary info */}
        {phase === "error" && (
          <div className={styles.body}>
            <div className={styles.errorBanner}>
              {loadError ?? "Unable to fetch binary information."}
            </div>
          </div>
        )}

        {/* Consent phase */}
        {(phase === "consent" || phase === "downloading" || phase === "done") && (
          <div className={styles.body}>
            {phase === "consent" && (
              <>
                <p className={styles.description}>
                  Music playback requires two open-source tools to be downloaded once and stored locally on your
                  machine.
                </p>

                {downloadError && <div className={styles.errorBanner}>{downloadError}</div>}

                <div className={styles.binaryList}>
                  {/* yt-dlp row */}
                  <div className={styles.binaryRow}>
                    <span className={styles.binaryIcon} aria-hidden="true">&#128190;</span>
                    <div className={styles.binaryDetails}>
                      <span className={styles.binaryName}>{ytDlpFilename}</span>
                      <div className={styles.binaryMeta}>
                        <span className={styles.binarySize}>
                          {formatBytes(binaryInfo?.ytDlpSize ?? null)}
                        </span>
                        <button
                          className={styles.binaryLink}
                          onClick={() => openExternal("https://github.com/yt-dlp/yt-dlp")}
                          type="button"
                        >
                          github.com/yt-dlp/yt-dlp
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* ffmpeg row */}
                  <div className={styles.binaryRow}>
                    <span className={styles.binaryIcon} aria-hidden="true">&#128190;</span>
                    <div className={styles.binaryDetails}>
                      <span className={styles.binaryName}>{ffmpegFilename}</span>
                      <div className={styles.binaryMeta}>
                        <span className={styles.binarySize}>
                          {formatBytes(binaryInfo?.ffmpegSize ?? null)}
                        </span>
                        <button
                          className={styles.binaryLink}
                          onClick={() => openExternal("https://ffmpeg.org")}
                          type="button"
                        >
                          ffmpeg.org
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {binaryInfo && (
                  <div className={styles.storagePath}>
                    <span className={styles.storageLabel}>Storage Location</span>
                    <span className={styles.storageValue}>{binaryInfo.storagePath}</span>
                  </div>
                )}

                {isWindows && (
                  <div className={styles.warningNote}>
                    <span className={styles.warningIcon} aria-hidden="true">&#9888;</span>
                    <p className={styles.warningText}>
                      Windows SmartScreen may flag these downloads. Both tools are open-source and widely used. You can
                      verify the binaries on their official pages above.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* Download progress phase */}
            {(phase === "downloading" || phase === "done") && (
              <div className={styles.progressSection}>
                <p className={styles.progressTitle}>
                  {phase === "done" ? "Download complete!" : "Downloading..."}
                </p>

                <ProgressItem
                  filename={ytDlpFilename}
                  progress={ytDlpProgress}
                  done={phase === "done" || (ytDlpProgress?.percent ?? 0) >= 100}
                  totalBytes={binaryInfo?.ytDlpSize ?? null}
                />

                <ProgressItem
                  filename={ffmpegFilename}
                  progress={ffmpegProgress}
                  done={phase === "done" || (ffmpegProgress?.percent ?? 0) >= 100}
                  totalBytes={binaryInfo?.ffmpegSize ?? null}
                />
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className={styles.footer}>
          {phase === "consent" && (
            <>
              <button className={styles.cancelBtn} onClick={onCancel} type="button">
                Cancel
              </button>
              <button
                className={styles.downloadBtn}
                onClick={() => void handleDownload()}
                type="button"
              >
                Download
              </button>
            </>
          )}

          {(phase === "downloading" || phase === "done") && (
            <button
              className={styles.cancelBtn}
              onClick={onCancel}
              disabled={phase === "downloading"}
              type="button"
            >
              Cancel
            </button>
          )}

          {(phase === "loading" || phase === "error") && (
            <button className={styles.cancelBtn} onClick={onCancel} type="button">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- ProgressItem sub-component ----

interface ProgressItemProps {
  filename: string;
  progress: BinaryDownloadProgress | null;
  done: boolean;
  totalBytes: number | null;
}

function ProgressItem({ filename, progress, done, totalBytes }: ProgressItemProps) {
  const percent = done ? 100 : (progress?.percent ?? 0);
  const downloaded = progress?.bytesDownloaded ?? 0;
  const total = progress?.totalBytes ?? totalBytes;
  const speed = progress?.speed ?? 0;

  return (
    <div className={styles.progressItem}>
      <div className={styles.progressItemHeader}>
        <span className={styles.progressBinaryName}>{filename}</span>
        {done
          ? <span className={styles.completedText}>Done</span>
          : (
            <span className={styles.progressStats}>
              {total !== null
                ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
                : formatBytes(downloaded)}
              {speed > 0 && ` — ${formatSpeed(speed)}`}
            </span>
          )}
      </div>
      <div className={styles.progressTrack}>
        <div
          className={`${styles.progressFill}${done ? ` ${styles.progressFillComplete}` : ""}`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}
