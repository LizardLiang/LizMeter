// src/renderer/src/hooks/useTimer.ts
// Timer finite state machine using useReducer with wall-clock accuracy

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { IssueRef, Session, TimerSettings, TimerStatus, TimerType } from "../../../shared/types.ts";

// --- State ---

export interface TimerState {
  status: TimerStatus;
  timerType: TimerType;
  title: string;
  remainingSeconds: number;
  settings: TimerSettings;
  // Internal tracking (not displayed):
  startedAtWallClock: number | null; // Date.now() when timer was started/resumed
  accumulatedActiveMs: number; // total active (non-paused) milliseconds
}

// --- Actions ---

type TimerAction =
  | { type: "SET_TIMER_TYPE"; payload: TimerType; }
  | { type: "SET_TITLE"; payload: string; }
  | { type: "SET_REMAINING"; payload: number; } // custom duration in seconds (idle only)
  | { type: "START"; }
  | { type: "PAUSE"; }
  | { type: "RESUME"; }
  | { type: "RESET"; }
  | { type: "TICK"; payload: number; } // payload = remaining seconds
  | { type: "COMPLETE"; payload: number; } // payload = elapsed ms for this run segment
  | { type: "UPDATE_SETTINGS"; payload: TimerSettings; }
  | { type: "CLEAR_COMPLETION"; };

const MAX_TITLE_LENGTH = 500;

function getDurationForType(settings: TimerSettings, timerType: TimerType): number {
  switch (timerType) {
    case "work":
      return settings.workDuration;
    case "short_break":
      return settings.shortBreakDuration;
    case "long_break":
      return settings.longBreakDuration;
    case "stopwatch":
      return 0;
  }
}

export function getInitialTimerState(settings: TimerSettings): TimerState {
  return {
    status: "idle",
    timerType: "work",
    title: "",
    remainingSeconds: settings.workDuration,
    settings,
    startedAtWallClock: null,
    accumulatedActiveMs: 0,
  };
}

export function timerReducer(state: TimerState, action: TimerAction): TimerState {
  switch (action.type) {
    case "SET_TIMER_TYPE": {
      // Only allowed when idle — changing type while running/paused is not supported
      if (state.status !== "idle") return state;
      const duration = getDurationForType(state.settings, action.payload);
      return {
        ...state,
        timerType: action.payload,
        remainingSeconds: duration,
      };
    }

    case "SET_REMAINING": {
      // Only allowed when idle — let the user pick a custom starting time
      if (state.status !== "idle") return state;
      const clamped = Math.max(1, Math.min(7200, action.payload));
      return { ...state, remainingSeconds: clamped };
    }

    case "SET_TITLE": {
      // Allowed in idle, running, and paused states (not completed)
      if (state.status === "completed") return state;
      const trimmed = action.payload.slice(0, MAX_TITLE_LENGTH);
      return { ...state, title: trimmed };
    }

    case "START": {
      // Only valid from idle state
      if (state.status !== "idle") return state;
      return {
        ...state,
        status: "running",
        startedAtWallClock: Date.now(),
        accumulatedActiveMs: 0,
      };
    }

    case "PAUSE": {
      // Only valid from running state
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
      // Only valid from paused state
      if (state.status !== "paused") return state;
      return {
        ...state,
        status: "running",
        startedAtWallClock: Date.now(),
      };
    }

    case "RESET": {
      // Valid from running or paused state. Title is preserved (PRD requirement).
      if (state.status !== "running" && state.status !== "paused") return state;
      const duration = getDurationForType(state.settings, state.timerType);
      return {
        ...state,
        status: "idle",
        remainingSeconds: duration,
        startedAtWallClock: null,
        accumulatedActiveMs: 0,
        // title is intentionally NOT reset
      };
    }

    case "TICK": {
      // Only valid when running
      if (state.status !== "running") return state;
      return { ...state, remainingSeconds: action.payload };
    }

    case "COMPLETE": {
      // Only valid when running
      if (state.status !== "running") return state;
      // action.payload is the elapsed ms for this run segment, computed in the tick effect
      // using `state.remainingSeconds * 1000` captured at effect-start time. This avoids
      // the timing gap between reducer execution and effect start that caused +1 min drift.
      return {
        ...state,
        status: "completed",
        remainingSeconds: 0,
        startedAtWallClock: null,
        accumulatedActiveMs: state.accumulatedActiveMs + action.payload,
      };
    }

    case "CLEAR_COMPLETION": {
      // Transition from completed back to idle
      if (state.status !== "completed") return state;
      const duration = getDurationForType(state.settings, state.timerType);
      return {
        ...state,
        status: "idle",
        remainingSeconds: duration,
        accumulatedActiveMs: 0,
      };
    }

    case "UPDATE_SETTINGS": {
      // Update settings; if idle, also update remainingSeconds
      const newDuration = getDurationForType(action.payload, state.timerType);
      return {
        ...state,
        settings: action.payload,
        remainingSeconds: state.status === "idle" ? newDuration : state.remainingSeconds,
      };
    }

    default:
      return state;
  }
}

// --- Hook ---

export interface UseTimerReturn {
  state: TimerState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  setTimerType: (type: TimerType) => void;
  setTitle: (title: string) => void;
  setRemaining: (seconds: number) => void;
  dismissCompletion: () => void;
  saveError: string | null;
}

export function useTimer(
  settings: TimerSettings,
  onSaved?: (session: Session) => void,
  pendingIssue?: IssueRef | null,
  customSave?: (input: SaveSessionInput) => Promise<Session>,
): UseTimerReturn {
  const [state, dispatch] = useReducer(timerReducer, settings, getInitialTimerState);
  const [saveError, setSaveError] = useState<string | null>(null);
  const onSavedRef = useRef(onSaved);
  const pendingIssueRef = useRef(pendingIssue);
  const customSaveRef = useRef(customSave);
  useLayoutEffect(() => {
    onSavedRef.current = onSaved;
  });
  useLayoutEffect(() => {
    pendingIssueRef.current = pendingIssue;
  });
  useLayoutEffect(() => {
    customSaveRef.current = customSave;
  });

  // Update settings when they change externally
  useEffect(() => {
    dispatch({ type: "UPDATE_SETTINGS", payload: settings });
  }, [settings]);

  // Wall-clock tick effect
  useEffect(() => {
    if (state.status !== "running") return;

    // Capture elapsed ms for this run segment at effect-start time.
    // Using remainingSeconds (not wall-clock subtraction) makes COMPLETE exact:
    // the elapsed equals precisely the duration this segment was supposed to run.
    const runElapsedMs = state.remainingSeconds * 1000;
    const endTime = Date.now() + runElapsedMs;

    const intervalId = setInterval(() => {
      const now = Date.now();
      const remaining = Math.max(0, Math.round((endTime - now) / 1000));

      if (remaining <= 0) {
        dispatch({ type: "COMPLETE", payload: runElapsedMs });
        clearInterval(intervalId);
      } else {
        dispatch({ type: "TICK", payload: remaining });
      }
    }, 250);

    return () => clearInterval(intervalId);
    // Re-run only when status changes or a resume happens (new startedAtWallClock)
  }, [state.status, state.startedAtWallClock]); // eslint-disable-line react-hooks/exhaustive-deps

  // Session save effect — triggered when status transitions to 'completed'
  useEffect(() => {
    if (state.status !== "completed") return;

    const actualDurationSeconds = Math.round(state.accumulatedActiveMs / 1000);

    const issue = pendingIssueRef.current;
    const issueFields = issue
      ? issue.provider === "github"
        ? {
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueProvider: "github" as const,
          issueId: String(issue.number),
        }
        : {
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueProvider: "linear" as const,
          issueId: issue.identifier,
        }
      : {};
    const saveInput: SaveSessionInput = {
      title: state.title,
      timerType: state.timerType,
      plannedDurationSeconds: getDurationForType(state.settings, state.timerType),
      actualDurationSeconds,
      ...issueFields,
    };

    const saveFn = customSaveRef.current ?? window.electronAPI.session.save;
    saveFn(saveInput)
      .then((session) => {
        setSaveError(null);
        onSavedRef.current?.(session);
      })
      .catch((err: unknown) => {
        setSaveError(err instanceof Error ? err.message : "Session could not be saved");
      });
  }, [state.status]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    start: () => dispatch({ type: "START" }),
    pause: () => dispatch({ type: "PAUSE" }),
    resume: () => dispatch({ type: "RESUME" }),
    reset: () => dispatch({ type: "RESET" }),
    setTimerType: (type: TimerType) => dispatch({ type: "SET_TIMER_TYPE", payload: type }),
    setTitle: (title: string) => dispatch({ type: "SET_TITLE", payload: title }),
    setRemaining: (seconds: number) => dispatch({ type: "SET_REMAINING", payload: seconds }),
    dismissCompletion: () => dispatch({ type: "CLEAR_COMPLETION" }),
    saveError,
  };
}
