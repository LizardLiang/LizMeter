// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb, initDatabase } from "../../database.ts";
import { compareHlc, MAX_CLOCK_DRIFT_MS, receive, tick } from "../hlc.ts";

beforeEach(() => {
  initDatabase(":memory:");
});

describe("hlc.tick", () => {
  it("advances physicalMs with wall-clock time and resets the counter", () => {
    const db = getDb();
    const a = tick(db, 0, 1000);
    const b = tick(db, 0, 2000);
    expect(a.physicalMs).toBe(1000);
    expect(b.physicalMs).toBe(2000);
    expect(b.counter).toBe(0);
  });

  it("bumps the counter instead of physicalMs when two ticks land in the same millisecond", () => {
    const db = getDb();
    const a = tick(db, 0, 5000);
    const b = tick(db, 0, 5000);
    expect(a.physicalMs).toBe(5000);
    expect(b.physicalMs).toBe(5000);
    expect(b.counter).toBe(a.counter + 1);
  });

  it("never regresses physicalMs even if wall-clock time runs backward", () => {
    const db = getDb();
    const a = tick(db, 0, 9000);
    const b = tick(db, 0, 1000); // clock ran backward
    expect(b.physicalMs).toBe(9000);
    expect(b.counter).toBe(a.counter + 1);
  });

  it("persists across a fresh tick call as if after a restart", () => {
    const db = getDb();
    tick(db, 0, 4000);
    const after = tick(db, 0, 100); // "restart" with a much earlier wall clock
    expect(after.physicalMs).toBe(4000);
  });
});

describe("hlc.compareHlc", () => {
  it("compares physicalMs, then counter, then deviceNumber in that order", () => {
    expect(compareHlc({ physicalMs: 1, counter: 0, deviceNumber: 0 }, { physicalMs: 2, counter: 0, deviceNumber: 0 }))
      .toBeLessThan(0);
    expect(compareHlc({ physicalMs: 5, counter: 1, deviceNumber: 0 }, { physicalMs: 5, counter: 2, deviceNumber: 0 }))
      .toBeLessThan(0);
    expect(compareHlc({ physicalMs: 5, counter: 1, deviceNumber: 1 }, { physicalMs: 5, counter: 1, deviceNumber: 2 }))
      .toBeLessThan(0);
    expect(compareHlc({ physicalMs: 5, counter: 1, deviceNumber: 1 }, { physicalMs: 5, counter: 1, deviceNumber: 1 }))
      .toBe(0);
  });
});

describe("hlc.receive", () => {
  it("merges a remote clock ahead of the local one", () => {
    const db = getDb();
    tick(db, 0, 1000);
    const { hlc, clamped } = receive(db, 0, { physicalMs: 5000, counter: 3, deviceNumber: 1 }, 1000);
    expect(clamped).toBe(false);
    expect(hlc.physicalMs).toBe(5000);
    expect(hlc.counter).toBe(4);
  });

  it("clamps a remote clock implausibly far in the future (FR-033) instead of trusting it", () => {
    const db = getDb();
    const now = 1_000_000;
    const farFuture = now + MAX_CLOCK_DRIFT_MS + 60_000; // 1 minute past the tolerance
    const { hlc, clamped } = receive(db, 0, { physicalMs: farFuture, counter: 0, deviceNumber: 1 }, now);
    expect(clamped).toBe(true);
    expect(hlc.physicalMs).toBe(now + MAX_CLOCK_DRIFT_MS);
    expect(hlc.physicalMs).toBeLessThan(farFuture);
  });

  it("does not clamp a remote clock within tolerance", () => {
    const db = getDb();
    const now = 1_000_000;
    const closeBy = now + MAX_CLOCK_DRIFT_MS - 1000;
    const { clamped } = receive(db, 0, { physicalMs: closeBy, counter: 0, deviceNumber: 1 }, now);
    expect(clamped).toBe(false);
  });
});
