import { useEffect, useState } from "react";
import type { IssueProviderStatus, TimerSettings } from "../../../shared/types.ts";
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

  const [tokenInput, setTokenInput] = useState("");
  const [tokenStatus, setTokenStatus] = useState<IssueProviderStatus>({ configured: false, provider: null });
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; } | null>(null);

  useEffect(() => {
    void window.electronAPI.issues.providerStatus().then(setTokenStatus);
  }, []);

  async function handleSaveToken() {
    const t = tokenInput.trim();
    if (!t) {
      setTokenError("Token cannot be empty.");
      return;
    }
    setTokenSaving(true);
    setTokenError(null);
    setTokenSaved(false);
    try {
      await window.electronAPI.issues.setToken({ token: t, provider: "github" });
      const status = await window.electronAPI.issues.providerStatus();
      setTokenStatus(status);
      setTokenInput("");
      setTokenSaved(true);
      setTimeout(() => setTokenSaved(false), 2000);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Failed to save token.");
    } finally {
      setTokenSaving(false);
    }
  }

  async function handleTestToken() {
    setTesting(true);
    setTestResult(null);
    try {
      const { username } = await window.electronAPI.issues.testToken();
      setTestResult({ ok: true, message: `Connected as ${username}` });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleRemoveToken() {
    await window.electronAPI.issues.deleteToken();
    const status = await window.electronAPI.issues.providerStatus();
    setTokenStatus(status);
  }

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
          <span className={styles.unit}>min</span>
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
          <span className={styles.unit}>min</span>
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
          <span className={styles.unit}>min</span>
        </div>
      </div>

      {error && <div className={styles.errorMsg}>{error}</div>}

      <button className={styles.saveBtn} onClick={() => void handleSave()} disabled={isSaving}>
        {isSaving ? "Saving…" : saved ? "Saved ✓" : "Save Settings"}
      </button>

      <div className={styles.sectionDivider} />

      <h2 className={styles.sectionHeading}>Issue Tracker</h2>

      {tokenStatus.configured
        ? (
          <>
            <div className={styles.tokenConnected}>
              <span className={styles.tokenStatus}>GitHub — Connected ✓</span>
              <div className={styles.tokenActions}>
                <button className={styles.testTokenBtn} onClick={() => void handleTestToken()} disabled={testing}>
                  {testing ? "Testing…" : "Test Connection"}
                </button>
                <button className={styles.removeTokenBtn} onClick={() => void handleRemoveToken()}>
                  Remove token
                </button>
              </div>
            </div>
            {testResult && (
              <div className={testResult.ok ? styles.testSuccess : styles.errorMsg}>
                {testResult.message}
              </div>
            )}
          </>
        )
        : (
          <div className={styles.tokenForm}>
            <label className={styles.label}>GitHub Personal Access Token</label>
            <p className={styles.tokenHint}>
              Needs <code>repo</code> scope.{" "}
              <span
                className={styles.tokenLink}
                onClick={() => void window.electronAPI.shell.openExternal("https://github.com/settings/tokens")}
              >
                Create token ↗
              </span>
            </p>
            <div className={styles.inputRow}>
              <input
                type="password"
                className={styles.tokenInput}
                placeholder="ghp_…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveToken()}
              />
            </div>
            {tokenError && <div className={styles.errorMsg}>{tokenError}</div>}
            <button className={styles.saveBtn} onClick={() => void handleSaveToken()} disabled={tokenSaving}>
              {tokenSaving ? "Saving…" : tokenSaved ? "Saved ✓" : "Save Token"}
            </button>
          </div>
        )}
    </div>
  );
}
