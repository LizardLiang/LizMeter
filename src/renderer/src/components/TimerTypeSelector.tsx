// src/renderer/src/components/TimerTypeSelector.tsx
// Work / Short Break / Long Break selector

import type { TimerType } from "../../../shared/types.ts";

interface TimerTypeSelectorProps {
  value: TimerType;
  onChange: (type: TimerType) => void;
  disabled: boolean;
}

const ACCENT: Record<TimerType, string> = {
  work: "#7aa2f7",
  short_break: "#9ece6a",
  long_break: "#bb9af7",
};

const TIMER_OPTIONS: { value: TimerType; label: string; }[] = [
  { value: "work", label: "Work" },
  { value: "short_break", label: "Short Break" },
  { value: "long_break", label: "Long Break" },
];

export function TimerTypeSelector({ value, onChange, disabled }: TimerTypeSelectorProps) {
  const containerStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    padding: "12px 0",
  };

  return (
    <div style={containerStyle} role="group" aria-label="Timer type">
      {TIMER_OPTIONS.map((option) => {
        const isSelected = option.value === value;
        const accent = ACCENT[option.value];
        const buttonStyle: React.CSSProperties = {
          padding: "7px 18px",
          fontSize: "0.875rem",
          fontWeight: isSelected ? "700" : "500",
          borderRadius: "20px",
          border: `1px solid ${isSelected ? accent : "#292e42"}`,
          backgroundColor: isSelected ? `${accent}22` : "transparent",
          color: isSelected ? accent : "#565f89",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled && !isSelected ? 0.4 : 1,
          transition: "all 0.15s",
          letterSpacing: "0.02em",
        };

        return (
          <button
            key={option.value}
            style={buttonStyle}
            onClick={() => {
              if (!disabled) onChange(option.value);
            }}
            aria-pressed={isSelected}
            disabled={disabled}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
