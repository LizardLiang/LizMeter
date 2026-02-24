import type { Session } from "../../../shared/types.ts";
import {
  formatCompletedAt,
  formatStopwatchDuration,
  formatTime,
  formatTimerType,
  timerTypeColor,
} from "../utils/format.ts";
import { IssueBadge } from "./IssueBadge.tsx";
import styles from "./SessionHistoryItem.module.scss";

interface SessionHistoryItemProps {
  session: Session;
  onDelete: (id: string) => void;
  onLogWork?: (sessionId: string, issueKey: string) => void;
  worklogLoading?: boolean;
}

export function SessionHistoryItem({ session, onDelete, onLogWork, worklogLoading }: SessionHistoryItemProps) {
  const typeAccent = timerTypeColor(session.timerType);

  const displayTitle = session.title || "(no title)";

  const isJiraLinked = session.issueProvider === "jira" && session.issueId;
  const isEligibleDuration = session.actualDurationSeconds >= 60;
  const showWorklogUi = isJiraLinked && isEligibleDuration;

  const handleLogWork = () => {
    if (onLogWork && session.issueId) {
      onLogWork(session.id, session.issueId);
    }
  };

  return (
    <li className={styles.row}>
      <span className={styles.title} title={session.title || undefined}>
        {displayTitle}
      </span>
      <IssueBadge session={session} />
      {showWorklogUi && (
        <>
          {session.worklogStatus === "logged" && (
            <span className={styles.worklogLogged} aria-label="Work logged to Jira">
              Logged
            </span>
          )}
          {session.worklogStatus === "not_logged" && (
            <button
              className={styles.logWorkBtn}
              onClick={handleLogWork}
              disabled={worklogLoading}
              aria-label={`Log work to Jira for session: ${displayTitle}`}
            >
              {worklogLoading ? "..." : "Log Work"}
            </button>
          )}
          {session.worklogStatus === "failed" && (
            <button
              className={styles.retryBtn}
              onClick={handleLogWork}
              disabled={worklogLoading}
              aria-label={`Retry logging work to Jira for session: ${displayTitle}`}
            >
              {worklogLoading ? "..." : "Retry"}
            </button>
          )}
        </>
      )}
      <span
        className={styles.typeBadge}
        style={{
          backgroundColor: `${typeAccent}22`,
          border: `1px solid ${typeAccent}66`,
          color: typeAccent,
        }}
      >
        {formatTimerType(session.timerType)}
      </span>
      <span className={styles.meta}>
        {session.timerType === "stopwatch"
          ? formatStopwatchDuration(session.actualDurationSeconds)
          : formatTime(session.plannedDurationSeconds)}
      </span>
      <span className={styles.meta}>{formatCompletedAt(session.completedAt)}</span>
      <button
        className={styles.deleteBtn}
        onClick={() => onDelete(session.id)}
        aria-label={`Delete session: ${displayTitle}`}
      >
        Delete
      </button>
    </li>
  );
}
