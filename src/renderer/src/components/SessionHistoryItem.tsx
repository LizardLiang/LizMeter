// src/renderer/src/components/SessionHistoryItem.tsx
// Single session row in the history list

import type { Session } from "../../../shared/types.ts";
import { formatCompletedAt, formatTime, formatTimerType } from "../utils/format.ts";
import styles from "./SessionHistoryItem.module.scss";

interface SessionHistoryItemProps {
  session: Session;
  onDelete: (id: string) => void;
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
