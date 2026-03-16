import { useCallback, useEffect, useState } from "react";
import type {
  AvatarPaths,
  BinaryInfo,
  BinaryStatus,
  CacheStats,
  IssueProviderStatus,
  JiraAuthType,
  JiraProviderStatus,
  LinearProviderStatus,
  LinearTeam,
  StopwatchSettings,
  TimerSettings,
  WidgetSettings,
} from "../../../shared/types.ts";
import styles from "./SettingsPage.module.scss";

interface Props {
  settings: TimerSettings;
  onSave: (settings: TimerSettings) => Promise<void>;
  stopwatchSettings?: StopwatchSettings;
  onStopwatchSettingsChange?: (settings: StopwatchSettings) => void;
  soundEnabled?: boolean;
  onSoundEnabledChange?: (enabled: boolean) => void;
}

export function SettingsPage({
  settings,
  onSave,
  stopwatchSettings,
  onStopwatchSettingsChange,
  soundEnabled = true,
  onSoundEnabledChange,
}: Props) {
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
    jiraConfigured: false,
    jiraDomainSet: false,
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

  // Jira state
  const [jiraStatus, setJiraStatus] = useState<JiraProviderStatus>({
    configured: false,
    domainSet: false,
    projectKeySet: false,
    authType: null,
  });
  const [jiraAuthType, setJiraAuthType] = useState<JiraAuthType>("cloud");
  const [jiraDomain, setJiraDomain] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraTokenInput, setJiraTokenInput] = useState("");
  const [jiraProjectKey, setJiraProjectKey] = useState("");
  const [jiraJqlFilter, setJiraJqlFilter] = useState("");
  const [jiraSaving, setJiraSaving] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [jiraTesting, setJiraTesting] = useState(false);
  const [jiraTestResult, setJiraTestResult] = useState<{ ok: boolean; message: string; } | null>(null);

  // Widget state
  const [widgetSettings, setWidgetSettings] = useState<WidgetSettings>({
    enabled: false,
    visibility: "always",
    position: null,
    avatars: { idle: null, thinking: null, tool_use: null },
  });
  const [widgetSaving, setWidgetSaving] = useState(false);

  // Avatar state
  const [avatarPaths, setAvatarPaths] = useState<AvatarPaths>({ idle: null, thinking: null, tool_use: null });
  const [avatarNaturalSizes, setAvatarNaturalSizes] = useState<Record<string, number>>({});

  // Music settings state
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [binaryStatus, setBinaryStatus] = useState<BinaryStatus | null>(null);
  const [binaryInfo, setBinaryInfo] = useState<BinaryInfo | null>(null);
  const [cacheLimitMb, setCacheLimitMb] = useState<number>(1024);
  const [cacheLimitSaving, setCacheLimitSaving] = useState(false);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  useEffect(() => {
    void window.electronAPI.issues.providerStatus().then(setTokenStatus);
    void window.electronAPI.linear.providerStatus().then(setLinearStatus);
    void window.electronAPI.jira.providerStatus().then(setJiraStatus);
    void window.electronAPI.widget.getSettings().then((settings) => {
      setWidgetSettings(settings);
      setAvatarPaths(settings.avatars);
    });
    // Load music settings
    void window.electronAPI.music.cacheStats().then((stats) => {
      setCacheStats(stats);
      setCacheLimitMb(Math.round(stats.maxBytes / (1024 * 1024)));
    }).catch(() => {});
    void window.electronAPI.music.binaryStatus().then(setBinaryStatus).catch(() => {});
    void window.electronAPI.music.binaryInfo().then(setBinaryInfo).catch(() => {});
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

  // Jira handlers

  async function handleSaveJira() {
    const domain = jiraDomain.trim();
    const identity = jiraEmail.trim();
    const secret = jiraTokenInput.trim();
    if (!domain || !identity || !secret) {
      setJiraError(
        jiraAuthType === "server"
          ? "Server URL, username, and password are all required."
          : "Domain, email, and API token are all required.",
      );
      return;
    }
    setJiraSaving(true);
    setJiraError(null);
    try {
      await window.electronAPI.jira.setAuthType({ authType: jiraAuthType });
      await window.electronAPI.jira.setDomain({ domain });
      await window.electronAPI.jira.setEmail({ email: identity });
      await window.electronAPI.jira.setToken({ token: secret });
      if (jiraProjectKey.trim()) {
        await window.electronAPI.jira.setProjectKey({ projectKey: jiraProjectKey.trim() });
      }
      if (jiraJqlFilter.trim()) {
        await window.electronAPI.jira.setJqlFilter({ jql: jiraJqlFilter.trim() });
      }
      const status = await window.electronAPI.jira.providerStatus();
      setJiraStatus(status);
      setJiraTokenInput("");
      // Auto test connection
      await handleJiraTestConnection();
      const providerStatus = await window.electronAPI.issues.providerStatus();
      setTokenStatus(providerStatus);
    } catch (err) {
      setJiraError(err instanceof Error ? err.message : "Failed to save Jira credentials.");
    } finally {
      setJiraSaving(false);
    }
  }

  async function handleJiraTestConnection() {
    setJiraTesting(true);
    setJiraTestResult(null);
    try {
      const { displayName } = await window.electronAPI.jira.testConnection();
      setJiraTestResult({ ok: true, message: `Connected as ${displayName}` });
    } catch (err) {
      setJiraTestResult({ ok: false, message: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setJiraTesting(false);
    }
  }

  async function handleJiraDisconnect() {
    await window.electronAPI.jira.deleteToken();
    setJiraStatus({ configured: false, domainSet: false, projectKeySet: false, authType: null });
    setJiraTestResult(null);
    setJiraAuthType("cloud");
    setJiraDomain("");
    setJiraEmail("");
    setJiraProjectKey("");
    setJiraJqlFilter("");
    const providerStatus = await window.electronAPI.issues.providerStatus();
    setTokenStatus(providerStatus);
  }

  // Widget handlers

  async function handleWidgetToggle(enabled: boolean) {
    setWidgetSaving(true);
    try {
      await window.electronAPI.widget.saveSettings({ enabled });
      setWidgetSettings((prev) => ({ ...prev, enabled }));
    } finally {
      setWidgetSaving(false);
    }
  }

  async function handleWidgetVisibilityChange(visibility: WidgetSettings["visibility"]) {
    setWidgetSaving(true);
    try {
      await window.electronAPI.widget.saveSettings({ visibility });
      setWidgetSettings((prev) => ({ ...prev, visibility }));
    } finally {
      setWidgetSaving(false);
    }
  }

  async function handleWidgetResetPosition() {
    setWidgetSaving(true);
    try {
      await window.electronAPI.widget.saveSettings({ position: null });
      setWidgetSettings((prev) => ({ ...prev, position: null }));
    } finally {
      setWidgetSaving(false);
    }
  }

  async function handleAvatarUpload(slot: keyof AvatarPaths) {
    const path = await window.electronAPI.widget.uploadAvatar(slot);
    if (path) {
      setAvatarPaths((prev) => ({ ...prev, [slot]: path }));
    }
  }

  async function handleAvatarRemove(slot: keyof AvatarPaths) {
    await window.electronAPI.widget.removeAvatar(slot);
    setAvatarPaths((prev) => ({ ...prev, [slot]: null }));
    setAvatarNaturalSizes((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });
  }

  // Music settings handlers

  const handleCacheLimitChange = useCallback(async (mb: number) => {
    setCacheLimitMb(mb);
    setCacheLimitSaving(true);
    try {
      const maxBytes = mb * 1024 * 1024;
      await window.electronAPI.music.cacheSetLimit(maxBytes);
      const stats = await window.electronAPI.music.cacheStats();
      setCacheStats(stats);
    } catch {
      // Non-fatal
    } finally {
      setCacheLimitSaving(false);
    }
  }, []);

  const handleClearCache = useCallback(async () => {
    setShowClearConfirm(false);
    setCacheClearing(true);
    try {
      await window.electronAPI.music.cacheClear();
      const stats = await window.electronAPI.music.cacheStats();
      setCacheStats(stats);
    } catch {
      // Non-fatal
    } finally {
      setCacheClearing(false);
    }
  }, []);

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

      {onSoundEnabledChange && (
        <label className={styles.checkboxRow} style={{ marginTop: 16 }}>
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={(e) => onSoundEnabledChange(e.target.checked)}
          />
          <span className={styles.checkboxLabel}>Play sound when timer completes</span>
        </label>
      )}

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

      {/* --- Jira Section --- */}
      <div className={styles.sectionDivider} />
      <h2 className={styles.sectionHeading}>Jira</h2>

      {!jiraStatus.configured
        ? (
          <div className={styles.tokenForm}>
            <div className={styles.segmentedControl}>
              <button
                className={`${styles.segmentBtn} ${jiraAuthType === "cloud" ? styles.segmentBtnActive : ""}`}
                onClick={() => setJiraAuthType("cloud")}
              >
                Cloud
              </button>
              <button
                className={`${styles.segmentBtn} ${jiraAuthType === "server" ? styles.segmentBtnActive : ""}`}
                onClick={() => setJiraAuthType("server")}
              >
                Server / Data Center
              </button>
            </div>

            {jiraAuthType === "cloud"
              ? (
                <>
                  <label className={styles.label}>Atlassian Domain</label>
                  <p className={styles.tokenHint}>
                    e.g. <code>mycompany.atlassian.net</code>
                  </p>
                  <div className={styles.inputRow}>
                    <input
                      type="text"
                      className={styles.tokenInput}
                      placeholder="mycompany.atlassian.net"
                      value={jiraDomain}
                      onChange={(e) => setJiraDomain(e.target.value)}
                    />
                  </div>

                  <label className={styles.label} style={{ marginTop: 12 }}>Email</label>
                  <div className={styles.inputRow}>
                    <input
                      type="email"
                      className={styles.tokenInput}
                      placeholder="you@company.com"
                      value={jiraEmail}
                      onChange={(e) => setJiraEmail(e.target.value)}
                    />
                  </div>

                  <label className={styles.label} style={{ marginTop: 12 }}>API Token</label>
                  <p className={styles.tokenHint}>
                    Generate at{" "}
                    <span
                      className={styles.tokenLink}
                      onClick={() =>
                        void window.electronAPI.shell.openExternal(
                          "https://id.atlassian.com/manage-profile/security/api-tokens",
                        )}
                    >
                      Atlassian API tokens ↗
                    </span>
                  </p>
                  <div className={styles.inputRow}>
                    <input
                      type="password"
                      className={styles.tokenInput}
                      placeholder="API token"
                      value={jiraTokenInput}
                      onChange={(e) => setJiraTokenInput(e.target.value)}
                    />
                  </div>
                </>
              )
              : (
                <>
                  <label className={styles.label}>Server URL</label>
                  <p className={styles.tokenHint}>
                    e.g. <code>jira.mycompany.com</code> or <code>jira.mycompany.com:8080</code>
                  </p>
                  <div className={styles.inputRow}>
                    <input
                      type="text"
                      className={styles.tokenInput}
                      placeholder="jira.mycompany.com"
                      value={jiraDomain}
                      onChange={(e) => setJiraDomain(e.target.value)}
                    />
                  </div>

                  <label className={styles.label} style={{ marginTop: 12 }}>Username</label>
                  <div className={styles.inputRow}>
                    <input
                      type="text"
                      className={styles.tokenInput}
                      placeholder="your.username"
                      value={jiraEmail}
                      onChange={(e) => setJiraEmail(e.target.value)}
                    />
                  </div>

                  <label className={styles.label} style={{ marginTop: 12 }}>Password</label>
                  <div className={styles.inputRow}>
                    <input
                      type="password"
                      className={styles.tokenInput}
                      placeholder="Password"
                      value={jiraTokenInput}
                      onChange={(e) => setJiraTokenInput(e.target.value)}
                    />
                  </div>
                </>
              )}

            <label className={styles.label} style={{ marginTop: 12 }}>Project Key (optional)</label>
            <p className={styles.tokenHint}>
              e.g. <code>PROJ</code> — leave empty to show issues assigned to you
            </p>
            <div className={styles.inputRow}>
              <input
                type="text"
                className={styles.tokenInput}
                placeholder="PROJ"
                value={jiraProjectKey}
                onChange={(e) => setJiraProjectKey(e.target.value)}
              />
            </div>

            <label className={styles.label} style={{ marginTop: 12 }}>JQL Filter (optional)</label>
            <p className={styles.tokenHint}>
              Custom JQL overrides the project key filter
            </p>
            <div className={styles.inputRow}>
              <input
                type="text"
                className={styles.tokenInput}
                placeholder="assignee = currentUser() AND status != Done"
                value={jiraJqlFilter}
                onChange={(e) => setJiraJqlFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void handleSaveJira()}
              />
            </div>

            {jiraError && <div className={styles.errorMsg}>{jiraError}</div>}
            <button className={styles.saveBtn} onClick={() => void handleSaveJira()} disabled={jiraSaving}>
              {jiraSaving ? "Saving…" : "Save & Connect"}
            </button>
          </div>
        )
        : (
          <>
            <div className={styles.tokenConnected}>
              <span className={styles.tokenStatus}>
                Jira{jiraStatus.authType === "server" ? " Server" : ""} — Connected ✓
              </span>
              <div className={styles.tokenActions}>
                <button
                  className={styles.testTokenBtn}
                  onClick={() => void handleJiraTestConnection()}
                  disabled={jiraTesting}
                >
                  {jiraTesting ? "Testing…" : "Test Connection"}
                </button>
                <button className={styles.removeTokenBtn} onClick={() => void handleJiraDisconnect()}>
                  Disconnect
                </button>
              </div>
            </div>
            {jiraTestResult && (
              <div className={jiraTestResult.ok ? styles.testSuccess : styles.errorMsg}>
                {jiraTestResult.message}
              </div>
            )}
          </>
        )}

      {/* --- Widget Section --- */}
      <div className={styles.sectionDivider} />
      <h2 className={styles.sectionHeading}>Desktop Widget</h2>

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={widgetSettings.enabled}
          disabled={widgetSaving}
          onChange={(e) => void handleWidgetToggle(e.target.checked)}
        />
        <span className={styles.checkboxLabel}>Enable Widget</span>
      </label>

      {widgetSettings.enabled && (
        <>
          <label className={styles.label} style={{ marginTop: 16, display: "block" }}>
            Visibility
          </label>
          <div className={styles.segmentedControl} style={{ marginTop: 8 }}>
            <button
              className={`${styles.segmentBtn} ${
                widgetSettings.visibility === "always" ? styles.segmentBtnActive : ""
              }`}
              onClick={() => void handleWidgetVisibilityChange("always")}
              disabled={widgetSaving}
            >
              Always visible
            </button>
            <button
              className={`${styles.segmentBtn} ${
                widgetSettings.visibility === "when-active" ? styles.segmentBtnActive : ""
              }`}
              onClick={() => void handleWidgetVisibilityChange("when-active")}
              disabled={widgetSaving}
            >
              When active
            </button>
          </div>

          <button
            className={styles.testTokenBtn}
            style={{ marginTop: 12 }}
            onClick={() => void handleWidgetResetPosition()}
            disabled={widgetSaving}
          >
            Reset Position
          </button>

          <label className={styles.label} style={{ marginTop: 16, display: "block" }}>
            Avatar
          </label>
          <p className={styles.tokenHint}>
            Upload GIF/PNG for each Claude session status. Pixel art auto-scales crispy.
          </p>
          <div className={styles.avatarGrid}>
            {(["idle", "thinking", "tool_use"] as const).map((slot) => {
              const src = avatarPaths[slot];
              const isPixelArt = (avatarNaturalSizes[slot] ?? 0) <= 128 && (avatarNaturalSizes[slot] ?? 0) > 0;
              const label = slot === "tool_use" ? "Working" : slot.charAt(0).toUpperCase() + slot.slice(1);
              return (
                <div key={slot} className={styles.avatarSlot}>
                  <span className={styles.avatarSlotLabel}>{label}</span>
                  <div
                    className={styles.avatarPreview}
                    onClick={() => void handleAvatarUpload(slot)}
                    title={`Upload ${label} avatar`}
                  >
                    {src
                      ? (
                        <img
                          src={src}
                          className={isPixelArt ? styles.pixelArt : ""}
                          onLoad={(e) => {
                            const img = e.currentTarget as HTMLImageElement;
                            setAvatarNaturalSizes((prev) => ({
                              ...prev,
                              [slot]: Math.max(img.naturalWidth, img.naturalHeight),
                            }));
                          }}
                        />
                      )
                      : <span className={styles.avatarPlaceholder}>+</span>}
                  </div>
                  {src && (
                    <button
                      className={styles.avatarRemoveBtn}
                      onClick={() => void handleAvatarRemove(slot)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* --- Time Tracking Section --- */}
      {stopwatchSettings && onStopwatchSettingsChange && (
        <>
          <div className={styles.sectionDivider} />
          <h2 className={styles.sectionHeading}>Time Tracking</h2>

          <div className={styles.field}>
            <label className={styles.label}>Max Duration</label>
            <div className={styles.inputRow}>
              <input
                type="number"
                min={0}
                max={24}
                className={styles.input}
                value={stopwatchSettings.maxDurationSeconds === 0
                  ? ""
                  : String(stopwatchSettings.maxDurationSeconds / 3600)}
                disabled={stopwatchSettings.maxDurationSeconds === 0}
                onChange={(e) => {
                  const hours = parseFloat(e.target.value);
                  if (!isNaN(hours) && hours > 0) {
                    onStopwatchSettingsChange({ ...stopwatchSettings, maxDurationSeconds: Math.round(hours * 3600) });
                  }
                }}
              />
              <span className={styles.unit}>hours</span>
            </div>
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={stopwatchSettings.maxDurationSeconds === 0}
              onChange={(e) => {
                onStopwatchSettingsChange({
                  ...stopwatchSettings,
                  maxDurationSeconds: e.target.checked ? 0 : 28800,
                });
              }}
            />
            <span className={styles.checkboxLabel}>No limit</span>
          </label>

          <label className={styles.checkboxRow} style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={stopwatchSettings.promptForIssue}
              onChange={(e) => {
                onStopwatchSettingsChange({
                  ...stopwatchSettings,
                  promptForIssue: e.target.checked,
                });
              }}
            />
            <span className={styles.checkboxLabel}>Prompt to link issue when starting</span>
          </label>
        </>
      )}

      {/* --- Music Section --- */}
      <div className={styles.sectionDivider} />
      <h2 className={styles.sectionHeading}>Music</h2>

      {/* Cache limit */}
      <div className={styles.field}>
        <label className={styles.label}>Cache Size Limit</label>
        <div className={styles.segmentedControl} style={{ marginTop: 8 }}>
          {([500, 1024, 2048, 5120] as const).map((mb) => (
            <button
              key={mb}
              className={`${styles.segmentBtn} ${cacheLimitMb === mb ? styles.segmentBtnActive : ""}`}
              onClick={() => void handleCacheLimitChange(mb)}
              disabled={cacheLimitSaving}
            >
              {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
            </button>
          ))}
        </div>
      </div>

      {/* Cache usage */}
      {cacheStats !== null && (
        <div className={styles.field}>
          <label className={styles.label}>Current Cache Usage</label>
          <p className={styles.tokenHint} style={{ margin: "6px 0 0" }}>
            {(cacheStats.currentBytes / (1024 * 1024)).toFixed(1)} MB used ({cacheStats.trackCount}{" "}
            track{cacheStats.trackCount !== 1 ? "s" : ""} cached)
          </p>
        </div>
      )}

      {/* Clear cache */}
      {showClearConfirm
        ? (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className={styles.saveBtn}
              style={{ background: "rgba(247,118,142,0.12)", borderColor: "rgba(247,118,142,0.3)", color: "#f7768e" }}
              onClick={() => void handleClearCache()}
              disabled={cacheClearing}
            >
              {cacheClearing ? "Clearing…" : "Confirm Clear"}
            </button>
            <button
              className={styles.testTokenBtn}
              onClick={() => setShowClearConfirm(false)}
            >
              Cancel
            </button>
          </div>
        )
        : (
          <button
            className={styles.testTokenBtn}
            style={{ marginTop: 8 }}
            onClick={() => setShowClearConfirm(true)}
            disabled={cacheClearing || (cacheStats !== null && cacheStats.currentBytes === 0)}
          >
            Clear Cache
          </button>
        )}

      {/* yt-dlp version */}
      {binaryStatus !== null && (
        <div className={styles.field} style={{ marginTop: 16 }}>
          <label className={styles.label}>yt-dlp Version</label>
          <p className={styles.tokenHint} style={{ margin: "6px 0 0" }}>
            {binaryStatus.ytDlpInstalled
              ? binaryStatus.ytDlpVersion ?? "Installed (version unknown)"
              : "Not installed"}
          </p>
        </div>
      )}

      {/* Binary storage path */}
      {binaryInfo !== null && (
        <div className={styles.field}>
          <label className={styles.label}>Binary Storage Path</label>
          <p className={styles.tokenHint} style={{ margin: "6px 0 0", wordBreak: "break-all" }}>
            {binaryInfo.storagePath}
          </p>
        </div>
      )}
    </div>
  );
}
