import { useCallback, useState } from "react";
import type { CreateTagInput, Session, Tag, TimerStatus } from "../../../shared/types.ts";
import { useGroupExpand } from "../hooks/useGroupExpand.ts";
import { formatDuration, formatTimerType, timerTypeColor } from "../utils/format.ts";
import type { DateSubGroup } from "../utils/groupSessions.ts";
import { stripHtml } from "../utils/html.ts";
import { DateSubGroupHeader } from "./DateSubGroupHeader.tsx";
import styles from "./HistoryPage.module.scss";
import { IssueBadge } from "./IssueBadge.tsx";
import { IssueGroupHeader } from "./IssueGroupHeader.tsx";
import { TagBadge } from "./TagBadge.tsx";
import { TagPicker } from "./TagPicker.tsx";
import { WorklogConfirmDialog } from "./WorklogConfirmDialog.tsx";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}

interface Props {
  sessions: Session[];
  total: number;
  isLoading: boolean;
  error: string | null;
  allTags: Tag[];
  activeTagFilter: number | undefined;
  onSetTagFilter: (tagId: number | undefined) => void;
  onDeleteSession: (id: string) => void;
  onLoadMore: () => void;
  onAssignTag: (sessionId: string, tagId: number) => Promise<void>;
  onUnassignTag: (sessionId: string, tagId: number) => Promise<void>;
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onLogWork?: (
    sessionId: string,
    issueKey: string,
    overrides?: { startTime: string; endTime: string; description: string; },
  ) => Promise<void>;
  onRefresh?: () => void;
  worklogLoading?: Record<string, boolean>;
  onResumeSession?: (session: Session) => void;
  timerStatus?: TimerStatus;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

interface SessionCardProps {
  session: Session;
  allTags: Tag[];
  onDelete: (id: string) => void;
  onAssign: (sessionId: string, tagId: number) => Promise<void>;
  onUnassign: (sessionId: string, tagId: number) => Promise<void>;
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onLogWork?: (sessionId: string, issueKey: string) => void;
  worklogLoading?: boolean;
  onResumeSession?: (session: Session) => void;
  timerStatus?: TimerStatus;
}

function SessionCard(
  {
    session,
    allTags,
    onDelete,
    onAssign,
    onUnassign,
    onCreateTag,
    onLogWork,
    worklogLoading,
    onResumeSession,
    timerStatus,
  }: SessionCardProps,
) {
  const assignedTagIds = session.tags.map((t) => t.id);

  const typeColor = timerTypeColor(session.timerType);
  const typeLabel = formatTimerType(session.timerType);

  const isJiraLinked = session.issueProvider === "jira" && session.issueId;
  const isEligibleDuration = session.actualDurationSeconds >= 60;
  const showWorklogUi = isJiraLinked && isEligibleDuration;

  const isTimerActive = timerStatus !== undefined && timerStatus !== "idle";

  const handleLogWork = () => {
    if (onLogWork && session.issueId) {
      onLogWork(session.id, session.issueId);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <span
          className={styles.typePill}
          style={{ color: typeColor, backgroundColor: typeColor + "18", border: `1px solid ${typeColor}30` }}
        >
          {typeLabel}
        </span>
        <span className={styles.cardDuration}>{formatDuration(session.actualDurationSeconds)}</span>
        <span className={styles.cardMeta}>
          {formatDate(session.completedAt)} · {formatLocalTime(session.completedAt)}
        </span>
        {showWorklogUi && (
          <>
            {session.worklogStatus === "logged" && (
              <>
                <span className={styles.worklogLogged} aria-label="Work logged to Jira">
                  Logged
                </span>
                <button
                  className={styles.relogBtn}
                  onClick={handleLogWork}
                  disabled={worklogLoading}
                  aria-label={`Re-log to Jira for: ${session.title || "session"}`}
                >
                  {worklogLoading ? "..." : "Re-log"}
                </button>
              </>
            )}
            {session.worklogStatus === "not_logged" && (
              <button
                className={styles.logWorkBtn}
                onClick={handleLogWork}
                disabled={worklogLoading}
                aria-label={`Log work to Jira for: ${session.title || "session"}`}
              >
                {worklogLoading ? "..." : "Log Work"}
              </button>
            )}
            {session.worklogStatus === "failed" && (
              <button
                className={styles.retryBtn}
                onClick={handleLogWork}
                disabled={worklogLoading}
                aria-label={`Retry logging work to Jira for: ${session.title || "session"}`}
              >
                {worklogLoading ? "..." : "Retry"}
              </button>
            )}
          </>
        )}
        {onResumeSession && (
          <button
            style={{
              padding: "2px 8px",
              fontSize: "0.75rem",
              fontWeight: 500,
              borderRadius: "4px",
              border: "1px solid #7aa2f730",
              backgroundColor: "#7aa2f711",
              color: "#7aa2f7",
              cursor: isTimerActive ? "not-allowed" : "pointer",
              opacity: isTimerActive ? 0.4 : 1,
              marginLeft: "4px",
            }}
            disabled={isTimerActive}
            onClick={() => onResumeSession(session)}
            aria-label={`Resume session: ${session.title || "session"}`}
          >
            ▶ Resume
          </button>
        )}
        <button className={styles.cardDelBtn} onClick={() => onDelete(session.id)} aria-label="Delete session">
          ✕
        </button>
      </div>
      {session.title && <div className={styles.cardTitle}>{stripHtml(session.title)}</div>}
      <div className={styles.cardTags}>
        <IssueBadge session={session} />
        {session.tags.map((t) => <TagBadge key={t.id} tag={t} onRemove={(id) => void onUnassign(session.id, id)} />)}
        <TagPicker
          allTags={allTags}
          selectedTagIds={assignedTagIds}
          onAdd={(tagId) => void onAssign(session.id, tagId)}
          onRemove={(tagId) => void onUnassign(session.id, tagId)}
          onCreateTag={onCreateTag}
        />
      </div>
    </div>
  );
}

export function HistoryPage({
  sessions,
  total,
  isLoading,
  error,
  allTags,
  activeTagFilter,
  onSetTagFilter,
  onDeleteSession,
  onLoadMore,
  onAssignTag,
  onUnassignTag,
  onCreateTag,
  onLogWork,
  onRefresh,
  worklogLoading,
  onResumeSession,
  timerStatus,
}: Props) {
  const activeFilterTag = allTags.find((t) => t.id === activeTagFilter);
  const { groupedData, expandedIssueGroups, expandedDateGroups, toggleIssueGroup, toggleDateGroup } = useGroupExpand(
    sessions,
    activeTagFilter,
  );

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [worklogDialogState, setWorklogDialogState] = useState<
    { session: Session | Session[]; issueKey: string; isRelog: boolean; sessionIds: string[]; } | null
  >(null);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleLogWork = useCallback(
    async (
      sessionId: string,
      issueKey: string,
      overrides?: { startTime: string; endTime: string; description: string; },
    ) => {
      if (!onLogWork) return;
      try {
        await onLogWork(sessionId, issueKey, overrides);
        const session = sessions.find((s) => s.id === sessionId);
        const durationMins = session ? Math.round(session.actualDurationSeconds / 60) : 0;
        const toastId = crypto.randomUUID();
        const message = `Logged ${durationMins}m to ${issueKey}`;
        setToasts((prev) => [...prev, { id: toastId, message, type: "success" }]);
        setTimeout(() => dismissToast(toastId), 4000);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : "Failed to log work";
        let userMessage = "Failed to log work to Jira.";
        if (errMessage.includes("authentication") || errMessage.includes("credentials")) {
          userMessage = "Jira authentication failed. Check your credentials.";
        } else if (errMessage.includes("not found") || errMessage.includes("NOT_FOUND")) {
          userMessage = `Issue ${issueKey} not found in Jira.`;
        } else if (errMessage.includes("rate limit") || errMessage.includes("RATE_LIMITED")) {
          userMessage = "Jira rate limit reached. Try again later.";
        } else if (errMessage.includes("reach") || errMessage.includes("NETWORK_ERROR")) {
          userMessage = "Could not reach Jira. Check your connection.";
        } else if (errMessage.includes("already logged") || errMessage.includes("INELIGIBLE")) {
          userMessage = "Worklog already logged for this session.";
        } else if (errMessage.includes("60 seconds") || errMessage.includes("minimum")) {
          userMessage = "Session too short (minimum 60 seconds for Jira).";
        }
        const toastId = crypto.randomUUID();
        setToasts((prev) => [...prev, { id: toastId, message: userMessage, type: "error" }]);
        setTimeout(() => dismissToast(toastId), 4000);
      }
    },
    [onLogWork, sessions, dismissToast],
  );

  // Open dialog for individual session log work
  const handleOpenWorklogDialog = useCallback(
    (sessionId: string, issueKey: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const isRelog = session.worklogStatus === "logged";
      setWorklogDialogState({ session, issueKey, isRelog, sessionIds: [session.id] });
    },
    [sessions],
  );

  // Called when user confirms the worklog dialog (single or bulk)
  const handleWorklogDialogConfirm = useCallback(
    async (params: {
      startTime: string;
      endTime: string;
      description: string;
      selectedSessionIds: string[];
    }) => {
      if (!worklogDialogState) return;
      const { issueKey } = worklogDialogState;
      const selectedIds = params.selectedSessionIds;
      const isBulk = selectedIds.length > 1;
      setWorklogDialogState(null);

      if (isBulk) {
        // Bulk: ONE Jira API call using first selected session as anchor, then mark rest as logged
        try {
          const result = await window.electronAPI.worklog.log({
            sessionId: selectedIds[0]!,
            issueKey,
            startTimeOverride: params.startTime,
            endTimeOverride: params.endTime,
            descriptionOverride: params.description,
          });
          // Mark remaining sessions as logged (no extra API calls)
          if (selectedIds.length > 1) {
            await window.electronAPI.worklog.markLogged({
              sessionIds: selectedIds.slice(1),
              worklogId: result.worklogId,
            });
          }
          const durationMins = Math.round(
            (new Date(params.endTime).getTime() - new Date(params.startTime).getTime()) / 60000,
          );
          const toastId = crypto.randomUUID();
          const message = `Logged ${durationMins}m to ${issueKey} (${selectedIds.length} sessions combined)`;
          setToasts((prev) => [...prev, { id: toastId, message, type: "success" }]);
          setTimeout(() => dismissToast(toastId), 4000);
          onRefresh?.();
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : "Failed to log work";
          const toastId = crypto.randomUUID();
          setToasts((prev) => [...prev, { id: toastId, message: errMessage, type: "error" }]);
          setTimeout(() => dismissToast(toastId), 4000);
        }
      } else {
        // Single session
        await handleLogWork(selectedIds[0]!, issueKey, params);
      }
    },
    [worklogDialogState, handleLogWork, dismissToast, onRefresh],
  );

  // Open combined worklog dialog for a date sub-group
  const handleLogDate = useCallback(
    (subGroup: DateSubGroup) => {
      const eligible = subGroup.sessions.filter(
        (s) => s.issueProvider === "jira" && s.issueId && s.actualDurationSeconds >= 60,
      );
      if (eligible.length === 0) return;
      const unloggedCount = eligible.filter((s) => s.worklogStatus !== "logged").length;
      const isRelog = unloggedCount === 0;
      const issueKey = eligible[0]!.issueId!;
      setWorklogDialogState({
        session: eligible.length === 1 ? eligible[0]! : eligible,
        issueKey,
        isRelog,
        sessionIds: eligible.map((s) => s.id),
      });
    },
    [],
  );

  return (
    <div className={styles.page} style={{ position: "relative" }}>
      <h1 className={styles.heading}>History</h1>

      {allTags.length > 0 && (
        <div className={styles.filterRow}>
          <button
            className={activeTagFilter === undefined ? styles.chipActive : styles.chip}
            onClick={() => onSetTagFilter(undefined)}
          >
            All
          </button>
          {allTags.map((t) => (
            <button
              key={t.id}
              className={activeTagFilter === t.id ? styles.chipActive : styles.chip}
              onClick={() => onSetTagFilter(activeTagFilter === t.id ? undefined : t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {activeFilterTag && (
        <div className={styles.filterBy}>
          <span className={styles.filterByLabel}>Filtered by</span>
          <TagBadge tag={activeFilterTag} onRemove={() => onSetTagFilter(undefined)} />
        </div>
      )}

      {isLoading && <div className={styles.stateMsg}>Loading…</div>}
      {error && <div className={styles.errorMsg}>{error}</div>}
      {!isLoading && sessions.length === 0 && <div className={styles.emptyMsg}>No sessions yet.</div>}

      <div className={styles.list}>
        {/* Issue groups */}
        {groupedData.issueGroups.map((group) => {
          const issueKey = group.issueKey.key;
          const isIssueExpanded = expandedIssueGroups.has(issueKey);
          return (
            <IssueGroupHeader
              key={issueKey}
              group={group}
              isExpanded={isIssueExpanded}
              onToggle={() => toggleIssueGroup(issueKey)}
              compact={false}
            >
              {group.dateSubGroups.map((subGroup) => {
                const dateGroupKey = `${issueKey}::${subGroup.dateKey}`;
                const isDateExpanded = expandedDateGroups.has(dateGroupKey);
                return (
                  <DateSubGroupHeader
                    key={subGroup.dateKey}
                    subGroup={subGroup}
                    isExpanded={isDateExpanded}
                    onToggle={() => toggleDateGroup(dateGroupKey)}
                    compact={false}
                    onLogDate={onLogWork ? handleLogDate : undefined}
                  >
                    {subGroup.sessions.map((session) => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        allTags={allTags}
                        onDelete={onDeleteSession}
                        onAssign={onAssignTag}
                        onUnassign={onUnassignTag}
                        onCreateTag={onCreateTag}
                        onLogWork={onLogWork ? handleOpenWorklogDialog : undefined}
                        worklogLoading={worklogLoading?.[session.id] ?? false}
                        onResumeSession={onResumeSession}
                        timerStatus={timerStatus}
                      />
                    ))}
                  </DateSubGroupHeader>
                );
              })}
            </IssueGroupHeader>
          );
        })}

        {/* Ungrouped sessions (no linked issue) */}
        {groupedData.ungroupedSessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            allTags={allTags}
            onDelete={onDeleteSession}
            onAssign={onAssignTag}
            onUnassign={onUnassignTag}
            onCreateTag={onCreateTag}
            onLogWork={onLogWork ? handleOpenWorklogDialog : undefined}
            worklogLoading={worklogLoading?.[session.id] ?? false}
            onResumeSession={onResumeSession}
            timerStatus={timerStatus}
          />
        ))}
      </div>

      {sessions.length < total && (
        <button className={styles.loadMoreBtn} onClick={onLoadMore}>
          Load more ({total - sessions.length} remaining)
        </button>
      )}

      {worklogDialogState && (
        <WorklogConfirmDialog
          session={worklogDialogState.session}
          issueKey={worklogDialogState.issueKey}
          isRelog={worklogDialogState.isRelog}
          onConfirm={(params) => void handleWorklogDialogConfirm(params)}
          onCancel={() => setWorklogDialogState(null)}
        />
      )}

      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            zIndex: 1000,
          }}
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              style={{
                padding: "10px 16px",
                borderRadius: "6px",
                fontSize: "0.875rem",
                fontWeight: 500,
                color: toast.type === "success" ? "#9ece6a" : "#f7768e",
                backgroundColor: toast.type === "success" ? "#9ece6a11" : "#f7768e11",
                border: `1px solid ${toast.type === "success" ? "#9ece6a44" : "#f7768e44"}`,
                cursor: "pointer",
                maxWidth: "320px",
              }}
              onClick={() => dismissToast(toast.id)}
              role="alert"
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
