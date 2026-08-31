import type React from "react";
import { useTodoLiveInfo } from "../hooks/useTodoLiveInfo.ts";
import { formatDuration } from "../utils/format.ts";
import type { IssueGroup } from "../utils/groupSessions.ts";
import styles from "./IssueGroupHeader.module.scss";

interface IssueGroupHeaderProps {
  group: IssueGroup;
  isExpanded: boolean;
  onToggle: () => void;
  /** When true, uses compact sizing suitable for the 260px sidebar */
  compact?: boolean;
  children?: React.ReactNode;
}

/**
 * Collapsible header for an issue group in session history.
 * Displays provider display ID, issue title, total time, and session count.
 * Clicking the header toggles the expand/collapse state.
 * Children are rendered inside the collapsible content area.
 */
export function IssueGroupHeader(
  { group, isExpanded, onToggle, compact = false, children }: IssueGroupHeaderProps,
) {
  const { issueKey, totalSeconds, sessionCount } = group;

  // Todo groups live-join the linked Todo's current title instead of the frozen snapshot every
  // other provider uses, falling back to the snapshot only when the lookup fails.
  // `key` is the parseable "provider:issueId" composite (see IssueGroupKey) -- reading the raw id
  // from it, rather than reversing the "#"-prefixed displayId, doesn't depend on display formatting.
  const liveTodo = useTodoLiveInfo(
    issueKey.provider === "todo" ? issueKey.key.split(":")[1]! : null,
    issueKey.provider,
  );
  // The fallback to the stored snapshot is reached from two distinct branches on purpose: while
  // "loading" it is a provisional placeholder (the live title hasn't arrived yet), while "missing"
  // it is the genuine answer (the lookup found nothing). Only "found" ever shows the live title.
  const displayTitle = issueKey.provider !== "todo"
    ? issueKey.title
    : liveTodo.status === "found"
    ? liveTodo.info.title
    : issueKey.title;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };

  return (
    <div>
      <div
        className={compact ? styles.headerCompact : styles.header}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        data-testid="issue-group-header"
      >
        <span className={isExpanded ? styles.chevronExpanded : styles.chevron}>▶</span>
        <span className={compact ? styles.displayIdCompact : styles.displayIdNormal}>
          {issueKey.displayId}
        </span>
        {displayTitle && (
          <span className={compact ? styles.titleCompact : styles.titleNormal} title={displayTitle}>
            {displayTitle}
          </span>
        )}
        <span className={compact ? styles.metaCompact : styles.metaNormal}>
          <span className={styles.totalTime}>{formatDuration(totalSeconds)}</span>
          <span className={styles.sessionCount}>· {sessionCount} session{sessionCount !== 1 ? "s" : ""}</span>
        </span>
      </div>
      <div className={isExpanded ? styles.contentExpanded : styles.content} aria-hidden={!isExpanded}>
        {children}
      </div>
    </div>
  );
}
