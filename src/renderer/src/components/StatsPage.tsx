// src/renderer/src/components/StatsPage.tsx
// Statistics charts: By Date, By Tag, By Work Type

import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../shared/types.ts";
import styles from "./StatsPage.module.scss";

type GroupBy = "date" | "tag" | "type";
type DateRange = 7 | 14 | 30;

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m === 0) return "—";
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function getLocalDateStr(d: Date): string {
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  );
}

export function StatsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [dateRange, setDateRange] = useState<DateRange>(7);

  useEffect(() => {
    window.electronAPI.session
      .list({ limit: 5000 })
      .then((result) => setSessions(result.sessions))
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  // Sessions within the selected date range
  const filtered = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dateRange);
    cutoff.setHours(0, 0, 0, 0);
    return sessions.filter((s) => new Date(s.completedAt) >= cutoff);
  }, [sessions, dateRange]);

  // --- By Date (work sessions only) ---
  const dateData = useMemo(() => {
    const days: Array<{ date: string; label: string; seconds: number; }> = [];
    for (let i = dateRange - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = getLocalDateStr(d);
      const label = dateRange <= 7
        ? d.toLocaleDateString(undefined, { weekday: "short" })
        : `${d.getMonth() + 1}/${d.getDate()}`;
      const seconds = filtered
        .filter((s) => getLocalDateStr(new Date(s.completedAt)) === dateStr && s.timerType === "work")
        .reduce((sum, s) => sum + s.actualDurationSeconds, 0);
      days.push({ date: dateStr, label, seconds });
    }
    return days;
  }, [filtered, dateRange]);

  const maxDateSeconds = useMemo(() => Math.max(...dateData.map((d) => d.seconds), 1), [dateData]);

  // --- By Tag (work sessions only) ---
  const tagData = useMemo(() => {
    const map = new Map<string, { name: string; color: string; seconds: number; }>();
    for (const session of filtered) {
      if (session.timerType !== "work") continue;
      if (session.tags.length === 0) {
        const e = map.get("__untagged__") ?? { name: "Untagged", color: "#3b4261", seconds: 0 };
        map.set("__untagged__", { ...e, seconds: e.seconds + session.actualDurationSeconds });
      } else {
        for (const tag of session.tags) {
          const key = String(tag.id);
          const e = map.get(key) ?? { name: tag.name, color: tag.color, seconds: 0 };
          map.set(key, { ...e, seconds: e.seconds + session.actualDurationSeconds });
        }
      }
    }
    const arr = Array.from(map.values()).sort((a, b) => b.seconds - a.seconds);
    const total = arr.reduce((sum, d) => sum + d.seconds, 0);
    return arr.map((d) => ({ ...d, pct: total > 0 ? Math.round((d.seconds / total) * 100) : 0 }));
  }, [filtered]);

  // --- By Work Type ---
  const typeData = useMemo(() => {
    const totals = { work: 0, short_break: 0, long_break: 0 };
    for (const s of filtered) totals[s.timerType] += s.actualDurationSeconds;
    const total = totals.work + totals.short_break + totals.long_break;
    return [
      {
        key: "work",
        label: "Work",
        seconds: totals.work,
        color: "#7aa2f7",
        pct: total > 0 ? Math.round((totals.work / total) * 100) : 0,
      },
      {
        key: "short_break",
        label: "Short Break",
        seconds: totals.short_break,
        color: "#9ece6a",
        pct: total > 0 ? Math.round((totals.short_break / total) * 100) : 0,
      },
      {
        key: "long_break",
        label: "Long Break",
        seconds: totals.long_break,
        color: "#bb9af7",
        pct: total > 0 ? Math.round((totals.long_break / total) * 100) : 0,
      },
    ];
  }, [filtered]);

  const workSeconds = filtered.filter((s) => s.timerType === "work").reduce(
    (sum, s) => sum + s.actualDurationSeconds,
    0,
  );
  const workSessions = filtered.filter((s) => s.timerType === "work").length;
  const totalSeconds = filtered.reduce((sum, s) => sum + s.actualDurationSeconds, 0);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Stats</h1>

      {/* Date range selector */}
      <div className={styles.rangeRow}>
        {([7, 14, 30] as DateRange[]).map((r) => (
          <button
            key={r}
            className={dateRange === r ? styles.rangeActive : styles.range}
            onClick={() => setDateRange(r)}
          >
            {r}d
          </button>
        ))}
      </div>

      {isLoading
        ? <div className={styles.stateMsg}>Loading…</div>
        : filtered.length === 0
        ? <div className={styles.stateMsg}>No sessions in this period.</div>
        : (
          <>
            {/* Summary metrics */}
            <div className={styles.summaryRow}>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Work Time</div>
                <div className={styles.summaryValue}>{formatDuration(workSeconds)}</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Sessions</div>
                <div className={styles.summaryValue}>{workSessions}</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryLabel}>Total Time</div>
                <div className={styles.summaryValue}>{formatDuration(totalSeconds)}</div>
              </div>
            </div>

            {/* Group-by tab selector */}
            <div className={styles.tabRow}>
              {(["date", "tag", "type"] as GroupBy[]).map((g) => (
                <button
                  key={g}
                  className={groupBy === g ? styles.tabActive : styles.tab}
                  onClick={() => setGroupBy(g)}
                >
                  {g === "date" ? "By Date" : g === "tag" ? "By Tag" : "By Type"}
                </button>
              ))}
            </div>

            {/* By Date — vertical bar chart */}
            {groupBy === "date" && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Work Focus by Day</div>
                <div className={styles.barChart}>
                  {dateData.map((d) => (
                    <div key={d.date} className={styles.barCol}>
                      <div className={styles.barDuration}>{d.seconds > 0 ? formatDuration(d.seconds) : ""}</div>
                      <div className={styles.barTrack}>
                        <div
                          className={styles.barFill}
                          style={{
                            height: `${(d.seconds / maxDateSeconds) * 100}%`,
                            background: d.seconds > 0 ? "#7aa2f7" : "transparent",
                          }}
                        />
                      </div>
                      <div className={styles.barLabel}>{d.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* By Tag — horizontal bars */}
            {groupBy === "tag" && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Work Time by Tag</div>
                {tagData.length === 0
                  ? <div className={styles.stateMsg}>No work sessions with tags.</div>
                  : (
                    <div className={styles.hBarList}>
                      {tagData.map((d) => (
                        <div key={d.name} className={styles.hBarRow}>
                          <div className={styles.hBarName}>{d.name}</div>
                          <div className={styles.hBarTrack}>
                            <div className={styles.hBarFill} style={{ width: `${d.pct}%`, background: d.color }} />
                          </div>
                          <div className={styles.hBarMeta}>
                            <span className={styles.hBarPct}>{d.pct}%</span>
                            <span className={styles.hBarDuration}>{formatDuration(d.seconds)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            )}

            {/* By Work Type — horizontal bars */}
            {groupBy === "type" && (
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Time by Work Type</div>
                <div className={styles.hBarList}>
                  {typeData.map((d) => (
                    <div key={d.key} className={styles.hBarRow}>
                      <div className={styles.hBarName}>{d.label}</div>
                      <div className={styles.hBarTrack}>
                        <div className={styles.hBarFill} style={{ width: `${d.pct}%`, background: d.color }} />
                      </div>
                      <div className={styles.hBarMeta}>
                        <span className={styles.hBarPct}>{d.pct}%</span>
                        <span className={styles.hBarDuration}>{formatDuration(d.seconds)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
    </div>
  );
}
