// src/renderer/src/components/TomatoClock.tsx
// Root container for the Tomato Clock feature

import { useEffect } from "react";
import type { TimerSettings } from "../../../shared/types.ts";
import { useSessionHistory } from "../hooks/useSessionHistory.ts";
import { useSettings } from "../hooks/useSettings.ts";
import { useTimer } from "../hooks/useTimer.ts";
import { SessionHistory } from "./SessionHistory.tsx";
import { TimerView } from "./TimerView.tsx";

const DEFAULT_SETTINGS: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
};

export function TomatoClock() {
  const { settings, isLoading: settingsLoading } = useSettings();
  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

  const { state, start, pause, resume, reset, setTimerType, setTitle, setRemaining, dismissCompletion, saveError } =
    useTimer(effectiveSettings);

  const { sessions, isLoading: historyLoading, error: historyError, refresh, deleteSession } = useSessionHistory();

  // Refresh session history when a session completes
  useEffect(() => {
    if (state.status === "completed") {
      // Slight delay to allow the save to complete first
      const timer = setTimeout(() => {
        refresh();
      }, 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state.status, refresh]);

  const containerStyle: React.CSSProperties = {
    maxWidth: "640px",
    margin: "0 auto",
    padding: "24px 16px",
  };

  const titleStyle: React.CSSProperties = {
    fontSize: "1.5rem",
    fontWeight: "700",
    color: "#c0caf5",
    textAlign: "center",
    marginBottom: "20px",
    letterSpacing: "0.04em",
  };

  if (settingsLoading) {
    return (
      <div style={containerStyle}>
        <p style={{ textAlign: "center", color: "#565f89" }}>Loading...</p>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h1 style={titleStyle}>Tomato Clock</h1>

      <TimerView
        status={state.status}
        timerType={state.timerType}
        remainingSeconds={state.remainingSeconds}
        title={state.title}
        saveError={saveError}
        onStart={start}
        onPause={pause}
        onResume={resume}
        onReset={reset}
        onDismiss={dismissCompletion}
        onTimerTypeChange={setTimerType}
        onTitleChange={setTitle}
        onRemainingChange={setRemaining}
      />

      <SessionHistory
        sessions={sessions}
        isLoading={historyLoading}
        error={historyError}
        onDelete={deleteSession}
      />
    </div>
  );
}
