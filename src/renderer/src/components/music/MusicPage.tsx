// src/renderer/src/components/music/MusicPage.tsx
// Music page shell: URL input bar at top, three tabs (Queue, Library, Playlists).
// Phase 2: Queue and Library tabs are fully wired. Playlists remain a placeholder (Phase 3).

import { useCallback, useEffect, useRef, useState } from "react";
import { useMusicPlayer } from "../../contexts/MusicPlayerContext.tsx";
import { BinaryConsentDialog } from "./BinaryConsentDialog.tsx";
import { LibraryView } from "./LibraryView.tsx";
import styles from "./MusicPage.module.scss";
import { PlaylistManager } from "./PlaylistManager.tsx";
import { QueueView } from "./QueueView.tsx";

// ---- Toast ----

interface Toast {
  id: string;
  message: string;
}

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  return { toasts, showToast };
}

// ---- Tab types ----

type MusicTab = "queue" | "library" | "playlists";

// ---- MusicPage ----

export function MusicPage() {
  const context = useMusicPlayer();

  // URL input state
  const [urlInput, setUrlInput] = useState("");
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionStartedAt, setExtractionStartedAt] = useState<number | null>(null);
  const [showSlowMessage, setShowSlowMessage] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<MusicTab>("queue");

  // Binary consent dialog
  const [showConsentDialog, setShowConsentDialog] = useState(false);

  // Pending URL: stored when user tried to play but binaries were missing
  const pendingUrlRef = useRef<string | null>(null);

  const { toasts, showToast } = useToast();

  // "This is taking longer than usual" message after 5 seconds of extraction
  useEffect(() => {
    if (!isExtracting || extractionStartedAt === null) {
      setShowSlowMessage(false);
      return;
    }
    const elapsed = Date.now() - extractionStartedAt;
    const remaining = Math.max(0, 5000 - elapsed);
    const timer = setTimeout(() => setShowSlowMessage(true), remaining);
    return () => clearTimeout(timer);
  }, [isExtracting, extractionStartedAt]);

  // Reset slow message when extraction ends
  useEffect(() => {
    if (!isExtracting) {
      setShowSlowMessage(false);
    }
  }, [isExtracting]);

  const handlePlay = useCallback(async (url: string) => {
    // Validate URL format
    try {
      new URL(url);
    } catch {
      showToast("Please enter a valid URL.");
      return;
    }

    // Check if binaries are missing — if so, show consent dialog and store the URL
    if (
      context.binaryStatus !== null && (!context.binaryStatus.ytDlpInstalled || !context.binaryStatus.ffmpegInstalled)
    ) {
      pendingUrlRef.current = url;
      setShowConsentDialog(true);
      return;
    }

    setIsExtracting(true);
    setExtractionStartedAt(Date.now());
    try {
      await context.play(url);
      setUrlInput("");
      // Switch to queue tab after successfully starting playback
      setActiveTab("queue");
    } catch (err: unknown) {
      const code = (err as { code?: string; }).code;
      if (code === "BINARY_MISSING") {
        pendingUrlRef.current = url;
        setShowConsentDialog(true);
      } else {
        const message = err instanceof Error ? err.message : "Playback failed.";
        showToast(message);
      }
    } finally {
      setIsExtracting(false);
      setExtractionStartedAt(null);
    }
  }, [context, showToast]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = urlInput.trim();
      if (!trimmed || isExtracting) return;
      void handlePlay(trimmed);
    },
    [urlInput, isExtracting, handlePlay],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const trimmed = urlInput.trim();
        if (!trimmed || isExtracting) return;
        void handlePlay(trimmed);
      }
    },
    [urlInput, isExtracting, handlePlay],
  );

  const handleConsentAccept = useCallback(async () => {
    setShowConsentDialog(false);
    await context.refreshBinaryStatus();
    const url = pendingUrlRef.current;
    pendingUrlRef.current = null;
    if (url) {
      setUrlInput(url);
      await handlePlay(url);
    }
  }, [context, handlePlay]);

  const handleConsentCancel = useCallback(() => {
    setShowConsentDialog(false);
    pendingUrlRef.current = null;
  }, []);

  const handleCancelImport = useCallback(() => {
    void window.electronAPI.music.importCancel().catch(() => {});
  }, []);

  // Whether binaries are known to be missing
  const binariesMissing = context.binaryStatus !== null
    && (!context.binaryStatus.ytDlpInstalled || !context.binaryStatus.ffmpegInstalled);

  // Import progress
  const importProgress = context.importProgress;
  const isImporting = importProgress !== null && (
    importProgress.total === null || importProgress.current < importProgress.total
  );

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Music</h1>

      {/* Non-blocking setup banner */}
      {binariesMissing && !showConsentDialog && (
        <div className={styles.setupBanner}>
          <span className={styles.setupBannerText}>
            Music playback requires a one-time setup.
          </span>
          <button
            className={styles.setupBannerBtn}
            onClick={() => setShowConsentDialog(true)}
            type="button"
          >
            Set Up Now
          </button>
        </div>
      )}

      {/* URL input bar */}
      <form className={styles.urlForm} onSubmit={handleSubmit}>
        <div className={styles.urlInputWrapper}>
          <input
            className={styles.urlInput}
            type="text"
            placeholder="Paste a URL to play audio..."
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isExtracting}
            aria-label="Audio URL"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className={styles.playBtn}
            type="submit"
            disabled={isExtracting || !urlInput.trim()}
            aria-label="Play"
          >
            {isExtracting
              ? <span className={styles.spinner} aria-hidden="true" />
              : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
          </button>
        </div>

        {/* Extraction status messages */}
        {isExtracting && (
          <div className={styles.extractionStatus}>
            <span>Extracting audio...</span>
            {showSlowMessage && <span className={styles.slowMessage}>This is taking longer than usual.</span>}
          </div>
        )}

        {/* Playlist import progress (T2.7) */}
        {importProgress !== null && (
          <div className={styles.importProgress}>
            {isImporting && <span className={styles.spinner} aria-hidden="true" />}
            <span className={styles.importText}>
              {isImporting
                ? `Loading playlist... ${importProgress.current} track${importProgress.current !== 1 ? "s" : ""} added`
                : `Playlist loaded: ${importProgress.current} track${importProgress.current !== 1 ? "s" : ""}`}
            </span>
            {isImporting && (
              <button
                className={styles.cancelImportBtn}
                onClick={handleCancelImport}
                type="button"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </form>

      {/* Tab bar */}
      <div className={styles.tabBar} role="tablist" aria-label="Music tabs">
        {(["queue", "library", "playlists"] as MusicTab[]).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={activeTab === tab ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab(tab)}
            type="button"
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className={styles.tabContent} role="tabpanel">
        {activeTab === "queue" && <QueueView />}
        {activeTab === "library" && <LibraryView />}
        {activeTab === "playlists" && <PlaylistManager />}
      </div>

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className={styles.toastContainer} aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={styles.toast}>
              {t.message}
            </div>
          ))}
        </div>
      )}

      {/* Binary consent dialog */}
      {showConsentDialog && (
        <BinaryConsentDialog
          onAccept={() => void handleConsentAccept()}
          onCancel={handleConsentCancel}
        />
      )}
    </div>
  );
}
