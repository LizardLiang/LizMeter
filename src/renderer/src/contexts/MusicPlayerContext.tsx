// src/renderer/src/contexts/MusicPlayerContext.tsx
// React Context providing all music player state and actions to the entire app.
// This is the single source of truth for music playback state in the renderer.
//
// Architecture note: all playback controls (play/pause/seek/volume/speed) operate
// directly on the HTMLAudioElement owned by useAudioPlayer — zero IPC round-trips.
// IPC is only used for: initiating a play (to obtain the streamUrl from the main
// process), stopping the stream server, and settings persistence.

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  BinaryStatus,
  ImportProgress,
  MusicPlaybackState,
  MusicQueueItem,
  MusicTrack,
  RepeatMode,
} from "../../../shared/types.ts";
import { useAudioPlayer } from "../hooks/useAudioPlayer.ts";

// ---- Context shape ----

export interface MusicPlayerContextValue {
  // Current track
  currentTrack: MusicTrack | null;
  playbackState: MusicPlaybackState;

  // Time
  currentTime: number;
  duration: number;
  buffered: number;

  // Queue
  queue: MusicQueueItem[];
  currentIndex: number;
  queueLength: number;

  // Settings
  volume: number;
  muted: boolean;
  playbackSpeed: number;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;

  // Binary / setup status
  binaryStatus: BinaryStatus | null;

  // Import progress (push events from main process)
  importProgress: ImportProgress | null;

  // Error tracking
  consecutiveFailures: number;
  lastError: string | null;

  // Visibility: true once the first track has started playing
  isBottomBarVisible: boolean;

  // Navigation availability (accounts for shuffle order and repeat mode)
  canGoNext: boolean;
  canGoPrev: boolean;

  // Playback actions
  play: (url: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  seek: (seconds: number) => void;
  next: () => void;
  prev: () => void;
  jumpTo: (queueIndex: number) => void;

  // Queue management
  enqueue: (track: MusicTrack, playlistId?: number) => void;
  enqueueBulk: (tracks: MusicTrack[], playlistId?: number) => void;
  dequeueAt: (queueIndex: number) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;

  // Settings
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setPlaybackSpeed: (r: number) => void;
  setShuffleEnabled: (s: boolean) => void;
  setRepeatMode: (m: RepeatMode) => void;

  // Binary
  refreshBinaryStatus: () => Promise<void>;
}

// ---- Context creation ----

const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null);

// ---- Helper: generate a client-side queue ID ----

function makeQueueId(): string {
  return crypto.randomUUID();
}

// ---- Helper: reorder an array (immutable) ----

function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const result = [...arr];
  const spliced = result.splice(from, 1);
  const item = spliced[0] as T;
  result.splice(to, 0, item);
  return result;
}

// ---- Provider ----

interface MusicPlayerProviderProps {
  children: ReactNode;
}

export function MusicPlayerProvider({ children }: MusicPlayerProviderProps) {
  // ---- Persistent settings state ----
  const [volume, setVolumeState] = useState(0.3);
  const [muted, setMutedState] = useState(false);
  const [playbackSpeed, setPlaybackSpeedState] = useState(1.0);
  const [shuffleEnabled, setShuffleEnabledState] = useState(false);
  const [repeatMode, setRepeatModeState] = useState<RepeatMode>("off");

  // ---- Playback / queue state ----
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null);
  const [queue, setQueue] = useState<MusicQueueItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isBottomBarVisible, setIsBottomBarVisible] = useState(false);

  // ---- Shuffle order ----
  // Null when shuffle is off. Array of queue indices in play order when on.
  const [shuffleOrder, setShuffleOrder] = useState<number[] | null>(null);

  // ---- Binary / import state ----
  const [binaryStatus, setBinaryStatus] = useState<BinaryStatus | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

  // ---- Error tracking ----
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);

  // Keep refs to queue + index so callbacks can read latest without stale closures
  const queueRef = useRef(queue);
  const currentIndexRef = useRef(currentIndex);
  const repeatModeRef = useRef(repeatMode);
  const shuffleOrderRef = useRef(shuffleOrder);
  const shuffleEnabledRef = useRef(shuffleEnabled);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    repeatModeRef.current = repeatMode;
  }, [repeatMode]);
  useEffect(() => {
    shuffleOrderRef.current = shuffleOrder;
  }, [shuffleOrder]);
  useEffect(() => {
    shuffleEnabledRef.current = shuffleEnabled;
  }, [shuffleEnabled]);

  // ---- Fisher-Yates shuffle utility ----
  const buildShuffleOrder = useCallback((length: number, pinFirst: number): number[] => {
    const order = Array.from({ length }, (_, i) => i);
    // Move pinFirst to position 0
    const pinIdx = order.indexOf(pinFirst);
    if (pinIdx > 0) {
      const tmp0 = order[0] as number;
      const tmpPin = order[pinIdx] as number;
      order[0] = tmpPin;
      order[pinIdx] = tmp0;
    }
    // Shuffle positions 1..length-1 (Fisher-Yates)
    for (let i = length - 1; i > 1; i--) {
      const j = Math.floor(Math.random() * i) + 1;
      const tmpi = order[i] as number;
      const tmpj = order[j] as number;
      order[i] = tmpj;
      order[j] = tmpi;
    }
    return order;
  }, []);

  // ---- Core play-by-index (internal) ----
  // Loads audio for the track at queueIndex via IPC, then hands stream URL to the
  // audio element. Called by next/prev/jumpTo/play.
  const playQueueItem = useCallback(async (queueIndex: number): Promise<void> => {
    const q = queueRef.current;
    if (queueIndex < 0 || queueIndex >= q.length) return;

    const item = q[queueIndex]!;
    try {
      const result = await window.electronAPI.music.play({ url: item.track.sourceUrl });
      setCurrentTrack(result.track);
      setCurrentIndex(queueIndex);
      setIsBottomBarVisible(true);
      setConsecutiveFailures(0);
      setLastError(null);
      // Delegate audio element management to useAudioPlayer
      audioPlayer.loadAndPlay(result.streamUrl);

      // Update isCached on this queue item if server says it was from cache
      if (result.fromCache) {
        setQueue((prev) =>
          prev.map((qi, i) => i === queueIndex ? { ...qi, track: { ...qi.track, isCached: true } } : qi)
        );
      }
    } catch (err: unknown) {
      const code = (err as { code?: string; }).code;
      const message = err instanceof Error ? err.message : "Playback failed";
      setLastError(message);
      setConsecutiveFailures((n) => n + 1);
      // Re-throw so callers can handle BINARY_MISSING etc.
      throw Object.assign(new Error(message), { code });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- useAudioPlayer callbacks ----

  const handleAudioEnded = useCallback(() => {
    const q = queueRef.current;
    const idx = currentIndexRef.current;
    const repeat = repeatModeRef.current;

    // repeat-one: replay current
    if (repeat === "one") {
      void playQueueItem(idx);
      return;
    }

    // Determine next index (respects shuffle)
    let nextIdx: number | null = null;
    const shuffleOrd = shuffleOrderRef.current;
    if (shuffleOrd !== null) {
      const shufflePos = shuffleOrd.indexOf(idx);
      const nextShufflePos = shufflePos + 1;
      if (nextShufflePos < shuffleOrd.length) {
        nextIdx = shuffleOrd[nextShufflePos] ?? null;
      } else if (repeat === "queue") {
        nextIdx = shuffleOrd[0] ?? null;
      }
    } else {
      if (idx + 1 < q.length) {
        nextIdx = idx + 1;
      } else if (repeat === "queue") {
        nextIdx = 0;
      }
    }

    if (nextIdx !== null) {
      void playQueueItem(nextIdx);
    } else {
      // Queue ended — stay at last track in paused state (spec: queue-end behavior)
      audioPlayer.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playQueueItem]);

  const handleAudioError = useCallback(() => {
    setLastError("Audio playback error");
    setConsecutiveFailures((n) => n + 1);
  }, []);

  const audioPlayer = useAudioPlayer({
    onEnded: handleAudioEnded,
    onError: handleAudioError,
  });

  // ---- Apply volume/muted/speed changes to audio element ----
  useEffect(() => {
    audioPlayer.setVolume(volume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume]);

  useEffect(() => {
    audioPlayer.setMuted(muted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  useEffect(() => {
    audioPlayer.setPlaybackRate(playbackSpeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackSpeed]);

  // ---- Load persisted settings on mount ----
  useEffect(() => {
    const load = async () => {
      try {
        const [volVal, mutedVal, speedVal, shuffleVal, repeatVal] = await Promise.all([
          window.electronAPI.settings.getValue("music.volume"),
          window.electronAPI.settings.getValue("music.muted"),
          window.electronAPI.settings.getValue("music.playbackSpeed"),
          window.electronAPI.settings.getValue("music.shuffleEnabled"),
          window.electronAPI.settings.getValue("music.repeatMode"),
        ]);

        if (volVal !== null) {
          const v = parseFloat(volVal);
          if (isFinite(v)) setVolumeState(Math.max(0, Math.min(1, v)));
        }
        if (mutedVal !== null) {
          setMutedState(mutedVal === "1");
        }
        if (speedVal !== null) {
          const s = parseFloat(speedVal);
          if (isFinite(s) && s > 0) setPlaybackSpeedState(s);
        }
        if (shuffleVal !== null) {
          setShuffleEnabledState(shuffleVal === "1");
        }
        if (repeatVal !== null && ["off", "queue", "one"].includes(repeatVal)) {
          setRepeatModeState(repeatVal as RepeatMode);
        }
      } catch {
        // Settings load failure is non-fatal — defaults are fine
      }
    };
    void load();
  }, []);

  // ---- Check binary status on mount ----
  useEffect(() => {
    void window.electronAPI.music.binaryStatus().then(setBinaryStatus).catch(() => {
      // Non-fatal — binaryStatus remains null
    });
  }, []);

  // ---- mediaSession integration (T3.8) ----
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (currentTrack === null) {
      navigator.mediaSession.metadata = null;
      return;
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.artist ?? undefined,
        artwork: currentTrack.thumbnailUrl
          ? [{ src: currentTrack.thumbnailUrl }]
          : undefined,
      });
    } catch {
      // mediaSession may be unavailable in some environments
    }
  }, [currentTrack]);

  // ---- Register mediaSession action handlers ----
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => {
        audioPlayer.play();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        audioPlayer.pause();
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        handleNext();
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        handlePrev();
      });
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.seekTime !== undefined) {
          audioPlayer.seek(details.seekTime);
        }
      });
    } catch {
      // Non-fatal
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Subscribe to push events from main process ----
  useEffect(() => {
    const unsubImport = window.electronAPI.music.onImportProgress((progress) => {
      setImportProgress((prev) => {
        // Once we've received a completion event (total !== null), ignore
        // subsequent intermediate events (total === null) that arrive from
        // buffered stdout after the 500-track cap fires resolve().
        if (prev !== null && prev.total !== null && progress.total === null) {
          return prev;
        }
        return progress;
      });
    });

    const unsubCached = window.electronAPI.music.onStreamCached(({ trackId }) => {
      // Mark the matching queue item as cached so seek becomes fully available
      setQueue((prev) =>
        prev.map((qi) => qi.track.id === trackId ? { ...qi, track: { ...qi.track, isCached: true } } : qi)
      );
      setCurrentTrack((prev) => (prev?.id === trackId ? { ...prev, isCached: true } : prev));
    });

    const unsubMediaKey = window.electronAPI.music.onMediaKey((action) => {
      switch (action) {
        case "MediaPlayPause":
          if (audioPlayer.paused) {
            audioPlayer.play();
          } else {
            audioPlayer.pause();
          }
          break;
        case "MediaNextTrack":
          handleNext();
          break;
        case "MediaPreviousTrack":
          handlePrev();
          break;
      }
    });

    // T2.7: playlist import — bulk-enqueue remaining tracks after the first one plays
    const unsubPlaylistImported = window.electronAPI.music.onPlaylistImported(({ tracks }) => {
      if (tracks.length === 0) return;
      const items: MusicQueueItem[] = tracks.map((track) => ({
        queueId: makeQueueId(),
        track,
        sourcePlaylistId: null,
      }));
      setQueue((prev) => [...prev, ...items]);
    });

    return () => {
      unsubImport();
      unsubCached();
      unsubMediaKey();
      unsubPlaylistImported();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Clear import progress when it reaches 100% ----
  useEffect(() => {
    if (importProgress === null) return;
    if (importProgress.total !== null && importProgress.current >= importProgress.total) {
      const timer = setTimeout(() => setImportProgress(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [importProgress]);

  // ---- Public actions ----

  const play = useCallback(async (url: string): Promise<void> => {
    // Obtain stream URL from main process (initiates yt-dlp extraction)
    let result: Awaited<ReturnType<typeof window.electronAPI.music.play>>;
    try {
      result = await window.electronAPI.music.play({ url });
    } catch (err: unknown) {
      const code = (err as { code?: string; }).code;
      const message = err instanceof Error ? err.message : "Playback failed";
      setLastError(message);
      setConsecutiveFailures((n) => n + 1);
      throw Object.assign(new Error(message), { code });
    }

    const newItem: MusicQueueItem = {
      queueId: makeQueueId(),
      track: result.track,
      sourcePlaylistId: null,
    };

    // Already-playing behavior: if something is playing, enqueue instead of interrupting
    if (audioPlayer.playbackState !== "stopped" && currentIndexRef.current >= 0) {
      setQueue((prev) => [...prev, newItem]);
      // TODO: show toast "Added to queue" — toast system is a later task
      return;
    }

    // Nothing playing — place the new track at index 0, preserving any tracks
    // already added by onPlaylistImported (which fires before this promise resolves).
    setQueue((prev) => [newItem, ...prev.filter((t) => t.track.sourceUrl !== newItem.track.sourceUrl)]);
    setCurrentIndex(0);
    queueRef.current = [newItem, ...queueRef.current.filter((t) => t.track.sourceUrl !== newItem.track.sourceUrl)];
    currentIndexRef.current = 0;
    setCurrentTrack(result.track);
    setIsBottomBarVisible(true);
    setConsecutiveFailures(0);
    setLastError(null);
    audioPlayer.loadAndPlay(result.streamUrl);

    if (result.fromCache) {
      setQueue((prev) => prev.map((qi, i) => i === 0 ? { ...qi, track: { ...qi.track, isCached: true } } : qi));
    }

    // Rebuild shuffle order if shuffle is on
    if (shuffleEnabledRef.current) {
      setShuffleOrder([0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => {
    audioPlayer.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resume = useCallback(() => {
    audioPlayer.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    audioPlayer.stop();
    setCurrentTrack(null);
    setCurrentIndex(-1);
    setQueue([]);
    setShuffleOrder(null);
    void window.electronAPI.music.stop().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seek = useCallback((seconds: number) => {
    audioPlayer.seek(seconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNext = useCallback(() => {
    const q = queueRef.current;
    const idx = currentIndexRef.current;
    const repeat = repeatModeRef.current;
    const shuffleOrd = shuffleOrderRef.current;

    let nextIdx: number | null = null;
    if (repeat === "one") {
      // Per most player UX, next always advances even in repeat-one mode
      nextIdx = shuffleOrd !== null
        ? (shuffleOrd.indexOf(idx) + 1 < shuffleOrd.length ? (shuffleOrd[shuffleOrd.indexOf(idx) + 1] ?? null) : null)
        : (idx + 1 < q.length ? idx + 1 : null);
    } else if (shuffleOrd !== null) {
      const pos = shuffleOrd.indexOf(idx);
      if (pos + 1 < shuffleOrd.length) {
        nextIdx = shuffleOrd[pos + 1] ?? null;
      } else if (repeat === "queue") {
        nextIdx = shuffleOrd[0] ?? null;
      }
    } else {
      if (idx + 1 < q.length) {
        nextIdx = idx + 1;
      } else if (repeat === "queue") {
        nextIdx = 0;
      }
    }

    if (nextIdx !== null) {
      void playQueueItem(nextIdx).catch(() => {
        setConsecutiveFailures((n) => n + 1);
      });
    }
  }, [playQueueItem]);

  const handlePrev = useCallback(() => {
    const idx = currentIndexRef.current;
    const shuffleOrd = shuffleOrderRef.current;

    // If more than 3 seconds in, restart current track
    if (audioPlayer.currentTime > 3) {
      audioPlayer.seek(0);
      return;
    }

    let prevIdx: number | null = null;
    if (shuffleOrd !== null) {
      const pos = shuffleOrd.indexOf(idx);
      if (pos > 0) {
        prevIdx = shuffleOrd[pos - 1] ?? null;
      }
    } else {
      if (idx > 0) {
        prevIdx = idx - 1;
      }
    }

    if (prevIdx !== null) {
      void playQueueItem(prevIdx).catch(() => {
        setConsecutiveFailures((n) => n + 1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playQueueItem]);

  const jumpTo = useCallback((queueIndex: number) => {
    void playQueueItem(queueIndex).catch(() => {
      setConsecutiveFailures((n) => n + 1);
    });
  }, [playQueueItem]);

  // ---- Queue management ----

  const enqueue = useCallback((track: MusicTrack, playlistId?: number) => {
    const item: MusicQueueItem = {
      queueId: makeQueueId(),
      track,
      sourcePlaylistId: playlistId ?? null,
    };
    setQueue((prev) => {
      const next = [...prev, item];
      // Extend shuffle order if enabled
      if (shuffleEnabledRef.current) {
        setShuffleOrder((ord) => {
          if (ord === null) return null;
          // Append the new index (insertion order) at a random position after current
          const newIdx = next.length - 1;
          const pos = currentIndexRef.current + 1;
          const insertAt = pos + Math.floor(Math.random() * (ord.length - pos + 1));
          const newOrd = [...ord];
          newOrd.splice(insertAt, 0, newIdx);
          return newOrd;
        });
      }
      return next;
    });
  }, []);

  const enqueueBulk = useCallback((tracks: MusicTrack[], playlistId?: number) => {
    const items: MusicQueueItem[] = tracks.map((track) => ({
      queueId: makeQueueId(),
      track,
      sourcePlaylistId: playlistId ?? null,
    }));
    setQueue((prev) => {
      const next = [...prev, ...items];
      if (shuffleEnabledRef.current && next.length > 0) {
        setShuffleOrder(buildShuffleOrder(next.length, currentIndexRef.current));
      }
      return next;
    });
  }, [buildShuffleOrder]);

  const dequeueAt = useCallback((queueIndex: number) => {
    setQueue((prev) => {
      if (queueIndex < 0 || queueIndex >= prev.length) return prev;
      const next = prev.filter((_, i) => i !== queueIndex);

      // Adjust currentIndex
      setCurrentIndex((idx) => {
        if (queueIndex < idx) return idx - 1;
        if (queueIndex === idx) {
          // Removed currently playing track — stop
          audioPlayer.stop();
          setCurrentTrack(null);
          return -1;
        }
        return idx;
      });

      // Rebuild shuffle order
      if (shuffleEnabledRef.current && next.length > 0) {
        setShuffleOrder(
          buildShuffleOrder(
            next.length,
            Math.max(0, currentIndexRef.current - (queueIndex < currentIndexRef.current ? 1 : 0)),
          ),
        );
      } else if (next.length === 0) {
        setShuffleOrder(null);
      }

      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildShuffleOrder]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue((prev) => {
      const next = reorderArray(prev, fromIndex, toIndex);

      // Adjust currentIndex
      setCurrentIndex((idx) => {
        if (idx === fromIndex) return toIndex;
        if (fromIndex < toIndex) {
          if (idx > fromIndex && idx <= toIndex) return idx - 1;
        } else {
          if (idx >= toIndex && idx < fromIndex) return idx + 1;
        }
        return idx;
      });

      // Rebuild shuffle order after reorder (MINOR-04 fix)
      if (shuffleEnabledRef.current && next.length > 0) {
        const newCurrent = currentIndexRef.current === fromIndex
          ? toIndex
          : currentIndexRef.current;
        setShuffleOrder(buildShuffleOrder(next.length, newCurrent));
      }

      return next;
    });
  }, [buildShuffleOrder]);

  const clearQueue = useCallback(() => {
    audioPlayer.stop();
    setQueue([]);
    setCurrentIndex(-1);
    setCurrentTrack(null);
    setShuffleOrder(null);
    void window.electronAPI.music.stop().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Settings setters (persist to KV store) ----

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    void window.electronAPI.settings.setValue("music.volume", String(clamped)).catch(() => {});
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    void window.electronAPI.settings.setValue("music.muted", m ? "1" : "0").catch(() => {});
  }, []);

  const setPlaybackSpeed = useCallback((r: number) => {
    setPlaybackSpeedState(r);
    void window.electronAPI.settings.setValue("music.playbackSpeed", String(r)).catch(() => {});
  }, []);

  const setShuffleEnabled = useCallback((s: boolean) => {
    setShuffleEnabledState(s);
    void window.electronAPI.settings.setValue("music.shuffleEnabled", s ? "1" : "0").catch(() => {});

    // Build or clear shuffle order
    if (s) {
      const q = queueRef.current;
      const idx = currentIndexRef.current;
      if (q.length > 0) {
        setShuffleOrder(buildShuffleOrder(q.length, Math.max(0, idx)));
      }
    } else {
      setShuffleOrder(null);
    }
  }, [buildShuffleOrder]);

  const setRepeatMode = useCallback((m: RepeatMode) => {
    setRepeatModeState(m);
    void window.electronAPI.settings.setValue("music.repeatMode", m).catch(() => {});
  }, []);

  const refreshBinaryStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await window.electronAPI.music.binaryStatus();
      setBinaryStatus(status);
    } catch {
      // Non-fatal
    }
  }, []);

  // ---- Assemble context value ----

  const value = useMemo<MusicPlayerContextValue>(() => {
    // Compute navigation availability accounting for shuffle order and repeat mode.
    // When shuffle is active the "next" / "prev" slots are determined by shuffleOrder
    // position, not raw queue index. When repeatMode is "queue" or "one", next is
    // always available as long as there is at least one track.
    let canGoNext = false;
    let canGoPrev = false;
    if (queue.length > 0 && currentIndex >= 0) {
      if (repeatMode === "queue" || repeatMode === "one") {
        canGoNext = true;
        canGoPrev = true;
      } else if (shuffleOrder !== null) {
        const pos = shuffleOrder.indexOf(currentIndex);
        canGoNext = pos >= 0 && pos + 1 < shuffleOrder.length;
        canGoPrev = pos > 0;
      } else {
        canGoNext = currentIndex + 1 < queue.length;
        canGoPrev = currentIndex > 0;
      }
    }

    return {
      currentTrack,
      playbackState: audioPlayer.playbackState,
      currentTime: audioPlayer.currentTime,
      duration: audioPlayer.duration,
      buffered: audioPlayer.buffered,
      queue,
      currentIndex,
      queueLength: queue.length,
      volume,
      muted,
      playbackSpeed,
      shuffleEnabled,
      repeatMode,
      binaryStatus,
      importProgress,
      consecutiveFailures,
      lastError,
      isBottomBarVisible,
      canGoNext,
      canGoPrev,
      play,
      pause,
      resume,
      stop,
      seek,
      next: handleNext,
      prev: handlePrev,
      jumpTo,
      enqueue,
      enqueueBulk,
      dequeueAt,
      reorderQueue,
      clearQueue,
      setVolume,
      setMuted,
      setPlaybackSpeed,
      setShuffleEnabled,
      setRepeatMode,
      refreshBinaryStatus,
    };
  }, [
    currentTrack,
    audioPlayer.playbackState,
    audioPlayer.currentTime,
    audioPlayer.duration,
    audioPlayer.buffered,
    queue,
    currentIndex,
    shuffleOrder,
    volume,
    muted,
    playbackSpeed,
    shuffleEnabled,
    repeatMode,
    binaryStatus,
    importProgress,
    consecutiveFailures,
    lastError,
    isBottomBarVisible,
    play,
    pause,
    resume,
    stop,
    seek,
    handleNext,
    handlePrev,
    jumpTo,
    enqueue,
    enqueueBulk,
    dequeueAt,
    reorderQueue,
    clearQueue,
    setVolume,
    setMuted,
    setPlaybackSpeed,
    setShuffleEnabled,
    setRepeatMode,
    refreshBinaryStatus,
  ]);

  return <MusicPlayerContext.Provider value={value}>{children}</MusicPlayerContext.Provider>;
}

// ---- Consumer hook ----

export function useMusicPlayer(): MusicPlayerContextValue {
  const ctx = useContext(MusicPlayerContext);
  if (ctx === null) {
    throw new Error("useMusicPlayer must be used within a MusicPlayerProvider");
  }
  return ctx;
}
