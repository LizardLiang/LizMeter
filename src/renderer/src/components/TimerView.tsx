// src/renderer/src/components/TimerView.tsx
// Timer section: type selector, display, title input, controls

import type { IssueRef, TimerStatus, TimerType } from "../../../shared/types.ts";
import { stripHtml } from "../utils/html.ts";
import { IssuePickerDropdown } from "./IssuePickerDropdown.tsx";
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
  selectedIssue: IssueRef | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onReset: () => void;
  onDismiss: () => void;
  onTimerTypeChange: (type: TimerType) => void;
  onTitleChange: (title: string) => void;
  onRemainingChange: (seconds: number) => void;
  onIssueSelect: (issue: IssueRef | null) => void;
}

export function TimerView({
  status,
  timerType,
  remainingSeconds,
  title,
  saveError,
  selectedIssue,
  onStart,
  onPause,
  onResume,
  onReset,
  onDismiss,
  onTimerTypeChange,
  onTitleChange,
  onRemainingChange,
  onIssueSelect,
}: TimerViewProps) {
  const isRunningOrPaused = status === "running" || status === "paused";
  const showIssuePicker = status !== "completed";

  return (
    <div className={styles.container} data-timer-type={timerType}>
      <div className={styles.sectionLabel}>Timer</div>
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

      {showIssuePicker && (
        <div className={styles.issuePickerRow}>
          <IssuePickerDropdown selectedIssue={selectedIssue} onSelect={onIssueSelect} />
        </div>
      )}

      <TimerControls
        status={status}
        startDisabled={stripHtml(title).trim() === ""}
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
