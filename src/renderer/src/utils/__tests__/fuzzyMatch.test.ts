import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "../fuzzyMatch.ts";

describe("fuzzyMatch", () => {
  it("matches a contiguous substring", () => {
    const result = fuzzyMatch("app", "Fix the app crash");
    expect(result.matched).toBe(true);
  });

  it("matches a subsequence that is not contiguous", () => {
    // "fxc" matches "Fix the app crash" as f...x...c, in order but not adjacent.
    const result = fuzzyMatch("fxc", "Fix the app crash");
    expect(result.matched).toBe(true);
  });

  it("does not match when characters are out of order or missing", () => {
    const result = fuzzyMatch("zzz", "Fix the app crash");
    expect(result.matched).toBe(false);
    expect(result.score).toBe(0);
  });

  it("matches everything with score 0 for an empty query", () => {
    const result = fuzzyMatch("", "Anything at all");
    expect(result.matched).toBe(true);
    expect(result.score).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("APP", "fix the app crash").matched).toBe(true);
  });

  it("scores a contiguous match higher than a scattered subsequence match", () => {
    const contiguous = fuzzyMatch("app", "an app");
    const scattered = fuzzyMatch("app", "a pit stop"); // a...p...p, scattered
    expect(scattered.matched).toBe(true);
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });
});
