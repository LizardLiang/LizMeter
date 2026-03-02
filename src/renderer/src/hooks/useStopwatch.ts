// src/renderer/src/hooks/useStopwatch.ts
// Stopwatch FSM using useReducer with wall-clock accuracy (count-up mode)

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { IssueRef, Session, StopwatchSettings } from "../../../shared/types.ts";

// --- State ---

export interface StopwatchState {
  status: "idle" | "running" | "paused";
  elapsedSeconds: number;
  title: string;
  linkedIssue: IssueRef | null;
  startedAtWallClock: number | null;
  accumulatedActiveMs: number;
  restoredBaseMs: number; // set by RESTORE, consumed by START, 0 for normal starts
  restoredSessionId: string | null; // if set, stop updates this session instead of creating a new one
}

// --- Actions ---

type StopwatchAction =
  | { type: "START"; }
  | { type: "PAUSE"; }
  | { type: "RESUME"; }
  | { type: "STOP"; }
  | { type: "RESET"; }
  | { type: "TICK_UP"; payload: number; } // payload = elapsed seconds
  | { type: "SET_TITLE"; payload: string; }
  | { type: "SET_LINKED_ISSUE"; payload: IssueRef | null; }
  | { type: "AUTO_STOP"; }
  | { type: "RESTORE"; payload: { title: string; linkedIssue: IssueRef | null; baseMs: number; sessionId: string; }; };

const MAX_TITLE_LENGTH = 5000;

function getInitialState(): StopwatchState {
  return {
    status: "idle",
    elapsedSeconds: 0,
    title: "",
    linkedIssue: null,
    startedAtWallClock: null,
    accumulatedActiveMs: 0,
    restoredBaseMs: 0,
    restoredSessionId: null,
  };
}

function stopwatchReducer(state: StopwatchState, action: StopwatchAction): StopwatchState {
  switch (action.type) {
    case "START": {
      if (state.status !== "idle") return state;
      const baseMs = state.restoredBaseMs;
      return {
        ...state,
        status: "running",
        elapsedSeconds: Math.round(baseMs / 1000),
        startedAtWallClock: Date.now(),
        accumulatedActiveMs: baseMs,
        restoredBaseMs: 0,
      };
    }

    case "PAUSE": {
      if (state.status !== "running") return state;
      const elapsed = state.startedAtWallClock ? Date.now() - state.startedAtWallClock : 0;
      return {
        ...state,
        status: "paused",
        startedAtWallClock: null,
        accumulatedActiveMs: state.accumulatedActiveMs + elapsed,
      };
    }

    case "RESUME": {
      if (state.status !== "paused") return state;
      return {
        ...state,
        status: "running",
        startedAtWallClock: Date.now(),
      };
    }

    case "STOP":
    case "AUTO_STOP": {
      if (state.status !== "running" && state.status !== "paused") return state;
      // Final elapsed calculation
      const currentSegmentMs = state.status === "running" && state.startedAtWallClock
        ? Date.now() - state.startedAtWallClock
        : 0;
      const totalMs = state.accumulatedActiveMs + currentSegmentMs;
      return {
        ...state,
        status: "idle",
        elapsedSeconds: Math.round(totalMs / 1000),
        startedAtWallClock: null,
        accumulatedActiveMs: totalMs,
      };
    }

    case "TICK_UP": {
      if (state.status !== "running") return state;
      return { ...state, elapsedSeconds: action.payload };
    }

    case "SET_TITLE": {
      if (state.status === "idle" || state.status === "running" || state.status === "paused") {
        return { ...state, title: action.payload.slice(0, MAX_TITLE_LENGTH) };
      }
      return state;
    }

    case "SET_LINKED_ISSUE": {
      return { ...state, linkedIssue: action.payload };
    }

    case "RESET": {
      // Only valid from idle with a restored session (restoredSessionId set)
      if (state.status !== "idle" || !state.restoredSessionId) return state;
      return getInitialState();
    }

    case "RESTORE": {
      if (state.status !== "idle") return state;
      return {
        ...state,
        title: action.payload.title,
        linkedIssue: action.payload.linkedIssue,
        restoredBaseMs: action.payload.baseMs,
        restoredSessionId: action.payload.sessionId,
        elapsedSeconds: Math.round(action.payload.baseMs / 1000),
      };
    }

    default:
      return state;
  }
}

// --- Hook ---

export interface UseStopwatchReturn {
  state: StopwatchState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  reset: () => void;
  setTitle: (title: string) => void;
  setLinkedIssue: (issue: IssueRef | null) => void;
  restore: (title: string, linkedIssue: IssueRef | null, baseMs: number, sessionId: string) => void;
  saveError: string | null;
}

export type StopwatchSaveFn = (
  input: Parameters<typeof window.electronAPI.session.save>[0],
) => Promise<Session>;

export function useStopwatch(
  settings: StopwatchSettings,
  onSaved?: (session: Session) => void,
  customSave?: StopwatchSaveFn,
): UseStopwatchReturn {
  const [state, dispatch] = useReducer(stopwatchReducer, undefined, getInitialState);
  const [saveError, setSaveError] = useState<string | null>(null);
  const onSavedRef = useRef(onSaved);
  const customSaveRef = useRef(customSave);
  const savingRef = useRef(false);
  const lastSaveElapsedRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    onSavedRef.current = onSaved;
    customSaveRef.current = customSave;
  });

  // Wall-clock tick-up effect
  useEffect(() => {
    if (state.status !== "running" || !state.startedAtWallClock) return;

    const accMs = state.accumulatedActiveMs;
    const wallStart = state.startedAtWallClock;
    const maxSeconds = settings.maxDurationSeconds;

    const intervalId = setInterval(() => {
      const currentSegmentMs = Date.now() - wallStart;
      const totalMs = accMs + currentSegmentMs;
      const totalSeconds = Math.round(totalMs / 1000);

      if (maxSeconds > 0 && totalSeconds >= maxSeconds) {
        dispatch({ type: "AUTO_STOP" });
        clearInterval(intervalId);
      } else {
        dispatch({ type: "TICK_UP", payload: totalSeconds });
      }
    }, 250);

    return () => clearInterval(intervalId);
  }, [state.status, state.startedAtWallClock, state.accumulatedActiveMs, settings.maxDurationSeconds]);

  // Save session when stopped (status transitions to idle with elapsed > 0)
  useEffect(() => {
    // Only save after a stop (accumulated > 0, status = idle)
    if (state.status !== "idle" || state.accumulatedActiveMs === 0) return;

    const elapsed = Math.round(state.accumulatedActiveMs / 1000);
    // Prevent duplicate saves
    if (savingRef.current || elapsed === lastSaveElapsedRef.current) return;
    savingRef.current = true;
    lastSaveElapsedRef.current = elapsed;

    const issue = state.linkedIssue;
    const issueFields = issue
      ? issue.provider === "github"
        ? {
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueProvider: "github" as const,
          issueId: String(issue.number),
        }
        : issue.provider === "linear"
        ? {
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueProvider: "linear" as const,
          issueId: issue.identifier,
        }
        : {
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueProvider: "jira" as const,
          issueId: issue.key,
        }
      : {};

    const saveInput = {
      title: state.title,
      timerType: "stopwatch" as const,
      plannedDurationSeconds: 0,
      actualDurationSeconds: elapsed,
      ...issueFields,
    };

    const restoredId = state.restoredSessionId;
    const savePromise = restoredId
      ? window.electronAPI.session.updateDuration({ id: restoredId, actualDurationSeconds: elapsed })
      : (customSaveRef.current ?? window.electronAPI.session.save)(saveInput);

    savePromise
      .then((session) => {
        setSaveError(null);
        onSavedRef.current?.(session);
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : "Session could not be saved");
      })
      .finally(() => {
        savingRef.current = false;
      });
  }, [state.status, state.accumulatedActiveMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    start: () => dispatch({ type: "START" }),
    pause: () => dispatch({ type: "PAUSE" }),
    resume: () => dispatch({ type: "RESUME" }),
    stop: () => dispatch({ type: "STOP" }),
    reset: () => dispatch({ type: "RESET" }),
    setTitle: (title: string) => dispatch({ type: "SET_TITLE", payload: title }),
    setLinkedIssue: (issue: IssueRef | null) => dispatch({ type: "SET_LINKED_ISSUE", payload: issue }),
    restore: (title: string, linkedIssue: IssueRef | null, baseMs: number, sessionId: string) =>
      dispatch({ type: "RESTORE", payload: { title, linkedIssue, baseMs, sessionId } }),
    saveError,
  };
}
