// src/renderer/src/components/TimerTypeSelector.tsx
// Work / Short Break / Long Break selector

import type { TimerType } from "../../../shared/types.ts";
import styles from "./TimerTypeSelector.module.scss";

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
  return (
    <div className={styles.container} role="group" aria-label="Timer type">
      {TIMER_OPTIONS.map((option) => {
        const isSelected = option.value === value;
        const accent = ACCENT[option.value];

        return (
          <button
            key={option.value}
            className={styles.btn}
            style={{
              fontWeight: isSelected ? 600 : 400,
              borderBottom: `2px solid ${isSelected ? accent : "transparent"}`,
              color: isSelected ? accent : "#565f89",
              opacity: disabled && !isSelected ? 0.35 : 1,
              cursor: disabled ? "not-allowed" : "pointer",
            }}
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
