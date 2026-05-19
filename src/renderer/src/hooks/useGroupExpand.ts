import { useMemo, useState } from "react";
import type { Session } from "../../../shared/types.ts";
import type { GroupedSessionData } from "../utils/groupSessions.ts";
import { getDateKey, groupSessionsByIssue } from "../utils/groupSessions.ts";

interface GroupExpandState {
  filterId: number | undefined;
  issueGroups: Set<string>;
  dateGroups: Set<string>;
  dayGroups: Set<string>;
}

interface UseGroupExpandResult {
  groupedData: GroupedSessionData;
  expandedIssueGroups: Set<string>;
  expandedDateGroups: Set<string>;
  expandedDayGroups: Set<string>;
  toggleIssueGroup: (key: string) => void;
  toggleDateGroup: (key: string) => void;
  toggleDayGroup: (dateKey: string) => void;
}

/**
 * Computes the most-recent day's dateKey from an array of ungrouped sessions.
 * Returns an empty Set when the array is empty.
 */
function seedDayGroups(ungroupedSessions: Session[]): Set<string> {
  if (ungroupedSessions.length === 0) return new Set<string>();
  const latest = ungroupedSessions.reduce((best, s) => s.completedAt > best.completedAt ? s : best);
  return new Set([getDateKey(latest.completedAt)]);
}

/**
 * Manages grouped session data and expand/collapse state for issue and date sub-groups.
 * Automatically resets expand state when the active tag filter changes.
 */
export function useGroupExpand(
  sessions: Session[],
  activeTagFilter: number | undefined,
): UseGroupExpandResult {
  const groupedData = useMemo(() => groupSessionsByIssue(sessions), [sessions]);

  const [expandState, setExpandState] = useState<GroupExpandState>(() => ({
    filterId: activeTagFilter,
    issueGroups: new Set(),
    dateGroups: new Set(),
    dayGroups: seedDayGroups(groupedData.ungroupedSessions),
  }));

  const filterChanged = expandState.filterId !== activeTagFilter;

  const expandedIssueGroups = filterChanged ? new Set<string>() : expandState.issueGroups;
  const expandedDateGroups = filterChanged ? new Set<string>() : expandState.dateGroups;
  const expandedDayGroups = filterChanged
    ? seedDayGroups(groupedData.ungroupedSessions)
    : expandState.dayGroups;

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

  function toggleDayGroup(dateKey: string): void {
    setExpandState((prev) => {
      // If filter has changed, reset all and apply toggle to fresh seeds
      const baseDayGroups = filterChanged
        ? seedDayGroups(groupedData.ungroupedSessions)
        : prev.dayGroups;
      return {
        filterId: activeTagFilter,
        issueGroups: filterChanged ? new Set<string>() : prev.issueGroups,
        dateGroups: filterChanged ? new Set<string>() : prev.dateGroups,
        dayGroups: toggleSet(baseDayGroups, dateKey),
      };
    });
  }

  return {
    groupedData,
    expandedIssueGroups,
    expandedDateGroups,
    expandedDayGroups,
    toggleIssueGroup,
    toggleDateGroup,
    toggleDayGroup,
  };
}
