// src/renderer/src/components/TimerView.tsx
// Timer section: type selector, display, title input, controls

import type { TimerStatus, TimerType } from "../../../shared/types.ts";
import { SessionTitleInput } from "./SessionTitleInput.tsx";
import { TimerControls } from "./TimerControls.tsx";
import { TimerDisplay } from "./TimerDisplay.tsx";
import { TimerTypeSelector } from "./TimerTypeSelector.tsx";

interface TimerViewProps {
  status: TimerStatus;
  timerType: TimerType;
  remainingSeconds: number;
  title: string;
  saveError: string | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onDismiss: () => void;
  onTimerTypeChange: (type: TimerType) => void;
  onTitleChange: (title: string) => void;
  onRemainingChange: (seconds: number) => void;
}

export function TimerView({
  status,
  timerType,
  remainingSeconds,
  title,
  saveError,
  onStart,
  onPause,
  onResume,
  onReset,
  onDismiss,
  onTimerTypeChange,
  onTitleChange,
  onRemainingChange,
}: TimerViewProps) {
  // Visual distinction between work and break timer types (FR-023)
  const accentColor = timerType === "work" ? "#7aa2f7" : timerType === "short_break" ? "#9ece6a" : "#bb9af7";
  const containerStyle: React.CSSProperties = {
    backgroundColor: "#1f2335",
    borderRadius: "12px",
    padding: "24px",
    border: `1px solid ${accentColor}33`,
    boxShadow: `0 0 24px ${accentColor}18`,
  };

  const isRunningOrPaused = status === "running" || status === "paused";

  const errorStyle: React.CSSProperties = {
    padding: "8px 12px",
    backgroundColor: "#1a1b2e",
    border: "1px solid #f7768e44",
    borderRadius: "6px",
    color: "#f7768e",
    fontSize: "0.875rem",
    marginTop: "8px",
  };

  return (
    <div style={containerStyle} data-timer-type={timerType}>
      <TimerTypeSelector
        value={timerType}
        onChange={onTimerTypeChange}
        disabled={isRunningOrPaused || status === "completed"}
      />

      <TimerDisplay remainingSeconds={remainingSeconds} status={status} onRemainingChange={onRemainingChange} />

      <SessionTitleInput
        value={title}
        onChange={onTitleChange}
        disabled={status === "completed"}
      />

      <TimerControls
        status={status}
        onStart={onStart}
        onPause={onPause}
        onResume={onResume}
        onReset={onReset}
        onDismiss={onDismiss}
      />

      {saveError && <div style={errorStyle}>{saveError}</div>}
    </div>
  );
}
