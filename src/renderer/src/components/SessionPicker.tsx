// src/renderer/src/components/SessionPicker.tsx
// Inline collapsible session picker panel for selecting Claude Code sessions to track

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeCodeSessionPreview } from "../../../shared/types.ts";

export type SessionPickerState = "loading" | "open" | "collapsed" | "hidden";

interface SessionPickerProps {
  sessions: ClaudeCodeSessionPreview[];
  pickerState: SessionPickerState;
  // UUIDs already being tracked (pre-checked when re-opened mid-run)
  trackedUuids?: string[];
  // Called with selected UUIDs when user confirms
  onConfirm: (selectedUuids: string[]) => void;
  // Called when user clicks Skip
  onSkip: () => void;
  // Called when user collapses/expands
  onToggleCollapse: () => void;
}

function formatRelativeTime(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes === 1) return "1 min ago";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return "1 hr ago";
  if (diffHours < 24) return `${diffHours} hr ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function SessionPicker({
  sessions,
  pickerState,
  trackedUuids = [],
  onConfirm,
  onSkip,
  onToggleCollapse,
}: SessionPickerProps) {
  // initialTrackedUuids is snapshotted at mount time (via key-based remount from parent)
  const [selectedUuids, setSelectedUuids] = useState<Set<string>>(new Set(trackedUuids));
  const [, forceUpdate] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Update relative times every 10 seconds
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      forceUpdate((n) => n + 1);
    }, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleToggle = useCallback((uuid: string) => {
    setSelectedUuids((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(Array.from(selectedUuids));
  }, [selectedUuids, onConfirm]);

  if (pickerState === "hidden") return null;

  const containerStyle: React.CSSProperties = {
    marginTop: 12,
    borderRadius: 8,
    border: "1px solid rgba(122, 162, 247, 0.25)",
    background: "rgba(26, 27, 38, 0.95)",
    fontSize: 13,
    color: "#a9b1d6",
    overflow: "hidden",
  };

  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "9px 14px",
    borderBottom: pickerState === "open" ? "1px solid rgba(122, 162, 247, 0.12)" : "none",
    background: "rgba(122, 162, 247, 0.06)",
    cursor: "pointer",
    userSelect: "none",
  };

  const headerTitleStyle: React.CSSProperties = {
    fontWeight: 600,
    color: "#7aa2f7",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };

  const collapseToggleStyle: React.CSSProperties = {
    color: "#565f89",
    fontSize: 11,
    display: "flex",
    alignItems: "center",
    gap: 4,
  };

  // Collapsed state: just show header with tracked count
  if (pickerState === "collapsed") {
    return (
      <div style={containerStyle}>
        <div style={headerStyle} onClick={onToggleCollapse}>
          <span style={headerTitleStyle}>Claude Code Sessions</span>
          <span style={collapseToggleStyle}>
            {trackedUuids.length > 0 ? `${trackedUuids.length} tracked` : "No sessions tracked"}{" "}
            <span style={{ fontSize: 10 }}>▼</span>
          </span>
        </div>
      </div>
    );
  }

  // Loading state
  if (pickerState === "loading") {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <span style={headerTitleStyle}>Claude Code Sessions</span>
        </div>
        <div
          style={{
            padding: "14px",
            color: "#565f89",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          Scanning for Claude Code sessions…
        </div>
      </div>
    );
  }

  // Open state
  const sessionListStyle: React.CSSProperties = {
    maxHeight: 280,
    overflowY: "auto",
    padding: "6px 0",
  };

  const sessionRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 14px",
    cursor: "pointer",
    transition: "background 0.1s",
  };

  const footerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "9px 14px",
    borderTop: "1px solid rgba(122, 162, 247, 0.12)",
  };

  const skipBtnStyle: React.CSSProperties = {
    padding: "5px 14px",
    borderRadius: 5,
    border: "1px solid rgba(122, 162, 247, 0.25)",
    background: "transparent",
    color: "#7aa2f7",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  };

  const confirmBtnStyle: React.CSSProperties = {
    padding: "5px 14px",
    borderRadius: 5,
    border: "1px solid rgba(122, 162, 247, 0.4)",
    background: selectedUuids.size > 0 ? "rgba(122, 162, 247, 0.15)" : "rgba(86, 95, 137, 0.1)",
    color: selectedUuids.size > 0 ? "#7aa2f7" : "#565f89",
    fontSize: 12,
    cursor: selectedUuids.size > 0 ? "pointer" : "not-allowed",
    fontFamily: "inherit",
    fontWeight: 600,
  };

  const uuidStyle: React.CSSProperties = {
    fontFamily: "monospace",
    color: "#565f89",
    fontSize: 11,
    minWidth: 68,
  };

  const timeStyle: React.CSSProperties = {
    color: "#565f89",
    fontSize: 11,
    minWidth: 64,
  };

  const previewStyle: React.CSSProperties = {
    color: "#a9b1d6",
    fontSize: 12,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };

  const noPreviewStyle: React.CSSProperties = {
    ...previewStyle,
    color: "#565f89",
    fontStyle: "italic",
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle} onClick={onToggleCollapse}>
        <span style={headerTitleStyle}>Claude Code Sessions</span>
        <span style={collapseToggleStyle}>
          Collapse <span style={{ fontSize: 10 }}>▲</span>
        </span>
      </div>

      {sessions.length === 0
        ? (
          <div
            style={{
              padding: "14px",
              color: "#565f89",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            No active sessions found
          </div>
        )
        : (
          <div style={sessionListStyle}>
            {sessions.map((session) => {
              const isSelected = selectedUuids.has(session.ccSessionUuid);
              return (
                <div
                  key={session.ccSessionUuid}
                  style={{
                    ...sessionRowStyle,
                    background: isSelected ? "rgba(122, 162, 247, 0.08)" : "transparent",
                  }}
                  onClick={() => handleToggle(session.ccSessionUuid)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => handleToggle(session.ccSessionUuid)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ accentColor: "#7aa2f7", cursor: "pointer" }}
                  />
                  <span style={uuidStyle}>{session.ccSessionUuid.substring(0, 8)}</span>
                  <span style={timeStyle}>{formatRelativeTime(session.lastActivityAt)}</span>
                  {session.firstUserMessage
                    ? <span style={previewStyle}>{session.firstUserMessage}</span>
                    : <span style={noPreviewStyle}>(no preview available)</span>}
                </div>
              );
            })}
          </div>
        )}

      <div style={footerStyle}>
        <button style={skipBtnStyle} onClick={onSkip}>
          Skip
        </button>
        <button
          style={confirmBtnStyle}
          onClick={handleConfirm}
          disabled={selectedUuids.size === 0}
        >
          Confirm{selectedUuids.size > 0 ? ` (${selectedUuids.size})` : ""}
        </button>
      </div>
    </div>
  );
}
