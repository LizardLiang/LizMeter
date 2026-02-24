// src/renderer/src/utils/format.ts
// Utility functions for formatting time and dates

/**
 * Formats a duration in seconds to MM:SS string.
 * Minutes can exceed 59 (e.g., 3661 seconds = "61:01").
 * Negative values are clamped to 0.
 */
export function formatTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Formats an ISO 8601 timestamp to a human-readable local date/time string.
 * Example: "2026-02-19T10:00:00.000Z" -> "Feb 19, 10:00 AM"
 */
export function formatCompletedAt(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Returns a human-readable label for a timer type.
 */
export function formatTimerType(timerType: "work" | "short_break" | "long_break" | "stopwatch"): string {
  switch (timerType) {
    case "work":
      return "Work";
    case "short_break":
      return "Short Break";
    case "long_break":
      return "Long Break";
    case "stopwatch":
      return "Stopwatch";
  }
}

/**
 * Returns the accent color for a timer type (Tokyo Night palette).
 */
export function timerTypeColor(timerType: "work" | "short_break" | "long_break" | "stopwatch"): string {
  switch (timerType) {
    case "work":
      return "#7aa2f7";
    case "short_break":
      return "#9ece6a";
    case "stopwatch":
      return "#7dcfff";
    case "long_break":
      return "#bb9af7";
  }
}

/**
 * Formats elapsed seconds as HH:MM:SS string for stopwatch display.
 */
export function formatElapsed(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Formats elapsed seconds as a human-readable duration (e.g., "1h 23m 45s").
 */
export function formatStopwatchDuration(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
