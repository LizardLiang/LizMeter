import type { Session } from "../../../shared/types.ts";
import styles from "./IssueBadge.module.scss";

interface IssueBadgeProps {
  session: Session;
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
  if (issueProvider === null && issueNumber !== null) return `#${issueNumber}`;

  return null;
}

/**
 * Renders a compact badge showing the linked issue identifier and title.
 * Supports all providers: github, linear, jira, and legacy-github.
 * Returns null if the session has no linked issue.
 */
export function IssueBadge({ session }: IssueBadgeProps) {
  const displayId = getDisplayId(session);
  if (displayId === null) return null;

  const { issueTitle, issueUrl } = session;

  const handleClick = issueUrl
    ? () => void window.electronAPI.shell.openExternal(issueUrl)
    : undefined;

  const badgeClass = issueUrl ? `${styles.issueBadge} ${styles.clickable}` : styles.issueBadge;

  return (
    <span
      className={badgeClass}
      onClick={handleClick}
      title={issueTitle ?? displayId}
    >
      <span className={styles.issueBadgeId}>{displayId}</span>
      {issueTitle && <span className={styles.issueBadgeTitle}>{issueTitle}</span>}
    </span>
  );
}
