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
}

export function SessionHistoryItem({ session, onDelete }: SessionHistoryItemProps) {
  const typeAccent = timerTypeColor(session.timerType);

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
