import { useEffect, useState } from "react";
import type { IssueProviderStatus, LinearProviderStatus, LinearTeam, TimerSettings } from "../../../shared/types.ts";
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

  // GitHub token state
  const [tokenInput, setTokenInput] = useState("");
  const [tokenStatus, setTokenStatus] = useState<IssueProviderStatus>({
    configured: false,
    provider: null,
    linearConfigured: false,
    linearTeamSelected: false,
  });
  const [tokenSaving, setTokenSaving] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; } | null>(null);

  // Linear state
  const [linearStatus, setLinearStatus] = useState<LinearProviderStatus>({
    configured: false,
    teamSelected: false,
    teamName: null,
  });
  const [linearTokenInput, setLinearTokenInput] = useState("");
  const [linearTokenSaving, setLinearTokenSaving] = useState(false);
  const [linearTokenError, setLinearTokenError] = useState<string | null>(null);
  const [linearTesting, setLinearTesting] = useState(false);
  const [linearTestResult, setLinearTestResult] = useState<{ ok: boolean; message: string; } | null>(null);
  const [linearTeams, setLinearTeams] = useState<LinearTeam[]>([]);
  const [linearTeamsLoading, setLinearTeamsLoading] = useState(false);
  const [linearTeamsError, setLinearTeamsError] = useState<string | null>(null);

  useEffect(() => {
    void window.electronAPI.issues.providerStatus().then(setTokenStatus);
    void window.electronAPI.linear.providerStatus().then(setLinearStatus);
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

  // Linear handlers

  async function handleSaveLinearToken() {
    const t = linearTokenInput.trim();
    if (!t) {
      setLinearTokenError("API key cannot be empty.");
      return;
    }
    setLinearTokenSaving(true);
    setLinearTokenError(null);
    try {
      await window.electronAPI.linear.setToken({ token: t });
      const status = await window.electronAPI.linear.providerStatus();
      setLinearStatus(status);
      setLinearTokenInput("");
      // Automatically test connection and load teams
      await handleLinearTestConnection();
    } catch (err) {
      setLinearTokenError(err instanceof Error ? err.message : "Failed to save Linear API key.");
    } finally {
      setLinearTokenSaving(false);
    }
  }

  async function handleLinearTestConnection() {
    setLinearTesting(true);
    setLinearTestResult(null);
    setLinearTeamsError(null);
    try {
      const { displayName } = await window.electronAPI.linear.testConnection();
      setLinearTestResult({ ok: true, message: `Connected as ${displayName}` });
      // Load teams after successful connection
      await loadLinearTeams();
    } catch (err) {
      setLinearTestResult({ ok: false, message: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setLinearTesting(false);
    }
  }

  async function loadLinearTeams() {
    setLinearTeamsLoading(true);
    setLinearTeamsError(null);
    try {
      const teams = await window.electronAPI.linear.listTeams();
      setLinearTeams(teams);
      // Auto-select if single team
      if (teams.length === 1 && teams[0]) {
        await handleLinearSelectTeam(teams[0].id, teams[0].name);
      }
    } catch (err) {
      setLinearTeamsError(err instanceof Error ? err.message : "Failed to load teams");
    } finally {
      setLinearTeamsLoading(false);
    }
  }

  async function handleLinearSelectTeam(teamId: string, teamName: string) {
    await window.electronAPI.linear.setTeam({ teamId, teamName });
    const status = await window.electronAPI.linear.providerStatus();
    setLinearStatus(status);
  }

  async function handleLinearDisconnect() {
    await window.electronAPI.linear.deleteToken();
    setLinearStatus({ configured: false, teamSelected: false, teamName: null });
    setLinearTestResult(null);
    setLinearTeams([]);
    setLinearTeamsError(null);
    const providerStatus = await window.electronAPI.issues.providerStatus();
    setTokenStatus(providerStatus);
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

      {/* --- GitHub Section --- */}
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

      {/* --- Linear Section --- */}
      <div className={styles.sectionDivider} />
      <h2 className={styles.sectionHeading}>Linear</h2>

      {!linearStatus.configured
        ? (
          <div className={styles.tokenForm}>
            <label className={styles.label}>Linear API Key</label>
            <p className={styles.tokenHint}>
              Generate at{" "}
              <span
                className={styles.tokenLink}
                onClick={() => void window.electronAPI.shell.openExternal("https://linear.app/settings/api")}
              >
                Settings &gt; Account &gt; API in Linear ↗
              </span>
            </p>
            <div className={styles.inputRow}>
              <input
                type="password"
                className={styles.tokenInput}
                placeholder="lin_api_…"
                value={linearTokenInput}
                onChange={(e) => setLinearTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveLinearToken()}
              />
            </div>
            {linearTokenError && <div className={styles.errorMsg}>{linearTokenError}</div>}
            <button
              className={styles.saveBtn}
              onClick={() => void handleSaveLinearToken()}
              disabled={linearTokenSaving}
            >
              {linearTokenSaving ? "Saving…" : "Save Key"}
            </button>
          </div>
        )
        : (
          <>
            <div className={styles.tokenConnected}>
              <span className={styles.tokenStatus}>
                Linear — Connected ✓
                {linearStatus.teamSelected && linearStatus.teamName && (
                  <span className={styles.linearTeamLabel}>· {linearStatus.teamName}</span>
                )}
              </span>
              <div className={styles.tokenActions}>
                <button
                  className={styles.testTokenBtn}
                  onClick={() => void handleLinearTestConnection()}
                  disabled={linearTesting}
                >
                  {linearTesting ? "Testing…" : "Test Connection"}
                </button>
                <button className={styles.removeTokenBtn} onClick={() => void handleLinearDisconnect()}>
                  Disconnect
                </button>
              </div>
            </div>

            {linearTestResult && (
              <div className={linearTestResult.ok ? styles.testSuccess : styles.errorMsg}>
                {linearTestResult.message}
              </div>
            )}

            {/* Team selection — show when not yet selected or when re-loading teams */}
            {!linearStatus.teamSelected && (
              <div className={styles.linearTeamSection}>
                {linearTeamsLoading && <p className={styles.tokenHint}>Loading teams…</p>}
                {linearTeamsError && <div className={styles.errorMsg}>{linearTeamsError}</div>}
                {!linearTeamsLoading && !linearTeamsError && linearTeams.length === 0 && linearTestResult?.ok && (
                  <p className={styles.tokenHint}>No teams found in your workspace.</p>
                )}
                {!linearTeamsLoading && linearTeams.length > 1 && (
                  <>
                    <label className={styles.label}>Select Team</label>
                    <div className={styles.linearTeamSelect}>
                      {linearTeams.map((team) => (
                        <button
                          key={team.id}
                          className={styles.teamOption}
                          onClick={() => void handleLinearSelectTeam(team.id, team.name)}
                        >
                          {team.name}
                          <span className={styles.teamKey}>{team.key}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {!linearTeamsLoading && linearTeams.length === 0 && !linearTestResult && (
                  <button
                    className={styles.testTokenBtn}
                    onClick={() => void loadLinearTeams()}
                    style={{ marginTop: 8 }}
                  >
                    Load Teams
                  </button>
                )}
              </div>
            )}
          </>
        )}
    </div>
  );
}
