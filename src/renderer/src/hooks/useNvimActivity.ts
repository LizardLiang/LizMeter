// src/renderer/src/hooks/useNvimActivity.ts
// Custom hook for fetching Neovim activity data by date

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NvimActivity, NvimActivityGroup } from "../../../shared/types.ts";

function getLocalDateString(date: Date): string {
  return (
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  );
}

function groupByProject(records: NvimActivity[]): NvimActivityGroup[] {
  const map = new Map<string, NvimActivity[]>();
  for (const record of records) {
    const list = map.get(record.project);
    if (list) {
      list.push(record);
    } else {
      map.set(record.project, [record]);
    }
  }
  // Sort groups by first activity time (most recent project first)
  return Array.from(map.entries())
    .map(([project, activities]) => ({ project, activities }))
    .sort((a, b) => {
      const aTime = a.activities[0]?.recordedAt ?? "";
      const bTime = b.activities[0]?.recordedAt ?? "";
      return bTime.localeCompare(aTime);
    });
}

export interface UseNvimActivityReturn {
  date: Date;
  dateString: string;
  groups: NvimActivityGroup[];
  totalCount: number;
  isLoading: boolean;
  error: string | null;
  goToPreviousDay: () => void;
  goToNextDay: () => void;
  goToToday: () => void;
}

export function useNvimActivity(): UseNvimActivityReturn {
  const [date, setDate] = useState<Date>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  });
  const [records, setRecords] = useState<NvimActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateString = getLocalDateString(date);

  const fetchActivity = useCallback(async (ds: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.nvimActivity.listByDate({ date: ds });
      setRecords(result.records);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
      setRecords([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchActivity(dateString);

    // Poll every 5 seconds so new saves from Neovim appear automatically.
    // Pause polling when the window is hidden to avoid wasting resources.
    let interval: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (interval) return;
      interval = setInterval(() => void fetchActivity(dateString), 5000);
    }

    function stopPolling() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopPolling();
      } else {
        void fetchActivity(dateString);
        startPolling();
      }
    }

    if (!document.hidden) {
      startPolling();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchActivity, dateString]);

  const goToPreviousDay = useCallback(() => {
    setDate((prev: Date) => {
      const d = new Date(prev);
      d.setDate(d.getDate() - 1);
      return d;
    });
  }, []);

  const goToNextDay = useCallback(() => {
    setDate((prev: Date) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + 1);
      return d;
    });
  }, []);

  const goToToday = useCallback(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    setDate(now);
  }, []);

  const groups = useMemo(() => groupByProject(records), [records]);

  return {
    date,
    dateString,
    groups,
    totalCount: records.length,
    isLoading,
    error,
    goToPreviousDay,
    goToNextDay,
    goToToday,
  };
}
