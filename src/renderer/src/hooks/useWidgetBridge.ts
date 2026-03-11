// src/renderer/src/hooks/useWidgetBridge.ts
// Bridge hook that syncs timer/stopwatch state to the desktop widget and handles
// control relay commands sent from the widget back to the main renderer.

import { useEffect, useRef } from "react";
import type { AppMode, ClaudeSessionActivityType, TimerType, WidgetTimerSnapshot } from "../../../shared/types.ts";
import type { StopwatchState } from "./useStopwatch.ts";
import type { TimerState } from "./useTimer.ts";

export interface WidgetBridgeActions {
  timerPause: () => void;
  timerResume: () => void;
  timerReset: () => void;
  stopwatchPause: () => void;
  stopwatchResume: () => void;
  stopwatchStop: () => void;
}

function buildSnapshot(
  appMode: AppMode,
  timerState: TimerState,
  stopwatchState: StopwatchState,
  claudeActivity?: ClaudeSessionActivityType,
): WidgetTimerSnapshot {
  if (appMode === "pomodoro") {
    return {
      mode: "pomodoro",
      status: timerState.status,
      timerType: timerState.timerType,
      displaySeconds: timerState.remainingSeconds,
      title: timerState.title,
      plannedDurationSeconds: timerState.originalPlannedDuration
        ?? timerState.remainingSeconds,
      claudeActivity,
    };
  }

  // time-tracking mode uses stopwatch
  const stopwatchTimerType: TimerType = "stopwatch";
  return {
    mode: "time-tracking",
    status: stopwatchState.status === "idle" ? "idle" : stopwatchState.status,
    timerType: stopwatchTimerType,
    displaySeconds: stopwatchState.elapsedSeconds,
    title: stopwatchState.title,
    plannedDurationSeconds: null,
    claudeActivity,
  };
}

export function useWidgetBridge(
  appMode: AppMode,
  timerState: TimerState,
  stopwatchState: StopwatchState,
  actions: WidgetBridgeActions,
  claudeActivity?: ClaudeSessionActivityType,
): void {
  const actionsRef = useRef(actions);
  const appModeRef = useRef(appMode);
  const timerStateRef = useRef(timerState);
  const stopwatchStateRef = useRef(stopwatchState);
  const claudeActivityRef = useRef(claudeActivity);

  useEffect(() => {
    actionsRef.current = actions;
    appModeRef.current = appMode;
    timerStateRef.current = timerState;
    stopwatchStateRef.current = stopwatchState;
    claudeActivityRef.current = claudeActivity;
  });

  // Push state to widget whenever relevant state changes
  useEffect(() => {
    const api = window.electronAPI?.widget;
    if (!api) return;

    const snapshot = buildSnapshot(appMode, timerState, stopwatchState, claudeActivity);
    api.sendStateUpdate(snapshot);
  }, [
    appMode,
    timerState.status,
    timerState.timerType,
    timerState.remainingSeconds,
    timerState.title,
    timerState.originalPlannedDuration,
    stopwatchState.status,
    stopwatchState.elapsedSeconds,
    stopwatchState.title,
    claudeActivity,
  ]);

  // Subscribe to control relay from widget (play-pause / stop)
  useEffect(() => {
    const api = window.electronAPI?.widget;
    if (!api) return;

    const unsubControl = api.onControlRelay((action) => {
      const mode = appModeRef.current;
      if (mode === "pomodoro") {
        const { status } = timerStateRef.current;
        if (action === "play-pause") {
          if (status === "running") {
            actionsRef.current.timerPause();
          } else if (status === "paused") {
            actionsRef.current.timerResume();
          }
        } else if (action === "stop") {
          if (status === "running" || status === "paused") {
            actionsRef.current.timerReset();
          }
        }
      } else {
        const { status } = stopwatchStateRef.current;
        if (action === "play-pause") {
          if (status === "running") {
            actionsRef.current.stopwatchPause();
          } else if (status === "paused") {
            actionsRef.current.stopwatchResume();
          }
        } else if (action === "stop") {
          if (status === "running" || status === "paused") {
            actionsRef.current.stopwatchStop();
          }
        }
      }
    });

    // Subscribe to state request relay from widget
    const unsubRequest = api.onRequestStateRelay(() => {
      const snapshot = buildSnapshot(
        appModeRef.current,
        timerStateRef.current,
        stopwatchStateRef.current,
        claudeActivityRef.current,
      );
      api.sendStateUpdate(snapshot);
    });

    return () => {
      unsubControl();
      unsubRequest();
    };
  }, []);
}
