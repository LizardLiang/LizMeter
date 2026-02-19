import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimerSettings } from "../../../../shared/types.ts";
import { useTimer } from "../useTimer.ts";

const defaultSettings: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
};

const shortSettings: TimerSettings = {
  workDuration: 3,
  shortBreakDuration: 3,
  longBreakDuration: 3,
};

const mockElectronAPI = {
  platform: "linux",
  session: {
    save: vi.fn(),
    list: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue(defaultSettings),
    save: vi.fn().mockResolvedValue(undefined),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
  mockElectronAPI.session.save.mockResolvedValue({
    id: "mock-id",
    title: "Complete Me",
    timerType: "work",
    plannedDurationSeconds: 3,
    actualDurationSeconds: 3,
    completedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TC-501: useTimer starts countdown and ticks correctly", () => {
  it("decrements remainingSeconds as fake timers advance", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useTimer(defaultSettings));

    act(() => result.current.start());
    expect(result.current.state.status).toBe("running");

    // Advance 1 second
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.state.remainingSeconds).toBeLessThanOrEqual(1500);

    // Advance 4 more seconds (total 5)
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.state.remainingSeconds).toBeLessThanOrEqual(1496);
    expect(result.current.state.remainingSeconds).toBeGreaterThanOrEqual(1490);

    vi.useRealTimers();
  });
});

describe("TC-502: useTimer pause stops the countdown", () => {
  it("remainingSeconds frozen during pause", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useTimer(defaultSettings));

    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(3000));

    const R = result.current.state.remainingSeconds;
    expect(R).toBeLessThan(1500);

    act(() => result.current.pause());
    expect(result.current.state.status).toBe("paused");

    // Advance another 5 seconds — should NOT change remainingSeconds
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.state.remainingSeconds).toBe(R);
    expect(result.current.state.status).toBe("paused");

    vi.useRealTimers();
  });
});

describe("TC-503: useTimer reset returns to configured duration", () => {
  it("resets to 1500 and does not save session", () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => useTimer(defaultSettings));

    act(() => result.current.start());
    act(() => vi.advanceTimersByTime(10000));
    act(() => result.current.reset());

    expect(result.current.state.status).toBe("idle");
    expect(result.current.state.remainingSeconds).toBe(1500);
    expect(mockElectronAPI.session.save).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("TC-504: useTimer triggers session save on completion", () => {
  it("calls session.save when timer completes", async () => {
    // Use real timers with short duration for this test
    const { result } = renderHook(() => useTimer(shortSettings));

    act(() => result.current.setTitle("Complete Me"));
    act(() => result.current.start());

    // Wait for timer to complete naturally (3 second timer + buffer)
    await waitFor(
      () => expect(result.current.state.status).toBe("completed"),
      { timeout: 8000 },
    );

    // Allow async save to complete
    await waitFor(
      () => expect(mockElectronAPI.session.save).toHaveBeenCalledOnce(),
      { timeout: 2000 },
    );

    expect(result.current.state.remainingSeconds).toBe(0);

    const callArg = (mockElectronAPI.session.save.mock.calls[0]![0]) as {
      title: string;
      timerType: string;
      plannedDurationSeconds: number;
      actualDurationSeconds: number;
    };
    expect(callArg.title).toBe("Complete Me");
    expect(callArg.timerType).toBe("work");
    expect(callArg.plannedDurationSeconds).toBe(3);
    expect(callArg.actualDurationSeconds).toBeGreaterThanOrEqual(0);
  }, 15000);
});

describe("TC-505: useTimer shows error when session save fails", () => {
  it("exposes saveError on save failure", async () => {
    mockElectronAPI.session.save.mockRejectedValueOnce(new Error("DB write failed"));

    const { result } = renderHook(() => useTimer(shortSettings));

    act(() => result.current.start());

    // Wait for timer to complete naturally
    await waitFor(
      () => expect(result.current.state.status).toBe("completed"),
      { timeout: 8000 },
    );

    // Wait for save error to surface
    await waitFor(
      () => expect(result.current.saveError).not.toBeNull(),
      { timeout: 3000 },
    );

    expect(result.current.state.status).toBe("completed");
    expect(result.current.saveError).toBeTruthy();
  }, 15000);
});
