// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generateOrderedKeys, initialKey, keyBetween } from "../lexorank.ts";

describe("lexorank.keyBetween", () => {
  it("returns a value strictly between two unbounded ends", () => {
    const first = initialKey();
    const before = keyBetween(null, first);
    const after = keyBetween(first, null);
    expect(before < first).toBe(true);
    expect(first < after).toBe(true);
  });

  it("throws when lower does not sort before upper", () => {
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a", "a")).toThrow();
  });

  it("never collides or exhausts precision across 300 inserts at the same spot (strapi#22015)", () => {
    let lo = "a";
    const hi = "b";
    for (let i = 0; i < 300; i++) {
      const mid = keyBetween(lo, hi);
      expect(mid > lo).toBe(true);
      expect(mid < hi).toBe(true);
      lo = mid;
    }
  });

  it("keeps 200 sequential appends strictly increasing", () => {
    const keys: string[] = [keyBetween(null, null)];
    for (let i = 0; i < 200; i++) keys.push(keyBetween(keys[keys.length - 1]!, null));
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! > keys[i - 1]!).toBe(true);
    }
  });
});

describe("lexorank.generateOrderedKeys", () => {
  it("generates N strictly increasing keys with no duplicates", () => {
    const keys = generateOrderedKeys(50);
    expect(keys.length).toBe(50);
    expect(new Set(keys).size).toBe(50);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! > keys[i - 1]!).toBe(true);
    }
  });

  it("returns an empty array for count 0", () => {
    expect(generateOrderedKeys(0)).toEqual([]);
  });
});
