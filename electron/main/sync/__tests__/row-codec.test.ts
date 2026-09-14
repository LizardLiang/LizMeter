// @vitest-environment node
// Pure unit coverage for toBindValue (defect 1's fix): the Vitest sql.js shim silently tolerates
// a boolean bind where real better-sqlite3 throws (see .claude/.Arena/debt.md), so a test that
// only exercises the merge succeeding would pass whether or not this coercion exists. Testing the
// function directly is the part of the fix that stays meaningful under that shim.
import { describe, expect, it } from "vitest";
import { toBindValue } from "../row-codec.ts";

describe("toBindValue", () => {
  it("coerces true to 1", () => {
    expect(toBindValue(true)).toBe(1);
  });

  it("coerces false to 0", () => {
    expect(toBindValue(false)).toBe(0);
  });

  it("passes a string through unchanged", () => {
    expect(toBindValue("Staged")).toBe("Staged");
  });

  it("passes a number through unchanged", () => {
    expect(toBindValue(42)).toBe(42);
  });

  it("passes null through unchanged", () => {
    expect(toBindValue(null)).toBeNull();
  });

  it("never returns a boolean, for any legal OplogFieldValue input", () => {
    for (const input of [true, false, "x", 0, 1, null]) {
      expect(typeof toBindValue(input)).not.toBe("boolean");
    }
  });
});
