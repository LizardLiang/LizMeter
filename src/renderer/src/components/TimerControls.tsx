// src/renderer/src/components/TimerControls.tsx
// Start, Pause/Resume, Reset buttons for the timer

import type { TimerStatus } from "../../../shared/types.ts";

interface TimerControlsProps {
  status: TimerStatus;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onDismiss: () => void;
}

const buttonBase: React.CSSProperties = {
  padding: "10px 24px",
  fontSize: "0.9375rem",
  fontWeight: "600",
  borderRadius: "8px",
  border: "1px solid transparent",
  cursor: "pointer",
  margin: "0 6px",
  transition: "opacity 0.15s, box-shadow 0.15s",
  letterSpacing: "0.02em",
};

const primaryButton: React.CSSProperties = {
  ...buttonBase,
  backgroundColor: "#7aa2f722",
  border: "1px solid #7aa2f7",
  color: "#7aa2f7",
};

const warningButton: React.CSSProperties = {
  ...buttonBase,
  backgroundColor: "#e0af6822",
  border: "1px solid #e0af68",
  color: "#e0af68",
};

const dangerButton: React.CSSProperties = {
  ...buttonBase,
  backgroundColor: "#f7768e22",
  border: "1px solid #f7768e",
  color: "#f7768e",
};

const successButton: React.CSSProperties = {
  ...buttonBase,
  backgroundColor: "#9ece6a22",
  border: "1px solid #9ece6a",
  color: "#9ece6a",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.3,
  cursor: "not-allowed",
};

export function TimerControls({
  status,
  onStart,
  onPause,
  onResume,
  onReset,
  onDismiss,
}: TimerControlsProps) {
  const containerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: "16px 0",
    gap: "4px",
  };

  if (status === "completed") {
    return (
      <div style={containerStyle}>
        <button style={successButton} onClick={onDismiss}>
          Start New Session
        </button>
      </div>
    );
  }

  const isIdle = status === "idle";
  const isRunning = status === "running";
  const isPaused = status === "paused";
  const canReset = isRunning || isPaused;

  return (
    <div style={containerStyle}>
      {/* Start button — visible when idle */}
      {isIdle && (
        <button style={primaryButton} onClick={onStart} disabled={false}>
          Start
        </button>
      )}

      {/* Pause button — visible when running */}
      {isRunning && (
        <button style={warningButton} onClick={onPause}>
          Pause
        </button>
      )}

      {/* Resume button — visible when paused */}
      {isPaused && (
        <button style={primaryButton} onClick={onResume}>
          Resume
        </button>
      )}

      {/* Reset button — visible when running or paused */}
      <button
        style={canReset ? dangerButton : { ...dangerButton, ...disabledStyle }}
        onClick={canReset ? onReset : undefined}
        disabled={!canReset}
      >
        Reset
      </button>
    </div>
  );
}
