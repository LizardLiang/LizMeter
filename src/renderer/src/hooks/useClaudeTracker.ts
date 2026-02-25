// src/renderer/src/hooks/useClaudeTracker.ts
// React hook for consuming Claude Code tracker IPC events

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeCodeLiveStats, ClaudeCodeSessionData } from "../../../shared/types.ts";

export interface UseClaudeTrackerReturn {
  isTracking: boolean;
  liveStats: ClaudeCodeLiveStats | null;
  startTracking: (projectDirName: string) => Promise<{ started: boolean; error?: string; }>;
  stopTracking: () => Promise<ClaudeCodeSessionData[]>;
}

export function useClaudeTracker(): UseClaudeTrackerReturn {
  const [isTracking, setIsTracking] = useState(false);
  const [liveStats, setLiveStats] = useState<ClaudeCodeLiveStats | null>(null);
  const isTrackingRef = useRef(false);

  useEffect(() => {
    isTrackingRef.current = isTracking;
  }, [isTracking]);

  // Subscribe to live updates from main process
  useEffect(() => {
    const unsubscribe = window.electronAPI.claudeTracker.onUpdate((stats) => {
      setLiveStats(stats);
    });
    // Cleanup on unmount — prevents memory leak
    return unsubscribe;
  }, []);

  const startTracking = useCallback(async (projectDirName: string): Promise<{ started: boolean; error?: string; }> => {
    const result = await window.electronAPI.claudeTracker.start({ projectDirName });
    if (result.started) {
      setIsTracking(true);
      setLiveStats(null);
    }
    return result;
  }, []);

  const stopTracking = useCallback(async (): Promise<ClaudeCodeSessionData[]> => {
    const result = await window.electronAPI.claudeTracker.stop();
    setIsTracking(false);
    setLiveStats(null);
    return result.sessions;
  }, []);

  return {
    isTracking,
    liveStats,
    startTracking,
    stopTracking,
  };
}
