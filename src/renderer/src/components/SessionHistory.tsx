// src/renderer/src/components/SessionHistory.tsx
// Session history section with list or empty state

import type { Session } from "../../../shared/types.ts";
import styles from "./SessionHistory.module.scss";
import { SessionHistoryItem } from "./SessionHistoryItem.tsx";

interface SessionHistoryProps {
  sessions: Session[];
  isLoading: boolean;
  error: string | null;
  onDelete: (id: string) => void;
}

export function SessionHistory({ sessions, isLoading, error, onDelete }: SessionHistoryProps) {
  return (
    <section className={styles.container} aria-label="Session History">
      <h2 className={styles.heading}>Session History</h2>

      {isLoading && <p className={styles.loadingMsg}>Loading history...</p>}

      {!isLoading && error && <div className={styles.error}>{error}</div>}

      {!isLoading && !error && sessions.length === 0 && (
        <div className={styles.empty}>
          <p style={{ margin: 0 }}>No sessions yet. Start your first session!</p>
        </div>
      )}

      {!isLoading && !error && sessions.length > 0 && (
        <ul className={styles.list}>
          {sessions.map((session) => <SessionHistoryItem key={session.id} session={session} onDelete={onDelete} />)}
        </ul>
      )}
    </section>
  );
}
