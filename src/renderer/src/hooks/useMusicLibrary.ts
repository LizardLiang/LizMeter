// src/renderer/src/hooks/useMusicLibrary.ts
// Paginated library data hook for the Library tab.
// Manages: tracks, hasMore, isLoading, searchQuery, sortField, sortDir, filterOfflineOnly.
// Refresh via token counter pattern (same as useSessionHistory).

import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicSortDir, MusicSortField, MusicTrack } from "../../../shared/types.ts";

const PAGE_SIZE = 50;

export interface UseMusicLibraryReturn {
  tracks: MusicTrack[];
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  searchQuery: string;
  sortField: MusicSortField;
  sortDir: MusicSortDir;
  filterOfflineOnly: boolean;
  setSearchQuery: (q: string) => void;
  setSortField: (f: MusicSortField) => void;
  setSortDir: (d: MusicSortDir) => void;
  setFilterOfflineOnly: (v: boolean) => void;
  loadMore: () => void;
  refresh: () => void;
}

export function useMusicLibrary(): UseMusicLibraryReturn {
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQueryState] = useState("");
  const [sortField, setSortFieldState] = useState<MusicSortField>("last_played_at");
  const [sortDir, setSortDirState] = useState<MusicSortDir>("desc");
  const [filterOfflineOnly, setFilterOfflineOnlyState] = useState(false);

  // Token counter: incrementing forces a full reload (resets offset to 0)
  const [refreshToken, setRefreshToken] = useState(0);

  // Current offset for infinite scroll
  const [offset, setOffset] = useState(0);

  // Track if this is a fresh load (reset tracks) vs. load-more (append)
  const isLoadMoreRef = useRef(false);

  // Debounced search: only fire after 250ms of no typing
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const setSearchQuery = useCallback((q: string) => {
    setSearchQueryState(q);
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(q);
      // A search change resets pagination
      isLoadMoreRef.current = false;
      setOffset(0);
      setRefreshToken((t) => t + 1);
    }, 250);
  }, []);

  const setSortField = useCallback((f: MusicSortField) => {
    setSortFieldState(f);
    isLoadMoreRef.current = false;
    setOffset(0);
    setRefreshToken((t) => t + 1);
  }, []);

  const setSortDir = useCallback((d: MusicSortDir) => {
    setSortDirState(d);
    isLoadMoreRef.current = false;
    setOffset(0);
    setRefreshToken((t) => t + 1);
  }, []);

  const setFilterOfflineOnly = useCallback((v: boolean) => {
    setFilterOfflineOnlyState(v);
    isLoadMoreRef.current = false;
    setOffset(0);
    setRefreshToken((t) => t + 1);
  }, []);

  const refresh = useCallback(() => {
    isLoadMoreRef.current = false;
    setOffset(0);
    setRefreshToken((t) => t + 1);
  }, []);

  const loadMore = useCallback(() => {
    isLoadMoreRef.current = true;
    setOffset((prev) => prev + PAGE_SIZE);
    setRefreshToken((t) => t + 1);
  }, []);

  // Keep refs stable for the effect
  const sortFieldRef = useRef(sortField);
  const sortDirRef = useRef(sortDir);
  const filterOfflineOnlyRef = useRef(filterOfflineOnly);
  const offsetRef = useRef(offset);
  useEffect(() => {
    sortFieldRef.current = sortField;
  }, [sortField]);
  useEffect(() => {
    sortDirRef.current = sortDir;
  }, [sortDir]);
  useEffect(() => {
    filterOfflineOnlyRef.current = filterOfflineOnly;
  }, [filterOfflineOnly]);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // Load data when refreshToken changes
  useEffect(() => {
    let cancelled = false;
    const currentOffset = offsetRef.current;
    const appendMode = isLoadMoreRef.current;

    const load = async () => {
      setIsLoading(true);
      try {
        const result = await window.electronAPI.music.libraryList({
          limit: PAGE_SIZE,
          offset: currentOffset,
          search: debouncedSearch || undefined,
          sortField: sortFieldRef.current,
          sortDir: sortDirRef.current,
          cachedOnly: filterOfflineOnlyRef.current || undefined,
        });
        if (!cancelled) {
          if (appendMode) {
            setTracks((prev) => [...prev, ...result.tracks]);
          } else {
            setTracks(result.tracks);
          }
          setTotal(result.total);
        }
      } catch {
        // Non-fatal — leave existing tracks as-is
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const hasMore = tracks.length < total;

  return {
    tracks,
    total,
    hasMore,
    isLoading,
    searchQuery,
    sortField,
    sortDir,
    filterOfflineOnly,
    setSearchQuery,
    setSortField,
    setSortDir,
    setFilterOfflineOnly,
    loadMore,
    refresh,
  };
}
