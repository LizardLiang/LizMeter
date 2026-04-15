// src/renderer/src/components/WorklogConfirmDialog.tsx
// Confirmation dialog for logging work to Jira, allowing time/description adjustment

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "../../../shared/types.ts";
import { summarizeMergedWorklogSessions } from "../../../shared/worklog.ts";
import styles from "./WorklogConfirmDialog.module.scss";

interface WorklogConfirmDialogProps {
  /** Single session (individual log) or array of sessions (bulk date-group log) */
  session: Session | Session[];
  issueKey: string;
  isRelog?: boolean;
  onConfirm: (params: {
    startTime: string;
    endTime: string;
    description: string;
    selectedSessionIds: string[];
  }) => void;
  onCancel: () => void;
}

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function WorklogConfirmDialog({ session, issueKey, isRelog, onConfirm, onCancel }: WorklogConfirmDialogProps) {
  const allSessions = Array.isArray(session) ? session : [session];
  const isBulk = allSessions.length > 1;

  // Track selected sessions (bulk mode only)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(allSessions.map((s) => s.id)));

  const selectedSessions = useMemo(
    () => allSessions.filter((s) => selectedIds.has(s.id)),
    [allSessions, selectedIds],
  );
  const mergedSummary = useMemo(() => summarizeMergedWorklogSessions(selectedSessions), [selectedSessions]);
  const uploadableSessions = useMemo(
    () => selectedSessions.filter((s) => mergedSummary.uploadableSessionIds.includes(s.id)),
    [mergedSummary.uploadableSessionIds, selectedSessions],
  );

  // Compute default times from selected sessions
  const computedDefaults = useMemo(() => {
    if (uploadableSessions.length === 0 || !mergedSummary.startedAt || !mergedSummary.endedAt) {
      return { start: new Date().toISOString(), end: new Date().toISOString(), desc: "" };
    }
    if (uploadableSessions.length === 1) {
      const s = uploadableSessions[0]!;
      return {
        start: new Date(new Date(s.completedAt).getTime() - s.actualDurationSeconds * 1000).toISOString(),
        end: s.completedAt,
        desc: s.title || "",
      };
    }
    return {
      start: mergedSummary.startedAt,
      end: mergedSummary.endedAt,
      desc: uploadableSessions.map((s) => s.title || "Work session").join("\n"),
    };
  }, [mergedSummary.endedAt, mergedSummary.startedAt, uploadableSessions]);

  const [startValue, setStartValue] = useState(() => toDatetimeLocal(computedDefaults.start));
  const [endValue, setEndValue] = useState(() => toDatetimeLocal(computedDefaults.end));
  const [description, setDescription] = useState(computedDefaults.desc);

  // Update times/description when selection changes (bulk mode)
  const [lastSelectionKey, setLastSelectionKey] = useState(() => [...selectedIds].sort().join(","));
  const currentSelectionKey = [...selectedIds].sort().join(",");
  if (currentSelectionKey !== lastSelectionKey) {
    setLastSelectionKey(currentSelectionKey);
    setStartValue(toDatetimeLocal(computedDefaults.start));
    setEndValue(toDatetimeLocal(computedDefaults.end));
    setDescription(computedDefaults.desc);
  }

  const toggleSession = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === allSessions.length) {
        return new Set<string>();
      }
      return new Set(allSessions.map((s) => s.id));
    });
  }, [allSessions]);

  // Recalculate duration whenever start or end changes
  const { durationSeconds, includedBreakSeconds, validationError } = useMemo(() => {
    if (uploadableSessions.length === 0) {
      return {
        durationSeconds: 0,
        includedBreakSeconds: 0,
        validationError: "Select at least one work or stopwatch session.",
      };
    }
    if (!startValue || !endValue) {
      return { durationSeconds: 0, includedBreakSeconds: 0, validationError: "Start and end time are required." };
    }
    const startMs = new Date(startValue).getTime();
    const endMs = new Date(endValue).getTime();
    if (isNaN(startMs) || isNaN(endMs)) {
      return { durationSeconds: 0, includedBreakSeconds: 0, validationError: "Invalid date/time." };
    }
    if (endMs <= startMs) {
      return {
        durationSeconds: mergedSummary.totalDurationSeconds,
        includedBreakSeconds: mergedSummary.totalBreakSeconds,
        validationError: "End time must be after start time.",
      };
    }
    if (mergedSummary.totalDurationSeconds < 60) {
      return {
        durationSeconds: mergedSummary.totalDurationSeconds,
        includedBreakSeconds: mergedSummary.totalBreakSeconds,
        validationError: "Merged worklog duration must be at least 60 seconds.",
      };
    }
    return {
      durationSeconds: mergedSummary.totalDurationSeconds,
      includedBreakSeconds: mergedSummary.totalBreakSeconds,
      validationError: null,
    };
  }, [
    endValue,
    mergedSummary.totalBreakSeconds,
    mergedSummary.totalDurationSeconds,
    startValue,
    uploadableSessions.length,
  ]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleConfirm = () => {
    if (validationError) return;
    onConfirm({
      startTime: fromDatetimeLocal(startValue),
      endTime: fromDatetimeLocal(endValue),
      description,
      selectedSessionIds: [...selectedIds],
    });
  };

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>
            {isRelog ? "Re-log" : "Log"} Work to {issueKey}
            {isBulk ? ` (${selectedIds.size}/${allSessions.length} sessions)` : ""}
          </h3>
        </div>

        <div className={styles.body}>
          {isRelog && (
            <div className={styles.warningBanner}>
              {isBulk
                ? "Some sessions have already been logged. Confirming will create duplicate worklog entries for those."
                : "This session has already been logged to Jira. Confirming will create a duplicate worklog entry."}
            </div>
          )}

          {isBulk && (
            <div className={styles.sessionList}>
              <div className={styles.sessionListHeader}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={selectedIds.size === allSessions.length}
                    onChange={toggleAll}
                    className={styles.checkbox}
                  />
                  <span className={styles.label} style={{ textTransform: "none" }}>Select all</span>
                </label>
              </div>
              {allSessions.map((s) => (
                <label key={s.id} className={styles.sessionRow}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggleSession(s.id)}
                    className={styles.checkbox}
                  />
                  <span className={styles.sessionTitle}>{s.title || "(no title)"}</span>
                  <span className={styles.sessionMeta}>
                    {formatDuration(s.actualDurationSeconds)} · {formatLocalTime(s.completedAt)}
                  </span>
                  {!mergedSummary.uploadableSessionIds.includes(s.id) && (
                    <span className={styles.sessionLogged}>Break</span>
                  )}
                  {s.worklogStatus === "logged" && <span className={styles.sessionLogged}>Logged</span>}
                </label>
              ))}
            </div>
          )}

          {isBulk && (
            <div className={styles.durationDisplay}>
              Uploadable sessions: {uploadableSessions.length} · Included break time:{" "}
              {formatDuration(includedBreakSeconds)}
            </div>
          )}

          <div className={styles.timeRow}>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Start Time</label>
              <input
                type="datetime-local"
                className={`${styles.input}${validationError ? ` ${styles.inputError}` : ""}`}
                value={startValue}
                onChange={(e) => setStartValue(e.target.value)}
              />
            </div>
            <div className={styles.fieldGroup}>
              <label className={styles.label}>End Time</label>
              <input
                type="datetime-local"
                className={`${styles.input}${validationError ? ` ${styles.inputError}` : ""}`}
                value={endValue}
                onChange={(e) => setEndValue(e.target.value)}
              />
            </div>
          </div>

          {validationError
            ? <span className={styles.errorMsg}>{validationError}</span>
            : (
              <span className={styles.durationDisplay}>
                Uploaded work time: {formatDuration(durationSeconds)}
              </span>
            )}

          <div className={styles.fieldGroup}>
            <label className={styles.label}>Description</label>
            {isBulk
              ? (
                <textarea
                  className={styles.textarea}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Work session"
                  rows={3}
                />
              )
              : (
                <input
                  type="text"
                  className={styles.input}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Work session"
                />
              )}
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={styles.confirmBtn}
            onClick={handleConfirm}
            disabled={!!validationError}
          >
            {isRelog ? "Re-log Work" : "Log Work"}
          </button>
        </div>
      </div>
    </div>
  );
}
