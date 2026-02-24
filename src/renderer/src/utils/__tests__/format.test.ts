import { describe, expect, it } from "vitest";
import { formatDuration, formatTime } from "../format.ts";

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
});
