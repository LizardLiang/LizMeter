// src/renderer/src/components/StopwatchView.tsx
// Stopwatch UI: elapsed display, controls, title input, issue linkage, Claude session linking

import { useCallback, useState } from "react";
import type { IssueRef } from "../../../shared/types.ts";
import type { UseStopwatchReturn } from "../hooks/useStopwatch.ts";
import { formatElapsed } from "../utils/format.ts";
import type { SelectedClaudeSession } from "./ClaudeSessionSelect.tsx";
import { ClaudeSessionSelect } from "./ClaudeSessionSelect.tsx";
import { IssuePromptDialog } from "./IssuePromptDialog.tsx";
import styles from "./StopwatchView.module.scss";

interface StopwatchViewProps {
  stopwatch: UseStopwatchReturn;
  promptForIssue: boolean;
  selectedClaudeSession: SelectedClaudeSession | null;
  onClaudeSessionSelect: (session: SelectedClaudeSession | null) => void;
}

export function StopwatchView(
  { stopwatch, promptForIssue, selectedClaudeSession, onClaudeSessionSelect }: StopwatchViewProps,
) {
  const { state, start, pause, resume, stop, setTitle, setLinkedIssue, saveError } = stopwatch;
  const [showIssuePrompt, setShowIssuePrompt] = useState(false);

  const handleStart = useCallback(() => {
    if (promptForIssue) {
      setShowIssuePrompt(true);
    } else {
      start();
    }
  }, [promptForIssue, start]);

  const handleIssueSelected = useCallback((issue: IssueRef) => {
    setLinkedIssue(issue);
    setShowIssuePrompt(false);
    start();
  }, [setLinkedIssue, start]);

  const handleSkipIssue = useCallback(() => {
    setShowIssuePrompt(false);
    start();
  }, [start]);

  const isRunning = state.status === "running";
  const isPaused = state.status === "paused";
  const isIdle = state.status === "idle";
  const isActive = isRunning || isPaused;

  return (
    <div className={styles.container}>
      <div className={styles.sectionLabel}>Stopwatch</div>

      <input
        className={styles.titleInput}
        type="text"
        placeholder="Describe what you'll be working on…"
        value={state.title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={isActive}
        maxLength={500}
      />

      <ClaudeSessionSelect
        selected={selectedClaudeSession}
        onSelect={onClaudeSessionSelect}
        disabled={isActive}
      />

      <div className={styles.elapsed}>{formatElapsed(state.elapsedSeconds)}</div>

      {state.linkedIssue && (
        <div className={styles.issueBadge}>
          <span className={styles.issueId}>
            {state.linkedIssue.provider === "github"
              ? `#${state.linkedIssue.number}`
              : state.linkedIssue.provider === "linear"
              ? state.linkedIssue.identifier
              : state.linkedIssue.key}
          </span>
          <span className={styles.issueTitle}>{state.linkedIssue.title}</span>
        </div>
      )}

      <div className={styles.controls}>
        {isIdle && (
          <button className={styles.startBtn} onClick={handleStart} disabled={state.title.trim() === ""}>Start</button>
        )}
        {isRunning && (
          <>
            <button className={styles.pauseBtn} onClick={pause}>Pause</button>
            <button className={styles.stopBtn} onClick={stop}>Stop</button>
          </>
        )}
        {isPaused && (
          <>
            <button className={styles.resumeBtn} onClick={resume}>Resume</button>
            <button className={styles.stopBtn} onClick={stop}>Stop</button>
          </>
        )}
      </div>

      {saveError && <div className={styles.error}>{saveError}</div>}

      {showIssuePrompt && (
        <IssuePromptDialog
          onSelect={handleIssueSelected}
          onSkip={handleSkipIssue}
        />
      )}
    </div>
  );
}
