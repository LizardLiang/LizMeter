// src/renderer/src/components/ClaudeCodeStats.tsx
// Compact live Claude Code stats widget shown in timer view during active tracking

import { useEffect, useRef, useState } from "react";
import type { ClaudeCodeLiveStats, ClaudeCodeSessionPreview } from "../../../shared/types.ts";
import { NewSessionNotification } from "./NewSessionNotification.tsx";

interface ClaudeCodeStatsProps {
  liveStats: ClaudeCodeLiveStats | null;
  isTracking: boolean;
  idleThresholdMinutes?: number;
  // v1.2: "Manage Sessions" button callback
  onManageSessions?: () => void;
  // v1.2: new session notification
  newSession?: ClaudeCodeSessionPreview | null;
  onAddNewSession?: () => void;
  onDismissNewSession?: () => void;
}

function formatIdleDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than 1 min";
  if (minutes === 1) return "1 min";
  return `${minutes} min`;
}

export function ClaudeCodeStats({
  liveStats,
  isTracking,
  idleThresholdMinutes = 5,
  onManageSessions,
  newSession,
  onAddNewSession,
  onDismissNewSession,
}: ClaudeCodeStatsProps) {
  const [idleDurationMs, setIdleDurationMs] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Update idle duration every 10 seconds
  useEffect(() => {
    function updateIdleDuration() {
      if (!liveStats?.lastActivityTimestamp) {
        setIdleDurationMs(null);
        return;
      }
      const ms = Date.now() - new Date(liveStats.lastActivityTimestamp).getTime();
      setIdleDurationMs(ms);
    }

    updateIdleDuration();

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(updateIdleDuration, 10_000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [liveStats?.lastActivityTimestamp]);

  if (!isTracking) return null;

  const containerStyle: React.CSSProperties = {
    marginTop: 12,
    padding: "10px 14px",
    background: "rgba(122, 162, 247, 0.06)",
    borderRadius: 8,
    border: "1px solid rgba(122, 162, 247, 0.18)",
    fontSize: 13,
    color: "#a9b1d6",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontWeight: 600,
    color: "#7aa2f7",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  const headerRightStyle: React.CSSProperties = {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 6,
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  };

  const labelStyle: React.CSSProperties = {
    color: "#565f89",
    fontSize: 12,
  };

  const valueStyle: React.CSSProperties = {
    color: "#c0caf5",
    fontVariantNumeric: "tabular-nums",
  };

  const errorStyle: React.CSSProperties = {
    color: "#f7768e",
    fontSize: 12,
  };

  const manageBtnStyle: React.CSSProperties = {
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid rgba(122, 162, 247, 0.3)",
    background: "transparent",
    color: "#7aa2f7",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
    textTransform: "none",
    fontWeight: 400,
    letterSpacing: 0,
  };

  const idleThresholdMs = idleThresholdMinutes * 60_000;
  const isCurrentlyIdle = idleDurationMs !== null && idleDurationMs > idleThresholdMs;
  const statusStyle: React.CSSProperties = {
    color: isCurrentlyIdle ? "#e0af68" : "#9ece6a",
    fontWeight: 600,
    fontSize: 12,
  };

  if (liveStats?.error) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>Claude Code</div>
        <div style={errorStyle}>{liveStats.error}</div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span>Claude Code</span>
        {liveStats && (
          <span style={statusStyle}>
            {isCurrentlyIdle && idleDurationMs !== null
              ? `Idle for ${formatIdleDuration(idleDurationMs)}`
              : "Active"}
          </span>
        )}
        <div style={headerRightStyle}>
          {onManageSessions && (
            <button style={manageBtnStyle} onClick={onManageSessions}>
              Manage Sessions
            </button>
          )}
        </div>
      </div>

      {liveStats
        ? (
          <>
            <div style={rowStyle}>
              <span style={labelStyle}>Sessions detected</span>
              <span style={valueStyle}>{liveStats.activeSessions}</span>
            </div>
            <div style={rowStyle}>
              <span style={labelStyle}>Files edited</span>
              <span style={valueStyle}>{liveStats.totalFilesEdited}</span>
            </div>
            {liveStats.idleSessions > 0 && (
              <div style={rowStyle}>
                <span style={labelStyle}>Idle sessions</span>
                <span style={{ ...valueStyle, color: "#e0af68" }}>{liveStats.idleSessions}</span>
              </div>
            )}
          </>
        )
        : <div style={labelStyle}>Waiting for Claude Code activity…</div>}

      {newSession && onAddNewSession && onDismissNewSession && (
        <NewSessionNotification
          session={newSession}
          onAdd={() => onAddNewSession()}
          onDismiss={onDismissNewSession}
        />
      )}
    </div>
  );
}
