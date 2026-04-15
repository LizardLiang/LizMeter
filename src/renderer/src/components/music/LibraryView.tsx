// src/renderer/src/components/music/LibraryView.tsx
// Library tab content for MusicPage (Phase 2).
// Features: paginated track list with infinite scroll, search, filters, sort controls.
// Each track row: thumbnail, title, artist, duration, source site badge, cached indicator.
// Clicking a track plays it immediately (or adds to queue if something is already playing).

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DamagedTrackInfo,
  IntegrityProgress,
  MusicSortDir,
  MusicSortField,
  MusicTrack,
} from "../../../../shared/types.ts";
import { useMusicPlayer } from "../../contexts/MusicPlayerContext.tsx";
import { useMusicLibrary } from "../../hooks/useMusicLibrary.ts";
import styles from "./LibraryView.module.scss";

// ---- Format duration ----

function formatDuration(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---- Track thumbnail ----

function TrackThumb({ thumbnailUrl, title }: { thumbnailUrl: string | null; title: string; }) {
  if (thumbnailUrl) {
    return <img src={thumbnailUrl} alt={title} className={styles.thumb} loading="lazy" />;
  }
  return (
    <div className={styles.thumbPlaceholder} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
    </div>
  );
}

// ---- Source site badge ----

function SiteBadge({ site }: { site: string; }) {
  const label = site.charAt(0).toUpperCase() + site.slice(1, 8);
  return <span className={styles.siteBadge} title={site}>{label}</span>;
}

// ---- Sort button ----

interface SortButtonProps {
  label: string;
  field: MusicSortField;
  currentField: MusicSortField;
  currentDir: MusicSortDir;
  onSort: (f: MusicSortField) => void;
  onToggleDir: () => void;
}

function SortButton({ label, field, currentField, currentDir, onSort, onToggleDir }: SortButtonProps) {
  const isActive = currentField === field;
  return (
    <button
      className={`${styles.sortBtn} ${isActive ? styles.sortBtnActive : ""}`}
      onClick={() => {
        if (isActive) {
          onToggleDir();
        } else {
          onSort(field);
        }
      }}
      type="button"
    >
      {label}
      {isActive && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          style={{
            transform: currentDir === "desc" ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        >
          <path d="M7 14l5-5 5 5z" />
        </svg>
      )}
    </button>
  );
}

// ---- Track row ----

interface TrackRowProps {
  track: MusicTrack;
  onPlay: (track: MusicTrack) => void;
}

function TrackRow({ track, onPlay }: TrackRowProps) {
  return (
    <button
      className={styles.trackRow}
      onClick={() => onPlay(track)}
      type="button"
      title={`Play: ${track.title}`}
    >
      <TrackThumb thumbnailUrl={track.thumbnailUrl} title={track.title} />
      <div className={styles.trackText}>
        <span className={styles.trackTitle}>{track.title}</span>
        {track.artist && <span className={styles.trackArtist}>{track.artist}</span>}
      </div>
      <div className={styles.trackMeta}>
        <SiteBadge site={track.sourceSite} />
        {track.isCached && (
          <span className={styles.cachedIcon} title="Available offline">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
            </svg>
          </span>
        )}
        <span className={styles.trackDuration}>{formatDuration(track.durationSeconds)}</span>
      </div>
    </button>
  );
}

// ---- Integrity check hook + panel ----

type IntegrityState =
  | { phase: "idle"; }
  | { phase: "scanning"; progress: IntegrityProgress | null; }
  | { phase: "done"; damaged: DamagedTrackInfo[]; checked: number; error: string | null; }
  | { phase: "repairing"; };

function useIntegrityCheck(refreshLibrary: () => void) {
  const [state, setState] = useState<IntegrityState>({ phase: "idle" });

  useEffect(() => {
    const unsub = window.electronAPI.music.onIntegrityProgress((progress) => {
      setState((prev) => prev.phase === "scanning" ? { phase: "scanning", progress } : prev);
    });
    return unsub;
  }, []);

  const handleCheck = useCallback(async () => {
    setState({ phase: "scanning", progress: null });
    try {
      const result = await window.electronAPI.music.integrityCheck();
      setState({ phase: "done", damaged: result.damaged, checked: result.checked, error: result.error });
    } catch (err) {
      setState({ phase: "done", damaged: [], checked: 0, error: err instanceof Error ? err.message : "Scan failed" });
    }
  }, []);

  const handleRepairAll = useCallback(async () => {
    if (state.phase !== "done" || state.damaged.length === 0) return;
    const ids = state.damaged.map((d) => d.track.id);
    setState({ phase: "repairing" });
    try {
      await window.electronAPI.music.integrityRepair(ids);
      setState({ phase: "idle" });
      refreshLibrary();
    } catch {
      setState({ phase: "idle" });
    }
  }, [state, refreshLibrary]);

  const handleRepairOne = useCallback(async (trackId: string) => {
    if (state.phase !== "done") return;
    try {
      await window.electronAPI.music.integrityRepair([trackId]);
      setState((prev) => {
        if (prev.phase !== "done") return prev;
        const remaining = prev.damaged.filter((d) => d.track.id !== trackId);
        return remaining.length === 0
          ? { phase: "idle" }
          : { ...prev, damaged: remaining };
      });
      refreshLibrary();
    } catch { /* non-fatal */ }
  }, [state, refreshLibrary]);

  const dismiss = useCallback(() => setState({ phase: "idle" }), []);

  return { state, handleCheck, handleRepairAll, handleRepairOne, dismiss };
}

function IntegrityResultPanel({ state, handleRepairAll, handleRepairOne, dismiss }: {
  state: IntegrityState;
  handleRepairAll: () => Promise<void>;
  handleRepairOne: (trackId: string) => Promise<void>;
  dismiss: () => void;
}) {
  if (state.phase === "scanning") {
    const p = state.progress;
    return (
      <div className={styles.integrityPanel}>
        <div className={styles.integrityHeader}>
          <span className={styles.spinner} aria-hidden="true" />
          <span className={styles.integrityTitle}>
            {p ? `Scanning ${p.current}/${p.total}...` : "Starting scan..."}
          </span>
        </div>
        {p && (
          <div className={styles.integrityProgress}>
            <div className={styles.integrityProgressBar} style={{ width: `${(p.current / p.total) * 100}%` }} />
          </div>
        )}
        {p && <span className={styles.integrityDetail}>{p.title}</span>}
      </div>
    );
  }

  if (state.phase === "repairing") {
    return (
      <div className={styles.integrityPanel}>
        <div className={styles.integrityHeader}>
          <span className={styles.spinner} aria-hidden="true" />
          <span className={styles.integrityTitle}>Repairing...</span>
        </div>
      </div>
    );
  }

  if (state.phase !== "done") return null;

  const { damaged, checked, error } = state;

  if (error) {
    return (
      <div className={styles.integrityPanel}>
        <div className={styles.integrityHeader}>
          <span className={styles.integrityTitle}>Scan error: {error}</span>
          <button className={styles.integrityClose} onClick={dismiss} type="button">&times;</button>
        </div>
      </div>
    );
  }

  if (damaged.length === 0) {
    return (
      <div className={styles.integrityPanel}>
        <div className={styles.integrityHeader}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="#9ece6a" aria-hidden="true">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
          </svg>
          <span className={styles.integrityTitle}>All {checked} cached tracks are healthy</span>
          <button className={styles.integrityClose} onClick={dismiss} type="button">&times;</button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.integrityPanel}>
      <div className={styles.integrityHeader}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="#f7768e" aria-hidden="true">
          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
        </svg>
        <span className={styles.integrityTitle}>
          {damaged.length} damaged track{damaged.length !== 1 ? "s" : ""} found
        </span>
        <button
          className={styles.integrityRepairAll}
          onClick={() => void handleRepairAll()}
          type="button"
          title="Delete damaged cache files — tracks will re-download on next play"
        >
          Repair All
        </button>
        <button className={styles.integrityClose} onClick={dismiss} type="button">&times;</button>
      </div>
      <div className={styles.integrityList}>
        {damaged.map((d) => (
          <div key={d.track.id} className={styles.integrityItem}>
            <div className={styles.integrityItemText}>
              <span className={styles.integrityItemTitle}>{d.track.title}</span>
              <span className={styles.integrityItemDetail}>{d.detail}</span>
            </div>
            <button
              className={styles.integrityRepairBtn}
              onClick={() => void handleRepairOne(d.track.id)}
              type="button"
              title="Delete cache — will re-download on next play"
            >
              Repair
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- LibraryView (exported) ----

export function LibraryView() {
  const lib = useMusicLibrary();
  const ctx = useMusicPlayer();
  const integrity = useIntegrityCheck(lib.refresh);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Infinite scroll sentinel
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && lib.hasMore && !lib.isLoading) {
          lib.loadMore();
        }
      },
      { threshold: 0.1 },
    );

    const sentinel = sentinelRef.current;
    if (sentinel) {
      observerRef.current.observe(sentinel);
    }

    return () => {
      observerRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.hasMore, lib.isLoading, lib.loadMore]);

  const [isEnqueueing, setIsEnqueueing] = useState(false);

  const handlePlay = useCallback((track: MusicTrack) => {
    void ctx.play(track.sourceUrl, track).catch(() => {});
  }, [ctx]);

  const handleAddAllToQueue = useCallback(async () => {
    if (isEnqueueing || lib.total === 0) return;
    setIsEnqueueing(true);
    try {
      // Fast-path: all tracks already loaded in the current page
      if (!lib.hasMore && lib.tracks.length > 0) {
        ctx.enqueueBulk(lib.tracks);
        return;
      }
      const result = await window.electronAPI.music.libraryList({
        limit: lib.total,
        offset: 0,
        search: lib.searchQuery || undefined,
        sortField: lib.sortField,
        sortDir: lib.sortDir,
        cachedOnly: lib.filterOfflineOnly || undefined,
      });
      ctx.enqueueBulk(result.tracks);
    } catch {
      // Non-fatal
    } finally {
      setIsEnqueueing(false);
    }
  }, [lib.total, lib.hasMore, lib.tracks, lib.searchQuery, lib.sortField, lib.sortDir, lib.filterOfflineOnly, ctx]);

  const toggleSortDir = useCallback(() => {
    lib.setSortDir(lib.sortDir === "desc" ? "asc" : "desc");
  }, [lib]);

  if (lib.tracks.length === 0 && !lib.isLoading && !lib.searchQuery && !lib.filterOfflineOnly) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon} aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
          </svg>
        </span>
        <p className={styles.emptyText}>No tracks yet.</p>
        <p className={styles.emptyHint}>Paste a URL above to get started.</p>
      </div>
    );
  }

  return (
    <div className={styles.libraryContainer}>
      {/* Search bar */}
      <div className={styles.searchWrapper}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          className={styles.searchIcon}
          aria-hidden="true"
        >
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search by title or artist..."
          value={lib.searchQuery}
          onChange={(e) => lib.setSearchQuery(e.target.value)}
          aria-label="Search library"
        />
        {lib.searchQuery && (
          <button
            className={styles.clearSearch}
            onClick={() => lib.setSearchQuery("")}
            type="button"
            aria-label="Clear search"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
      </div>

      {/* Filters and sort row */}
      <div className={styles.controlsRow}>
        {/* Filter chips */}
        <div className={styles.filterChips}>
          <button
            className={`${styles.filterChip} ${lib.filterOfflineOnly ? styles.filterChipActive : ""}`}
            onClick={() => lib.setFilterOfflineOnly(!lib.filterOfflineOnly)}
            type="button"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
            </svg>
            Offline only
          </button>
          <button
            className={`${styles.filterChip} ${integrity.state.phase !== "idle" ? styles.filterChipActive : ""}`}
            onClick={() => void integrity.handleCheck()}
            disabled={integrity.state.phase === "scanning" || integrity.state.phase === "repairing"}
            type="button"
            title="Scan cached tracks for corruption"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
            </svg>
            Health Check
          </button>
        </div>

        {/* Sort buttons */}
        <div className={styles.sortControls}>
          <SortButton
            label="Recent"
            field="last_played_at"
            currentField={lib.sortField}
            currentDir={lib.sortDir}
            onSort={lib.setSortField}
            onToggleDir={toggleSortDir}
          />
          <SortButton
            label="Title"
            field="title"
            currentField={lib.sortField}
            currentDir={lib.sortDir}
            onSort={lib.setSortField}
            onToggleDir={toggleSortDir}
          />
          <SortButton
            label="Duration"
            field="duration_seconds"
            currentField={lib.sortField}
            currentDir={lib.sortDir}
            onSort={lib.setSortField}
            onToggleDir={toggleSortDir}
          />
          <SortButton
            label="Added"
            field="added_at"
            currentField={lib.sortField}
            currentDir={lib.sortDir}
            onSort={lib.setSortField}
            onToggleDir={toggleSortDir}
          />
        </div>
      </div>

      {/* Integrity scan results panel */}
      {integrity.state.phase !== "idle" && (
        <IntegrityResultPanel
          state={integrity.state}
          handleRepairAll={integrity.handleRepairAll}
          handleRepairOne={integrity.handleRepairOne}
          dismiss={integrity.dismiss}
        />
      )}

      {/* Track count + Add All to Queue */}
      {lib.total > 0 && (
        <div className={styles.trackCountRow}>
          <span className={styles.trackCount}>{lib.total} track{lib.total !== 1 ? "s" : ""}</span>
          <button
            className={`${styles.addAllBtn} ${isEnqueueing ? styles.addAllBtnLoading : ""}`}
            onClick={() => void handleAddAllToQueue()}
            disabled={isEnqueueing}
            type="button"
            title="Add all tracks to queue"
          >
            {isEnqueueing
              ? <span className={styles.addAllSpinner} aria-hidden="true" />
              : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M19 11H7.83l4.88-4.88c.39-.39.39-1.03 0-1.42-.39-.39-1.02-.39-1.41 0l-6.59 6.59c-.39.39-.39 1.02 0 1.41l6.59 6.59c.39.39 1.02.39 1.41 0 .39-.39.39-1.02 0-1.41L7.83 13H19c.55 0 1-.45 1-1s-.45-1-1-1z" />
                </svg>
              )}
            <span>{isEnqueueing ? "Adding…" : `Add All (${lib.total})`}</span>
          </button>
        </div>
      )}

      {/* Empty search results */}
      {lib.tracks.length === 0 && !lib.isLoading && (lib.searchQuery || lib.filterOfflineOnly) && (
        <div className={styles.emptyState}>
          <p className={styles.emptyText}>No tracks match your search.</p>
        </div>
      )}

      {/* Track list */}
      {lib.tracks.length > 0 && (
        <div className={styles.trackList}>
          {lib.tracks.map((track) => <TrackRow key={track.id} track={track} onPlay={handlePlay} />)}

          {/* Infinite scroll sentinel */}
          <div ref={sentinelRef} className={styles.sentinel} aria-hidden="true" />

          {/* Loading indicator */}
          {lib.isLoading && (
            <div className={styles.loadingRow} aria-label="Loading more tracks">
              <span className={styles.spinner} aria-hidden="true" />
            </div>
          )}
        </div>
      )}

      {/* Initial loading state */}
      {lib.tracks.length === 0 && lib.isLoading && (
        <div className={styles.loadingState}>
          <span className={styles.spinner} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
