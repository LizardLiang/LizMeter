// src/renderer/src/hooks/useLinearIssues.ts
// Hook for fetching Linear issues from the main process via IPC

import { useCallback, useEffect, useState } from "react";
import type { LinearIssue } from "../../../shared/types.ts";

export interface UseLinearIssuesReturn {
  issues: LinearIssue[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLinearIssues(): UseLinearIssuesReturn {
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const fetchIssues = useCallback(async (forceRefresh: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.linear.fetchIssues({ forceRefresh });
      setIssues(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Linear issues");
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
