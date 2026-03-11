// src/renderer/widget/Widget.tsx
// Desktop widget overlay — Holographic HUD style
// Runs its own local tick to stay accurate even when the main window is background-throttled.

import { useEffect, useRef, useState } from "react";
import type { AvatarPaths, ClaudeSessionActivityType, WidgetTimerSnapshot } from "../../../shared/types.ts";
import styles from "./Widget.module.scss";

declare global {
  interface Window {
    widgetAPI: {
      onStateUpdate: (callback: (snapshot: WidgetTimerSnapshot) => void) => () => void;
      sendControl: (action: "play-pause" | "stop") => void;
      requestState: () => void;
      getAvatarPaths: () => Promise<AvatarPaths>;
      onAvatarsUpdated: (callback: (avatars: AvatarPaths) => void) => () => void;
    };
  }
}

function formatTime(seconds: number): string {
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getModeIcon(snapshot: WidgetTimerSnapshot | null): string {
  if (!snapshot) return "⏱";
  if (snapshot.mode === "time-tracking") return "⏱";
  switch (snapshot.timerType) {
    case "work":
      return "🍅";
    case "short_break":
    case "long_break":
      return "☕";
    default:
      return "⏱";
  }
}

function getAvatarForActivity(avatars: AvatarPaths, activity: ClaudeSessionActivityType | undefined): string | null {
  if (!activity || activity === "idle") return avatars.idle;
  if (activity === "thinking") return avatars.thinking;
  if (activity === "tool_use") return avatars.tool_use;
  return avatars.idle;
}

/** Snapshot + the wall-clock time it was received */
interface TimedSnapshot {
  snap: WidgetTimerSnapshot;
  receivedAt: number; // Date.now()
}

/**
 * Compute the current display seconds by extrapolating from the last snapshot.
 * Countdown (pomodoro): subtract elapsed. Count-up (stopwatch): add elapsed.
 */
function computeDisplaySeconds(ts: TimedSnapshot): number {
  const { snap, receivedAt } = ts;
  if (snap.status !== "running") return snap.displaySeconds;
  const elapsed = Math.round((Date.now() - receivedAt) / 1000);
  if (snap.mode === "time-tracking") return snap.displaySeconds + elapsed;
  return Math.max(0, snap.displaySeconds - elapsed);
}

export function Widget() {
  const [timedSnap, setTimedSnap] = useState<TimedSnapshot | null>(null);
  const [displaySeconds, setDisplaySeconds] = useState(0);
  const [avatars, setAvatars] = useState<AvatarPaths>({ idle: null, thinking: null, tool_use: null });
  const [imgNaturalSize, setImgNaturalSize] = useState<number>(0);
  const timedSnapRef = useRef(timedSnap);

  useEffect(() => {
    timedSnapRef.current = timedSnap;
  });

  // Subscribe to snapshot updates from main process
  useEffect(() => {
    const api = window.widgetAPI;
    if (!api) return;

    const unsub = api.onStateUpdate((s) => {
      const ts = { snap: s, receivedAt: Date.now() };
      setTimedSnap(ts);
      setDisplaySeconds(s.displaySeconds);
    });

    void api.getAvatarPaths().then(setAvatars);
    const unsubAvatars = api.onAvatarsUpdated(setAvatars);
    api.requestState();

    return () => {
      unsub();
      unsubAvatars();
    };
  }, []);

  // Local tick — keeps widget accurate when main renderer is background-throttled
  useEffect(() => {
    const id = setInterval(() => {
      const ts = timedSnapRef.current;
      if (ts && ts.snap.status === "running") {
        setDisplaySeconds(computeDisplaySeconds(ts));
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const snapshot = timedSnap?.snap ?? null;
  const status = snapshot?.status ?? "idle";
  const isActive = status === "running" || status === "paused";
  const rawTitle = snapshot?.title ?? "";
  const title = rawTitle.replace(/<[^>]*>/g, "").trim();
  const claudeActivity = snapshot?.claudeActivity;

  const avatarSrc = getAvatarForActivity(avatars, claudeActivity);
  const hasAvatar = avatarSrc !== null;
  const isPixelArt = imgNaturalSize > 0 && imgNaturalSize <= 128;

  const statusDotClass = [
    styles.statusDot,
    status === "running" ? styles.running : "",
    status === "paused" ? styles.paused : "",
    status === "completed" ? styles.completed : "",
  ]
    .filter(Boolean)
    .join(" ");

  const statusBarClass = [
    styles.statusBar,
    status === "running" ? styles.running : "",
    status === "paused" ? styles.paused : "",
    status === "completed" ? styles.completed : "",
  ]
    .filter(Boolean)
    .join(" ");

  const playPauseLabel = status === "running" ? "⏸" : "▶";

  return (
    <div className={`${styles.widget} ${hasAvatar ? styles.withAvatar : ""}`}>
      {/* Status accent bar */}
      <div className={statusBarClass} />

      {/* Left: Avatar in hex frame or mode icon */}
      <div className={styles.left}>
        {hasAvatar
          ? (
            <div className={styles.avatarFrame}>
              <img
                src={avatarSrc}
                className={`${styles.avatar} ${isPixelArt ? styles.pixelArt : ""}`}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  setImgNaturalSize(Math.max(img.naturalWidth, img.naturalHeight));
                }}
                draggable={false}
              />
            </div>
          )
          : (
            <div className={styles.modeIconWrap}>
              <span className={styles.modeIcon}>{getModeIcon(snapshot)}</span>
              <span className={statusDotClass} />
            </div>
          )}
      </div>

      {/* Center: Timer + title */}
      <div className={styles.center}>
        <div className={styles.timeRow}>
          <span className={styles.time}>{formatTime(displaySeconds)}</span>
          {hasAvatar && <span className={statusDotClass} />}
        </div>
        {title && <span className={styles.title}>{title}</span>}
      </div>

      {/* Right: Controls */}
      <div className={styles.right}>
        <button
          className={styles.btn}
          onClick={() => window.widgetAPI?.sendControl("play-pause")}
          disabled={!isActive}
          title={status === "running" ? "Pause" : "Resume"}
        >
          {playPauseLabel}
        </button>
        <button
          className={`${styles.btn} ${styles.stopBtn}`}
          onClick={() => window.widgetAPI?.sendControl("stop")}
          disabled={!isActive}
          title="Stop"
        >
          ■
        </button>
      </div>
    </div>
  );
}
