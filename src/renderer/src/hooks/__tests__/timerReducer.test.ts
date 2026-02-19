import { beforeEach, describe, expect, it } from "vitest";
import type { TimerSettings } from "../../../../shared/types.ts";
import { getInitialTimerState, timerReducer } from "../useTimer.ts";
import type { TimerState } from "../useTimer.ts";

const defaultSettings: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
};

let idleState: TimerState;
let runningState: TimerState;
let pausedState: TimerState;
let completedState: TimerState;

beforeEach(() => {
  idleState = getInitialTimerState(defaultSettings);

  runningState = {
    ...idleState,
    status: "running",
    startedAtWallClock: Date.now() - 5000,
    remainingSeconds: 1495,
    accumulatedActiveMs: 0,
  };

  pausedState = {
    ...idleState,
    status: "paused",
    remainingSeconds: 800,
    startedAtWallClock: null,
    accumulatedActiveMs: 700000,
  };

  completedState = {
    ...idleState,
    status: "completed",
    remainingSeconds: 0,
    startedAtWallClock: null,
    accumulatedActiveMs: 1500000,
  };
});

describe("TC-101: initial state defaults", () => {
  it("has correct defaults", () => {
    const state = getInitialTimerState(defaultSettings);
    expect(state.status).toBe("idle");
    expect(state.timerType).toBe("work");
    expect(state.remainingSeconds).toBe(1500);
    expect(state.title).toBe("");
    expect(state.startedAtWallClock).toBeNull();
    expect(state.accumulatedActiveMs).toBe(0);
  });
});

describe("TC-102: START transitions idle to running", () => {
  it("sets status to running and records startedAtWallClock", () => {
    const before = Date.now();
    const result = timerReducer(idleState, { type: "START" });
    const after = Date.now();

    expect(result.status).toBe("running");
    expect(result.startedAtWallClock).not.toBeNull();
    expect(result.startedAtWallClock!).toBeGreaterThanOrEqual(before);
    expect(result.startedAtWallClock!).toBeLessThanOrEqual(after);
    expect(result.remainingSeconds).toBe(1500);
    expect(result.accumulatedActiveMs).toBe(0);
  });
});

describe("TC-103: PAUSE transitions running to paused", () => {
  it("sets status to paused, clears startedAtWallClock, accumulates elapsed time", () => {
    const result = timerReducer(runningState, { type: "PAUSE" });

    expect(result.status).toBe("paused");
    expect(result.startedAtWallClock).toBeNull();
    expect(result.accumulatedActiveMs).toBeGreaterThan(0);
  });
});

describe("TC-104: RESET from running returns to idle, preserves title", () => {
  it("resets status and remainingSeconds but keeps title", () => {
    const stateWithTitle: TimerState = {
      ...runningState,
      title: "Write PRD",
      remainingSeconds: 900,
    };

    const result = timerReducer(stateWithTitle, { type: "RESET" });

    expect(result.status).toBe("idle");
    expect(result.remainingSeconds).toBe(1500); // reset to configured work duration
    expect(result.title).toBe("Write PRD"); // CRITICAL: title preserved
    expect(result.startedAtWallClock).toBeNull();
    expect(result.accumulatedActiveMs).toBe(0);
  });
});

describe("TC-105: RESET from paused returns to idle", () => {
  it("resets status and remainingSeconds", () => {
    const result = timerReducer(pausedState, { type: "RESET" });

    expect(result.status).toBe("idle");
    expect(result.remainingSeconds).toBe(1500);
    expect(result.accumulatedActiveMs).toBe(0);
  });
});

describe("TC-106: COMPLETE transitions running to completed", () => {
  it("sets status to completed, remainingSeconds to 0, accumulates active time", () => {
    const startTime = Date.now() - 1500000;
    const stateAboutToComplete: TimerState = {
      ...runningState,
      accumulatedActiveMs: 0,
      startedAtWallClock: startTime,
    };

    const result = timerReducer(stateAboutToComplete, { type: "COMPLETE" });

    expect(result.status).toBe("completed");
    expect(result.remainingSeconds).toBe(0);
    expect(result.startedAtWallClock).toBeNull();
    expect(result.accumulatedActiveMs).toBeGreaterThan(0);
  });
});

describe("TC-107: CLEAR_COMPLETION returns to idle", () => {
  it("transitions completed state back to idle with full duration", () => {
    const result = timerReducer(completedState, { type: "CLEAR_COMPLETION" });

    expect(result.status).toBe("idle");
    expect(result.remainingSeconds).toBe(1500);
  });
});

describe("TC-108: SET_TIMER_TYPE when idle updates remaining seconds", () => {
  it("changes timer type and updates remaining seconds", () => {
    const result1 = timerReducer(idleState, { type: "SET_TIMER_TYPE", payload: "short_break" });

    expect(result1.timerType).toBe("short_break");
    expect(result1.remainingSeconds).toBe(300);
    expect(result1.status).toBe("idle");

    const result2 = timerReducer(result1, { type: "SET_TIMER_TYPE", payload: "long_break" });

    expect(result2.timerType).toBe("long_break");
    expect(result2.remainingSeconds).toBe(900);
  });
});

describe("TC-109: SET_TITLE works in idle, running, and paused states", () => {
  it("updates title in all non-completed states", () => {
    const states = [idleState, runningState, pausedState];
    for (const state of states) {
      const result = timerReducer(state, { type: "SET_TITLE", payload: "My Focus Task" });
      expect(result.title).toBe("My Focus Task");
      expect(result.status).toBe(state.status);
    }
  });

  it("does NOT update title in completed state", () => {
    const result = timerReducer(completedState, { type: "SET_TITLE", payload: "Should not change" });
    expect(result.title).toBe(completedState.title);
  });
});

describe("TC-110: SET_TITLE enforces maximum length of 500", () => {
  it("truncates title to 500 characters", () => {
    const longTitle = "a".repeat(501);
    const result = timerReducer(idleState, { type: "SET_TITLE", payload: longTitle });
    expect(result.title.length).toBeLessThanOrEqual(500);
  });
});

describe("TC-111: TICK updates remaining seconds", () => {
  it("updates remainingSeconds and keeps status as running", () => {
    const result = timerReducer(runningState, { type: "TICK", payload: 1450 });

    expect(result.remainingSeconds).toBe(1450);
    expect(result.status).toBe("running");
  });
});

describe("TC-112: illegal transitions are no-ops", () => {
  it("PAUSE on idle is a no-op", () => {
    const result = timerReducer(idleState, { type: "PAUSE" });
    expect(result).toEqual(idleState);
  });

  it("RESUME on idle is a no-op", () => {
    const result = timerReducer(idleState, { type: "RESUME" });
    expect(result).toEqual(idleState);
  });

  it("START on running is a no-op", () => {
    const result = timerReducer(runningState, { type: "START" });
    expect(result).toEqual(runningState);
  });

  it("RESUME on running is a no-op", () => {
    const result = timerReducer(runningState, { type: "RESUME" });
    expect(result).toEqual(runningState);
  });

  it("PAUSE on paused is a no-op", () => {
    const result = timerReducer(pausedState, { type: "PAUSE" });
    expect(result).toEqual(pausedState);
  });

  it("TICK on completed is a no-op", () => {
    const result = timerReducer(completedState, { type: "TICK", payload: 5 });
    expect(result).toEqual(completedState);
  });
});

describe("TC-113: RESUME sets new startedAtWallClock", () => {
  it("transitions to running and sets a fresh startedAtWallClock", () => {
    const before = Date.now();
    const result = timerReducer(pausedState, { type: "RESUME" });
    const after = Date.now();

    expect(result.status).toBe("running");
    expect(result.startedAtWallClock).not.toBeNull();
    expect(result.startedAtWallClock!).toBeGreaterThanOrEqual(before);
    expect(result.startedAtWallClock!).toBeLessThanOrEqual(after);
    expect(result.accumulatedActiveMs).toBe(700000); // unchanged
    expect(result.remainingSeconds).toBe(800); // unchanged
  });
});
