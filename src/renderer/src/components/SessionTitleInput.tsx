// src/renderer/src/components/SessionTitleInput.tsx
// Rich text input for session title using TipTap

import { RichTextInput } from "./RichTextInput.tsx";
import styles from "./SessionTitleInput.module.scss";

interface SessionTitleInputProps {
  value: string;
  onChange: (value: string) => void;
  /** No longer enforced directly — TipTap manages content. Kept for API compatibility. */
  maxLength?: number;
  disabled?: boolean;
}

export function SessionTitleInput({ value, onChange, disabled = false }: SessionTitleInputProps) {
  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>Session Description</label>
      <RichTextInput
        value={value}
        onChange={onChange}
        placeholder="Describe what you'll be working on\u2026"
        disabled={disabled}
      />
    </div>
  );
}
