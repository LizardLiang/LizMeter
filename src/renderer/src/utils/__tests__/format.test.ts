import { describe, expect, it } from "vitest";
import { formatTime } from "../format.ts";

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
