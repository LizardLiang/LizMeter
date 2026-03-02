// src/renderer/src/components/TimerControls.tsx
// Start, Pause/Resume, Reset buttons for the timer

import type { TimerStatus } from "../../../shared/types.ts";
import styles from "./TimerControls.module.scss";

interface TimerControlsProps {
  status: TimerStatus;
  startDisabled?: boolean;
  isRestored?: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onDismiss: () => void;
}

export function TimerControls({
  status,
  startDisabled = false,
  isRestored = false,
  onStart,
  onPause,
  onResume,
  onReset,
  onDismiss,
}: TimerControlsProps) {
  if (status === "completed") {
    return (
      <div className={styles.container}>
        <button className={styles.btnSuccess} onClick={onDismiss}>
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
    <div className={styles.container}>
      {/* Start button — visible when idle */}
      {isIdle && (
        <button className={styles.btnPrimary} onClick={onStart} disabled={startDisabled}>
          Start
        </button>
      )}

      {/* Cancel button — visible when idle with a restored session loaded */}
      {isIdle && isRestored && (
        <button className={styles.btnDanger} onClick={onReset}>
          Cancel
        </button>
      )}

      {/* Pause button — visible when running */}
      {isRunning && (
        <button className={styles.btnWarning} onClick={onPause}>
          Pause
        </button>
      )}

      {/* Resume button — visible when paused */}
      {isPaused && (
        <button className={styles.btnPrimary} onClick={onResume}>
          Resume
        </button>
      )}

      {/* Reset button — visible when running or paused */}
      <button
        className={styles.btnDanger}
        onClick={canReset ? onReset : undefined}
        disabled={!canReset}
      >
        Reset
      </button>
    </div>
  );
}
