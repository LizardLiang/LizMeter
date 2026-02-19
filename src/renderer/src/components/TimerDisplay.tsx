// src/renderer/src/components/TimerDisplay.tsx
// Large MM:SS countdown display

import type { TimerStatus } from "../../../shared/types.ts";
import { formatTime } from "../utils/format.ts";

interface TimerDisplayProps {
  remainingSeconds: number;
  status: TimerStatus;
}

export function TimerDisplay({ remainingSeconds, status }: TimerDisplayProps) {
  const timeStr = formatTime(remainingSeconds);

  const containerStyle: React.CSSProperties = {
    textAlign: "center",
    padding: "20px 0",
  };

  const displayStyle: React.CSSProperties = {
    fontSize: "5rem",
    fontWeight: "bold",
    fontFamily: "'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace",
    letterSpacing: "0.05em",
    color: status === "completed" ? "#9ece6a" : status === "paused" ? "#e0af68" : "#c0caf5",
    lineHeight: 1,
  };

  return (
    <div style={containerStyle} data-status={status}>
      <span style={displayStyle} aria-live="polite" aria-label={`${timeStr} remaining`}>
        {timeStr}
      </span>
      {status === "completed" && (
        <div
          style={{
            marginTop: "8px",
            fontSize: "1rem",
            color: "#9ece6a",
            fontWeight: "600",
          }}
        >
          Session Complete!
        </div>
      )}
    </div>
  );
}
