import { useMemo, useState } from "react";
import type { Session } from "../../../shared/types.ts";
import type { GroupedSessionData } from "../utils/groupSessions.ts";
import { groupSessionsByIssue } from "../utils/groupSessions.ts";

interface GroupExpandState {
  filterId: number | undefined;
  issueGroups: Set<string>;
  dateGroups: Set<string>;
}

interface UseGroupExpandResult {
  groupedData: GroupedSessionData;
  expandedIssueGroups: Set<string>;
  expandedDateGroups: Set<string>;
  toggleIssueGroup: (key: string) => void;
  toggleDateGroup: (key: string) => void;
}

/**
 * Manages grouped session data and expand/collapse state for issue and date sub-groups.
 * Automatically resets expand state when the active tag filter changes.
 */
export function useGroupExpand(
  sessions: Session[],
  activeTagFilter: number | undefined,
): UseGroupExpandResult {
  const [expandState, setExpandState] = useState<GroupExpandState>({
    filterId: activeTagFilter,
    issueGroups: new Set(),
    dateGroups: new Set(),
  });

  const expandedIssueGroups = expandState.filterId === activeTagFilter ? expandState.issueGroups : new Set<string>();
  const expandedDateGroups = expandState.filterId === activeTagFilter ? expandState.dateGroups : new Set<string>();

  const groupedData = useMemo(() => groupSessionsByIssue(sessions), [sessions]);

  function toggleSet(current: Set<string>, key: string): Set<string> {
    const next = new Set(current);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  }

  function toggleIssueGroup(key: string): void {
    setExpandState((prev) => ({
      ...prev,
      filterId: activeTagFilter,
      issueGroups: toggleSet(expandedIssueGroups, key),
    }));
  }

  function toggleDateGroup(key: string): void {
    setExpandState((prev) => ({
      ...prev,
      filterId: activeTagFilter,
      dateGroups: toggleSet(expandedDateGroups, key),
    }));
  }

  return {
    groupedData,
    expandedIssueGroups,
    expandedDateGroups,
    toggleIssueGroup,
    toggleDateGroup,
  };
}
