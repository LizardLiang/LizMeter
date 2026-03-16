// src/renderer/src/components/music/MusicBottomBar.tsx
// Persistent glass bottom bar for music playback controls.
// Renders at root level in TomatoClock.tsx, outside the page routing area.
// Consumes MusicPlayerContext via useMusicPlayer().
// Phase 3: full controls — thumbnail, title, prev/play/next, seek, speed, shuffle, repeat, volume.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RepeatMode } from "../../../../shared/types.ts";
import { useMusicPlayer } from "../../contexts/MusicPlayerContext.tsx";
import styles from "./MusicBottomBar.module.scss";

// ---- Time formatting ----

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

// ---- Icons ----

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <path d="M5 3.5l10 5.5-10 5.5V3.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
      <rect x="4" y="3" width="3.5" height="12" rx="1" />
      <rect x="10.5" y="3" width="3.5" height="12" rx="1" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="2.5" height="12" rx="1" />
      <path d="M13 2.5L5.5 8 13 13.5V2.5z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="11.5" y="2" width="2.5" height="12" rx="1" />
      <path d="M3 2.5L10.5 8 3 13.5V2.5z" />
    </svg>
  );
}

function MusicNoteIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M15 2v10.5a2.5 2.5 0 1 1-1.5-2.29V5.5L7 6.97v7.53a2.5 2.5 0 1 1-1.5-2.29V4.5a1 1 0 0 1 .78-.976l8-2A1 1 0 0 1 15 2z" />
    </svg>
  );
}

function VolumeHighIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2.2L4.5 5.5H2a1 1 0 00-1 1v3a1 1 0 001 1h2.5L8 13.8a.5.5 0 00.85-.35V2.55A.5.5 0 008 2.2z" />
      <path
        d="M11.36 3.53a.5.5 0 01.71 0 6.5 6.5 0 010 8.94.5.5 0 11-.71-.71 5.5 5.5 0 000-7.52.5.5 0 010-.71z"
        opacity="0.7"
      />
      <path
        d="M10.05 5.88a.5.5 0 01.71 0 3.5 3.5 0 010 4.24.5.5 0 11-.76-.65 2.5 2.5 0 000-2.94.5.5 0 01.05-.65z"
        opacity="0.9"
      />
    </svg>
  );
}

function VolumeLowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2.2L4.5 5.5H2a1 1 0 00-1 1v3a1 1 0 001 1h2.5L8 13.8a.5.5 0 00.85-.35V2.55A.5.5 0 008 2.2z" />
      <path
        d="M10.05 5.88a.5.5 0 01.71 0 3.5 3.5 0 010 4.24.5.5 0 11-.76-.65 2.5 2.5 0 000-2.94.5.5 0 01.05-.65z"
        opacity="0.9"
      />
    </svg>
  );
}

function VolumeMutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2.2L4.5 5.5H2a1 1 0 00-1 1v3a1 1 0 001 1h2.5L8 13.8a.5.5 0 00.85-.35V2.55A.5.5 0 008 2.2z" />
      <path d="M12.35 5.65a.5.5 0 01.7.7L11.42 8l1.63 1.65a.5.5 0 01-.7.7L10.72 8.7l-1.63 1.65a.5.5 0 01-.7-.7L9.99 8 8.37 6.35a.5.5 0 01.7-.7l1.63 1.64 1.65-1.64z" />
    </svg>
  );
}

function ShuffleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
    </svg>
  );
}

function RepeatOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
    </svg>
  );
}

function RepeatQueueIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
    </svg>
  );
}

function RepeatOneIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2v-3h-1l-2 1v1h1.5v4H13v-3z" />
    </svg>
  );
}

function BufferingSpinner() {
  return (
    <svg
      className={styles.spinner}
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-label="Buffering"
    >
      <circle
        cx="9"
        cy="9"
        r="7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="30 14"
      />
    </svg>
  );
}

// ---- Seek bar ----

interface SeekBarProps {
  currentTime: number;
  duration: number;
  buffered: number;
  isCached: boolean;
  onSeek: (seconds: number) => void;
}

function SeekBar({ currentTime, duration, buffered, isCached, onSeek }: SeekBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragPercent, setDragPercent] = useState(0);

  const playedPercent = duration > 0 ? Math.min((currentTime / duration) * 100, 100) : 0;
  const bufferedPercent = duration > 0 ? Math.min((buffered / duration) * 100, 100) : 0;
  const displayPercent = isDragging ? dragPercent : playedPercent;

  const getPercentFromEvent = useCallback((e: MouseEvent | React.MouseEvent): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(100, (x / rect.width) * 100));
  }, []);

  const seekToPercent = useCallback(
    (percent: number) => {
      if (duration <= 0) return;
      let targetSeconds = (percent / 100) * duration;
      // Clamp to buffered range during streaming (not cached)
      if (!isCached && buffered > 0) {
        targetSeconds = Math.min(targetSeconds, buffered);
      }
      onSeek(targetSeconds);
    },
    [duration, buffered, isCached, onSeek],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const percent = getPercentFromEvent(e);
      setIsDragging(true);
      setDragPercent(percent);
    },
    [getPercentFromEvent],
  );

  // Global mouse move and up while dragging
  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      const percent = getPercentFromEvent(e);
      setDragPercent(percent);
    };

    const onMouseUp = (e: MouseEvent) => {
      setIsDragging(false);
      const percent = getPercentFromEvent(e);
      seekToPercent(percent);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, getPercentFromEvent, seekToPercent]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) return;
      const percent = getPercentFromEvent(e);
      seekToPercent(percent);
    },
    [isDragging, getPercentFromEvent, seekToPercent],
  );

  return (
    <div
      ref={trackRef}
      className={styles.seekTrack}
      role="slider"
      aria-label="Seek"
      aria-valuenow={Math.round(currentTime)}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      {/* Buffered fill */}
      <div
        className={styles.seekBuffered}
        style={{ width: `${bufferedPercent}%` }}
      />
      {/* Played fill */}
      <div
        className={styles.seekPlayed}
        style={{ width: `${displayPercent}%` }}
      />
      {/* Thumb */}
      <div
        className={`${styles.seekThumb} ${isDragging ? styles.seekThumbDragging : ""}`}
        style={{ left: `${displayPercent}%` }}
      />
    </div>
  );
}

// ---- Volume slider (custom div-based) ----

interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

function VolumeSlider({ value, onChange }: VolumeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);

  const displayPercent = (isDragging ? dragValue : value) * 100;

  const getValueFromEvent = useCallback((e: MouseEvent | React.MouseEvent): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const v = getValueFromEvent(e);
      setIsDragging(true);
      setDragValue(v);
      onChange(v);
    },
    [getValueFromEvent, onChange],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      const v = getValueFromEvent(e);
      setDragValue(v);
      onChange(v);
    };

    const onMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging, getValueFromEvent, onChange]);

  return (
    <div
      ref={trackRef}
      className={styles.volumeTrack}
      onMouseDown={handleMouseDown}
      role="slider"
      aria-label="Volume"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
    >
      <div className={styles.volumeFill} style={{ width: `${displayPercent}%` }} />
      <div
        className={`${styles.volumeThumb} ${isDragging ? styles.volumeThumbActive : ""}`}
        style={{ left: `${displayPercent}%` }}
      />
    </div>
  );
}

// ---- Speed selector ----

interface SpeedSelectorProps {
  value: number;
  onChange: (speed: number) => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function SpeedSelector({ value, onChange }: SpeedSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const label = value === 1 ? "1x" : `${value}x`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className={styles.controlBtn}
        style={{ width: "auto", padding: "0 6px", fontSize: "11px", fontWeight: 600, letterSpacing: "0.02em" }}
        aria-label={`Playback speed: ${label}`}
        title="Playback speed"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        {label}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(14,16,30,0.95)",
            backdropFilter: "blur(24px) saturate(1.6)",
            border: "1px solid rgba(86,95,137,0.35)",
            borderRadius: "10px",
            padding: "4px",
            zIndex: 600,
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            minWidth: "72px",
          }}
          role="menu"
        >
          {SPEED_OPTIONS.map((speed) => (
            <button
              key={speed}
              type="button"
              role="menuitem"
              style={{
                display: "block",
                width: "100%",
                padding: "6px 12px",
                border: "none",
                borderRadius: "7px",
                background: speed === value ? "rgba(122,162,247,0.15)" : "transparent",
                color: speed === value ? "#7aa2f7" : "#a9b1d6",
                fontSize: "12px",
                fontWeight: speed === value ? 600 : 400,
                cursor: "pointer",
                textAlign: "center",
                transition: "background 0.1s",
              }}
              onClick={() => {
                onChange(speed);
                setOpen(false);
              }}
            >
              {speed === 1 ? "1x" : `${speed}x`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main component ----

export function MusicBottomBar() {
  const {
    currentTrack,
    playbackState,
    currentTime,
    duration,
    buffered,
    isBottomBarVisible,
    pause,
    resume,
    seek,
    next,
    prev,
    queueLength,
    currentIndex,
    volume,
    muted,
    setVolume,
    setMuted,
    playbackSpeed,
    setPlaybackSpeed,
    shuffleEnabled,
    setShuffleEnabled,
    repeatMode,
    setRepeatMode,
  } = useMusicPlayer();

  const [previousVolume, setPreviousVolume] = useState(volume);

  const isPlaying = playbackState === "playing";
  const isBuffering = playbackState === "buffering";
  const isCached = currentTrack?.isCached ?? false;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < queueLength - 1;

  const handleRepeatCycle = useCallback(() => {
    const next: RepeatMode = repeatMode === "off" ? "queue" : repeatMode === "queue" ? "one" : "off";
    setRepeatMode(next);
  }, [repeatMode, setRepeatMode]);

  return (
    <div
      className={`${styles.bar} ${isBottomBarVisible ? styles.barVisible : ""}`}
      aria-label="Music player"
      role="region"
    >
      {/* Left: thumbnail + track info */}
      <div className={styles.left}>
        <div className={styles.thumbnail} aria-hidden="true">
          <MusicNoteIcon />
        </div>
        {currentTrack
          ? (
            <div className={styles.trackInfo}>
              <span
                className={styles.trackTitle}
                title={currentTrack.title}
              >
                {currentTrack.title}
              </span>
              {currentTrack.artist && (
                <span className={styles.trackArtist}>
                  {currentTrack.artist}
                </span>
              )}
            </div>
          )
          : (
            <div className={styles.trackInfo}>
              <span className={styles.trackTitle}>No track</span>
            </div>
          )}
      </div>

      {/* Center: playback controls + seek */}
      <div className={styles.center}>
        <div className={styles.controls}>
          <button
            className={styles.controlBtn}
            aria-label="Previous track"
            disabled={!hasPrev}
            onClick={prev}
            tabIndex={0}
          >
            <PrevIcon />
          </button>

          <button
            className={styles.playPauseBtn}
            aria-label={isPlaying ? "Pause" : "Play"}
            disabled={isBuffering && !currentTrack}
            onClick={isPlaying ? pause : resume}
            tabIndex={0}
          >
            {isBuffering ? <BufferingSpinner /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>

          <button
            className={styles.controlBtn}
            aria-label="Next track"
            disabled={!hasNext}
            onClick={next}
            tabIndex={0}
          >
            <NextIcon />
          </button>
        </div>

        <div className={styles.seekRow}>
          <span className={styles.timeLabel}>{formatTime(currentTime)}</span>
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            buffered={buffered}
            isCached={isCached}
            onSeek={seek}
          />
          <span className={styles.timeLabel}>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Right: extra controls + volume */}
      <div className={styles.right}>
        {/* Speed selector */}
        <SpeedSelector value={playbackSpeed} onChange={setPlaybackSpeed} />

        {/* Shuffle */}
        <button
          className={styles.controlBtn}
          aria-label={shuffleEnabled ? "Disable shuffle" : "Enable shuffle"}
          title="Shuffle"
          onClick={() => setShuffleEnabled(!shuffleEnabled)}
          style={shuffleEnabled ? { color: "#7aa2f7" } : undefined}
        >
          <ShuffleIcon />
        </button>

        {/* Repeat */}
        <button
          className={styles.controlBtn}
          aria-label={`Repeat: ${repeatMode}`}
          title={`Repeat: ${repeatMode}`}
          onClick={handleRepeatCycle}
          style={repeatMode !== "off" ? { color: "#7aa2f7" } : undefined}
        >
          {repeatMode === "one" ? <RepeatOneIcon /> : repeatMode === "queue" ? <RepeatQueueIcon /> : <RepeatOffIcon />}
        </button>

        {/* Volume mute toggle */}
        <button
          className={styles.controlBtn}
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => {
            if (muted) {
              setMuted(false);
              if (volume === 0) setVolume(previousVolume > 0 ? previousVolume : 0.5);
            } else {
              setPreviousVolume(volume);
              setMuted(true);
            }
          }}
        >
          {muted || volume === 0 ? <VolumeMutedIcon /> : volume < 0.5 ? <VolumeLowIcon /> : <VolumeHighIcon />}
        </button>
        <VolumeSlider
          value={muted ? 0 : volume}
          onChange={(v) => {
            setVolume(v);
            if (v > 0 && muted) setMuted(false);
          }}
        />
      </div>
    </div>
  );
}
