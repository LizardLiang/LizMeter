import type { Session } from "../../../shared/types.ts";
import { useTodoLiveInfo } from "../hooks/useTodoLiveInfo.ts";
import styles from "./IssueBadge.module.scss";

interface IssueBadgeProps {
  session: Session;
  /** Called with the linked todo's id when a Todo-linked badge is clicked, instead of opening a URL. */
  onNavigateToTodo?: (todoId: number) => void;
}

/**
 * Derives the display identifier for a session's linked issue.
 * Returns null if the session has no linked issue.
 */
function getDisplayId(session: Session): string | null {
  const { issueProvider, issueId, issueNumber } = session;

  if (issueProvider === "github" && issueId) return `#${issueId}`;
  if (issueProvider === "linear" && issueId) return issueId;
  if (issueProvider === "jira" && issueId) return issueId;
  if (issueProvider === "todo" && issueId) return `#${issueId}`;
  if (issueProvider === null && issueNumber !== null) return `#${issueNumber}`;

  return null;
}

/**
 * Renders a compact badge showing the linked issue identifier and title.
 * Supports all providers: github, linear, jira, todo, and legacy-github.
 * Returns null if the session has no linked issue.
 *
 * Todo-linked badges show the Todo's *current* title (live join by id) rather than the frozen
 * snapshot every other provider uses, falling back to the stored snapshot only when the lookup
 * fails (todo deleted, or not yet synced to this machine).
 */
export function IssueBadge({ session, onNavigateToTodo }: IssueBadgeProps) {
  const displayId = getDisplayId(session);
  const liveTodo = useTodoLiveInfo(session.issueId, session.issueProvider);

  if (displayId === null) return null;

  const { issueTitle, issueUrl, issueProvider } = session;
  const isTodo = issueProvider === "todo";
  // The fallback to the stored snapshot is reached from two distinct branches on purpose: while
  // "loading" it is a provisional placeholder (the live title hasn't arrived yet), while "missing"
  // it is the genuine answer (the lookup found nothing). Both currently render the same string,
  // but only "found" ever shows the live title -- an in-flight request never gets treated as a
  // confirmed not-found.
  const displayTitle = !isTodo ? issueTitle : liveTodo.status === "found" ? liveTodo.info.title : issueTitle;

  // A corrupt/legacy issueId could fail to parse; guard so the badge falls back to non-clickable
  // instead of silently navigating to a todo id of NaN (matches reconstructIssueRef's guard).
  const todoId = isTodo ? Number(session.issueId) : NaN;
  const handleClick = isTodo
    ? (onNavigateToTodo && !Number.isNaN(todoId) ? () => onNavigateToTodo(todoId) : undefined)
    : issueUrl
    ? () => void window.electronAPI.shell.openExternal(issueUrl)
    : undefined;

  const isClickable = Boolean(handleClick);
  const badgeClass = isClickable ? `${styles.issueBadge} ${styles.clickable}` : styles.issueBadge;

  return (
    <span
      className={badgeClass}
      onClick={handleClick}
      title={displayTitle ?? displayId}
    >
      <span className={styles.issueBadgeId}>{displayId}</span>
      {displayTitle && <span className={styles.issueBadgeTitle}>{displayTitle}</span>}
    </span>
  );
}
