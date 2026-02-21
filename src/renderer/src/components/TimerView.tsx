// src/renderer/src/components/TimerView.tsx
// Timer section: type selector, display, title input, controls

import type { TimerStatus, TimerType } from "../../../shared/types.ts";
import { SessionTitleInput } from "./SessionTitleInput.tsx";
import { TimerControls } from "./TimerControls.tsx";
import { TimerDisplay } from "./TimerDisplay.tsx";
import { TimerTypeSelector } from "./TimerTypeSelector.tsx";
import styles from "./TimerView.module.scss";

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

  const isRunningOrPaused = status === "running" || status === "paused";

  return (
    <div
      className={styles.container}
      style={{
        border: `1px solid ${accentColor}25`,
        boxShadow: `0 0 48px ${accentColor}14, 0 20px 60px #00000055, inset 0 1px 0 ${accentColor}0d`,
      }}
      data-timer-type={timerType}
    >
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

      {saveError && <div className={styles.error}>{saveError}</div>}
    </div>
  );
}
