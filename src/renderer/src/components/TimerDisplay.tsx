// src/renderer/src/components/TimerDisplay.tsx
// Large MM:SS countdown display, editable when idle

import { useEffect, useRef, useState } from "react";
import type { TimerStatus } from "../../../shared/types.ts";

interface TimerDisplayProps {
  remainingSeconds: number;
  status: TimerStatus;
  onRemainingChange?: (seconds: number) => void;
}

export function TimerDisplay({ remainingSeconds, status, onRemainingChange }: TimerDisplayProps) {
  const [editing, setEditing] = useState(false);
  const [editMinutes, setEditMinutes] = useState("");
  const [editSeconds, setEditSeconds] = useState("");
  const minutesRef = useRef<HTMLInputElement>(null);
  const secondsRef = useRef<HTMLInputElement>(null);

  const canEdit = status === "idle" && onRemainingChange != null;
  const isEditing = editing && status === "idle";

  const mins = Math.floor(Math.max(0, remainingSeconds) / 60);
  const secs = Math.max(0, remainingSeconds) % 60;
  const displayMinutes = String(mins).padStart(2, "0");
  const displaySeconds = String(secs).padStart(2, "0");

  const fontStyles: React.CSSProperties = {
    fontSize: "5rem",
    fontWeight: "bold",
    fontFamily: "'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace",
    letterSpacing: "0.05em",
    lineHeight: 1,
  };

  const containerStyle: React.CSSProperties = {
    textAlign: "center",
    padding: "20px 0",
  };

  const displayColor = status === "completed" ? "#9ece6a" : status === "paused" ? "#e0af68" : "#c0caf5";

  const inputStyle: React.CSSProperties = {
    font: "inherit",
    letterSpacing: "inherit",
    lineHeight: "inherit",
    color: "inherit",
    background: "transparent",
    border: "none",
    outline: "none",
    textAlign: "center",
    padding: 0,
    width: "2.5ch",
    cursor: "inherit",
    caretColor: isEditing ? "auto" : "transparent",
  };

  const editingBorder: React.CSSProperties = isEditing
    ? { borderBottom: "2px solid #7aa2f7" }
    : {};

  const hintStyle: React.CSSProperties = {
    marginTop: "4px",
    fontSize: "0.75rem",
    color: "#565f89",
    height: "1.2em",
  };

  function startEditing() {
    if (!canEdit) return;
    setEditMinutes(displayMinutes);
    setEditSeconds(displaySeconds);
    setEditing(true);
  }

  useEffect(() => {
    if (isEditing && minutesRef.current) {
      minutesRef.current.focus();
      minutesRef.current.select();
    }
  }, [isEditing]);

  function commitEdit() {
    if (!editing) return;
    const m = Math.max(0, parseInt(editMinutes, 10) || 0);
    const s = Math.max(0, Math.min(59, parseInt(editSeconds, 10) || 0));
    const total = m * 60 + s;
    if (total > 0 && onRemainingChange) {
      onRemainingChange(total);
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div style={containerStyle} data-status={status}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          ...fontStyles,
          color: displayColor,
          cursor: canEdit && !isEditing ? "pointer" : "default",
        }}
        aria-live="polite"
      >
        <input
          ref={minutesRef}
          type="text"
          inputMode="numeric"
          readOnly={!isEditing}
          tabIndex={isEditing ? 0 : -1}
          value={isEditing ? editMinutes : displayMinutes}
          onChange={(e) => setEditMinutes(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          onKeyDown={isEditing ? handleKeyDown : undefined}
          onFocus={!isEditing ? startEditing : undefined}
          onClick={!isEditing ? startEditing : undefined}
          onBlur={isEditing
            ? (e) => {
              if (e.relatedTarget !== secondsRef.current) commitEdit();
            }
            : undefined}
          style={{ ...inputStyle, ...editingBorder }}
          aria-label="Minutes"
        />
        <span>:</span>
        <input
          ref={secondsRef}
          type="text"
          inputMode="numeric"
          readOnly={!isEditing}
          tabIndex={isEditing ? 0 : -1}
          value={isEditing ? editSeconds : displaySeconds}
          onChange={(e) => setEditSeconds(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
          onKeyDown={isEditing ? handleKeyDown : undefined}
          onFocus={!isEditing ? startEditing : undefined}
          onClick={!isEditing ? startEditing : undefined}
          onBlur={isEditing
            ? (e) => {
              if (e.relatedTarget !== minutesRef.current) commitEdit();
            }
            : undefined}
          style={{ ...inputStyle, ...editingBorder }}
          aria-label="Seconds"
        />
      </div>
      <div style={hintStyle}>
        {isEditing ? "enter to confirm" : canEdit ? "click to edit" : "\u00A0"}
      </div>
      {status === "completed" && (
        <div
          style={{
            marginTop: "8px",
            fontSize: "1rem",
            color: "#9ece6a",
            fontWeight: "600",
          }}
        >
          Session Complete!
        </div>
      )}
    </div>
  );
}
