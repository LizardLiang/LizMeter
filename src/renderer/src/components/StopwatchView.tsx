// src/renderer/src/components/StopwatchView.tsx
// Stopwatch UI: elapsed display, controls, title input, issue linkage

import { useCallback, useState } from "react";
import type { IssueRef } from "../../../shared/types.ts";
import type { UseStopwatchReturn } from "../hooks/useStopwatch.ts";
import { formatElapsed } from "../utils/format.ts";
import { IssuePromptDialog } from "./IssuePromptDialog.tsx";
import styles from "./StopwatchView.module.scss";

interface StopwatchViewProps {
  stopwatch: UseStopwatchReturn;
  promptForIssue: boolean;
}

export function StopwatchView({ stopwatch, promptForIssue }: StopwatchViewProps) {
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
    // Auto-fill title from issue
    if (!state.title) {
      const label = issue.provider === "github"
        ? `#${issue.number}: ${issue.title}`
        : issue.provider === "linear"
        ? `${issue.identifier}: ${issue.title}`
        : `${issue.key}: ${issue.title}`;
      setTitle(label);
    }
    setShowIssuePrompt(false);
    start();
  }, [setLinkedIssue, setTitle, start, state.title]);

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
        placeholder="What are you working on?"
        value={state.title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={isActive}
        maxLength={500}
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
        {isIdle && <button className={styles.startBtn} onClick={handleStart}>Start</button>}
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
