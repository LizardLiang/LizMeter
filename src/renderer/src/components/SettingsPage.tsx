import { useState } from "react";
import type { TimerSettings } from "../../../shared/types.ts";
import styles from "./SettingsPage.module.scss";

interface Props {
  settings: TimerSettings;
  onSave: (settings: TimerSettings) => Promise<void>;
}

export function SettingsPage({ settings, onSave }: Props) {
  const [work, setWork] = useState(String(settings.workDuration / 60));
  const [shortBreak, setShortBreak] = useState(String(settings.shortBreakDuration / 60));
  const [longBreak, setLongBreak] = useState(String(settings.longBreakDuration / 60));
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const w = parseInt(work, 10);
    const s = parseInt(shortBreak, 10);
    const l = parseInt(longBreak, 10);
    if (!w || !s || !l || w < 1 || s < 1 || l < 1) {
      setError("All durations must be at least 1 minute.");
      return;
    }
    setIsSaving(true);
    setError(null);
    setSaved(false);
    try {
      await onSave({
        workDuration: w * 60,
        shortBreakDuration: s * 60,
        longBreakDuration: l * 60,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Settings</h1>

      <div className={styles.field}>
        <label className={styles.label}>Work Duration</label>
        <div className={styles.inputRow}>
          <input
            type="number"
            min={1}
            max={120}
            className={styles.input}
            value={work}
            onChange={(e) => setWork(e.target.value)}
          />
          <span className={styles.unit}>minutes</span>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Short Break</label>
        <div className={styles.inputRow}>
          <input
            type="number"
            min={1}
            max={60}
            className={styles.input}
            value={shortBreak}
            onChange={(e) => setShortBreak(e.target.value)}
          />
          <span className={styles.unit}>minutes</span>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Long Break</label>
        <div className={styles.inputRow}>
          <input
            type="number"
            min={1}
            max={120}
            className={styles.input}
            value={longBreak}
            onChange={(e) => setLongBreak(e.target.value)}
          />
          <span className={styles.unit}>minutes</span>
        </div>
      </div>

      {error && <div className={styles.errorMsg}>{error}</div>}

      <button className={styles.saveBtn} onClick={() => void handleSave()} disabled={isSaving}>
        {isSaving ? "Saving…" : saved ? "Saved ✓" : "Save Settings"}
      </button>
    </div>
  );
}
