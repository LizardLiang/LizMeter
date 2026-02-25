import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const mockElectronAPI = {
  platform: "linux",
  session: {
    save: vi.fn().mockResolvedValue({}),
    saveWithTracking: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue({
      workDuration: 1500,
      shortBreakDuration: 300,
      longBreakDuration: 900,
    }),
    save: vi.fn().mockResolvedValue(undefined),
    getValue: vi.fn().mockResolvedValue(null),
    setValue: vi.fn().mockResolvedValue(undefined),
  },
  tag: {
    create: vi.fn().mockResolvedValue({ id: 1, name: "test", color: "#7aa2f7", createdAt: "" }),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: 1, name: "test", color: "#7aa2f7", createdAt: "" }),
    delete: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    unassign: vi.fn().mockResolvedValue(undefined),
    listForSession: vi.fn().mockResolvedValue([]),
  },
  window: {
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
  },
  issues: {
    list: vi.fn().mockResolvedValue({ issues: [] }),
    providerStatus: vi.fn().mockResolvedValue({
      configured: false,
      provider: null,
      linearConfigured: false,
      linearTeamSelected: false,
    }),
    setToken: vi.fn().mockResolvedValue(undefined),
    deleteToken: vi.fn().mockResolvedValue(undefined),
    testToken: vi.fn().mockResolvedValue({ username: "testuser" }),
  },
  linear: {
    setToken: vi.fn().mockResolvedValue(undefined),
    deleteToken: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ displayName: "Test User" }),
    listTeams: vi.fn().mockResolvedValue([]),
    setTeam: vi.fn().mockResolvedValue(undefined),
    getTeam: vi.fn().mockResolvedValue(null),
    fetchIssues: vi.fn().mockResolvedValue([]),
    providerStatus: vi.fn().mockResolvedValue({ configured: false, teamSelected: false, teamName: null }),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  jira: {
    setToken: vi.fn().mockResolvedValue(undefined),
    deleteToken: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ displayName: "Test User" }),
    fetchIssues: vi.fn().mockResolvedValue([]),
    providerStatus: vi.fn().mockResolvedValue({
      configured: false,
      domainSet: false,
      projectKeySet: false,
      authType: null,
    }),
    fetchComments: vi.fn().mockResolvedValue([]),
    setAuthType: vi.fn().mockResolvedValue(undefined),
    setDomain: vi.fn().mockResolvedValue(undefined),
    setEmail: vi.fn().mockResolvedValue(undefined),
    setProjectKey: vi.fn().mockResolvedValue(undefined),
    setJqlFilter: vi.fn().mockResolvedValue(undefined),
  },
  worklog: {
    log: vi.fn().mockResolvedValue({ worklogId: "wl-1" }),
    markLogged: vi.fn().mockResolvedValue(undefined),
  },
  claudeTracker: {
    scan: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    trackSelected: vi.fn().mockResolvedValue({ tracked: 0 }),
    stop: vi.fn().mockResolvedValue({ sessions: [] }),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    getProjects: vi.fn().mockResolvedValue({ projects: [] }),
    getForSession: vi.fn().mockResolvedValue(null),
    onUpdate: vi.fn().mockReturnValue(() => {}),
    onNewSession: vi.fn().mockReturnValue(() => {}),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
});

test("renders the timer UI after settings load", async () => {
  render(<App />);
  // App renders "Loading..." first while settings load, then TomatoClock with timer UI
  await waitFor(() => expect(screen.getByText("Timer")).toBeInTheDocument());
});
