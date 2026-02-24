import type { Session } from "../../../shared/types.ts";

/** Key that uniquely identifies an issue for grouping purposes */
export interface IssueGroupKey {
  /** Composite string key: "provider:issueId" or "legacy-github:issueNumber" or "legacy-github-url:issueUrl" */
  key: string;
  provider: "github" | "linear" | "jira" | "legacy-github";
  /** Display identifier: "#42", "LIN-42", "PROJ-123", etc. */
  displayId: string;
  /** Issue title (from issueTitle field, may be null) */
  title: string | null;
  /** Issue URL for linking out */
  url: string | null;
}

export interface DateSubGroup {
  /** Date string in YYYY-MM-DD format (derived from completedAt) */
  dateKey: string;
  /** Human-readable date label: "Today", "Yesterday", or absolute format (e.g., "Feb 22") */
  dateLabel: string;
  /** Number of sessions in this sub-group */
  sessionCount: number;
  /** Sum of actualDurationSeconds for sessions in this sub-group */
  totalSeconds: number;
  /** Sessions in this sub-group, ordered by completedAt descending */
  sessions: Session[];
}

export interface IssueGroup {
  /** Unique key for this issue group */
  issueKey: IssueGroupKey;
  /** Sum of actualDurationSeconds across all sessions in this group */
  totalSeconds: number;
  /** Total number of sessions in this group */
  sessionCount: number;
  /** Date sub-groups, ordered by date descending (most recent first) */
  dateSubGroups: DateSubGroup[];
  /** Most recent completedAt across all sessions (for sorting groups) */
  latestCompletedAt: string;
}

export interface GroupedSessionData {
  /** Issue groups, ordered by latestCompletedAt descending */
  issueGroups: IssueGroup[];
  /** Sessions with no linked issue, ordered by completedAt descending */
  ungroupedSessions: Session[];
}

/**
 * Determines whether a session has a linked issue.
 * A session is considered linked if:
 *   - issueProvider is set AND issueId is set, OR
 *   - issueProvider is null AND issueNumber is not null (legacy GitHub)
 */
export function hasLinkedIssue(session: Session): boolean {
  return (session.issueProvider !== null && session.issueId !== null)
    || (session.issueProvider === null && session.issueNumber !== null);
}

/**
 * Computes the grouping key for a session with a linked issue.
 * Must only be called when hasLinkedIssue(session) is true.
 */
export function getIssueGroupKey(session: Session): IssueGroupKey {
  const { issueProvider, issueId, issueNumber, issueTitle, issueUrl } = session;

  // Modern providers: github, linear, jira
  if (issueProvider !== null && issueId !== null) {
    const displayId = issueProvider === "github" ? `#${issueId}` : issueId;
    return {
      key: `${issueProvider}:${issueId}`,
      provider: issueProvider,
      displayId,
      title: issueTitle,
      url: issueUrl,
    };
  }

  // Legacy GitHub: issueProvider is null but issueNumber is set.
  // Group by URL when available to distinguish same issue number across repos.
  const legacyKey = issueUrl !== null
    ? `legacy-github-url:${issueUrl}`
    : `legacy-github-num:${issueNumber}`;

  return {
    key: legacyKey,
    provider: "legacy-github",
    displayId: `#${issueNumber}`,
    title: issueTitle,
    url: issueUrl,
  };
}

/**
 * Extracts the YYYY-MM-DD date key from an ISO 8601 timestamp.
 * Uses local time to match what users see in the UI.
 */
function getDateKey(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Computes a human-readable date label for a given date key.
 * Uses relative labels ("Today", "Yesterday") for recent dates,
 * absolute format for older dates.
 *
 * @param dateKey - Date string in YYYY-MM-DD format
 * @param now - Current date (injectable for testing)
 * @returns Human-readable label
 */
export function formatDateLabel(dateKey: string, now?: Date): string {
  const reference = now ?? new Date();
  const todayKey = getDateKey(reference.toISOString());

  // Compute yesterday's date key
  const yesterday = new Date(reference);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = getDateKey(yesterday.toISOString());

  if (dateKey === todayKey) {
    return "Today";
  }
  if (dateKey === yesterdayKey) {
    return "Yesterday";
  }

  // Parse the date key as a local date
  const [yearStr, monthStr, dayStr] = dateKey.split("-");
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10) - 1;
  const day = parseInt(dayStr!, 10);
  const date = new Date(year, month, day);

  const currentYear = reference.getFullYear();
  if (year === currentYear) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Transforms a flat array of sessions into a grouped structure.
 * Pure function, no side effects.
 *
 * @param sessions - Flat array of sessions (as returned by session:list IPC)
 * @returns Grouped data structure with issue groups and ungrouped sessions
 */
export function groupSessionsByIssue(sessions: Session[]): GroupedSessionData {
  // Map from composite key -> IssueGroup (mutable intermediate)
  const issueGroupMap = new Map<
    string,
    {
      issueKey: IssueGroupKey;
      totalSeconds: number;
      sessionCount: number;
      latestCompletedAt: string;
      // date key -> mutable DateSubGroup
      dateMap: Map<string, { sessions: Session[]; totalSeconds: number; }>;
    }
  >();

  const ungroupedSessions: Session[] = [];

  for (const session of sessions) {
    if (!hasLinkedIssue(session)) {
      ungroupedSessions.push(session);
      continue;
    }

    const issueKey = getIssueGroupKey(session);
    const dateKey = getDateKey(session.completedAt);

    let group = issueGroupMap.get(issueKey.key);
    if (!group) {
      group = {
        issueKey,
        totalSeconds: 0,
        sessionCount: 0,
        latestCompletedAt: session.completedAt,
        dateMap: new Map(),
      };
      issueGroupMap.set(issueKey.key, group);
    }

    group.totalSeconds += session.actualDurationSeconds;
    group.sessionCount += 1;
    if (session.completedAt > group.latestCompletedAt) {
      group.latestCompletedAt = session.completedAt;
    }

    let dateEntry = group.dateMap.get(dateKey);
    if (!dateEntry) {
      dateEntry = { sessions: [], totalSeconds: 0 };
      group.dateMap.set(dateKey, dateEntry);
    }
    dateEntry.sessions.push(session);
    dateEntry.totalSeconds += session.actualDurationSeconds;
  }

  // Build final IssueGroup array sorted by latestCompletedAt descending
  const issueGroups: IssueGroup[] = [];
  for (const group of issueGroupMap.values()) {
    // Build DateSubGroup array sorted by dateKey descending
    const dateSubGroups: DateSubGroup[] = [];
    for (const [dateKey, dateEntry] of group.dateMap.entries()) {
      // Sort sessions within each date group by completedAt descending
      const sortedSessions = dateEntry.sessions.slice().sort((a, b) => b.completedAt.localeCompare(a.completedAt));
      dateSubGroups.push({
        dateKey,
        dateLabel: formatDateLabel(dateKey),
        sessionCount: sortedSessions.length,
        totalSeconds: dateEntry.totalSeconds,
        sessions: sortedSessions,
      });
    }
    dateSubGroups.sort((a, b) => b.dateKey.localeCompare(a.dateKey));

    issueGroups.push({
      issueKey: group.issueKey,
      totalSeconds: group.totalSeconds,
      sessionCount: group.sessionCount,
      dateSubGroups,
      latestCompletedAt: group.latestCompletedAt,
    });
  }

  // Sort issue groups by latestCompletedAt descending
  issueGroups.sort((a, b) => b.latestCompletedAt.localeCompare(a.latestCompletedAt));

  // Ungrouped sessions: maintain original order (already descending from IPC)
  return {
    issueGroups,
    ungroupedSessions,
  };
}
