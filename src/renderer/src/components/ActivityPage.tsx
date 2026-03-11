// src/renderer/src/components/ActivityPage.tsx
// Activity page: browse Neovim file edit events grouped by project, by date

import { useMemo, useState } from "react";
import { useNvimActivity } from "../hooks/useNvimActivity.ts";
import styles from "./ActivityPage.module.scss";

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

interface ProjectGroupProps {
  project: string;
  activities: Array<{ id: number; file: string; recordedAt: string; }>;
}

function ProjectGroup({ project, activities }: ProjectGroupProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={styles.projectGroup}>
      <button
        className={styles.projectHeader}
        onClick={() => setCollapsed((prev) => !prev)}
        type="button"
      >
        <span
          className={styles.chevron}
          style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
        <span className={styles.projectName}>{project}</span>
        <span className={styles.projectCount}>{activities.length}</span>
      </button>
      {!collapsed && (
        <div className={styles.fileList}>
          {activities.map((a) => (
            <div key={a.id} className={styles.fileRow}>
              <span className={styles.fileName} title={a.file}>{a.file}</span>
              <span className={styles.fileTime}>{formatTime(a.recordedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActivityPage() {
  const {
    date,
    dateString,
    groups,
    totalCount,
    isLoading,
    error,
    goToPreviousDay,
    goToNextDay,
    goToToday,
  } = useNvimActivity();

  const isToday = useMemo(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${
      String(now.getDate()).padStart(2, "0")
    }`;
    return dateString === today;
  }, [dateString]);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Activity</h1>

      <div className={styles.dateNav}>
        <button className={styles.navBtn} onClick={goToPreviousDay} aria-label="Previous day" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className={styles.dateDisplay}>
          <span className={styles.dateText}>{formatDisplayDate(date)}</span>
          {!isToday && (
            <button className={styles.todayBtn} onClick={goToToday} type="button">
              Today
            </button>
          )}
        </div>
        <button className={styles.navBtn} onClick={goToNextDay} aria-label="Next day" type="button">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {isLoading && (
        <div className={styles.empty}>
          <span className={styles.emptyText}>Loading...</span>
        </div>
      )}

      {error && (
        <div className={styles.empty}>
          <span className={styles.emptyText}>{error}</span>
        </div>
      )}

      {!isLoading && !error && totalCount === 0 && (
        <div className={styles.empty}>
          <svg
            className={styles.emptyIcon}
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className={styles.emptyText}>No activity recorded for this day</span>
        </div>
      )}

      {!isLoading && !error && totalCount > 0 && (
        <div className={styles.groupList}>
          {groups.map((group) => (
            <ProjectGroup
              key={group.project}
              project={group.project}
              activities={group.activities}
            />
          ))}
        </div>
      )}
    </div>
  );
}
