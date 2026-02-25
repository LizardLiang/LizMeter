// src/renderer/src/hooks/useSessionHistory.ts
// Custom hook for session history data fetching and mutations

import { useCallback, useEffect, useState } from "react";
import type { Session } from "../../../shared/types.ts";

export interface UseSessionHistoryReturn {
  sessions: Session[];
  total: number;
  isLoading: boolean;
  error: string | null;
  activeTagFilter: number | undefined;
  refresh: () => void;
  deleteSession: (id: string) => void;
  loadMore: () => void;
  setTagFilter: (tagId: number | undefined) => void;
  logWork: (
    sessionId: string,
    issueKey: string,
    overrides?: { startTime: string; endTime: string; description: string; },
  ) => Promise<void>;
  worklogLoading: Record<string, boolean>;
}

const DEFAULT_LIMIT = 50;

export function useSessionHistory(): UseSessionHistoryReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [activeTagFilter, setActiveTagFilter] = useState<number | undefined>(undefined);
  const [worklogLoading, setWorklogLoading] = useState<Record<string, boolean>>({});

  const fetchSessions = useCallback(async (currentOffset: number, tagId?: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.session.list({
        limit: DEFAULT_LIMIT,
        offset: currentOffset,
        tagId,
      });
      if (currentOffset === 0) {
        setSessions(result.sessions);
      } else {
        setSessions((prev) => [...prev, ...result.sessions]);
      }
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load session history");
      setSessions([]);
      setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load and refresh
  useEffect(() => {
    setOffset(0);
    void fetchSessions(0, activeTagFilter);
  }, [fetchSessions, refreshToken, activeTagFilter]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      window.electronAPI.session
        .delete(id)
        .then(() => {
          refresh();
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to delete session");
        });
    },
    [refresh],
  );

  const loadMore = useCallback(() => {
    const newOffset = offset + DEFAULT_LIMIT;
    setOffset(newOffset);
    void fetchSessions(newOffset, activeTagFilter);
  }, [offset, fetchSessions, activeTagFilter]);

  const setTagFilter = useCallback((tagId: number | undefined) => {
    setActiveTagFilter(tagId);
    setOffset(0);
    setRefreshToken((t) => t + 1);
  }, []);

  const logWork = useCallback(
    async (
      sessionId: string,
      issueKey: string,
      overrides?: { startTime: string; endTime: string; description: string; },
    ): Promise<void> => {
      setWorklogLoading((prev) => ({ ...prev, [sessionId]: true }));
      try {
        await window.electronAPI.worklog.log({
          sessionId,
          issueKey,
          ...(overrides
            ? {
              startTimeOverride: overrides.startTime,
              endTimeOverride: overrides.endTime,
              descriptionOverride: overrides.description,
            }
            : {}),
        });
        refresh();
      } finally {
        setWorklogLoading((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      }
    },
    [refresh],
  );

  return {
    sessions,
    total,
    isLoading,
    error,
    activeTagFilter,
    refresh,
    deleteSession,
    loadMore,
    setTagFilter,
    logWork,
    worklogLoading,
  };
}
