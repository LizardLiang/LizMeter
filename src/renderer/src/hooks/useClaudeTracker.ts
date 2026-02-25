// src/renderer/src/hooks/useClaudeTracker.ts
// React hook for consuming Claude Code tracker IPC events (v1.2: two-phase scan/track flow)

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeCodeLiveStats, ClaudeCodeSessionData, ClaudeCodeSessionPreview } from "../../../shared/types.ts";
import type { SessionPickerState } from "../components/SessionPicker.tsx";

export interface UseClaudeTrackerReturn {
  // Tracking state
  isTracking: boolean;
  liveStats: ClaudeCodeLiveStats | null;
  trackedUuids: string[];
  // Picker state
  pickerState: SessionPickerState;
  discoveredSessions: ClaudeCodeSessionPreview[];
  // New session notification
  newSessionNotification: ClaudeCodeSessionPreview | null;
  dismissNewSessionNotification: () => void;
  // Actions
  scan: (
    projectDirName: string,
  ) => Promise<{ success: boolean; error?: string; sessions: ClaudeCodeSessionPreview[]; }>;
  trackSelected: (sessionUuids: string[]) => Promise<{ tracked: number; }>;
  stopTracking: () => Promise<ClaudeCodeSessionData[]>;
  pauseTracking: () => Promise<void>;
  resumeTracking: () => Promise<void>;
  setPickerState: (state: SessionPickerState) => void;
}

export function useClaudeTracker(): UseClaudeTrackerReturn {
  const [isTracking, setIsTracking] = useState(false);
  const [liveStats, setLiveStats] = useState<ClaudeCodeLiveStats | null>(null);
  const [trackedUuids, setTrackedUuids] = useState<string[]>([]);
  const [pickerState, setPickerState] = useState<SessionPickerState>("hidden");
  const [discoveredSessions, setDiscoveredSessions] = useState<ClaudeCodeSessionPreview[]>([]);
  const [newSessionNotification, setNewSessionNotification] = useState<ClaudeCodeSessionPreview | null>(null);

  // Track dismissed session UUIDs to avoid re-notifying
  const dismissedUuidsRef = useRef<Set<string>>(new Set());

  // Subscribe to live updates and new-session notifications from main process
  useEffect(() => {
    const unsubUpdate = window.electronAPI.claudeTracker.onUpdate((stats) => {
      setLiveStats(stats);
    });
    const unsubNewSession = window.electronAPI.claudeTracker.onNewSession(({ session }) => {
      // Don't re-notify for dismissed sessions
      if (dismissedUuidsRef.current.has(session.ccSessionUuid)) return;
      // Replace any existing notification (only one at a time per spec)
      setNewSessionNotification(session);
    });
    return () => {
      unsubUpdate();
      unsubNewSession();
    };
  }, []);

  const scan = useCallback(async (
    projectDirName: string,
  ): Promise<{ success: boolean; error?: string; sessions: ClaudeCodeSessionPreview[]; }> => {
    setPickerState("loading");
    setDiscoveredSessions([]);
    setTrackedUuids([]);
    setLiveStats(null);
    setIsTracking(false);

    const result = await window.electronAPI.claudeTracker.scan({ projectDirName });

    if (result.success) {
      setDiscoveredSessions(result.sessions);
      setPickerState("open");
    } else {
      setPickerState("hidden");
    }

    return result;
  }, []);

  const trackSelected = useCallback(async (sessionUuids: string[]): Promise<{ tracked: number; }> => {
    const result = await window.electronAPI.claudeTracker.trackSelected({ sessionUuids });
    setTrackedUuids(sessionUuids);
    setIsTracking(sessionUuids.length > 0);
    setPickerState("collapsed");
    return result;
  }, []);

  const stopTracking = useCallback(async (): Promise<ClaudeCodeSessionData[]> => {
    const result = await window.electronAPI.claudeTracker.stop();
    setIsTracking(false);
    setLiveStats(null);
    setTrackedUuids([]);
    setPickerState("hidden");
    setDiscoveredSessions([]);
    setNewSessionNotification(null);
    dismissedUuidsRef.current.clear();
    return result.sessions;
  }, []);

  const pauseTracking = useCallback(async (): Promise<void> => {
    await window.electronAPI.claudeTracker.pause();
  }, []);

  const resumeTracking = useCallback(async (): Promise<void> => {
    await window.electronAPI.claudeTracker.resume();
  }, []);

  const dismissNewSessionNotification = useCallback(() => {
    setNewSessionNotification((prev) => {
      if (prev) {
        dismissedUuidsRef.current.add(prev.ccSessionUuid);
      }
      return null;
    });
  }, []);

  return {
    isTracking,
    liveStats,
    trackedUuids,
    pickerState,
    discoveredSessions,
    newSessionNotification,
    dismissNewSessionNotification,
    scan,
    trackSelected,
    stopTracking,
    pauseTracking,
    resumeTracking,
    setPickerState,
  };
}
