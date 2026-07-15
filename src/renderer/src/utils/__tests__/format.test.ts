import { describe, expect, it } from "vitest";
import { formatDuration, formatElapsed, formatStopwatchDuration, formatTime } from "../format.ts";

describe("formatTime", () => {
  it("TC-201: converts seconds to MM:SS", () => {
    expect(formatTime(1500)).toBe("25:00");
    expect(formatTime(300)).toBe("05:00");
    expect(formatTime(900)).toBe("15:00");
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(61)).toBe("01:01");
    expect(formatTime(59)).toBe("00:59");
    expect(formatTime(3600)).toBe("60:00");
    expect(formatTime(3661)).toBe("61:01");
    expect(formatTime(1)).toBe("00:01");
  });

  it("TC-202: handles negative input gracefully by returning 00:00", () => {
    expect(formatTime(-1)).toBe("00:00");
    expect(formatTime(-100)).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it("TC-FD-01: returns '5m' for 300 seconds", () => {
    expect(formatDuration(300)).toBe("5m");
  });

  it("TC-FD-02: returns '1h 23m' for 4980 seconds", () => {
    expect(formatDuration(4980)).toBe("1h 23m");
  });

  it("TC-FD-03: returns '0m' for 0 seconds", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("TC-FD-04: returns '2h 0m' for 7200 seconds", () => {
    expect(formatDuration(7200)).toBe("2h 0m");
  });

  it("TC-FD-05: clamps negative values to 0m", () => {
    expect(formatDuration(-100)).toBe("0m");
  });

  it("TC-FD-06: returns '1h 0m' for exactly 3600 seconds", () => {
    expect(formatDuration(3600)).toBe("1h 0m");
  });
});

describe("formatElapsed", () => {
  it("TC-FE-01: formats 3661 seconds as '01:01:01'", () => {
    expect(formatElapsed(3661)).toBe("01:01:01");
  });

  it("TC-FE-02: formats 0 seconds as '00:00:00'", () => {
    expect(formatElapsed(0)).toBe("00:00:00");
  });

  it("TC-FE-03: clamps negative seconds to '00:00:00'", () => {
    expect(formatElapsed(-1)).toBe("00:00:00");
    expect(formatElapsed(-999)).toBe("00:00:00");
  });

  it("TC-FE-04: formats 3600 seconds as '01:00:00'", () => {
    expect(formatElapsed(3600)).toBe("01:00:00");
  });

  it("TC-FE-05: formats 59 seconds as '00:00:59'", () => {
    expect(formatElapsed(59)).toBe("00:00:59");
  });

  it("TC-FE-06: formats 3599 seconds as '00:59:59'", () => {
    expect(formatElapsed(3599)).toBe("00:59:59");
  });

  it("TC-FE-07: formats 7322 seconds (2h 2m 2s) as '02:02:02'", () => {
    expect(formatElapsed(7322)).toBe("02:02:02");
  });
});

describe("formatStopwatchDuration", () => {
  it("TC-SD-01: formats 3723 seconds as '1h 2m 3s'", () => {
    expect(formatStopwatchDuration(3723)).toBe("1h 2m 3s");
  });

  it("TC-SD-02: formats 330 seconds as '5m 30s'", () => {
    expect(formatStopwatchDuration(330)).toBe("5m 30s");
  });

  it("TC-SD-03: formats 45 seconds as '45s'", () => {
    expect(formatStopwatchDuration(45)).toBe("45s");
  });

  it("TC-SD-04: formats 0 seconds as '0s'", () => {
    expect(formatStopwatchDuration(0)).toBe("0s");
  });

  it("TC-SD-05: formats 60 seconds as '1m 0s'", () => {
    expect(formatStopwatchDuration(60)).toBe("1m 0s");
  });

  it("TC-SD-06: formats 3600 seconds as '1h 0m 0s'", () => {
    expect(formatStopwatchDuration(3600)).toBe("1h 0m 0s");
  });

  it("TC-SD-07: clamps negative seconds to '0s'", () => {
    expect(formatStopwatchDuration(-1)).toBe("0s");
    expect(formatStopwatchDuration(-3600)).toBe("0s");
  });
});
