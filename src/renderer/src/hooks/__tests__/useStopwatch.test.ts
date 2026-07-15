import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRef, Session } from "../../../../../shared/types.ts";
import { useStopwatch } from "../useStopwatch.ts";

// --- Mock electronAPI ---

const mockSavedSession: Session = {
  id: "sess-1",
  title: "",
  timerType: "stopwatch",
  plannedDurationSeconds: 0,
  actualDurationSeconds: 0,
  completedAt: new Date().toISOString(),
  tags: [],
  issueNumber: null,
  issueTitle: null,
  issueUrl: null,
  issueProvider: null,
  issueId: null,
  worklogStatus: "none",
  worklogId: null,
};

const mockUpdatedSession: Session = {
  id: "restored-1",
  title: "",
  timerType: "stopwatch",
  plannedDurationSeconds: 0,
  actualDurationSeconds: 0,
  completedAt: new Date().toISOString(),
  tags: [],
  issueNumber: null,
  issueTitle: null,
  issueUrl: null,
  issueProvider: null,
  issueId: null,
  worklogStatus: "none",
  worklogId: null,
};

const mockElectronAPI = {
  session: {
    save: vi.fn().mockResolvedValue(mockSavedSession),
    updateDuration: vi.fn().mockResolvedValue(mockUpdatedSession),
  },
};

const defaultSettings = { maxDurationSeconds: 0, promptForIssue: false };

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
  mockElectronAPI.session.save.mockResolvedValue(mockSavedSession);
  mockElectronAPI.session.updateDuration.mockResolvedValue(mockUpdatedSession);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- TC-SW-01: Initial state ---

describe("TC-SW-01: Initial state is idle", () => {
  it("starts with idle status, elapsedSeconds=0, empty title, null linkedIssue", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.elapsedSeconds).toBe(0);
    expect(result.current.state.title).toBe("");
    expect(result.current.state.linkedIssue).toBeNull();
    expect(result.current.saveError).toBeNull();
  });
});

// --- TC-SW-02: start() transitions to running ---

describe("TC-SW-02: start() transitions from idle to running", () => {
  it("status becomes running after start()", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.start());

    expect(result.current.state.status).toBe("running");
  });
});

// --- TC-SW-03: pause() from running transitions to paused ---

describe("TC-SW-03: pause() from running transitions to paused", () => {
  it("status becomes paused after start then pause", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.start());
    act(() => result.current.pause());

    expect(result.current.state.status).toBe("paused");
  });
});

// --- TC-SW-04: resume() from paused transitions to running ---

describe("TC-SW-04: resume() from paused transitions to running", () => {
  it("status becomes running after start, pause, resume", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.start());
    act(() => result.current.pause());
    act(() => result.current.resume());

    expect(result.current.state.status).toBe("running");
  });
});

// --- TC-SW-05: stop() from running saves and goes idle ---

describe("TC-SW-05: stop() from running transitions to idle and saves", () => {
  it("calls session.save and returns to idle when stopped from running", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.start());
    // Advance so accumulatedActiveMs > 0 when stopped
    act(() => vi.advanceTimersByTime(2000));
    act(() => result.current.stop());

    expect(result.current.state.status).toBe("idle");

    vi.useRealTimers();

    await waitFor(() => {
      expect(mockElectronAPI.session.save).toHaveBeenCalledOnce();
    });
  });
});

// --- TC-SW-06: stop() from paused saves and goes idle ---

describe("TC-SW-06: stop() from paused transitions to idle and saves", () => {
  it("calls session.save and returns to idle when stopped from paused", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(2000));
    act(() => result.current.pause());
    act(() => result.current.stop());

    expect(result.current.state.status).toBe("idle");

    vi.useRealTimers();

    await waitFor(() => {
      expect(mockElectronAPI.session.save).toHaveBeenCalledOnce();
    });
  });
});

// --- TC-SW-07: setTitle sets title in state ---

describe("TC-SW-07: setTitle sets title in state", () => {
  it("updates title to the provided string", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.setTitle("Hello"));

    expect(result.current.state.title).toBe("Hello");
  });
});

// --- TC-SW-08: setTitle trims to MAX_TITLE_LENGTH (5000) ---

describe("TC-SW-08: setTitle trims title to 5000 characters", () => {
  it("title is sliced to 5000 chars when input is longer", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));
    const longTitle = "x".repeat(5001);

    act(() => result.current.setTitle(longTitle));

    expect(result.current.state.title).toHaveLength(5000);
    expect(result.current.state.title).toBe("x".repeat(5000));
  });
});

// --- TC-SW-09: setLinkedIssue sets linkedIssue in state ---

describe("TC-SW-09: setLinkedIssue sets linkedIssue in state", () => {
  it("updates linkedIssue to provided IssueRef", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));
    const issue: IssueRef = {
      provider: "jira",
      key: "PROJ-1",
      title: "Fix bug",
      url: "https://jira.example.com/PROJ-1",
    };

    act(() => result.current.setLinkedIssue(issue));

    expect(result.current.state.linkedIssue).toEqual(issue);
  });
});

// --- TC-SW-10: restore() sets title, linkedIssue, restoredSessionId, and elapsedSeconds ---

describe("TC-SW-10: restore() sets restored fields and elapsedSeconds", () => {
  it("sets title, linkedIssue, restoredSessionId, and elapsedSeconds=Math.round(baseMs/1000)", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));
    const issue: IssueRef = {
      provider: "jira",
      key: "PROJ-2",
      title: "Another bug",
      url: "https://jira.example.com/PROJ-2",
    };
    const baseMs = 3661000; // 3661 seconds

    act(() => result.current.restore("Restored task", issue, baseMs, "restored-session-id"));

    expect(result.current.state.title).toBe("Restored task");
    expect(result.current.state.linkedIssue).toEqual(issue);
    expect(result.current.state.restoredSessionId).toBe("restored-session-id");
    expect(result.current.state.elapsedSeconds).toBe(Math.round(baseMs / 1000));
  });
});

// --- TC-SW-11: After restore+start+stop, calls updateDuration not save ---

describe("TC-SW-11: After restore+start+stop, calls updateDuration instead of save", () => {
  it("calls session.updateDuration with the restored session id", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.restore("Restored", null, 5000, "restored-1"));
    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.stop());

    vi.useRealTimers();

    await waitFor(() => {
      expect(mockElectronAPI.session.updateDuration).toHaveBeenCalledOnce();
    });

    expect(mockElectronAPI.session.save).not.toHaveBeenCalled();

    const callArg = mockElectronAPI.session.updateDuration.mock.calls[0]![0] as {
      id: string;
      actualDurationSeconds: number;
    };
    expect(callArg.id).toBe("restored-1");
  });
});

// --- TC-SW-12: reset() from idle with restoredSessionId returns to clean initial state ---

describe("TC-SW-12: reset() from idle with restoredSessionId clears state", () => {
  it("returns to initial state after restore then reset", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));
    const issue: IssueRef = {
      provider: "jira",
      key: "PROJ-3",
      title: "Reset test",
      url: "https://jira.example.com/PROJ-3",
    };

    act(() => result.current.restore("Some title", issue, 10000, "session-to-cancel"));
    expect(result.current.state.restoredSessionId).toBe("session-to-cancel");

    act(() => result.current.reset());

    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.title).toBe("");
    expect(result.current.state.linkedIssue).toBeNull();
    expect(result.current.state.elapsedSeconds).toBe(0);
    expect(result.current.state.restoredSessionId).toBeNull();
    expect(result.current.state.accumulatedActiveMs).toBe(0);
  });
});

// --- TC-SW-13: reset() without restoredSessionId does nothing ---

describe("TC-SW-13: reset() without restoredSessionId does nothing", () => {
  it("state is unchanged when reset() called from clean idle", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.setTitle("My task"));
    act(() => result.current.reset());

    // Title should be unchanged — reset was a no-op
    expect(result.current.state.title).toBe("My task");
    expect(result.current.state.status).toBe("idle");
  });
});

// --- TC-SW-14: pause() when idle does nothing ---

describe("TC-SW-14: pause() when idle does nothing", () => {
  it("status stays idle after pause() called without starting", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.pause());

    expect(result.current.state.status).toBe("idle");
  });
});

// --- TC-SW-15: resume() when idle does nothing ---

describe("TC-SW-15: resume() when idle does nothing", () => {
  it("status stays idle after resume() called without starting", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.resume());

    expect(result.current.state.status).toBe("idle");
  });
});

// --- TC-SW-16: saveError is null initially; set if save throws ---

describe("TC-SW-16: saveError reflects save failures", () => {
  it("saveError is null initially", () => {
    const { result } = renderHook(() => useStopwatch(defaultSettings));
    expect(result.current.saveError).toBeNull();
  });

  it("saveError is set when session.save rejects", async () => {
    mockElectronAPI.session.save.mockRejectedValueOnce(new Error("DB write failed"));

    vi.useFakeTimers();

    const { result } = renderHook(() => useStopwatch(defaultSettings));

    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(2000));
    act(() => result.current.stop());

    vi.useRealTimers();

    await waitFor(() => {
      expect(result.current.saveError).not.toBeNull();
    });

    expect(result.current.saveError).toBe("DB write failed");
  });
});
