// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFullyHydratedError, readFileGuarded } from "../hydration-guard.ts";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-hydration-guard-"));
  filePath = path.join(dir, "peer.oplog.jsonl");
  fs.writeFileSync(filePath, "the full 258000-byte file, standing in for a real oplog");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readFileGuarded", () => {
  it("returns the full bytes for a normally-hydrated file", () => {
    const buf = readFileGuarded(filePath);
    expect(buf.toString("utf8")).toBe("the full 258000-byte file, standing in for a real oplog");
  });

  it("throws NotFullyHydratedError when the read is shorter than fs.statSync reported (FR-014)", () => {
    // Simulates the exact reported symptom (anthropics/claude-code#62140): a 258 KB file that
    // reads back as 24 KB because OneDrive handed back a not-yet-downloaded placeholder.
    const realStat = fs.statSync(filePath);
    vi.spyOn(fs, "statSync").mockReturnValue({ ...realStat, size: realStat.size + 100_000 } as fs.Stats);

    expect(() => readFileGuarded(filePath)).toThrow(NotFullyHydratedError);
    try {
      readFileGuarded(filePath);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NotFullyHydratedError);
      const guardErr = err as NotFullyHydratedError;
      expect(guardErr.expectedBytes).toBe(realStat.size + 100_000);
      expect(guardErr.actualBytes).toBe(realStat.size);
      expect(guardErr.message).toMatch(/not fully downloaded/);
    }
  });

  it("propagates a genuine missing-file error rather than treating it as a hydration mismatch", () => {
    expect(() => readFileGuarded(path.join(dir, "does-not-exist.jsonl"))).toThrow();
    try {
      readFileGuarded(path.join(dir, "does-not-exist.jsonl"));
    } catch (err) {
      expect(err).not.toBeInstanceOf(NotFullyHydratedError);
    }
  });
});
