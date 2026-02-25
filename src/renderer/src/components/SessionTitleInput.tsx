// src/renderer/src/components/SessionTitleInput.tsx
// Text input for session title

import styles from "./SessionTitleInput.module.scss";

interface SessionTitleInputProps {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  disabled?: boolean;
}

export function SessionTitleInput({
  value,
  onChange,
  maxLength = 500,
  disabled = false,
}: SessionTitleInputProps) {
  return (
    <div className={styles.wrapper}>
      <label htmlFor="session-title" className={styles.label}>
        Session Description
      </label>
      <input
        id="session-title"
        type="text"
        className={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe what you'll be working on…"
        maxLength={maxLength}
        disabled={disabled}
      />
    </div>
  );
}
