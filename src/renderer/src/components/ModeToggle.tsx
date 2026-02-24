// src/renderer/src/components/ModeToggle.tsx
// Segmented control for switching between Pomodoro and Time Tracking modes

import type { AppMode } from "../../../shared/types.ts";
import styles from "./ModeToggle.module.scss";

interface ModeToggleProps {
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  disabled?: boolean;
}

export function ModeToggle({ mode, onModeChange, disabled }: ModeToggleProps) {
  return (
    <div className={styles.container} role="tablist" aria-label="App mode">
      <button
        role="tab"
        className={`${styles.tab} ${mode === "pomodoro" ? styles.active : ""}`}
        aria-selected={mode === "pomodoro"}
        disabled={disabled}
        onClick={() => onModeChange("pomodoro")}
      >
        Pomodoro
      </button>
      <button
        role="tab"
        className={`${styles.tab} ${mode === "time-tracking" ? styles.active : ""}`}
        aria-selected={mode === "time-tracking"}
        disabled={disabled}
        onClick={() => onModeChange("time-tracking")}
      >
        Time Tracking
      </button>
    </div>
  );
}
