// src/renderer/src/hooks/useIssues.ts
// Hook for fetching issue list and provider status from the main process

import { useCallback, useEffect, useState } from "react";
import type { Issue, IssueProviderStatus, IssuesListInput } from "../../../shared/types.ts";

export interface UseIssuesReturn {
  issues: Issue[];
  status: IssueProviderStatus;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useIssues(input?: IssuesListInput): UseIssuesReturn {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<IssueProviderStatus>({
    configured: false,
    provider: null,
    linearConfigured: false,
    linearTeamSelected: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // Stable key to avoid infinite re-render when caller passes inline object
  const inputKey = JSON.stringify(input ?? {});

  useEffect(() => {
    void window.electronAPI.issues.providerStatus().then(setStatus);
  }, [refreshToken]);

  useEffect(() => {
    if (!status.configured) {
      setIssues([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    const req: IssuesListInput = { ...input, forceRefresh: refreshToken > 0 };
    void window.electronAPI.issues
      .list(req)
      .then((res) => {
        setIssues(res.issues);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to fetch issues");
      })
      .finally(() => {
        setIsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.configured, inputKey, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  return { issues, status, isLoading, error, refresh };
}
