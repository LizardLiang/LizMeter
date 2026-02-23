// src/renderer/src/hooks/useJiraIssues.ts
// Hook for fetching Jira issues from the main process via IPC

import { useCallback, useEffect, useState } from "react";
import type { JiraIssue } from "../../../shared/types.ts";

export interface UseJiraIssuesReturn {
  issues: JiraIssue[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useJiraIssues(): UseJiraIssuesReturn {
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const fetchIssues = useCallback(async (forceRefresh: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.jira.fetchIssues({ forceRefresh });
      setIssues(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Jira issues");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchIssues(refreshToken > 0);
  }, [fetchIssues, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  return { issues, isLoading, error, refresh };
}
