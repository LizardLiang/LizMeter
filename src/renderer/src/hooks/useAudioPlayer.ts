// src/renderer/src/hooks/useAudioPlayer.ts
// Owns a single HTMLAudioElement and translates audio events to React state.
// All playback controls (play, pause, seek, volume, speed) operate directly on
// the audio element — zero IPC round-trips.

import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicPlaybackState } from "../../../shared/types.ts";

export interface UseAudioPlayerReturn {
  // State (derived from audio events)
  currentTime: number;
  duration: number;
  buffered: number; // seconds buffered at the end of the last buffered range
  paused: boolean;
  ended: boolean;
  playbackState: MusicPlaybackState;

  // Actions (direct audio element manipulation — no IPC)
  beginPendingLoad: () => void;
  loadAndPlay: (url: string) => void;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  setPlaybackRate: (r: number) => void;
  stop: () => void;
}

// A minimal no-op audio stub for environments where the Audio constructor is
// unavailable or incomplete (e.g., jsdom in Vitest). All methods are no-ops and
// all properties return safe defaults so the hook can operate without crashing.
const noopAudio: HTMLAudioElement = {
  preload: "",
  src: "",
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  playbackRate: 1,
  paused: true,
  ended: false,
  buffered: { length: 0, end: () => 0, start: () => 0 } as TimeRanges,
  addEventListener: () => {},
  removeEventListener: () => {},
  play: () => Promise.resolve(),
  pause: () => {},
} as unknown as HTMLAudioElement;

export function useAudioPlayer(options: {
  onEnded: () => void;
  onError: (error: Event) => void;
}): UseAudioPlayerReturn {
  // Stable refs so callbacks always close over the latest values without
  // triggering re-registration of event listeners.
  const onEndedRef = useRef(options.onEnded);
  const onErrorRef = useRef(options.onError);
  useEffect(() => {
    onEndedRef.current = options.onEnded;
    onErrorRef.current = options.onError;
  });

  // audioRef is populated on mount inside an effect to avoid calling new Audio()
  // during the render phase (which fails in jsdom / server-side environments).
  const audioRef = useRef<HTMLAudioElement>(noopAudio);

  // ---- Derived state ----
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(true);
  const [ended, setEnded] = useState(false);
  const [playbackState, setPlaybackState] = useState<MusicPlaybackState>("stopped");

  // ---- Helper to read buffered range ----
  const readBuffered = useCallback((audio: HTMLAudioElement): number => {
    if (audio.buffered.length === 0) return 0;
    return audio.buffered.end(audio.buffered.length - 1);
  }, []);

  // ---- Create real HTMLAudioElement on mount and wire all events ----
  useEffect(() => {
    // Create the element inside an effect so we're safely past the render phase.
    // Falls back to the noopAudio stub if Audio is not available (e.g., jsdom).
    let audio: HTMLAudioElement;
    try {
      audio = new Audio();
      audio.preload = "auto";
      // Some jsdom versions create an object but without proper EventTarget methods.
      if (typeof audio.addEventListener !== "function") {
        audio = noopAudio;
      }
    } catch {
      audio = noopAudio;
    }
    audioRef.current = audio;

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      setBuffered(readBuffered(audio));
    };

    const onLoadedMetadata = () => {
      setDuration(audio.duration);
    };

    const onDurationChange = () => {
      setDuration(isFinite(audio.duration) ? audio.duration : 0);
    };

    const onProgress = () => {
      setBuffered(readBuffered(audio));
    };

    const onWaiting = () => {
      setPlaybackState("buffering");
    };

    const onCanPlay = () => {
      if (!audio.paused) {
        setPlaybackState("playing");
      }
    };

    const onPlaying = () => {
      setPlaybackState("playing");
      setPaused(false);
      setEnded(false);
    };

    const onPause = () => {
      if (!audio.ended) {
        setPlaybackState("paused");
        setPaused(true);
      }
    };

    const onEnded = () => {
      setPlaybackState("paused");
      setPaused(true);
      setEnded(true);
      onEndedRef.current();
    };

    const onError = (e: Event) => {
      setPlaybackState("stopped");
      onErrorRef.current(e);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("progress", onProgress);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [readBuffered]);

  // ---- Actions ----

  const beginPendingLoad = useCallback(() => {
    const audio = audioRef.current;
    audio.pause();
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setPaused(true);
    setEnded(false);
    setPlaybackState("buffering");
  }, []);

  const loadAndPlay = useCallback((url: string) => {
    const audio = audioRef.current;
    audio.src = url;
    audio.currentTime = 0;
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setEnded(false);
    setPlaybackState("buffering");
    void audio.play().catch(() => {
      // Browser may reject autoplay; the "error" event will propagate.
    });
  }, []);

  const play = useCallback(() => {
    void audioRef.current.play().catch(() => {});
  }, []);

  const pause = useCallback(() => {
    audioRef.current.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    const target = Math.max(0, Math.min(seconds, audio.duration || 0));
    audio.currentTime = target;
    setCurrentTime(target);
  }, []);

  const setVolume = useCallback((v: number) => {
    audioRef.current.volume = Math.max(0, Math.min(1, v));
  }, []);

  const setMuted = useCallback((m: boolean) => {
    audioRef.current.muted = m;
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    audioRef.current.playbackRate = r;
  }, []);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    audio.pause();
    audio.src = "";
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setPaused(true);
    setEnded(false);
    setPlaybackState("stopped");
  }, []);

  return {
    currentTime,
    duration,
    buffered,
    paused,
    ended,
    playbackState,
    beginPendingLoad,
    loadAndPlay,
    play,
    pause,
    seek,
    setVolume,
    setMuted,
    setPlaybackRate,
    stop,
  };
}
