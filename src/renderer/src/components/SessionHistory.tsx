// src/renderer/src/components/SessionHistory.tsx
// Session history section with list or empty state

import type { Session } from "../../../shared/types.ts";
import { SessionHistoryItem } from "./SessionHistoryItem.tsx";

interface SessionHistoryProps {
  sessions: Session[];
  isLoading: boolean;
  error: string | null;
  onDelete: (id: string) => void;
}

export function SessionHistory({ sessions, isLoading, error, onDelete }: SessionHistoryProps) {
  const containerStyle: React.CSSProperties = {
    marginTop: "24px",
    borderTop: "1px solid #292e42",
    paddingTop: "20px",
  };

  const headingStyle: React.CSSProperties = {
    fontSize: "0.8125rem",
    fontWeight: "700",
    color: "#a9b1d6",
    marginBottom: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  };

  const listStyle: React.CSSProperties = {
    listStyle: "none",
    padding: 0,
    margin: 0,
    maxHeight: "300px",
    overflowY: "auto",
    border: "1px solid #292e42",
    borderRadius: "8px",
    backgroundColor: "#16213e",
  };

  const emptyStyle: React.CSSProperties = {
    textAlign: "center",
    padding: "32px 16px",
    color: "#565f89",
    fontSize: "0.9375rem",
    border: "1px solid #292e42",
    borderRadius: "8px",
    backgroundColor: "#16213e",
  };

  const errorStyle: React.CSSProperties = {
    padding: "12px 16px",
    color: "#f7768e",
    backgroundColor: "#f7768e11",
    border: "1px solid #f7768e44",
    borderRadius: "8px",
    fontSize: "0.875rem",
  };

  return (
    <section style={containerStyle} aria-label="Session History">
      <h2 style={headingStyle}>Session History</h2>

      {isLoading && <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>Loading history...</p>}

      {!isLoading && error && <div style={errorStyle}>{error}</div>}

      {!isLoading && !error && sessions.length === 0 && (
        <div style={emptyStyle}>
          <p style={{ margin: 0 }}>No sessions yet. Start your first session!</p>
        </div>
      )}

      {!isLoading && !error && sessions.length > 0 && (
        <ul style={listStyle}>
          {sessions.map((session) => <SessionHistoryItem key={session.id} session={session} onDelete={onDelete} />)}
        </ul>
      )}
    </section>
  );
}
