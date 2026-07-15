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
  MusicPlayResult,
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
  autoRepairNotice: { id: string; message: string; } | null;

  // Visibility: true once the first track has started playing
  isBottomBarVisible: boolean;

  // Navigation availability (accounts for shuffle order and repeat mode)
  canGoNext: boolean;
  canGoPrev: boolean;

  // Playback actions
  play: (url: string, optimisticTrack?: MusicTrack) => Promise<void>;
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
  // Purges every queue item for a deleted library track (matched by track id, plus
  // any duplicate entries sharing its sourceUrl). Stops + advances if the removed
  // track was currently playing.
  removeTrackFromQueue: (trackId: string) => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  clearQueue: () => void;

  // Player reset (stops playback + clears current track; queue is preserved)
  clearPlayer: () => void;

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

interface PlaybackUiSnapshot {
  currentTrack: MusicTrack | null;
  currentIndex: number;
  isBottomBarVisible: boolean;
  playbackState: MusicPlaybackState;
}

const CACHE_STALL_REPAIR_THRESHOLD_MS = 5000;
const CACHE_STALL_POLL_INTERVAL_MS = 1000;

// ---- Helper: reorder an array (immutable) ----

function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr;
  const result = [...arr];
  const spliced = result.splice(from, 1);
  const item = spliced[0] as T;
  result.splice(to, 0, item);
  return result;
}

// Max number of consecutive playback failures the auto-skip chain will absorb
// before giving up and surfacing the error instead of trying another track.
const MAX_CONSECUTIVE_FAILURES = 3;

// ---- Helper: compute the next queue index to try (respects shuffle + repeat) ----
// treatRepeatOneAsOff: the "next" button always advances even in repeat-one mode,
// while the "track ended" event replays the current track instead (handled by the
// caller before this is invoked).
function computeNextIndex(
  fromIdx: number,
  queueLength: number,
  shuffleOrder: number[] | null,
  repeat: RepeatMode,
  treatRepeatOneAsOff: boolean,
): number | null {
  const effectiveRepeat = repeat === "one" && treatRepeatOneAsOff ? "off" : repeat;

  if (shuffleOrder !== null) {
    const pos = shuffleOrder.indexOf(fromIdx);
    const nextPos = pos + 1;
    if (nextPos < shuffleOrder.length) return shuffleOrder[nextPos] ?? null;
    if (effectiveRepeat === "queue") return shuffleOrder[0] ?? null;
    return null;
  }

  if (fromIdx + 1 < queueLength) return fromIdx + 1;
  if (effectiveRepeat === "queue") return 0;
  return null;
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
  const [pendingPlaybackState, setPendingPlaybackState] = useState<MusicPlaybackState | null>(null);

  // ---- Shuffle order ----
  // Null when shuffle is off. Array of queue indices in play order when on.
  const [shuffleOrder, setShuffleOrder] = useState<number[] | null>(null);

  // ---- Binary / import state ----
  const [binaryStatus, setBinaryStatus] = useState<BinaryStatus | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

  // ---- Error tracking ----
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [autoRepairNotice, setAutoRepairNotice] = useState<{ id: string; message: string; } | null>(null);

  // Keep refs to queue + index so callbacks can read latest without stale closures
  const queueRef = useRef(queue);
  const currentIndexRef = useRef(currentIndex);
  const repeatModeRef = useRef(repeatMode);
  const shuffleOrderRef = useRef(shuffleOrder);
  const shuffleEnabledRef = useRef(shuffleEnabled);
  const lastPlaybackProgressAtRef = useRef<number>(Date.now());
  const lastPlaybackTimeRef = useRef(0);
  const autoRepairTrackIdRef = useRef<string | null>(null);
  const autoRepairInFlightRef = useRef(false);
  const playRequestIdRef = useRef(0);
  const playQueueItemRef = useRef<(queueIndex: number) => Promise<void>>(() => Promise.resolve());
  const handleNextRef = useRef<() => void>(() => {});
  const advanceFromRef = useRef<
    (fromIdx: number, opts: { treatRepeatOneAsOff: boolean; }, failureCount: number) => void
  >(() => {});
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

  // ---- useAudioPlayer callbacks ----

  const handleAudioEnded = useCallback(() => {
    const idx = currentIndexRef.current;
    const repeat = repeatModeRef.current;

    // repeat-one: replay current
    if (repeat === "one") {
      void playQueueItemRef.current(idx);
      return;
    }

    // Advance to the next track, auto-skipping through failures (capped) instead
    // of leaving the queue stuck on a track that failed to load.
    advanceFromRef.current(idx, { treatRepeatOneAsOff: false }, 0);
  }, []);

  const handleAudioError = useCallback(() => {
    setLastError("Audio playback error");
    setConsecutiveFailures((n) => n + 1);
    // Route directly through advanceFrom with failureCount=1 (this track already
    // counted as one failure) instead of handleNext(), which always reseeds the
    // chain at failureCount=0 — that reseed let the auto-skip chain attempt 3
    // MORE tracks on top of this one (4 total) instead of respecting the
    // MAX_CONSECUTIVE_FAILURES cap of 3 total attempts.
    advanceFromRef.current(currentIndexRef.current, { treatRepeatOneAsOff: true }, 1);
  }, []);

  const audioPlayer = useAudioPlayer({
    onEnded: handleAudioEnded,
    onError: handleAudioError,
  });

  const snapshotPlaybackUi = useCallback((): PlaybackUiSnapshot => ({
    currentTrack,
    currentIndex,
    isBottomBarVisible,
    playbackState: pendingPlaybackState ?? audioPlayer.playbackState,
  }), [audioPlayer.playbackState, currentIndex, currentTrack, isBottomBarVisible, pendingPlaybackState]);

  const restorePlaybackUi = useCallback((snapshot: PlaybackUiSnapshot) => {
    setCurrentTrack(snapshot.currentTrack);
    setCurrentIndex(snapshot.currentIndex);
    currentIndexRef.current = snapshot.currentIndex;
    setIsBottomBarVisible(snapshot.isBottomBarVisible);
    setPendingPlaybackState(null);

    if (snapshot.playbackState === "playing") {
      audioPlayer.play();
      return;
    }

    if (snapshot.playbackState === "stopped") {
      audioPlayer.stop();
      return;
    }

    audioPlayer.pause();
  }, [audioPlayer]);

  const beginOptimisticSwitch = useCallback((track: MusicTrack | null, queueIndex: number) => {
    const snapshot = snapshotPlaybackUi();
    const requestId = playRequestIdRef.current + 1;
    playRequestIdRef.current = requestId;

    audioPlayer.beginPendingLoad();
    setPendingPlaybackState("buffering");
    setCurrentTrack(track);
    setCurrentIndex(queueIndex);
    currentIndexRef.current = queueIndex;
    setIsBottomBarVisible(track !== null || snapshot.isBottomBarVisible);
    setConsecutiveFailures(0);
    setLastError(null);

    return { requestId, snapshot };
  }, [audioPlayer, snapshotPlaybackUi]);

  const commitPlaybackResult = useCallback(
    (requestId: number, queueId: string, fallbackIndex: number, result: MusicPlayResult): boolean => {
      if (requestId !== playRequestIdRef.current) {
        return false;
      }

      // Recompute the index against the LIVE queue by queueId rather than
      // trusting the index captured when this request began. A dequeueAt of an
      // item before this one (queueIndex < currentIndex) leaves this in-flight
      // request valid (its requestId isn't bumped — only removing the item
      // itself does that) but shifts every later index down by one; blindly
      // writing back the stale captured index would overwrite the already-
      // decremented currentIndex, producing an off-by-one highlight and wrong
      // next/prev. If the item is genuinely gone, requestId would already have
      // been invalidated by the caller before we get here, so falling back to
      // fallbackIndex here is just a defensive no-op guard.
      const liveIndex = queueRef.current.findIndex((qi) => qi.queueId === queueId);
      const resolvedIndex = liveIndex >= 0 ? liveIndex : fallbackIndex;

      setPendingPlaybackState(null);
      setCurrentTrack(result.track);
      setCurrentIndex(resolvedIndex);
      currentIndexRef.current = resolvedIndex;
      setIsBottomBarVisible(true);
      setConsecutiveFailures(0);
      setLastError(null);
      audioPlayer.loadAndPlay(result.streamUrl);

      return true;
    },
    [audioPlayer],
  );

  const failPlaybackRequest = useCallback((requestId: number, snapshot: PlaybackUiSnapshot, message: string) => {
    if (requestId !== playRequestIdRef.current) {
      return;
    }

    restorePlaybackUi(snapshot);
    setLastError(message);
    setConsecutiveFailures((n) => n + 1);
  }, [restorePlaybackUi]);

  // Failure handler used by the auto-skip chain (advanceFrom): unlike
  // failPlaybackRequest, this does NOT restore the UI to whatever was showing
  // before the attempt — doing so would "snap back" to a stale track once the
  // chain gives up. It just clears the stuck buffering state and records the
  // error; the caller decides whether to try the next track or stop here.
  const failPlaybackRequestKeepCurrent = useCallback((requestId: number, message: string) => {
    if (requestId !== playRequestIdRef.current) {
      return;
    }

    setPendingPlaybackState(null);
    setLastError(message);
    setConsecutiveFailures((n) => n + 1);
  }, []);

  // ---- Core play-by-index (internal) ----
  // Loads audio for the track at queueIndex via IPC, then hands stream URL to the
  // audio element. Called by next/prev/jumpTo/play.
  // opts.restoreOnFailure (default true): whether a failure should roll the UI back
  // to the pre-attempt snapshot. The auto-skip chain (advanceFrom) passes false so
  // repeated skip attempts don't flicker back to a stale track.
  const playQueueItem = useCallback(async (
    queueIndex: number,
    opts?: { restoreOnFailure?: boolean; },
  ): Promise<void> => {
    const restoreOnFailure = opts?.restoreOnFailure ?? true;
    const q = queueRef.current;
    if (queueIndex < 0 || queueIndex >= q.length) return;

    const item = q[queueIndex]!;
    const { requestId, snapshot } = beginOptimisticSwitch(item.track, queueIndex);

    try {
      const result = await window.electronAPI.music.play({ url: item.track.sourceUrl });
      const didCommit = commitPlaybackResult(requestId, item.queueId, queueIndex, result);

      if (didCommit && result.fromCache) {
        setQueue((prev) =>
          prev.map((qi, i) => i === queueIndex ? { ...qi, track: { ...qi.track, isCached: true } } : qi)
        );
      }
    } catch (err: unknown) {
      const code = (err as { code?: string; }).code;
      const message = err instanceof Error ? err.message : "Playback failed";
      if (restoreOnFailure) {
        failPlaybackRequest(requestId, snapshot, message);
      } else {
        failPlaybackRequestKeepCurrent(requestId, message);
      }
      throw Object.assign(new Error(message), { code });
    }
  }, [beginOptimisticSwitch, commitPlaybackResult, failPlaybackRequest, failPlaybackRequestKeepCurrent]);

  useEffect(() => {
    playQueueItemRef.current = playQueueItem;
  }, [playQueueItem]);

  // ---- Auto-skip chain ----
  // Tries the next track after a failure, up to MAX_CONSECUTIVE_FAILURES attempts,
  // instead of leaving the player stuck (or snapped back) on a dead track. Used by
  // handleAudioEnded, handleNext (and transitively handleAudioError + the cached-
  // stall repair path, which both delegate to handleNext).
  const advanceFrom = useCallback((
    fromIdx: number,
    opts: { treatRepeatOneAsOff: boolean; },
    failureCount: number,
  ): void => {
    const q = queueRef.current;
    const repeat = repeatModeRef.current;
    const shuffleOrd = shuffleOrderRef.current;

    const nextIdx = computeNextIndex(fromIdx, q.length, shuffleOrd, repeat, opts.treatRepeatOneAsOff);

    if (nextIdx === null) {
      // Nothing left to try — end of queue, not a failure in itself.
      audioPlayer.stop();
      return;
    }

    playQueueItem(nextIdx, { restoreOnFailure: false }).catch(() => {
      const attempted = failureCount + 1;
      // Each attempt's own beginOptimisticSwitch resets the React-visible
      // consecutiveFailures counter to 0 before failing again — overwrite it
      // here so the exposed count reflects the whole chain, not just the last
      // attempt.
      setConsecutiveFailures(attempted);
      if (attempted >= MAX_CONSECUTIVE_FAILURES) {
        // Give up — halt playback but leave the last attempted track visible
        // with the error, rather than snapping back to whatever played before.
        audioPlayer.stop();
        return;
      }
      advanceFromRef.current(nextIdx, opts, attempted);
    });
  }, [audioPlayer, playQueueItem]);

  useEffect(() => {
    advanceFromRef.current = advanceFrom;
  }, [advanceFrom]);

  useEffect(() => {
    if (currentTrack?.id !== autoRepairTrackIdRef.current) {
      autoRepairTrackIdRef.current = null;
      autoRepairInFlightRef.current = false;
    }
    lastPlaybackProgressAtRef.current = Date.now();
    lastPlaybackTimeRef.current = 0;
  }, [currentTrack?.id]);

  useEffect(() => {
    if (audioPlayer.currentTime > lastPlaybackTimeRef.current + 0.25) {
      lastPlaybackTimeRef.current = audioPlayer.currentTime;
      lastPlaybackProgressAtRef.current = Date.now();
      if (currentTrack?.id === autoRepairTrackIdRef.current) {
        autoRepairTrackIdRef.current = null;
        autoRepairInFlightRef.current = false;
      }
      return;
    }

    if (audioPlayer.currentTime < lastPlaybackTimeRef.current) {
      lastPlaybackTimeRef.current = audioPlayer.currentTime;
      lastPlaybackProgressAtRef.current = Date.now();
    }
  }, [audioPlayer.currentTime, currentTrack?.id]);

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

  useEffect(() => {
    if (currentTrack === null || currentIndex < 0) return;

    const interval = window.setInterval(() => {
      if (autoRepairInFlightRef.current) return;
      if (audioPlayer.playbackState !== "buffering") return;
      if (audioPlayer.currentTime <= 0) return;
      const knownDuration = audioPlayer.duration > 0 ? audioPlayer.duration : (currentTrack.durationSeconds ?? 0);
      if (knownDuration > 0 && audioPlayer.currentTime >= knownDuration - 2) return;
      if (knownDuration <= 0) return;

      const stalledForMs = Date.now() - lastPlaybackProgressAtRef.current;
      if (stalledForMs < CACHE_STALL_REPAIR_THRESHOLD_MS) return;

      // A repair was already attempted for this exact track and it stalled again —
      // don't loop forever waiting for a repair that isn't sticking. Skip to the
      // next track instead (same auto-skip policy as any other playback failure).
      // Below: every branch that gives up on the current track routes directly
      // through advanceFrom with failureCount=1 (this track already counted as
      // one failure) instead of handleNext(), which always reseeds the chain at
      // failureCount=0 — that reseed let the auto-skip chain attempt 3 MORE
      // tracks on top of this one (4 total) instead of respecting the
      // MAX_CONSECUTIVE_FAILURES cap of 3 total attempts.
      if (currentTrack.id === autoRepairTrackIdRef.current) {
        setLastError("Cached track stalled again after repair");
        setConsecutiveFailures((n) => n + 1);
        advanceFromRef.current(currentIndexRef.current, { treatRepeatOneAsOff: true }, 1);
        lastPlaybackProgressAtRef.current = Date.now();
        return;
      }

      autoRepairInFlightRef.current = true;
      autoRepairTrackIdRef.current = currentTrack.id;

      if (!currentTrack.isCached) {
        setLastError("Streaming track stalled during playback");
        setConsecutiveFailures((n) => n + 1);
        advanceFromRef.current(currentIndexRef.current, { treatRepeatOneAsOff: true }, 1);
        autoRepairTrackIdRef.current = null;
        autoRepairInFlightRef.current = false;
        lastPlaybackProgressAtRef.current = Date.now();
        return;
      }

      setAutoRepairNotice({
        id: crypto.randomUUID(),
        message: `Detected a corrupt cached file for "${currentTrack.title}". Redownloading and retrying playback.`,
      });

      void window.electronAPI.music.integrityRepair([currentTrack.id]).then(() => {
        return playQueueItem(currentIndexRef.current);
      }).catch(() => {
        setLastError("Cached track stalled during playback");
        setConsecutiveFailures((n) => n + 1);
        advanceFromRef.current(currentIndexRef.current, { treatRepeatOneAsOff: true }, 1);
      }).finally(() => {
        autoRepairInFlightRef.current = false;
        lastPlaybackProgressAtRef.current = Date.now();
      });
    }, CACHE_STALL_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    audioPlayer.currentTime,
    audioPlayer.duration,
    audioPlayer.playbackState,
    currentIndex,
    currentTrack,
    playQueueItem,
  ]);

  // ---- Public actions ----

  const play = useCallback(async (url: string, optimisticTrack?: MusicTrack): Promise<void> => {
    // Something already playing → the new track is inserted right after it and
    // played immediately (interrupts, does not silently enqueue). Nothing
    // playing → the new track becomes index 0.
    const hasActiveTrack = audioPlayer.playbackState !== "stopped" && currentIndexRef.current >= 0;
    const insertIndex = hasActiveTrack ? currentIndexRef.current + 1 : 0;

    // Obtain stream URL from main process (initiates yt-dlp extraction)
    const pendingSwitch = beginOptimisticSwitch(optimisticTrack ?? currentTrack, insertIndex);

    let result: Awaited<ReturnType<typeof window.electronAPI.music.play>>;
    try {
      result = await window.electronAPI.music.play({ url });
    } catch (err: unknown) {
      const code = (err as { code?: string; }).code;
      const message = err instanceof Error ? err.message : "Playback failed";
      failPlaybackRequest(pendingSwitch.requestId, pendingSwitch.snapshot, message);
      throw Object.assign(new Error(message), { code });
    }

    if (pendingSwitch.requestId !== playRequestIdRef.current) {
      return;
    }

    const newItem: MusicQueueItem = {
      queueId: makeQueueId(),
      track: result.track,
      sourcePlaylistId: null,
    };

    if (hasActiveTrack) {
      // Insert immediately after the current track and switch to it.
      setQueue((prev) => {
        const next = [...prev];
        next.splice(insertIndex, 0, newItem);
        return next;
      });
      const nextQueueRef = [...queueRef.current];
      nextQueueRef.splice(insertIndex, 0, newItem);
      queueRef.current = nextQueueRef;

      commitPlaybackResult(pendingSwitch.requestId, newItem.queueId, insertIndex, result);

      if (result.fromCache) {
        setQueue((prev) =>
          prev.map((qi, i) => i === insertIndex ? { ...qi, track: { ...qi.track, isCached: true } } : qi)
        );
      }

      if (shuffleEnabledRef.current) {
        setShuffleOrder(buildShuffleOrder(queueRef.current.length, insertIndex));
      }
      return;
    }

    // Nothing playing — place the new track at index 0, preserving any tracks
    // already added by onPlaylistImported (which fires before this promise resolves).
    setQueue((prev) => [newItem, ...prev.filter((t) => t.track.sourceUrl !== newItem.track.sourceUrl)]);
    queueRef.current = [newItem, ...queueRef.current.filter((t) => t.track.sourceUrl !== newItem.track.sourceUrl)];
    commitPlaybackResult(pendingSwitch.requestId, newItem.queueId, 0, result);

    if (result.fromCache) {
      setQueue((prev) => prev.map((qi, i) => i === 0 ? { ...qi, track: { ...qi.track, isCached: true } } : qi));
    }

    // Rebuild shuffle order if shuffle is on
    if (shuffleEnabledRef.current) {
      setShuffleOrder([0]);
    }
  }, [
    audioPlayer.playbackState,
    beginOptimisticSwitch,
    buildShuffleOrder,
    commitPlaybackResult,
    currentTrack,
    failPlaybackRequest,
  ]);

  const pause = useCallback(() => {
    audioPlayer.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resume = useCallback(() => {
    audioPlayer.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    playRequestIdRef.current += 1;
    setPendingPlaybackState(null);
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
    // Per most player UX, next always advances even in repeat-one mode (unlike the
    // "track ended" event, which replays). Auto-skips through failures (capped)
    // instead of stopping on the first dead track.
    advanceFromRef.current(currentIndexRef.current, { treatRepeatOneAsOff: true }, 0);
  }, []);

  useEffect(() => {
    handleNextRef.current = handleNext;
  }, [handleNext]);

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
    const prevQueue = queueRef.current;
    if (queueIndex < 0 || queueIndex >= prevQueue.length) return;

    const next = prevQueue.filter((_, i) => i !== queueIndex);
    const wasCurrent = queueIndex === currentIndexRef.current;

    let newCurrentIndex = currentIndexRef.current;
    if (queueIndex < currentIndexRef.current) {
      newCurrentIndex = currentIndexRef.current - 1;
    } else if (wasCurrent) {
      newCurrentIndex = -1;
    }

    // Sync refs immediately (not just via the useEffect one render later) so any
    // callback that fires before the next render — e.g. handleAudioEnded racing
    // a removal — reads the up-to-date queue/index rather than stale values.
    queueRef.current = next;
    currentIndexRef.current = newCurrentIndex;

    if (wasCurrent) {
      // Invalidate any in-flight play/repair request for the removed track so a
      // late-resolving commit can't resurrect it.
      playRequestIdRef.current += 1;
      setPendingPlaybackState(null);
      audioPlayer.stop();
      setCurrentTrack(null);
    }

    setQueue(next);
    setCurrentIndex(newCurrentIndex);

    // Rebuild shuffle order
    if (shuffleEnabledRef.current && next.length > 0) {
      setShuffleOrder(buildShuffleOrder(next.length, Math.max(0, newCurrentIndex)));
    } else if (next.length === 0) {
      setShuffleOrder(null);
    }
  }, [audioPlayer, buildShuffleOrder]);

  // Removes every queue entry for a track deleted from the library — including
  // duplicate entries that share its sourceUrl (e.g. added before the sourceUrl
  // dedupe in play() had a chance to run). If the removed track was playing,
  // invalidates any in-flight request (same as dequeueAt) and advances to the
  // next remaining track, or goes idle if the queue is now empty.
  const removeTrackFromQueue = useCallback((trackId: string) => {
    const prevQueue = queueRef.current;
    const matchedSourceUrls = new Set(
      prevQueue.filter((item) => item.track.id === trackId).map((item) => item.track.sourceUrl),
    );
    if (matchedSourceUrls.size === 0) return;

    const isRemoved = (item: MusicQueueItem) =>
      item.track.id === trackId || matchedSourceUrls.has(item.track.sourceUrl);

    const removedCurrent = currentIndexRef.current >= 0
      && currentIndexRef.current < prevQueue.length
      && isRemoved(prevQueue[currentIndexRef.current]!);

    const next = prevQueue.filter((item) => !isRemoved(item));

    let newCurrentIndex: number;
    if (removedCurrent) {
      newCurrentIndex = -1;
    } else {
      const removedBeforeCurrent = prevQueue.slice(0, currentIndexRef.current).filter(isRemoved).length;
      newCurrentIndex = currentIndexRef.current - removedBeforeCurrent;
    }

    queueRef.current = next;
    currentIndexRef.current = newCurrentIndex;

    if (removedCurrent) {
      playRequestIdRef.current += 1;
      setPendingPlaybackState(null);
      audioPlayer.stop();
      setCurrentTrack(null);
      void window.electronAPI.music.stop().catch(() => {});
    }

    setQueue(next);
    setCurrentIndex(newCurrentIndex);

    // Rebuild the shuffle order and sync shuffleOrderRef synchronously (not just
    // via the useEffect one render later) — advanceFromRef below reads the ref
    // immediately in this same tick, and a stale pre-removal order would produce
    // an out-of-bounds index (silent no-op / idle player) or the wrong track.
    if (shuffleEnabledRef.current && next.length > 0) {
      const newShuffleOrder = buildShuffleOrder(next.length, Math.max(0, newCurrentIndex));
      shuffleOrderRef.current = newShuffleOrder;
      setShuffleOrder(newShuffleOrder);
    } else if (next.length === 0) {
      shuffleOrderRef.current = null;
      setShuffleOrder(null);
    }

    if (removedCurrent && next.length > 0) {
      advanceFromRef.current(newCurrentIndex, { treatRepeatOneAsOff: true }, 0);
    }
  }, [audioPlayer, buildShuffleOrder]);

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
    playRequestIdRef.current += 1;
    setPendingPlaybackState(null);
    audioPlayer.stop();
    setQueue([]);
    setCurrentIndex(-1);
    setCurrentTrack(null);
    setShuffleOrder(null);
    void window.electronAPI.music.stop().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stops playback and resets current track/position without touching the queue.
  // Audio element src is cleared (frees file handle / network stream).
  // isBottomBarVisible is reset so the bar slides back down.
  const clearPlayer = useCallback(() => {
    playRequestIdRef.current += 1;
    setPendingPlaybackState(null);
    audioPlayer.stop();
    setCurrentTrack(null);
    setCurrentIndex(-1);
    setIsBottomBarVisible(false);
    setShuffleOrder(null);
    setConsecutiveFailures(0);
    setLastError(null);
    setAutoRepairNotice(null);
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
    // Guards must match what the handlers actually do — a button should only be
    // enabled when pressing it will produce a result.
    //
    // handleNext behaviour:
    //   "one"   → advances sequentially/shuffle without wrap (same as "off")
    //   "queue" → advances with wrap (always has a next)
    //   "off"   → advances without wrap
    //
    // handlePrev behaviour:
    //   any mode → never wraps; at position 0 (or shuffle pos 0) it is a no-op
    let canGoNext = false;
    let canGoPrev = false;
    if (queue.length > 0 && currentIndex >= 0) {
      if (repeatMode === "queue") {
        // handleNext wraps → always a next track; handlePrev never wraps → check position
        canGoNext = true;
        if (shuffleOrder !== null) {
          const pos = shuffleOrder.indexOf(currentIndex);
          canGoPrev = pos > 0;
        } else {
          canGoPrev = currentIndex > 0;
        }
      } else {
        // "off" or "one": handleNext advances without wrap; handlePrev never wraps
        if (shuffleOrder !== null) {
          const pos = shuffleOrder.indexOf(currentIndex);
          canGoNext = pos >= 0 && pos + 1 < shuffleOrder.length;
          canGoPrev = pos > 0;
        } else {
          canGoNext = currentIndex + 1 < queue.length;
          canGoPrev = currentIndex > 0;
        }
      }
    }

    return {
      currentTrack,
      playbackState: pendingPlaybackState ?? audioPlayer.playbackState,
      currentTime: audioPlayer.currentTime,
      duration: audioPlayer.duration > 0 ? audioPlayer.duration : (currentTrack?.durationSeconds ?? 0),
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
      autoRepairNotice,
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
      removeTrackFromQueue,
      reorderQueue,
      clearQueue,
      clearPlayer,
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
    pendingPlaybackState,
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
    autoRepairNotice,
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
    removeTrackFromQueue,
    reorderQueue,
    clearQueue,
    clearPlayer,
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
