// src/renderer/src/components/TomatoClock.tsx
// Root container for the Tomato Clock feature

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppMode,
  ClaudeCodeSessionData,
  IssueRef,
  Session,
  StopwatchSettings,
  TimerSettings,
} from "../../../shared/types.ts";
import { useClaudeTracker } from "../hooks/useClaudeTracker.ts";
import { useSessionHistory } from "../hooks/useSessionHistory.ts";
import { useSettings } from "../hooks/useSettings.ts";
import { useStopwatch } from "../hooks/useStopwatch.ts";
import { useTagManager } from "../hooks/useTagManager.ts";
import { useTimer } from "../hooks/useTimer.ts";
import { ClaudeCodeStats } from "./ClaudeCodeStats.tsx";
import { ClaudePage } from "./ClaudePage.tsx";
import { HistoryPage } from "./HistoryPage.tsx";
import { IssuesPage } from "./IssuesPage.tsx";
import { ModeToggle } from "./ModeToggle.tsx";
import type { NavPage } from "./NavSidebar.tsx";
import { NavSidebar } from "./NavSidebar.tsx";
import type { SessionPickerState } from "./SessionPicker.tsx";
import { SessionPicker } from "./SessionPicker.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { StatsPage } from "./StatsPage.tsx";
import { StopwatchView } from "./StopwatchView.tsx";
import { TagPicker } from "./TagPicker.tsx";
import { TagsPage } from "./TagsPage.tsx";
import { TimerView } from "./TimerView.tsx";
import styles from "./TomatoClock.module.scss";

const DEFAULT_SETTINGS: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
};

const DEFAULT_STOPWATCH_SETTINGS: StopwatchSettings = {
  maxDurationSeconds: 28800, // 8 hours
  promptForIssue: true,
};

export function TomatoClock() {
  const { settings, isLoading: settingsLoading, saveSettings } = useSettings();
  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

  const {
    sessions,
    total,
    isLoading: historyLoading,
    error: historyError,
    refresh,
    deleteSession,
    loadMore,
    activeTagFilter,
    setTagFilter,
    logWork,
    worklogLoading,
  } = useSessionHistory();

  const tagManager = useTagManager();
  const claudeTracker = useClaudeTracker();

  const [activePage, setActivePage] = useState<NavPage>("timer");
  const [pendingTagIds, setPendingTagIds] = useState<number[]>([]);
  const [pendingIssue, setPendingIssue] = useState<IssueRef | null>(null);

  // Claude Code settings
  const [claudeProjectDirName, setClaudeProjectDirName] = useState<string | null>(null);
  const [claudeIdleThresholdMinutes, setClaudeIdleThresholdMinutes] = useState<number>(5);
  const [claudeSettingsLoaded, setClaudeSettingsLoaded] = useState(false);

  // App mode state
  const [appMode, setAppMode] = useState<AppMode>("pomodoro");
  const [stopwatchSettings, setStopwatchSettings] = useState<StopwatchSettings>(DEFAULT_STOPWATCH_SETTINGS);

  // Load persisted Claude Code settings from the generic KV store on mount
  useEffect(() => {
    const loadClaudeSettings = async () => {
      try {
        const [projectVal, thresholdVal] = await Promise.all([
          window.electronAPI.settings.getValue("claude_tracker.project_dir_name"),
          window.electronAPI.settings.getValue("claude_tracker.idle_threshold_minutes"),
        ]);
        if (projectVal) {
          setClaudeProjectDirName(projectVal);
        }
        if (thresholdVal) {
          const parsed = parseInt(thresholdVal, 10);
          if (!isNaN(parsed) && parsed >= 1 && parsed <= 60) {
            setClaudeIdleThresholdMinutes(parsed);
          }
        }
      } catch {
        // defaults are fine if load fails
      } finally {
        setClaudeSettingsLoaded(true);
      }
    };
    void loadClaudeSettings();
  }, []);

  // Persist Claude project selection when it changes (skip before initial load)
  useEffect(() => {
    if (!claudeSettingsLoaded) return;
    window.electronAPI.settings
      .setValue("claude_tracker.project_dir_name", claudeProjectDirName)
      .catch(() => {
        // Non-fatal
      });
  }, [claudeProjectDirName, claudeSettingsLoaded]);

  // Persist Claude idle threshold when it changes (skip before initial load)
  useEffect(() => {
    if (!claudeSettingsLoaded) return;
    window.electronAPI.settings
      .setValue("claude_tracker.idle_threshold_minutes", String(claudeIdleThresholdMinutes))
      .catch(() => {
        // Non-fatal
      });
  }, [claudeIdleThresholdMinutes, claudeSettingsLoaded]);

  // Ref to capture pending CC sessions at completion time
  const pendingCcSessionsRef = useRef<ClaudeCodeSessionData[] | null>(null);

  const handleSessionSaved = useCallback(
    (session: Session) => {
      const assigns = pendingTagIds.map((tagId) => window.electronAPI.tag.assign({ sessionId: session.id, tagId }));
      Promise.all(assigns)
        .then(() => {
          setPendingTagIds([]);
          setPendingIssue(null);
          pendingCcSessionsRef.current = null;
          refresh();
        })
        .catch(() => {
          setPendingTagIds([]);
          setPendingIssue(null);
          pendingCcSessionsRef.current = null;
          refresh();
        });
    },
    [pendingTagIds, refresh],
  );

  const handleStopwatchSaved = useCallback(
    (session: Session) => {
      refresh();
      void session;
    },
    [refresh],
  );

  // Ref to claudeTracker to avoid stale closure in customSaveSession
  const claudeTrackerRef = useRef(claudeTracker);
  useEffect(() => {
    claudeTrackerRef.current = claudeTracker;
  }, [claudeTracker]);

  // Custom save function for the timer that supports atomic save-with-tracking
  // Stops the tracker first, then saves atomically with tracking data
  const customSaveSession = useCallback(
    async (input: Parameters<typeof window.electronAPI.session.save>[0]): Promise<Session> => {
      if (claudeTrackerRef.current.isTracking) {
        try {
          const ccSessions = await claudeTrackerRef.current.stopTracking();
          pendingCcSessionsRef.current = ccSessions;
        } catch {
          // Non-fatal — if stop fails, save without tracking data
          pendingCcSessionsRef.current = null;
        }
      } else if (claudeTrackerRef.current.pickerState !== "hidden") {
        // Timer completed while picker was open (user never confirmed)
        // Stop the tracker to clean up watchers and return empty sessions
        try {
          await claudeTrackerRef.current.stopTracking();
        } catch {
          // Non-fatal
        }
        pendingCcSessionsRef.current = null;
      }

      const ccSessions = pendingCcSessionsRef.current;
      if (ccSessions && ccSessions.length > 0) {
        return window.electronAPI.session.saveWithTracking({
          ...input,
          claudeCodeSessions: ccSessions,
        });
      }
      return window.electronAPI.session.save(input);
    },
    [],
  );

  const {
    state,
    start: timerStart,
    pause,
    resume,
    reset,
    setTimerType,
    setTitle,
    setRemaining,
    dismissCompletion,
    saveError,
  } = useTimer(effectiveSettings, handleSessionSaved, pendingIssue, customSaveSession);

  // Wrap start to also scan for Claude sessions if a project is configured
  const start = useCallback(async () => {
    timerStart();
    if (claudeProjectDirName) {
      try {
        await claudeTracker.scan(claudeProjectDirName);
      } catch {
        // Non-fatal — scan failure doesn't block the timer
      }
    }
  }, [timerStart, claudeProjectDirName, claudeTracker]);

  // Handle timer pause — pause Claude tracking if active
  const handlePause = useCallback(() => {
    pause();
    if (claudeTrackerRef.current.isTracking) {
      claudeTrackerRef.current.pauseTracking().catch(() => {
        // Non-fatal
      });
    }
  }, [pause]);

  // Handle timer resume — resume Claude tracking if it was tracking
  const handleResume = useCallback(() => {
    resume();
    if (claudeTrackerRef.current.isTracking) {
      claudeTrackerRef.current.resumeTracking().catch(() => {
        // Non-fatal
      });
    }
  }, [resume]);

  const stopwatch = useStopwatch(stopwatchSettings, handleStopwatchSaved);

  const handleReset = useCallback(() => {
    reset();
    setPendingIssue(null);
    // Stop tracking if active (timer was reset mid-session)
    if (claudeTrackerRef.current.isTracking || claudeTrackerRef.current.pickerState !== "hidden") {
      claudeTrackerRef.current.stopTracking().catch(() => {
        // Non-fatal
      });
    }
  }, [reset]);

  const handleIssueSelect = useCallback(
    (issue: IssueRef | null) => {
      setPendingIssue(issue);
    },
    [],
  );

  const handlePendingTagAdd = useCallback((tagId: number) => {
    setPendingTagIds((prev) => (prev.includes(tagId) ? prev : [...prev, tagId]));
  }, []);

  const handlePendingTagRemove = useCallback((tagId: number) => {
    setPendingTagIds((prev) => prev.filter((id) => id !== tagId));
  }, []);

  const handleModeChange = useCallback((mode: AppMode) => {
    setAppMode(mode);
  }, []);

  // Session picker: user confirmed a selection
  const handlePickerConfirm = useCallback(
    (selectedUuids: string[]) => {
      claudeTracker.trackSelected(selectedUuids).catch(() => {
        // Non-fatal
      });
    },
    [claudeTracker],
  );

  // Session picker: user skipped (no tracking)
  const handlePickerSkip = useCallback(() => {
    claudeTracker.setPickerState("hidden");
  }, [claudeTracker]);

  // Toggle picker collapse/expand
  const handlePickerToggleCollapse = useCallback(() => {
    const current = claudeTracker.pickerState;
    if (current === "open") {
      claudeTracker.setPickerState("collapsed");
    } else if (current === "collapsed") {
      claudeTracker.setPickerState("open");
    }
  }, [claudeTracker]);

  // "Manage Sessions" button in compact stats — re-open the picker
  const handleManageSessions = useCallback(() => {
    claudeTracker.setPickerState("open");
  }, [claudeTracker]);

  // New session notification: user clicked "Add" — open picker with new session available
  // The picker re-opens and shows all sessions (including the new one) so the session param is unused
  const handleAddNewSession = useCallback(() => {
    claudeTracker.dismissNewSessionNotification();
    claudeTracker.setPickerState("open");
  }, [claudeTracker]);

  // Derive picker state for render
  const pickerState: SessionPickerState = claudeTracker.pickerState;
  const showPicker = pickerState !== "hidden";
  const showStats = claudeTracker.isTracking || pickerState === "collapsed";

  // pickerOpenKey: increments each time the picker transitions to "open".
  // Passed as `key` to SessionPicker to force remount with fresh initial selection.
  const [pickerOpenKey, setPickerOpenKey] = useState(0);
  useEffect(() => {
    if (pickerState === "open") {
      setPickerOpenKey((k) => k + 1);
    }
  }, [pickerState]);

  if (settingsLoading) {
    return (
      <div className={styles.loading}>
        <p className={styles.loadingText}>Loading…</p>
      </div>
    );
  }

  const isPomodoroActive = state.status === "running" || state.status === "paused";
  const isStopwatchActive = stopwatch.state.status === "running" || stopwatch.state.status === "paused";
  const isAnyTimerActive = isPomodoroActive || isStopwatchActive;

  return (
    <div className={styles.root}>
      <NavSidebar activePage={activePage} onNavigate={setActivePage} timerStatus={state.status} />

      <div className={styles.main}>
        {activePage === "timer" && (
          <div className={styles.timerPage}>
            <ModeToggle mode={appMode} onModeChange={handleModeChange} disabled={isAnyTimerActive} />

            {appMode === "pomodoro" && (
              <>
                <TimerView
                  status={state.status}
                  timerType={state.timerType}
                  remainingSeconds={state.remainingSeconds}
                  title={state.title}
                  saveError={saveError}
                  selectedIssue={pendingIssue}
                  onStart={() => void start()}
                  onPause={handlePause}
                  onResume={handleResume}
                  onReset={handleReset}
                  onDismiss={dismissCompletion}
                  onTimerTypeChange={setTimerType}
                  onTitleChange={setTitle}
                  onRemainingChange={setRemaining}
                  onIssueSelect={handleIssueSelect}
                />

                {isPomodoroActive && (
                  <>
                    {showPicker && (
                      <SessionPicker
                        key={pickerOpenKey}
                        sessions={claudeTracker.discoveredSessions}
                        pickerState={pickerState}
                        trackedUuids={claudeTracker.trackedUuids}
                        onConfirm={handlePickerConfirm}
                        onSkip={handlePickerSkip}
                        onToggleCollapse={handlePickerToggleCollapse}
                      />
                    )}

                    {showStats && (
                      <ClaudeCodeStats
                        liveStats={claudeTracker.liveStats}
                        isTracking={claudeTracker.isTracking || pickerState === "collapsed"}
                        idleThresholdMinutes={claudeIdleThresholdMinutes}
                        onManageSessions={claudeTracker.isTracking ? handleManageSessions : undefined}
                        newSession={claudeTracker.newSessionNotification}
                        onAddNewSession={handleAddNewSession}
                        onDismissNewSession={claudeTracker.dismissNewSessionNotification}
                      />
                    )}

                    <div className={styles.tagSection}>
                      <div className={styles.tagSectionLabel}>Session Tags</div>
                      <TagPicker
                        allTags={tagManager.tags}
                        selectedTagIds={pendingTagIds}
                        onAdd={handlePendingTagAdd}
                        onRemove={handlePendingTagRemove}
                        onCreateTag={tagManager.createTag}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            {appMode === "time-tracking" && (
              <StopwatchView
                stopwatch={stopwatch}
                promptForIssue={stopwatchSettings.promptForIssue}
              />
            )}
          </div>
        )}

        {activePage === "history" && (
          <HistoryPage
            sessions={sessions}
            total={total}
            isLoading={historyLoading}
            error={historyError}
            allTags={tagManager.tags}
            activeTagFilter={activeTagFilter}
            onSetTagFilter={setTagFilter}
            onDeleteSession={deleteSession}
            onLoadMore={loadMore}
            onAssignTag={tagManager.assignTag}
            onUnassignTag={tagManager.unassignTag}
            onCreateTag={tagManager.createTag}
            onLogWork={logWork}
            onRefresh={refresh}
            worklogLoading={worklogLoading}
          />
        )}

        {activePage === "stats" && <StatsPage />}

        {activePage === "tags" && (
          <TagsPage
            tags={tagManager.tags}
            onCreateTag={tagManager.createTag}
            onUpdateTag={tagManager.updateTag}
            onDeleteTag={tagManager.deleteTag}
          />
        )}

        {activePage === "issues" && <IssuesPage onNavigate={setActivePage} />}

        {activePage === "claude" && <ClaudePage />}

        {activePage === "settings" && (
          <SettingsPage
            settings={effectiveSettings}
            onSave={saveSettings}
            stopwatchSettings={stopwatchSettings}
            onStopwatchSettingsChange={setStopwatchSettings}
            claudeProjectDirName={claudeProjectDirName}
            claudeIdleThresholdMinutes={claudeIdleThresholdMinutes}
            onClaudeProjectChange={setClaudeProjectDirName}
            onClaudeIdleThresholdChange={setClaudeIdleThresholdMinutes}
          />
        )}
      </div>
    </div>
  );
}
