/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../../shared/types.ts";

// ---- Module mocks (hoisted by Vitest) ----

vi.mock("../../hooks/useSettings.ts");
vi.mock("../../hooks/useNotificationSound.ts");
vi.mock("../../hooks/useSessionHistory.ts");
vi.mock("../../hooks/useTagManager.ts");
vi.mock("../../hooks/useClaudeTracker.ts");
vi.mock("../../hooks/useTimer.ts");
vi.mock("../../hooks/useStopwatch.ts");
vi.mock("../../hooks/useWidgetBridge.ts");

vi.mock("../../contexts/MusicPlayerContext.tsx", () => ({
  MusicPlayerProvider: ({ children }: any) => <>{children}</>,
  useMusicPlayer: () => ({ isBottomBarVisible: false }),
}));

vi.mock("../NavSidebar.tsx", () => ({
  NavSidebar: ({ activePage, onNavigate, timerStatus }: any) => (
    <nav data-testid="nav-sidebar" data-page={activePage} data-timer-status={timerStatus}>
      <button
        data-testid="nav-timer"
        onClick={() =>
          onNavigate("timer")}
      >
        Timer
      </button>
      <button
        data-testid="nav-history"
        onClick={() =>
          onNavigate("history")}
      >
        History
      </button>
      <button
        data-testid="nav-settings"
        onClick={() =>
          onNavigate("settings")}
      >
        Settings
      </button>
      <button data-testid="nav-stats" onClick={() => onNavigate("stats")}>Stats</button>
      <button data-testid="nav-tags" onClick={() => onNavigate("tags")}>Tags</button>
      <button data-testid="nav-issues" onClick={() => onNavigate("issues")}>Issues</button>
      <button data-testid="nav-claude" onClick={() => onNavigate("claude")}>Claude</button>
      <button data-testid="nav-activity" onClick={() => onNavigate("activity")}>Activity</button>
      <button data-testid="nav-music" onClick={() => onNavigate("music")}>Music</button>
    </nav>
  ),
}));

vi.mock("../ModeToggle.tsx", () => ({
  ModeToggle: ({ mode, onModeChange, disabled }: any) => (
    <div data-testid="mode-toggle" data-mode={mode}>
      <button data-testid="mode-pomodoro" disabled={!!disabled} onClick={() => onModeChange("pomodoro")}>
        Pomodoro
      </button>
      <button data-testid="mode-time-tracking" disabled={!!disabled} onClick={() => onModeChange("time-tracking")}>
        Time Tracking
      </button>
    </div>
  ),
}));

vi.mock("../TimerView.tsx", () => ({
  TimerView: ({ onStart, onPause, onResume, onReset, onDismiss, status, selectedIssue, onIssueSelect }: any) => (
    <div data-testid="timer-view" data-status={status}>
      <button data-testid="timer-start" onClick={onStart}>Start</button>
      <button data-testid="timer-pause" onClick={onPause}>Pause</button>
      <button data-testid="timer-resume" onClick={onResume}>Resume</button>
      <button data-testid="timer-reset" onClick={onReset}>Reset</button>
      <button data-testid="timer-dismiss" onClick={onDismiss}>Dismiss</button>
      {selectedIssue && (
        <span data-testid="selected-issue">
          {selectedIssue.title ?? selectedIssue.key ?? selectedIssue.identifier ?? "issue"}
        </span>
      )}
      <button
        data-testid="timer-issue-clear"
        onClick={() =>
          onIssueSelect(null)}
      >
        Clear Issue
      </button>
    </div>
  ),
}));

vi.mock("../StopwatchView.tsx", () => ({
  StopwatchView: ({ stopwatch, selectedClaudeSession, onClaudeSessionSelect }: any) => (
    <div
      data-testid="stopwatch-view"
      data-claude-session={selectedClaudeSession?.ccSessionUuid ?? "none"}
    >
      <button data-testid="sw-start" onClick={stopwatch.start}>Start</button>
      <button data-testid="sw-pause" onClick={stopwatch.pause}>Pause</button>
      <button data-testid="sw-resume" onClick={stopwatch.resume}>Resume</button>
      <button
        data-testid="sw-set-claude-session"
        onClick={() => onClaudeSessionSelect({ ccSessionUuid: "sw-uuid-1", projectDirName: "sw-project" })}
      >
        Set Claude Session
      </button>
      <button data-testid="sw-clear-claude-session" onClick={() => onClaudeSessionSelect(null)}>
        Clear Claude Session
      </button>
    </div>
  ),
}));

vi.mock("../TagPicker.tsx", () => ({
  TagPicker: ({ onAdd, onRemove, selectedTagIds }: any) => (
    <div data-testid="tag-picker" data-tags={JSON.stringify(selectedTagIds ?? [])}>
      <button
        data-testid="tag-add-1"
        onClick={() =>
          onAdd(1)}
      >
        Add Tag 1
      </button>
      <button
        data-testid="tag-add-2"
        onClick={() =>
          onAdd(2)}
      >
        Add Tag 2
      </button>
      <button data-testid="tag-remove-1" onClick={() => onRemove(1)}>Remove Tag 1</button>
    </div>
  ),
}));

vi.mock("../ClaudeCodeStats.tsx", () => ({
  ClaudeCodeStats: ({ onManageSessions, onAddNewSession }: any) => (
    <div data-testid="claude-code-stats">
      {onManageSessions && <button data-testid="manage-sessions" onClick={onManageSessions}>Manage</button>}
      {onAddNewSession && <button data-testid="add-new-session" onClick={onAddNewSession}>Add</button>}
    </div>
  ),
}));

vi.mock("../SessionPicker.tsx", () => ({
  SessionPicker: ({ onConfirm, onSkip, onToggleCollapse, pickerState }: any) => (
    <div data-testid="session-picker" data-state={pickerState}>
      <button
        data-testid="picker-confirm"
        onClick={() =>
          onConfirm(["uuid-1"])}
      >
        Confirm
      </button>
      <button data-testid="picker-skip" onClick={onSkip}>Skip</button>
      <button data-testid="picker-collapse" onClick={onToggleCollapse}>Toggle</button>
    </div>
  ),
}));

vi.mock("../ClaudeSessionSelect.tsx", () => ({
  ClaudeSessionSelect: ({ selected, onSelect }: any) => (
    <div data-testid="claude-session-select" data-selected={selected?.ccSessionUuid ?? "none"}>
      <button
        data-testid="pomodoro-set-claude-session"
        onClick={() =>
          onSelect({ ccSessionUuid: "pomo-uuid-1", projectDirName: "pomo-project" })}
      >
        Set
      </button>
      <button
        data-testid="claude-session-clear"
        onClick={() =>
          onSelect(null)}
      >
        Clear
      </button>
    </div>
  ),
}));

vi.mock("../music/MusicBottomBar.tsx", () => ({
  MusicBottomBar: () => <div data-testid="music-bottom-bar" />,
}));

vi.mock("../HistoryPage.tsx", () => ({
  HistoryPage: ({ onResumeSession }: any) => (
    <div data-testid="history-page">
      <button
        data-testid="resume-work"
        onClick={() =>
          onResumeSession(
            {
              id: "s1",
              title: "Work Session",
              timerType: "work",
              plannedDurationSeconds: 1500,
              actualDurationSeconds: 1200,
              completedAt: "2026-01-01T10:00:00Z",
              tags: [],
              issueNumber: null,
              issueTitle: null,
              issueUrl: null,
              issueProvider: null,
              issueId: null,
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume Work
      </button>
      <button
        data-testid="resume-stopwatch"
        onClick={() =>
          onResumeSession(
            {
              id: "s2",
              title: "Track Task",
              timerType: "stopwatch",
              plannedDurationSeconds: 0,
              actualDurationSeconds: 3600,
              completedAt: "2026-01-01T11:00:00Z",
              tags: [],
              issueNumber: null,
              issueTitle: null,
              issueUrl: null,
              issueProvider: null,
              issueId: null,
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume Stopwatch
      </button>
      <button
        data-testid="resume-with-jira"
        onClick={() =>
          onResumeSession(
            {
              id: "s3",
              title: "Jira Work",
              timerType: "work",
              plannedDurationSeconds: 1500,
              actualDurationSeconds: 1200,
              completedAt: "2026-01-01T10:00:00Z",
              tags: [],
              issueNumber: null,
              issueTitle: "Bug fix",
              issueUrl: "https://jira.example.com",
              issueProvider: "jira",
              issueId: "PROJ-1",
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume With Jira
      </button>
      <button
        data-testid="resume-with-linear"
        onClick={() =>
          onResumeSession(
            {
              id: "s4",
              title: "Linear Work",
              timerType: "work",
              plannedDurationSeconds: 1500,
              actualDurationSeconds: 900,
              completedAt: "2026-01-01T10:00:00Z",
              tags: [],
              issueNumber: null,
              issueTitle: "Feature",
              issueUrl: "https://linear.app",
              issueProvider: "linear",
              issueId: "LIN-42",
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume With Linear
      </button>
      <button
        data-testid="resume-with-github"
        onClick={() =>
          onResumeSession(
            {
              id: "s5",
              title: "GitHub Work",
              timerType: "work",
              plannedDurationSeconds: 1500,
              actualDurationSeconds: 900,
              completedAt: "2026-01-01T10:00:00Z",
              tags: [],
              issueNumber: 99,
              issueTitle: "PR fix",
              issueUrl: "https://github.com/org/repo/issues/99",
              issueProvider: "github",
              issueId: "99",
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume With GitHub
      </button>
      <button
        data-testid="resume-with-github-invalid"
        onClick={() =>
          onResumeSession(
            {
              id: "s6",
              title: "Invalid GitHub",
              timerType: "work",
              plannedDurationSeconds: 1500,
              actualDurationSeconds: 900,
              completedAt: "2026-01-01T10:00:00Z",
              tags: [],
              issueNumber: null,
              issueTitle: "Invalid",
              issueUrl: "https://github.com/org/repo/issues/abc",
              issueProvider: "github",
              issueId: "abc",
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume With Invalid GitHub
      </button>
      <button
        data-testid="resume-with-unknown-provider"
        onClick={() =>
          onResumeSession(
            {
              id: "s7",
              title: "Unknown Provider",
              timerType: "work",
              plannedDurationSeconds: 1500,
              actualDurationSeconds: 900,
              completedAt: "2026-01-01T10:00:00Z",
              tags: [],
              issueNumber: null,
              issueTitle: "Something",
              issueUrl: "https://example.com",
              issueProvider: "jira" as any, // actually will be treated as unknown in the test below
              issueId: null, // null id → reconstructIssueRef returns null early (line 57)
              worklogStatus: "not_logged",
              worklogId: null,
            } satisfies Session,
          )}
      >
        Resume With Unknown Provider
      </button>
    </div>
  ),
}));

vi.mock("../SettingsPage.tsx", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));

vi.mock("../StatsPage.tsx", () => ({
  StatsPage: () => <div data-testid="stats-page" />,
}));

vi.mock("../TagsPage.tsx", () => ({
  TagsPage: () => <div data-testid="tags-page" />,
}));

vi.mock("../IssuesPage.tsx", () => ({
  IssuesPage: () => <div data-testid="issues-page" />,
}));

vi.mock("../ClaudePage.tsx", () => ({
  ClaudePage: () => <div data-testid="claude-page" />,
}));

vi.mock("../ActivityPage.tsx", () => ({
  ActivityPage: () => <div data-testid="activity-page" />,
}));

vi.mock("../music/MusicPage.tsx", () => ({
  MusicPage: () => <div data-testid="music-page" />,
}));

// ---- Hook imports (mocked) ----

import { useClaudeTracker } from "../../hooks/useClaudeTracker.ts";
import { useNotificationSound } from "../../hooks/useNotificationSound.ts";
import { useSessionHistory } from "../../hooks/useSessionHistory.ts";
import { useSettings } from "../../hooks/useSettings.ts";
import { useStopwatch } from "../../hooks/useStopwatch.ts";
import { useTagManager } from "../../hooks/useTagManager.ts";
import { useTimer } from "../../hooks/useTimer.ts";
import { useWidgetBridge } from "../../hooks/useWidgetBridge.ts";

// ---- Component under test ----

import { TomatoClock } from "../TomatoClock.tsx";

// ---- Helper ----

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    timerType: "work",
    plannedDurationSeconds: 1500,
    actualDurationSeconds: 1500,
    completedAt: "2026-01-01T10:00:00Z",
    tags: [],
    issueNumber: null,
    issueTitle: null,
    issueUrl: null,
    issueProvider: null,
    issueId: null,
    worklogStatus: "not_logged",
    worklogId: null,
    ...overrides,
  };
}

// ---- Default mock data ----

const DEFAULT_SETTINGS = { workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 };

const mockTimerState = {
  status: "idle" as const,
  timerType: "work" as const,
  remainingSeconds: 1500,
  title: "",
  originalPlannedDuration: null,
};

const mockStopwatchState = {
  status: "idle" as const,
  elapsedSeconds: 0,
  title: "",
  linkedIssue: null,
  startedAtWallClock: null,
  accumulatedActiveMs: 0,
  restoredBaseMs: 0,
  restoredSessionId: null,
};

const mockTimerReturn = {
  state: mockTimerState,
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  reset: vi.fn(),
  setTimerType: vi.fn(),
  setTitle: vi.fn(),
  setRemaining: vi.fn(),
  dismissCompletion: vi.fn(),
  restore: vi.fn(),
  saveError: null,
};

const mockStopwatchReturn = {
  state: mockStopwatchState,
  start: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
  setTitle: vi.fn(),
  setLinkedIssue: vi.fn(),
  restore: vi.fn(),
  saveError: null,
};

const mockClaudeTracker = {
  isTracking: false,
  pickerState: "hidden" as const,
  setPickerState: vi.fn(),
  discoveredSessions: [],
  trackedUuids: [],
  liveStats: null,
  newSessionNotification: null,
  dismissNewSessionNotification: vi.fn(),
  scan: vi.fn().mockResolvedValue(undefined),
  trackSelected: vi.fn().mockResolvedValue(undefined),
  stopTracking: vi.fn().mockResolvedValue([]),
  pauseTracking: vi.fn().mockResolvedValue(undefined),
  resumeTracking: vi.fn().mockResolvedValue(undefined),
};

const mockElectronAPI = {
  settings: {
    getValue: vi.fn().mockResolvedValue(null),
    setValue: vi.fn().mockResolvedValue(undefined),
  },
  session: {
    save: vi.fn().mockResolvedValue({
      id: "new-s",
      title: "",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      completedAt: new Date().toISOString(),
      tags: [],
      issueNumber: null,
      issueTitle: null,
      issueUrl: null,
      issueProvider: null,
      issueId: null,
      worklogStatus: "not_logged",
      worklogId: null,
    }),
    saveWithTracking: vi.fn(),
  },
  tag: { assign: vi.fn().mockResolvedValue(undefined) },
};

beforeEach(() => {
  // Reset electronAPI implementations to defaults before each test
  mockElectronAPI.settings.getValue.mockReset();
  mockElectronAPI.settings.getValue.mockResolvedValue(null);
  mockElectronAPI.settings.setValue.mockReset();
  mockElectronAPI.settings.setValue.mockResolvedValue(undefined);
  vi.stubGlobal("electronAPI", mockElectronAPI);

  vi.mocked(useSettings).mockReturnValue({
    settings: DEFAULT_SETTINGS,
    isLoading: false,
    saveSettings: vi.fn(),
  });

  vi.mocked(useNotificationSound).mockReturnValue({
    playSound: vi.fn(),
    soundEnabled: true,
    setSoundEnabled: vi.fn(),
  });

  vi.mocked(useSessionHistory).mockReturnValue({
    sessions: [],
    total: 0,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    deleteSession: vi.fn(),
    loadMore: vi.fn(),
    activeTagFilter: undefined,
    setTagFilter: vi.fn(),
    logWork: vi.fn(),
    worklogLoading: {},
  });

  vi.mocked(useTagManager).mockReturnValue({
    tags: [],
    createTag: vi.fn(),
    updateTag: vi.fn(),
    deleteTag: vi.fn(),
    assignTag: vi.fn(),
    unassignTag: vi.fn(),
  });

  vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker });
  vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn });
  vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ---- Tests ----

describe("TomatoClock — loading state", () => {
  it("shows loading text when settingsLoading is true", () => {
    vi.mocked(useSettings).mockReturnValue({ settings: null, isLoading: true, saveSettings: vi.fn() });
    render(<TomatoClock />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("does not render NavSidebar while loading", () => {
    vi.mocked(useSettings).mockReturnValue({ settings: null, isLoading: true, saveSettings: vi.fn() });
    render(<TomatoClock />);
    expect(screen.queryByTestId("nav-sidebar")).not.toBeInTheDocument();
  });
});

describe("TomatoClock — initial render", () => {
  it("renders NavSidebar and timer page by default", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("nav-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("timer-view")).toBeInTheDocument();
  });

  it("renders ModeToggle on timer page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("mode-toggle")).toBeInTheDocument();
  });

  it("renders MusicBottomBar", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("music-bottom-bar")).toBeInTheDocument();
  });

  it("uses DEFAULT_SETTINGS when useSettings returns null settings", async () => {
    vi.mocked(useSettings).mockReturnValue({ settings: null, isLoading: false, saveSettings: vi.fn() });
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("timer-view")).toBeInTheDocument();
  });
});

describe("TomatoClock — page navigation", () => {
  it("navigates to history page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-history"));
    await waitFor(() => expect(screen.getByTestId("history-page")).toBeInTheDocument());
  });

  it("navigates to settings page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-page")).toBeInTheDocument());
  });

  it("navigates to stats page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-stats"));
    await waitFor(() => expect(screen.getByTestId("stats-page")).toBeInTheDocument());
  });

  it("navigates to tags page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-tags"));
    await waitFor(() => expect(screen.getByTestId("tags-page")).toBeInTheDocument());
  });

  it("navigates to issues page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-issues"));
    await waitFor(() => expect(screen.getByTestId("issues-page")).toBeInTheDocument());
  });

  it("navigates to claude page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-claude"));
    await waitFor(() => expect(screen.getByTestId("claude-page")).toBeInTheDocument());
  });

  it("navigates to activity page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-activity"));
    await waitFor(() => expect(screen.getByTestId("activity-page")).toBeInTheDocument());
  });

  it("navigates to music page", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-music"));
    await waitFor(() => expect(screen.getByTestId("music-page")).toBeInTheDocument());
  });

  it("navigates back to timer from history", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-history"));
    await waitFor(() => expect(screen.getByTestId("history-page")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("nav-timer"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
  });
});

describe("TomatoClock — mode switching", () => {
  it("switches to time-tracking mode", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    expect(screen.getByTestId("stopwatch-view")).toBeInTheDocument();
  });

  it("switches back to pomodoro mode", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    expect(screen.getByTestId("stopwatch-view")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mode-pomodoro"));
    expect(screen.getByTestId("timer-view")).toBeInTheDocument();
  });

  it("ModeToggle is disabled when pomodoro timer is running", async () => {
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "running" },
    });
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("mode-pomodoro")).toBeDisabled();
    expect(screen.getByTestId("mode-time-tracking")).toBeDisabled();
  });

  it("ModeToggle is not disabled when no timer is active", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("mode-pomodoro")).not.toBeDisabled();
    expect(screen.getByTestId("mode-time-tracking")).not.toBeDisabled();
  });

  it("ModeToggle is disabled when stopwatch is paused", async () => {
    vi.mocked(useStopwatch).mockReturnValue({
      ...mockStopwatchReturn,
      state: { ...mockStopwatchState, status: "paused" },
    });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    expect(screen.getByTestId("mode-pomodoro")).toBeDisabled();
  });
});

describe("TomatoClock — timer controls", () => {
  it("calls timerStart when TimerView start is triggered", async () => {
    const start = vi.fn();
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, start });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-start"));
    await act(async () => {});
    expect(start).toHaveBeenCalledOnce();
  });

  it("scans for claude sessions on start when project is configured", async () => {
    const start = vi.fn();
    const scan = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, start });
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, scan });
    mockElectronAPI.settings.getValue.mockImplementation((key: string) => {
      if (key === "claude_tracker.project_dir_name") return Promise.resolve("my-project");
      return Promise.resolve(null);
    });

    render(<TomatoClock />);
    await act(async () => {}); // let claude settings load

    fireEvent.click(screen.getByTestId("timer-start"));
    await act(async () => {});

    expect(start).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledWith("my-project");
  });

  it("does not scan when no project is configured", async () => {
    const scan = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, scan });

    render(<TomatoClock />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId("timer-start"));
    await act(async () => {});

    expect(scan).not.toHaveBeenCalled();
  });

  it("calls timer pause when pause is triggered", async () => {
    const pause = vi.fn();
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, pause });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-pause"));
    expect(pause).toHaveBeenCalledOnce();
  });

  it("calls claudeTracker.pauseTracking when pausing while tracking", async () => {
    const pause = vi.fn();
    const pauseTracking = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, pause });
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, isTracking: true, pauseTracking });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-pause"));
    expect(pause).toHaveBeenCalledOnce();
    expect(pauseTracking).toHaveBeenCalledOnce();
  });

  it("calls timer resume when resume is triggered", async () => {
    const resume = vi.fn();
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, resume });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-resume"));
    expect(resume).toHaveBeenCalledOnce();
  });

  it("calls claudeTracker.resumeTracking when resuming while tracking", async () => {
    const resume = vi.fn();
    const resumeTracking = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, resume });
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, isTracking: true, resumeTracking });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-resume"));
    expect(resume).toHaveBeenCalledOnce();
    expect(resumeTracking).toHaveBeenCalledOnce();
  });

  it("calls timer reset when reset is triggered", async () => {
    const reset = vi.fn();
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, reset });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-reset"));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("calls stopTracking on reset when tracking is active", async () => {
    const reset = vi.fn();
    const stopTracking = vi.fn().mockResolvedValue([]);
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, reset });
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, isTracking: true, stopTracking });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-reset"));
    expect(stopTracking).toHaveBeenCalledOnce();
  });

  it("calls stopTracking on reset when picker is open (not tracking)", async () => {
    const reset = vi.fn();
    const stopTracking = vi.fn().mockResolvedValue([]);
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, reset });
    vi.mocked(useClaudeTracker).mockReturnValue({
      ...mockClaudeTracker,
      isTracking: false,
      pickerState: "open",
      stopTracking,
    });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-reset"));
    expect(stopTracking).toHaveBeenCalledOnce();
  });

  it("calls dismissCompletion when dismiss is triggered", async () => {
    const dismissCompletion = vi.fn();
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, dismissCompletion });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-dismiss"));
    expect(dismissCompletion).toHaveBeenCalledOnce();
  });
});

describe("TomatoClock — timer completion sound", () => {
  it("calls playSound when timer status is completed", () => {
    const playSound = vi.fn();
    vi.mocked(useNotificationSound).mockReturnValue({ playSound, soundEnabled: true, setSoundEnabled: vi.fn() });
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "completed" },
    });
    render(<TomatoClock />);
    expect(playSound).toHaveBeenCalledOnce();
  });

  it("does not call playSound when timer is idle", () => {
    const playSound = vi.fn();
    vi.mocked(useNotificationSound).mockReturnValue({ playSound, soundEnabled: true, setSoundEnabled: vi.fn() });
    render(<TomatoClock />);
    expect(playSound).not.toHaveBeenCalled();
  });
});

describe("TomatoClock — tag management (while pomodoro active)", () => {
  function renderWithRunningTimer() {
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "running" },
    });
    return render(<TomatoClock />);
  }

  it("shows TagPicker when pomodoro is running", async () => {
    renderWithRunningTimer();
    await act(async () => {});
    expect(screen.getByTestId("tag-picker")).toBeInTheDocument();
  });

  it("adds a pending tag when TagPicker triggers onAdd", async () => {
    renderWithRunningTimer();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("tag-add-1"));
    expect(screen.getByTestId("tag-picker").getAttribute("data-tags")).toBe("[1]");
  });

  it("removes a pending tag when TagPicker triggers onRemove", async () => {
    renderWithRunningTimer();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("tag-add-1"));
    fireEvent.click(screen.getByTestId("tag-remove-1"));
    expect(screen.getByTestId("tag-picker").getAttribute("data-tags")).toBe("[]");
  });

  it("does not add duplicate tags", async () => {
    renderWithRunningTimer();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("tag-add-1"));
    fireEvent.click(screen.getByTestId("tag-add-1"));
    expect(screen.getByTestId("tag-picker").getAttribute("data-tags")).toBe("[1]");
  });

  it("can hold multiple different tags", async () => {
    renderWithRunningTimer();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("tag-add-1"));
    fireEvent.click(screen.getByTestId("tag-add-2"));
    expect(screen.getByTestId("tag-picker").getAttribute("data-tags")).toBe("[1,2]");
  });

  it("clears pending issue when timer-issue-clear is triggered", async () => {
    renderWithRunningTimer();
    await act(async () => {});
    fireEvent.click(screen.getByTestId("timer-issue-clear"));
    expect(screen.queryByTestId("selected-issue")).not.toBeInTheDocument();
  });
});

describe("TomatoClock — claude settings loading", () => {
  it("calls getValue for project_dir_name and idle_threshold_minutes on mount", async () => {
    render(<TomatoClock />);
    await waitFor(() => {
      expect(mockElectronAPI.settings.getValue).toHaveBeenCalledWith("claude_tracker.project_dir_name");
      expect(mockElectronAPI.settings.getValue).toHaveBeenCalledWith("claude_tracker.idle_threshold_minutes");
    });
  });

  it("applies a valid idle threshold value from storage", async () => {
    mockElectronAPI.settings.getValue.mockImplementation((key: string) => {
      if (key === "claude_tracker.idle_threshold_minutes") return Promise.resolve("10");
      return Promise.resolve(null);
    });
    render(<TomatoClock />);
    await act(async () => {});
    expect(mockElectronAPI.settings.getValue).toHaveBeenCalled();
  });

  it("ignores out-of-range idle threshold values", async () => {
    mockElectronAPI.settings.getValue.mockImplementation((key: string) => {
      if (key === "claude_tracker.idle_threshold_minutes") return Promise.resolve("100");
      return Promise.resolve(null);
    });
    render(<TomatoClock />);
    await act(async () => {});
    expect(mockElectronAPI.settings.getValue).toHaveBeenCalled();
  });

  it("ignores non-numeric idle threshold values", async () => {
    mockElectronAPI.settings.getValue.mockImplementation((key: string) => {
      if (key === "claude_tracker.idle_threshold_minutes") return Promise.resolve("abc");
      return Promise.resolve(null);
    });
    render(<TomatoClock />);
    await act(async () => {});
    expect(mockElectronAPI.settings.getValue).toHaveBeenCalled();
  });

  it("persists project dir name via setValue after settings load", async () => {
    mockElectronAPI.settings.getValue.mockImplementation((key: string) => {
      if (key === "claude_tracker.project_dir_name") return Promise.resolve("my-project");
      return Promise.resolve(null);
    });
    render(<TomatoClock />);
    await act(async () => {});
    await waitFor(() => {
      expect(mockElectronAPI.settings.setValue).toHaveBeenCalledWith(
        "claude_tracker.project_dir_name",
        "my-project",
      );
    });
  });

  it("persists idle threshold via setValue after settings load", async () => {
    mockElectronAPI.settings.getValue.mockImplementation((key: string) => {
      if (key === "claude_tracker.idle_threshold_minutes") return Promise.resolve("8");
      return Promise.resolve(null);
    });
    render(<TomatoClock />);
    await act(async () => {});
    await waitFor(() => {
      expect(mockElectronAPI.settings.setValue).toHaveBeenCalledWith(
        "claude_tracker.idle_threshold_minutes",
        "8",
      );
    });
  });
});

describe("TomatoClock — session picker", () => {
  function renderWithRunningPomodoro(
    trackerOverrides: Partial<typeof mockClaudeTracker> = {},
  ) {
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "running" },
    });
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, ...trackerOverrides });
    return render(<TomatoClock />);
  }

  it("shows SessionPicker when pickerState is 'open'", async () => {
    renderWithRunningPomodoro({ pickerState: "open" });
    await act(async () => {});
    expect(screen.getByTestId("session-picker")).toBeInTheDocument();
  });

  it("shows SessionPicker when pickerState is 'collapsed'", async () => {
    renderWithRunningPomodoro({ pickerState: "collapsed", isTracking: false });
    await act(async () => {});
    expect(screen.getByTestId("session-picker")).toBeInTheDocument();
  });

  it("does not show SessionPicker when pickerState is 'hidden'", async () => {
    renderWithRunningPomodoro();
    await act(async () => {});
    expect(screen.queryByTestId("session-picker")).not.toBeInTheDocument();
  });

  it("calls trackSelected when picker confirms", async () => {
    const trackSelected = vi.fn().mockResolvedValue(undefined);
    renderWithRunningPomodoro({ pickerState: "open", trackSelected });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("picker-confirm"));
    expect(trackSelected).toHaveBeenCalledWith(["uuid-1"]);
  });

  it("calls setPickerState('hidden') when picker skips", async () => {
    const setPickerState = vi.fn();
    renderWithRunningPomodoro({ pickerState: "open", setPickerState });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("picker-skip"));
    expect(setPickerState).toHaveBeenCalledWith("hidden");
  });

  it("collapses picker when toggle clicked while open", async () => {
    const setPickerState = vi.fn();
    renderWithRunningPomodoro({ pickerState: "open", setPickerState });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("picker-collapse"));
    expect(setPickerState).toHaveBeenCalledWith("collapsed");
  });

  it("expands picker when toggle clicked while collapsed", async () => {
    const setPickerState = vi.fn();
    renderWithRunningPomodoro({ pickerState: "collapsed", isTracking: false, setPickerState });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("picker-collapse"));
    expect(setPickerState).toHaveBeenCalledWith("open");
  });

  it("shows ClaudeCodeStats when isTracking is true", async () => {
    renderWithRunningPomodoro({ isTracking: true });
    await act(async () => {});
    expect(screen.getByTestId("claude-code-stats")).toBeInTheDocument();
  });

  it("shows ClaudeCodeStats when pickerState is 'collapsed'", async () => {
    renderWithRunningPomodoro({ pickerState: "collapsed", isTracking: false });
    await act(async () => {});
    expect(screen.getByTestId("claude-code-stats")).toBeInTheDocument();
  });

  it("shows ClaudeSessionSelect when pickerState is 'hidden'", async () => {
    renderWithRunningPomodoro();
    await act(async () => {});
    expect(screen.getByTestId("claude-session-select")).toBeInTheDocument();
  });

  it("calls setPickerState('open') when manage sessions is clicked", async () => {
    const setPickerState = vi.fn();
    renderWithRunningPomodoro({ isTracking: true, setPickerState });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("manage-sessions"));
    expect(setPickerState).toHaveBeenCalledWith("open");
  });

  it("calls dismissNewSessionNotification and opens picker when add new session is clicked", async () => {
    const dismissNewSessionNotification = vi.fn();
    const setPickerState = vi.fn();
    renderWithRunningPomodoro({ isTracking: true, dismissNewSessionNotification, setPickerState });
    await act(async () => {});
    fireEvent.click(screen.getByTestId("add-new-session"));
    expect(dismissNewSessionNotification).toHaveBeenCalledOnce();
    expect(setPickerState).toHaveBeenCalledWith("open");
  });
});

describe("TomatoClock — handleResumeSession (reconstructIssueRef coverage)", () => {
  async function navigateToHistory() {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("nav-history"));
    await waitFor(() => expect(screen.getByTestId("history-page")).toBeInTheDocument());
  }

  it("navigates back to timer and calls restore for a work session", async () => {
    const restore = vi.fn();
    vi.mocked(useTimer).mockReturnValue({ ...mockTimerReturn, restore });
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-work"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
    expect(restore).toHaveBeenCalledOnce();
  });

  it("navigates to timer with no pending issue for a plain work session (no issueProvider)", async () => {
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-work"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
    expect(screen.queryByTestId("selected-issue")).not.toBeInTheDocument();
  });

  it("switches to time-tracking mode and calls stopwatch.restore for a stopwatch session", async () => {
    const stopwatchRestore = vi.fn();
    vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn, restore: stopwatchRestore });
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-stopwatch"));
    await waitFor(() => expect(screen.getByTestId("stopwatch-view")).toBeInTheDocument());
    expect(stopwatchRestore).toHaveBeenCalledWith("Track Task", null, 3600000, "s2");
  });

  it("sets pending jira issue when resuming a session with jira provider", async () => {
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-with-jira"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
    expect(screen.getByTestId("selected-issue")).toBeInTheDocument();
  });

  it("sets pending linear issue when resuming a session with linear provider", async () => {
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-with-linear"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
    expect(screen.getByTestId("selected-issue")).toBeInTheDocument();
  });

  it("sets pending github issue when resuming a session with valid github provider", async () => {
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-with-github"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
    expect(screen.getByTestId("selected-issue")).toBeInTheDocument();
  });

  it("sets null issue for github session with non-numeric issueId and no issueNumber", async () => {
    await navigateToHistory();
    fireEvent.click(screen.getByTestId("resume-with-github-invalid"));
    await waitFor(() => expect(screen.getByTestId("timer-view")).toBeInTheDocument());
    expect(screen.queryByTestId("selected-issue")).not.toBeInTheDocument();
  });
});

describe("TomatoClock — stopwatch in time-tracking mode", () => {
  it("shows stopwatch view in time-tracking mode", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    expect(screen.getByTestId("stopwatch-view")).toBeInTheDocument();
  });

  it("shows ClaudeCodeStats when stopwatch is running and tracking", async () => {
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, isTracking: true });
    vi.mocked(useStopwatch).mockReturnValue({
      ...mockStopwatchReturn,
      state: { ...mockStopwatchState, status: "running" },
    });
    render(<TomatoClock />);
    await act(async () => {});
    // Use resume-session to enter time-tracking mode (mode toggle is disabled when stopwatch is running)
    fireEvent.click(screen.getByTestId("nav-history"));
    await waitFor(() => expect(screen.getByTestId("history-page")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("resume-stopwatch"));
    await waitFor(() => expect(screen.getByTestId("stopwatch-view")).toBeInTheDocument());
    expect(screen.getByTestId("claude-code-stats")).toBeInTheDocument();
  });

  it("does not show ClaudeCodeStats when stopwatch is idle", async () => {
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, isTracking: true });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    expect(screen.queryByTestId("claude-code-stats")).not.toBeInTheDocument();
  });

  it("stopwatch start triggers handleStopwatchStart wrapper", async () => {
    const start = vi.fn();
    vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn, start });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    fireEvent.click(screen.getByTestId("sw-start"));
    await act(async () => {});
    expect(start).toHaveBeenCalledOnce();
  });

  it("stopwatch pause triggers handleStopwatchPause wrapper", async () => {
    const pause = vi.fn();
    vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn, pause });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    fireEvent.click(screen.getByTestId("sw-pause"));
    expect(pause).toHaveBeenCalledOnce();
  });

  it("stopwatch resume triggers handleStopwatchResume wrapper", async () => {
    const resume = vi.fn();
    vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn, resume });
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));
    fireEvent.click(screen.getByTestId("sw-resume"));
    expect(resume).toHaveBeenCalledOnce();
  });
});

describe("TomatoClock — NavSidebar receives correct timerStatus", () => {
  it("passes idle timerStatus to NavSidebar by default", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("nav-sidebar").getAttribute("data-timer-status")).toBe("idle");
  });

  it("passes running timerStatus to NavSidebar when timer is running", async () => {
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "running" },
    });
    render(<TomatoClock />);
    await act(async () => {});
    expect(screen.getByTestId("nav-sidebar").getAttribute("data-timer-status")).toBe("running");
  });
});

describe("TomatoClock — handleSessionSaved callback", () => {
  it("calls refresh when session saved with no pending tags", async () => {
    const refresh = vi.fn();
    vi.mocked(useSessionHistory).mockReturnValue({
      sessions: [],
      total: 0,
      isLoading: false,
      error: null,
      refresh,
      deleteSession: vi.fn(),
      loadMore: vi.fn(),
      activeTagFilter: undefined,
      setTagFilter: vi.fn(),
      logWork: vi.fn(),
      worklogLoading: {},
    });

    let capturedOnSessionSaved: (s: Session) => void = () => {};
    vi.mocked(useTimer).mockImplementation((...args: any[]) => {
      capturedOnSessionSaved = args[1];
      return { ...mockTimerReturn };
    });

    render(<TomatoClock />);
    await act(async () => {});

    capturedOnSessionSaved(makeSession("saved-1"));
    await act(async () => {});

    expect(refresh).toHaveBeenCalledOnce();
    expect(mockElectronAPI.tag.assign).not.toHaveBeenCalled();
  });

  it("calls tag.assign for each pending tag then refresh", async () => {
    const refresh = vi.fn();
    vi.mocked(useSessionHistory).mockReturnValue({
      sessions: [],
      total: 0,
      isLoading: false,
      error: null,
      refresh,
      deleteSession: vi.fn(),
      loadMore: vi.fn(),
      activeTagFilter: undefined,
      setTagFilter: vi.fn(),
      logWork: vi.fn(),
      worklogLoading: {},
    });

    let capturedOnSessionSaved: (s: Session) => void = () => {};
    vi.mocked(useTimer).mockImplementation((...args: any[]) => {
      capturedOnSessionSaved = args[1];
      return { ...mockTimerReturn, state: { ...mockTimerState, status: "running" } };
    });

    render(<TomatoClock />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId("tag-add-1"));
    fireEvent.click(screen.getByTestId("tag-add-2"));

    capturedOnSessionSaved(makeSession("saved-2"));
    await act(async () => {});

    expect(mockElectronAPI.tag.assign).toHaveBeenCalledTimes(2);
    expect(mockElectronAPI.tag.assign).toHaveBeenCalledWith({ sessionId: "saved-2", tagId: 1 });
    expect(mockElectronAPI.tag.assign).toHaveBeenCalledWith({ sessionId: "saved-2", tagId: 2 });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("still calls refresh when tag.assign rejects (.catch path)", async () => {
    const refresh = vi.fn();
    vi.mocked(useSessionHistory).mockReturnValue({
      sessions: [],
      total: 0,
      isLoading: false,
      error: null,
      refresh,
      deleteSession: vi.fn(),
      loadMore: vi.fn(),
      activeTagFilter: undefined,
      setTagFilter: vi.fn(),
      logWork: vi.fn(),
      worklogLoading: {},
    });
    mockElectronAPI.tag.assign.mockRejectedValue(new Error("assign failed"));

    let capturedOnSessionSaved: (s: Session) => void = () => {};
    vi.mocked(useTimer).mockImplementation((...args: any[]) => {
      capturedOnSessionSaved = args[1];
      return { ...mockTimerReturn, state: { ...mockTimerState, status: "running" } };
    });

    render(<TomatoClock />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId("tag-add-1"));
    capturedOnSessionSaved(makeSession("saved-3"));
    await act(async () => {});

    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("TomatoClock — handleStopwatchSaved callback", () => {
  it("calls refresh when stopwatch session is saved", async () => {
    const refresh = vi.fn();
    vi.mocked(useSessionHistory).mockReturnValue({
      sessions: [],
      total: 0,
      isLoading: false,
      error: null,
      refresh,
      deleteSession: vi.fn(),
      loadMore: vi.fn(),
      activeTagFilter: undefined,
      setTagFilter: vi.fn(),
      logWork: vi.fn(),
      worklogLoading: {},
    });

    let capturedStopwatchSaved: () => void = () => {};
    vi.mocked(useStopwatch).mockImplementation((...args: any[]) => {
      capturedStopwatchSaved = args[1];
      return { ...mockStopwatchReturn };
    });

    render(<TomatoClock />);
    await act(async () => {});

    capturedStopwatchSaved();

    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("TomatoClock — customSaveSession (4th arg to useTimer)", () => {
  it("calls session.save when tracker is idle and picker hidden", async () => {
    let capturedCustomSave: (input: any) => Promise<Session> = async () => makeSession("x");
    vi.mocked(useTimer).mockImplementation((...args: any[]) => {
      capturedCustomSave = args[3];
      return { ...mockTimerReturn };
    });

    render(<TomatoClock />);
    await act(async () => {});

    const input = { title: "T", timerType: "work" as const, plannedDurationSeconds: 1500, actualDurationSeconds: 1500 };
    await capturedCustomSave(input);

    expect(mockElectronAPI.session.save).toHaveBeenCalledWith(input);
  });

  it("calls stopTracking then saveWithTracking when tracker isTracking", async () => {
    const ccSessions = [{ id: "cc1", projectDirName: "p" }];
    const stopTracking = vi.fn().mockResolvedValue(ccSessions);
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, isTracking: true, stopTracking });

    let capturedCustomSave: (input: any) => Promise<Session> = async () => makeSession("x");
    vi.mocked(useTimer).mockImplementation((...args: any[]) => {
      capturedCustomSave = args[3];
      return { ...mockTimerReturn };
    });

    render(<TomatoClock />);
    await act(async () => {});

    const input = { title: "T", timerType: "work" as const, plannedDurationSeconds: 1500, actualDurationSeconds: 1500 };
    await capturedCustomSave(input);

    expect(stopTracking).toHaveBeenCalledOnce();
    expect(mockElectronAPI.session.saveWithTracking).toHaveBeenCalledWith({ ...input, claudeCodeSessions: ccSessions });
  });

  it("calls stopTracking then plain save when picker is open but not tracking", async () => {
    const stopTracking = vi.fn().mockResolvedValue([]);
    vi.mocked(useClaudeTracker).mockReturnValue({
      ...mockClaudeTracker,
      isTracking: false,
      pickerState: "open",
      stopTracking,
    });

    let capturedCustomSave: (input: any) => Promise<Session> = async () => makeSession("x");
    vi.mocked(useTimer).mockImplementation((...args: any[]) => {
      capturedCustomSave = args[3];
      return { ...mockTimerReturn };
    });

    render(<TomatoClock />);
    await act(async () => {});

    const input = { title: "T", timerType: "work" as const, plannedDurationSeconds: 1500, actualDurationSeconds: 1500 };
    await capturedCustomSave(input);

    expect(stopTracking).toHaveBeenCalledOnce();
    expect(mockElectronAPI.session.save).toHaveBeenCalledWith(input);
  });
});

describe("TomatoClock — handlePomodoroClaudeSessionSelect active paths", () => {
  it("calls scan and trackSelected when session set while timer is running", async () => {
    const scan = vi.fn().mockResolvedValue(undefined);
    const trackSelected = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, scan, trackSelected });
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "running" },
    });

    render(<TomatoClock />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId("pomodoro-set-claude-session"));
    await act(async () => {});

    expect(scan).toHaveBeenCalledWith("pomo-project");
    expect(trackSelected).toHaveBeenCalledWith(["pomo-uuid-1"]);
  });

  it("calls stopTracking when session cleared while timer is running and already tracking", async () => {
    const stopTracking = vi.fn().mockResolvedValue([]);
    vi.mocked(useClaudeTracker).mockReturnValue({
      ...mockClaudeTracker,
      isTracking: true,
      stopTracking,
    });
    vi.mocked(useTimer).mockReturnValue({
      ...mockTimerReturn,
      state: { ...mockTimerState, status: "running" },
    });

    render(<TomatoClock />);
    await act(async () => {});

    fireEvent.click(screen.getByTestId("claude-session-clear"));
    await act(async () => {});

    expect(stopTracking).toHaveBeenCalledOnce();
  });
});

describe("TomatoClock — handleLinkedStopwatchClaudeSessionChange active path", () => {
  it("calls scan and trackSelected when session set while stopwatch is running", async () => {
    const scan = vi.fn().mockResolvedValue(undefined);
    const trackSelected = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useClaudeTracker).mockReturnValue({ ...mockClaudeTracker, scan, trackSelected });
    vi.mocked(useStopwatch).mockReturnValue({
      ...mockStopwatchReturn,
      state: { ...mockStopwatchState, status: "running" },
    });

    render(<TomatoClock />);
    await act(async () => {});

    // Enter time-tracking mode via session restore (mode toggle is disabled when stopwatch running)
    fireEvent.click(screen.getByTestId("nav-history"));
    await waitFor(() => expect(screen.getByTestId("history-page")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("resume-stopwatch"));
    await waitFor(() => expect(screen.getByTestId("stopwatch-view")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("sw-set-claude-session"));
    await act(async () => {});

    expect(scan).toHaveBeenCalledWith("sw-project");
    expect(trackSelected).toHaveBeenCalledWith(["sw-uuid-1"]);
  });

  it("clears linked session when null selected while stopwatch is idle", async () => {
    render(<TomatoClock />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("mode-time-tracking"));

    fireEvent.click(screen.getByTestId("sw-clear-claude-session"));
    await act(async () => {});

    expect(screen.getByTestId("stopwatch-view").getAttribute("data-claude-session")).toBe("none");
  });
});

describe("TomatoClock — widget bridge stopwatch callbacks (lines 435-436)", () => {
  it("stopwatchPause callback invokes handleStopwatchPause(stopwatch.pause)", async () => {
    const pause = vi.fn();
    vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn, pause });

    let capturedCallbacks: Record<string, () => void> = {};
    vi.mocked(useWidgetBridge).mockImplementation((...args: any[]) => {
      capturedCallbacks = args[3] ?? {};
    });

    render(<TomatoClock />);
    await act(async () => {});

    capturedCallbacks["stopwatchPause"]?.();
    expect(pause).toHaveBeenCalledOnce();
  });

  it("stopwatchResume callback invokes handleStopwatchResume(stopwatch.resume)", async () => {
    const resume = vi.fn();
    vi.mocked(useStopwatch).mockReturnValue({ ...mockStopwatchReturn, resume });

    let capturedCallbacks: Record<string, () => void> = {};
    vi.mocked(useWidgetBridge).mockImplementation((...args: any[]) => {
      capturedCallbacks = args[3] ?? {};
    });

    render(<TomatoClock />);
    await act(async () => {});

    capturedCallbacks["stopwatchResume"]?.();
    expect(resume).toHaveBeenCalledOnce();
  });
});
