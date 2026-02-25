// src/renderer/src/components/NewSessionNotification.tsx
// Inline notification for newly detected Claude Code sessions with 30s auto-dismiss

import { useEffect } from "react";
import type { ClaudeCodeSessionPreview } from "../../../shared/types.ts";

const AUTO_DISMISS_MS = 30_000;

interface NewSessionNotificationProps {
  session: ClaudeCodeSessionPreview;
  onAdd: (session: ClaudeCodeSessionPreview) => void;
  onDismiss: () => void;
}

export function NewSessionNotification({ session, onAdd, onDismiss }: NewSessionNotificationProps) {
  // Auto-dismiss after 30 seconds
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [onDismiss]);

  const containerStyle: React.CSSProperties = {
    marginTop: 6,
    padding: "7px 10px",
    background: "rgba(224, 175, 104, 0.08)",
    border: "1px solid rgba(224, 175, 104, 0.25)",
    borderRadius: 6,
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
  };

  const textStyle: React.CSSProperties = {
    flex: 1,
    color: "#e0af68",
  };

  const addBtnStyle: React.CSSProperties = {
    padding: "2px 10px",
    borderRadius: 4,
    border: "1px solid rgba(224, 175, 104, 0.4)",
    background: "rgba(224, 175, 104, 0.12)",
    color: "#e0af68",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 600,
    flexShrink: 0,
  };

  const dismissBtnStyle: React.CSSProperties = {
    padding: "2px 6px",
    borderRadius: 4,
    border: "none",
    background: "transparent",
    color: "#565f89",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    flexShrink: 0,
    lineHeight: 1,
  };

  return (
    <div style={containerStyle}>
      <span style={textStyle}>New CC session detected</span>
      <button style={addBtnStyle} onClick={() => onAdd(session)}>
        Add
      </button>
      <button style={dismissBtnStyle} onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}
