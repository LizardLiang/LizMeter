// src/renderer/src/components/SessionHistoryItem.tsx
// Single session row in the history list

import type { Session } from "../../../shared/types.ts";
import { formatCompletedAt, formatTime, formatTimerType } from "../utils/format.ts";

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

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: "10px 16px",
    borderBottom: "1px solid #292e42",
    gap: "12px",
  };

  const titleStyle: React.CSSProperties = {
    flex: 1,
    fontWeight: "500",
    color: "#c0caf5",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "0.9375rem",
  };

  const metaStyle: React.CSSProperties = {
    fontSize: "0.8125rem",
    color: "#565f89",
    whiteSpace: "nowrap",
  };

  const typeBadgeStyle: React.CSSProperties = {
    fontSize: "0.6875rem",
    fontWeight: "600",
    padding: "2px 8px",
    borderRadius: "12px",
    backgroundColor: `${typeAccent}22`,
    border: `1px solid ${typeAccent}66`,
    color: typeAccent,
    whiteSpace: "nowrap",
    letterSpacing: "0.03em",
  };

  const deleteButtonStyle: React.CSSProperties = {
    padding: "3px 10px",
    fontSize: "0.75rem",
    fontWeight: "600",
    borderRadius: "4px",
    border: "1px solid #f7768e44",
    backgroundColor: "transparent",
    color: "#f7768e",
    cursor: "pointer",
    flexShrink: 0,
  };

  const displayTitle = session.title || "(no title)";

  return (
    <li style={rowStyle}>
      <span style={titleStyle} title={session.title || undefined}>
        {displayTitle}
      </span>
      <span style={typeBadgeStyle}>{formatTimerType(session.timerType)}</span>
      <span style={metaStyle}>{formatTime(session.plannedDurationSeconds)}</span>
      <span style={metaStyle}>{formatCompletedAt(session.completedAt)}</span>
      <button
        style={deleteButtonStyle}
        onClick={() => onDelete(session.id)}
        aria-label={`Delete session: ${displayTitle}`}
      >
        Delete
      </button>
    </li>
  );
}
