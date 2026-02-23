// src/renderer/src/components/SessionHistoryItem.tsx
// Single session row in the history list

import type { Session } from "../../../shared/types.ts";
import { formatCompletedAt, formatTime, formatTimerType } from "../utils/format.ts";
import styles from "./SessionHistoryItem.module.scss";

interface SessionHistoryItemProps {
  session: Session;
  onDelete: (id: string) => void;
}

function IssueBadge({ session }: { session: Session; }) {
  // Determine which provider/id to display
  const provider = session.issueProvider;
  const issueId = session.issueId;
  const issueNumber = session.issueNumber;
  const issueTitle = session.issueTitle;
  const issueUrl = session.issueUrl;

  // Linear issue (new field)
  if (provider === "linear" && issueId) {
    return (
      <span
        className={styles.issueBadge}
        style={{ cursor: issueUrl ? "pointer" : "default" }}
        onClick={issueUrl ? () => void window.electronAPI.shell.openExternal(issueUrl) : undefined}
        title={issueTitle ?? issueId}
      >
        <span className={styles.issueBadgeId}>{issueId}</span>
        {issueTitle && <span className={styles.issueBadgeTitle}>{issueTitle}</span>}
      </span>
    );
  }

  // GitHub issue (new field with issueProvider: "github")
  if (provider === "github" && issueId) {
    const displayNum = `#${issueId}`;
    return (
      <span
        className={styles.issueBadge}
        style={{ cursor: issueUrl ? "pointer" : "default" }}
        onClick={issueUrl ? () => void window.electronAPI.shell.openExternal(issueUrl) : undefined}
        title={issueTitle ?? displayNum}
      >
        <span className={styles.issueBadgeId}>{displayNum}</span>
        {issueTitle && <span className={styles.issueBadgeTitle}>{issueTitle}</span>}
      </span>
    );
  }

  // Legacy GitHub issue (issueProvider is null but issueNumber is set)
  if (provider === null && issueNumber !== null) {
    const displayNum = `#${issueNumber}`;
    return (
      <span
        className={styles.issueBadge}
        style={{ cursor: issueUrl ? "pointer" : "default" }}
        onClick={issueUrl ? () => void window.electronAPI.shell.openExternal(issueUrl) : undefined}
        title={issueTitle ?? displayNum}
      >
        <span className={styles.issueBadgeId}>{displayNum}</span>
        {issueTitle && <span className={styles.issueBadgeTitle}>{issueTitle}</span>}
      </span>
    );
  }

  return null;
}

export function SessionHistoryItem({ session, onDelete }: SessionHistoryItemProps) {
  const typeAccent = session.timerType === "work"
    ? "#7aa2f7"
    : session.timerType === "short_break"
    ? "#9ece6a"
    : "#bb9af7";

  const displayTitle = session.title || "(no title)";

  return (
    <li className={styles.row}>
      <span className={styles.title} title={session.title || undefined}>
        {displayTitle}
      </span>
      <IssueBadge session={session} />
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
      <span className={styles.meta}>{formatTime(session.plannedDurationSeconds)}</span>
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
