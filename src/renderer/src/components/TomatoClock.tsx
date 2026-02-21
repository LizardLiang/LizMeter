// src/renderer/src/components/TomatoClock.tsx
// Root container for the Tomato Clock feature

import { useCallback, useState } from "react";
import type { Session, TimerSettings } from "../../../shared/types.ts";
import { useSessionHistory } from "../hooks/useSessionHistory.ts";
import { useSettings } from "../hooks/useSettings.ts";
import { useTagManager } from "../hooks/useTagManager.ts";
import { useTimer } from "../hooks/useTimer.ts";
import { HistoryPage } from "./HistoryPage.tsx";
import type { NavPage } from "./NavSidebar.tsx";
import { NavSidebar } from "./NavSidebar.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { TagPicker } from "./TagPicker.tsx";
import { TagsPage } from "./TagsPage.tsx";
import { TimerView } from "./TimerView.tsx";
import styles from "./TomatoClock.module.scss";

const DEFAULT_SETTINGS: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
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
  } = useSessionHistory();

  const tagManager = useTagManager();

  const [activePage, setActivePage] = useState<NavPage>("timer");
  const [pendingTagIds, setPendingTagIds] = useState<number[]>([]);

  const handleSessionSaved = useCallback(
    (session: Session) => {
      const assigns = pendingTagIds.map((tagId) => window.electronAPI.tag.assign({ sessionId: session.id, tagId }));
      Promise.all(assigns)
        .then(() => {
          setPendingTagIds([]);
          refresh();
        })
        .catch(() => {
          setPendingTagIds([]);
          refresh();
        });
    },
    [pendingTagIds, refresh],
  );

  const { state, start, pause, resume, reset, setTimerType, setTitle, setRemaining, dismissCompletion, saveError } =
    useTimer(effectiveSettings, handleSessionSaved);

  const handlePendingTagAdd = useCallback((tagId: number) => {
    setPendingTagIds((prev) => (prev.includes(tagId) ? prev : [...prev, tagId]));
  }, []);

  const handlePendingTagRemove = useCallback((tagId: number) => {
    setPendingTagIds((prev) => prev.filter((id) => id !== tagId));
  }, []);

  if (settingsLoading) {
    return (
      <div className={styles.loading}>
        <p className={styles.loadingText}>Loading…</p>
      </div>
    );
  }

  const isTimerActive = state.status === "running" || state.status === "paused";

  return (
    <div className={styles.root}>
      <NavSidebar activePage={activePage} onNavigate={setActivePage} timerStatus={state.status} />

      <div className={styles.main}>
        {activePage === "timer" && (
          <div className={styles.timerPage}>
            <h1 className={styles.timerHeading}>Tomato Clock</h1>
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

            {isTimerActive && (
              <div className={styles.tagSection}>
                <div className={styles.tagSectionLabel}>Session Tags</div>
                <TagPicker
                  allTags={tagManager.tags}
                  selectedTagIds={pendingTagIds}
                  onAdd={handlePendingTagAdd}
                  onRemove={handlePendingTagRemove}
                />
              </div>
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
          />
        )}

        {activePage === "tags" && (
          <TagsPage
            tags={tagManager.tags}
            onCreateTag={tagManager.createTag}
            onUpdateTag={tagManager.updateTag}
            onDeleteTag={tagManager.deleteTag}
          />
        )}

        {activePage === "settings" && <SettingsPage settings={effectiveSettings} onSave={saveSettings} />}
      </div>
    </div>
  );
}
