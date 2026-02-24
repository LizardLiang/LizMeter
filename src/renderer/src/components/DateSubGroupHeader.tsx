import type React from "react";
import { formatDuration } from "../utils/format.ts";
import type { DateSubGroup } from "../utils/groupSessions.ts";
import styles from "./DateSubGroupHeader.module.scss";

interface DateSubGroupHeaderProps {
  subGroup: DateSubGroup;
  isExpanded: boolean;
  onToggle: () => void;
  /** When true, uses compact sizing suitable for the 260px sidebar */
  compact?: boolean;
  children?: React.ReactNode;
}

/**
 * Collapsible header for a date sub-group within an issue group.
 * Displays date label, total time, and session count.
 * Clicking the header toggles the expand/collapse state.
 * Children are rendered inside the collapsible content area.
 */
export function DateSubGroupHeader(
  { subGroup, isExpanded, onToggle, compact = false, children }: DateSubGroupHeaderProps,
) {
  const { dateLabel, totalSeconds, sessionCount } = subGroup;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };

  const contentClass = compact
    ? (isExpanded ? styles.contentCompactExpanded : styles.contentCompact)
    : (isExpanded ? styles.contentExpanded : styles.content);

  return (
    <div>
      <div
        className={compact ? styles.headerCompact : styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        data-testid="date-subgroup-header"
      >
        <span className={isExpanded ? styles.chevronExpanded : styles.chevron}>▶</span>
        <span className={compact ? styles.dateLabelCompact : styles.dateLabelNormal}>
          {dateLabel}
        </span>
        <span className={compact ? styles.metaCompact : styles.metaNormal}>
          <span className={styles.totalTime}>{formatDuration(totalSeconds)}</span>
          <span className={styles.sessionCount}>· {sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>
        </span>
      </div>
      <div className={contentClass} aria-hidden={!isExpanded}>
        {children}
      </div>
    </div>
  );
}
