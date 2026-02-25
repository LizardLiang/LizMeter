// src/renderer/src/components/ClaudeSessionSelect.tsx
// Dropdown for selecting a Claude Code session to link with the stopwatch

import { useCallback, useEffect, useState } from "react";
import type { ClaudeCodeSessionPreviewWithProject } from "../../../shared/types.ts";

function formatRelativeTime(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes === 1) return "1m ago";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours === 1) return "1h ago";
  return `${diffHours}h ago`;
}

function lastSegment(displayPath: string): string {
  const parts = displayPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : displayPath;
}

export interface SelectedClaudeSession {
  ccSessionUuid: string;
  projectDirName: string;
}

interface ClaudeSessionSelectProps {
  selected: SelectedClaudeSession | null;
  onSelect: (session: SelectedClaudeSession | null) => void;
  disabled?: boolean;
}

export function ClaudeSessionSelect({ selected, onSelect, disabled }: ClaudeSessionSelectProps) {
  const [sessions, setSessions] = useState<ClaudeCodeSessionPreviewWithProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.claudeTracker.scanAll();
      setSessions(result.sessions);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on first open
  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  const handleSelect = useCallback(
    (session: ClaudeCodeSessionPreviewWithProject) => {
      onSelect({
        ccSessionUuid: session.ccSessionUuid,
        projectDirName: session.projectDirName,
      });
      setOpen(false);
    },
    [onSelect],
  );

  const handleClear = useCallback(() => {
    onSelect(null);
    setOpen(false);
  }, [onSelect]);

  const containerStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
  };

  const triggerStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    border: "1px solid rgba(122, 162, 247, 0.25)",
    borderRadius: 6,
    background: "rgba(26, 27, 38, 0.8)",
    color: selected ? "#c0caf5" : "#565f89",
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontFamily: "inherit",
    textAlign: "left",
  };

  const dropdownStyle: React.CSSProperties = {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    marginTop: 4,
    maxHeight: 280,
    overflowY: "auto",
    background: "#1a1b26",
    border: "1px solid rgba(122, 162, 247, 0.3)",
    borderRadius: 8,
    zIndex: 50,
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: "8px 12px",
    cursor: "pointer",
    borderBottom: "1px solid rgba(86, 95, 137, 0.15)",
    transition: "background 0.1s",
  };

  const selectedSession = selected
    ? sessions.find((s) => s.ccSessionUuid === selected.ccSessionUuid)
    : null;

  const displayText = selectedSession
    ? `${selectedSession.ccSessionUuid.substring(0, 8)} — ${
      selectedSession.firstUserMessage || lastSegment(selectedSession.projectDisplayPath)
    }`
    : selected
    ? `${selected.ccSessionUuid.substring(0, 8)}`
    : "Link Claude Code session…";

  return (
    <div style={containerStyle}>
      <button
        type="button"
        style={triggerStyle}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {displayText}
        </span>
        <span style={{ color: "#565f89", fontSize: 10, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={dropdownStyle}>
          {loading && (
            <div style={{ padding: "12px", color: "#565f89", fontSize: 12, textAlign: "center" }}>
              Scanning…
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div style={{ padding: "12px", color: "#565f89", fontSize: 12, textAlign: "center" }}>
              No active Claude Code sessions
            </div>
          )}

          {!loading && selected && (
            <div
              style={{ ...rowStyle, color: "#f7768e", fontSize: 12, flexDirection: "row" }}
              onClick={handleClear}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "rgba(247, 118, 142, 0.08)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              Clear selection
            </div>
          )}

          {!loading && sessions.map((session) => {
            const isSelected = selected?.ccSessionUuid === session.ccSessionUuid;
            return (
              <div
                key={session.ccSessionUuid}
                style={{
                  ...rowStyle,
                  background: isSelected ? "rgba(122, 162, 247, 0.1)" : "transparent",
                }}
                onClick={() => handleSelect(session)}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "rgba(122, 162, 247, 0.08)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = isSelected
                    ? "rgba(122, 162, 247, 0.1)"
                    : "transparent";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "monospace", color: "#7aa2f7", fontSize: 12, fontWeight: 600 }}>
                    {session.ccSessionUuid.substring(0, 8)}
                  </span>
                  <span style={{ color: "#565f89", fontSize: 11 }}>
                    {formatRelativeTime(session.lastActivityAt)}
                  </span>
                  <span style={{ color: "#565f89", fontSize: 11, marginLeft: "auto" }}>
                    {lastSegment(session.projectDisplayPath)}
                  </span>
                </div>
                {session.firstUserMessage && (
                  <div
                    style={{
                      color: "#a9b1d6",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {session.firstUserMessage}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
