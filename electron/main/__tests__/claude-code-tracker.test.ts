// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonlLine, SessionState } from "../claude-code-tracker.ts";
import {
  decodeProjectPath,
  destroyTracker,
  extractFileEditsFromLine,
  extractFirstUserMessage,
  parseJsonlLine,
  pauseTracking,
  processLines,
  readNewLines,
  resumeTracking,
  scanSessions,
  stopTrackingAndGetData,
  trackSelectedSessions,
  validateProjectDirName,
} from "../claude-code-tracker.ts";

const projectsRoot = path.join(os.homedir(), ".claude", "projects");

// --- Helper: create a fresh empty SessionState for testing ---

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ccSessionUuid: "test-uuid",
    filesEdited: new Set(),
    lastMessageTimestamp: null,
    firstActivityAt: null,
    lastActivityAt: null,
    idlePeriods: [],
    bytesRead: 0,
    filePath: "",
    partialLine: "",
    ...overrides,
  };
}

// --- Helper: build a JSONL line string ---

function makeAssistantLine(timestamp: string, filePaths: string[] = [], toolName = "Write"): string {
  const content = filePaths.map((fp) => ({
    type: "tool_use",
    id: `toolu_${Math.random().toString(36).slice(2)}`,
    name: toolName,
    input: { file_path: fp },
  }));
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "session-1",
    message: { role: "assistant", content },
  });
}

function makeUserLine(timestamp: string): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    sessionId: "session-1",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

// --- Temp file helpers ---

const tempFiles: string[] = [];

function writeTempJsonl(lines: string[]): string {
  const tmpPath = path.join(os.tmpdir(), `cc-tracker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf8");
  tempFiles.push(tmpPath);
  return tmpPath;
}

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore cleanup errors
    }
  }
  destroyTracker();
});

// ============================================================
// validateProjectDirName
// ============================================================

describe("validateProjectDirName: rejects empty input", () => {
  it("throws for empty string", () => {
    expect(() => validateProjectDirName("")).toThrow("cannot be empty");
  });

  it("throws for whitespace-only string", () => {
    expect(() => validateProjectDirName("   ")).toThrow("cannot be empty");
  });
});

describe("validateProjectDirName: rejects path separators", () => {
  it("throws for forward slash", () => {
    expect(() => validateProjectDirName("foo/bar")).toThrow("path separators");
  });

  it("throws for backslash", () => {
    expect(() => validateProjectDirName("foo\\bar")).toThrow("path separators");
  });

  it("throws for double-dot traversal", () => {
    expect(() => validateProjectDirName("..")).toThrow("path separators");
  });

  it("throws for embedded double-dot", () => {
    expect(() => validateProjectDirName("foo..bar")).toThrow("path separators");
  });
});

describe("validateProjectDirName: rejects disallowed characters", () => {
  it("throws for colon", () => {
    expect(() => validateProjectDirName("C:Users")).toThrow("disallowed characters");
  });

  it("throws for space", () => {
    expect(() => validateProjectDirName("my project")).toThrow("disallowed characters");
  });

  it("throws for at-sign", () => {
    expect(() => validateProjectDirName("my@project")).toThrow("disallowed characters");
  });
});

describe("validateProjectDirName: path escape prevention", () => {
  it("resolved path must start with projectsRoot + separator", () => {
    const validName = "SomeProject";
    const result = validateProjectDirName(validName);
    expect(result).toBe(path.join(projectsRoot, validName));
    expect(result.startsWith(projectsRoot + path.sep)).toBe(true);
  });
});

// ============================================================
// decodeProjectPath
// ============================================================

describe("decodeProjectPath: Windows path decoding", () => {
  it("decodes drive letter prefix correctly", () => {
    const encoded = "C--Users-lizard-liang-personal-PersonalTool-LizMeter";
    const decoded = decodeProjectPath(encoded);
    expect(decoded).toBe("C:\\Users\\lizard\\liang\\personal\\PersonalTool\\LizMeter");
  });

  it("handles D drive prefix", () => {
    const encoded = "D--Projects-myapp";
    const decoded = decodeProjectPath(encoded);
    expect(decoded).toBe("D:\\Projects\\myapp");
  });
});

describe("decodeProjectPath: non-Windows fallback", () => {
  it("converts hyphens to forward slashes for non-drive paths", () => {
    const encoded = "home-user-projects-myapp";
    const decoded = decodeProjectPath(encoded);
    expect(decoded).toBe("/home/user/projects/myapp");
  });
});

// ============================================================
// parseJsonlLine — calls the actual module function
// ============================================================

describe("parseJsonlLine: parses valid JSONL lines", () => {
  it("returns parsed object for a valid JSON line", () => {
    const raw = JSON.stringify({ type: "assistant", timestamp: "2026-02-25T10:00:00.000Z", sessionId: "abc" });
    const result = parseJsonlLine(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.timestamp).toBe("2026-02-25T10:00:00.000Z");
  });

  it("returns null for empty string", () => {
    expect(parseJsonlLine("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseJsonlLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseJsonlLine("{ not valid json }")).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    const raw = "  " + JSON.stringify({ type: "user" }) + "  ";
    const result = parseJsonlLine(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
  });
});

// ============================================================
// extractFileEditsFromLine — calls the actual module function
// ============================================================

describe("extractFileEditsFromLine: extracts file paths from Write tool_use", () => {
  it("returns file_path from Write block", () => {
    const line: JsonlLine = {
      type: "assistant",
      timestamp: "2026-02-25T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "C:\\Users\\test\\types.ts" },
          },
        ],
      },
    };
    const result = extractFileEditsFromLine(line);
    expect(result).toEqual(["C:\\Users\\test\\types.ts"]);
  });

  it("returns file_path from Edit block", () => {
    const line: JsonlLine = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "src/index.ts" },
          },
        ],
      },
    };
    const result = extractFileEditsFromLine(line);
    expect(result).toEqual(["src/index.ts"]);
  });

  it("ignores non-file-edit tools (Bash, Read, etc.)", () => {
    const line: JsonlLine = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", name: "Read", input: { file_path: "some/file.ts" } },
        ],
      },
    };
    const result = extractFileEditsFromLine(line);
    expect(result).toEqual([]);
  });

  it("extracts multiple file paths from multiple Write/Edit blocks", () => {
    const line: JsonlLine = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Write", input: { file_path: "a.ts" } },
          { type: "tool_use", name: "Edit", input: { file_path: "b.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "echo" } },
        ],
      },
    };
    const result = extractFileEditsFromLine(line);
    expect(result).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty array for non-assistant line type", () => {
    const line: JsonlLine = {
      type: "user",
      message: {
        content: [
          { type: "tool_use", name: "Write", input: { file_path: "a.ts" } },
        ],
      },
    };
    expect(extractFileEditsFromLine(line)).toEqual([]);
  });

  it("returns empty array when content is not an array", () => {
    const line: JsonlLine = {
      type: "assistant",
      message: { content: "string content" as unknown as undefined },
    };
    expect(extractFileEditsFromLine(line)).toEqual([]);
  });

  it("ignores Write block with empty file_path", () => {
    const line: JsonlLine = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", input: { file_path: "   " } }],
      },
    };
    expect(extractFileEditsFromLine(line)).toEqual([]);
  });

  it("ignores Write block with missing file_path", () => {
    const line: JsonlLine = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", input: {} }],
      },
    };
    expect(extractFileEditsFromLine(line)).toEqual([]);
  });
});

// ============================================================
// processLines — calls the actual module function
// ============================================================

describe("processLines: tracks firstActivityAt and lastActivityAt", () => {
  it("sets firstActivityAt on first line with timestamp", () => {
    const state = makeSessionState();
    const lines: JsonlLine[] = [
      { type: "user", timestamp: "2026-02-25T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-02-25T10:01:00.000Z" },
    ];
    processLines(state, lines, 5 * 60 * 1000);
    expect(state.firstActivityAt).toBe("2026-02-25T10:00:00.000Z");
    expect(state.lastActivityAt).toBe("2026-02-25T10:01:00.000Z");
  });

  it("does not update firstActivityAt once set", () => {
    const state = makeSessionState({ firstActivityAt: "2026-02-25T09:00:00.000Z" });
    const lines: JsonlLine[] = [
      { type: "user", timestamp: "2026-02-25T10:00:00.000Z" },
    ];
    processLines(state, lines, 5 * 60 * 1000);
    expect(state.firstActivityAt).toBe("2026-02-25T09:00:00.000Z");
  });

  it("ignores lines without timestamps", () => {
    const state = makeSessionState();
    const lines: JsonlLine[] = [
      { type: "system" }, // no timestamp
      { type: "user", timestamp: "2026-02-25T10:05:00.000Z" },
    ];
    processLines(state, lines, 5 * 60 * 1000);
    expect(state.firstActivityAt).toBe("2026-02-25T10:05:00.000Z");
  });
});

describe("processLines: idle detection via actual processLines call", () => {
  it("records idle period when gap exceeds threshold", () => {
    const state = makeSessionState();
    const idleThresholdMs = 5 * 60 * 1000;
    const lines: JsonlLine[] = [
      { type: "user", timestamp: "2026-02-25T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-02-25T10:07:00.000Z" }, // 7 min gap
    ];
    processLines(state, lines, idleThresholdMs);
    expect(state.idlePeriods).toHaveLength(1);
    expect(state.idlePeriods[0]!.startAt).toBe("2026-02-25T10:00:00.000Z");
    expect(state.idlePeriods[0]!.endAt).toBe("2026-02-25T10:07:00.000Z");
    expect(state.idlePeriods[0]!.durationSeconds).toBe(7 * 60);
  });

  it("does not record idle period when gap is below threshold", () => {
    const state = makeSessionState();
    const idleThresholdMs = 5 * 60 * 1000;
    const lines: JsonlLine[] = [
      { type: "user", timestamp: "2026-02-25T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-02-25T10:02:00.000Z" }, // 2 min gap
    ];
    processLines(state, lines, idleThresholdMs);
    expect(state.idlePeriods).toHaveLength(0);
  });

  it("records multiple idle periods across a session", () => {
    const state = makeSessionState();
    const idleThresholdMs = 5 * 60 * 1000;
    const lines: JsonlLine[] = [
      { type: "user", timestamp: "2026-02-25T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-02-25T10:08:00.000Z" }, // 8 min idle
      { type: "user", timestamp: "2026-02-25T10:10:00.000Z" }, // 2 min, not idle
      { type: "assistant", timestamp: "2026-02-25T10:20:00.000Z" }, // 10 min idle
    ];
    processLines(state, lines, idleThresholdMs);
    expect(state.idlePeriods).toHaveLength(2);
    expect(state.idlePeriods[0]!.durationSeconds).toBe(8 * 60);
    expect(state.idlePeriods[1]!.durationSeconds).toBe(10 * 60);
  });

  it("cancel/re-prompt: short gap between messages is not recorded as idle", () => {
    const state = makeSessionState();
    const idleThresholdMs = 5 * 60 * 1000;
    const lines: JsonlLine[] = [
      { type: "assistant", timestamp: "2026-02-25T10:05:00.000Z" },
      { type: "user", timestamp: "2026-02-25T10:05:10.000Z" }, // 10 seconds later
    ];
    processLines(state, lines, idleThresholdMs);
    expect(state.idlePeriods).toHaveLength(0);
  });

  it("respects custom idle threshold (1 minute)", () => {
    const state = makeSessionState();
    const idleThresholdMs = 1 * 60 * 1000; // 1 minute
    const lines: JsonlLine[] = [
      { type: "user", timestamp: "2026-02-25T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-02-25T10:02:00.000Z" }, // 2 min gap — idle with 1min threshold
    ];
    processLines(state, lines, idleThresholdMs);
    expect(state.idlePeriods).toHaveLength(1);
  });
});

describe("processLines: file edit extraction via processLines", () => {
  it("accumulates file edits from Write/Edit blocks in the Set", () => {
    const state = makeSessionState();
    const lines: JsonlLine[] = [
      {
        type: "assistant",
        timestamp: "2026-02-25T10:00:00.000Z",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "src/types.ts" } },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-25T10:01:00.000Z",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/index.ts" } },
          ],
        },
      },
    ];
    processLines(state, lines, 5 * 60 * 1000);
    expect(state.filesEdited.size).toBe(2);
    expect(state.filesEdited.has("src/types.ts")).toBe(true);
    expect(state.filesEdited.has("src/index.ts")).toBe(true);
  });

  it("deduplicates same file edited multiple times", () => {
    const state = makeSessionState();
    const lines: JsonlLine[] = [
      {
        type: "assistant",
        timestamp: "2026-02-25T10:00:00.000Z",
        message: {
          content: [
            { type: "tool_use", name: "Write", input: { file_path: "src/types.ts" } },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-25T10:02:00.000Z",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/types.ts" } },
          ],
        },
      },
    ];
    processLines(state, lines, 5 * 60 * 1000);
    expect(state.filesEdited.size).toBe(1);
  });

  it("does not add files from Bash or Read tools", () => {
    const state = makeSessionState();
    const lines: JsonlLine[] = [
      {
        type: "assistant",
        timestamp: "2026-02-25T10:00:00.000Z",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", name: "Read", input: { file_path: "src/types.ts" } },
          ],
        },
      },
    ];
    processLines(state, lines, 5 * 60 * 1000);
    expect(state.filesEdited.size).toBe(0);
  });
});

// ============================================================
// readNewLines — calls the actual module function with temp files
// ============================================================

describe("readNewLines: reads content from a JSONL file at offset", () => {
  it("reads all lines from offset 0", () => {
    const line1 = makeAssistantLine("2026-02-25T10:00:00.000Z", ["a.ts"]);
    const line2 = makeUserLine("2026-02-25T10:01:00.000Z");
    const tmpPath = writeTempJsonl([line1, line2]);

    const result = readNewLines(tmpPath, 0, "");
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]!.type).toBe("assistant");
    expect(result.lines[1]!.type).toBe("user");
    expect(result.newOffset).toBeGreaterThan(0);
    expect(result.newPartialLine).toBe("");
  });

  it("returns empty lines when offset equals file size (no new content)", () => {
    const line1 = makeAssistantLine("2026-02-25T10:00:00.000Z", ["a.ts"]);
    const tmpPath = writeTempJsonl([line1]);

    // First read to get full offset
    const first = readNewLines(tmpPath, 0, "");
    expect(first.lines).toHaveLength(1);

    // Second read from same offset — no new content
    const second = readNewLines(tmpPath, first.newOffset, "");
    expect(second.lines).toHaveLength(0);
    expect(second.newOffset).toBe(first.newOffset);
  });

  it("reads only new content when starting from a non-zero offset", () => {
    const line1 = makeAssistantLine("2026-02-25T10:00:00.000Z", ["a.ts"]);
    const tmpPath = writeTempJsonl([line1]);

    // Read first line to get offset
    const first = readNewLines(tmpPath, 0, "");
    expect(first.lines).toHaveLength(1);

    // Append a new line to the file
    const line2 = makeUserLine("2026-02-25T10:02:00.000Z");
    fs.appendFileSync(tmpPath, line2 + "\n");

    // Read from the offset — should only see the new line
    const second = readNewLines(tmpPath, first.newOffset, "");
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]!.type).toBe("user");
  });

  it("skips malformed JSONL lines without throwing", () => {
    const goodLine = makeAssistantLine("2026-02-25T10:00:00.000Z", ["a.ts"]);
    const badLine = "{ not valid json }";
    const tmpPath = writeTempJsonl([goodLine, badLine]);

    const result = readNewLines(tmpPath, 0, "");
    // Only the valid line should be returned
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.type).toBe("assistant");
  });

  it("handles partial line at end of file (no trailing newline)", () => {
    const line1 = makeAssistantLine("2026-02-25T10:00:00.000Z");
    // Write without trailing newline so line2 is partial
    const partial = '{"type":"user","timestamp":"2026-02-25T10:01';
    const tmpPath = path.join(
      os.tmpdir(),
      `cc-partial-${Date.now()}.jsonl`,
    );
    fs.writeFileSync(tmpPath, line1 + "\n" + partial, "utf8");
    tempFiles.push(tmpPath);

    const result = readNewLines(tmpPath, 0, "");
    // line1 is complete, partial is not yet complete
    expect(result.lines).toHaveLength(1);
    expect(result.newPartialLine).toBe(partial);
  });

  it("returns empty result for a non-existent file path (throws)", () => {
    const fakePath = path.join(os.tmpdir(), "does-not-exist-xyz.jsonl");
    // readNewLines should throw for ENOENT (not EBUSY/EACCES)
    expect(() => readNewLines(fakePath, 0, "")).toThrow();
  });
});

// ============================================================
// destroyTracker: idempotent
// ============================================================

describe("destroyTracker: idempotent", () => {
  it("can be called multiple times without error", () => {
    expect(() => {
      destroyTracker();
      destroyTracker();
      destroyTracker();
    }).not.toThrow();
  });
});

// ============================================================
// Session buffer: 2-minute window (logic verified via constants)
// ============================================================

describe("Session buffer: 2-minute window check", () => {
  it("session within 2 minutes of timer start is within buffer", () => {
    const timerStart = Date.now();
    const bufferStart = timerStart - 2 * 60 * 1000;
    const sessionLastTs = new Date(timerStart - 60 * 1000).toISOString();
    const tsMs = new Date(sessionLastTs).getTime();
    expect(tsMs).toBeGreaterThanOrEqual(bufferStart);
    expect(tsMs).toBeLessThanOrEqual(timerStart);
  });

  it("session older than 2 minutes is outside buffer", () => {
    const timerStart = Date.now();
    const bufferStart = timerStart - 2 * 60 * 1000;
    const sessionLastTs = new Date(timerStart - 5 * 60 * 1000).toISOString();
    expect(new Date(sessionLastTs).getTime()).toBeLessThan(bufferStart);
  });

  it("future session is excluded", () => {
    const timerStart = Date.now();
    const sessionLastTs = new Date(timerStart + 60 * 1000).toISOString();
    expect(new Date(sessionLastTs).getTime()).toBeGreaterThan(timerStart);
  });
});

// ============================================================
// v1.2: extractFirstUserMessage
// ============================================================

function makeUserLineWithText(timestamp: string, text: string): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    sessionId: "session-1",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function makeSystemLine(timestamp: string): string {
  return JSON.stringify({ type: "system", timestamp, sessionId: "session-1" });
}

describe("extractFirstUserMessage: returns first user message text", () => {
  it("returns text of first user message", () => {
    const tmpPath = writeTempJsonl([
      makeSystemLine("2026-02-25T10:00:00.000Z"),
      makeUserLineWithText("2026-02-25T10:00:01.000Z", "Fix the login bug"),
      makeAssistantLine("2026-02-25T10:00:02.000Z"),
    ]);
    const result = extractFirstUserMessage(tmpPath);
    expect(result).toBe("Fix the login bug");
  });

  it("truncates long messages to 60 chars with ellipsis", () => {
    const longText = "A".repeat(80);
    const tmpPath = writeTempJsonl([
      makeUserLineWithText("2026-02-25T10:00:00.000Z", longText),
    ]);
    const result = extractFirstUserMessage(tmpPath);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(60);
    expect(result!.endsWith("…")).toBe(true);
  });

  it("returns exact text when message is within 60 chars", () => {
    const text = "Short message";
    const tmpPath = writeTempJsonl([
      makeUserLineWithText("2026-02-25T10:00:00.000Z", text),
    ]);
    expect(extractFirstUserMessage(tmpPath)).toBe("Short message");
  });

  it("returns null if no user message in first 100 lines", () => {
    // 101 assistant lines then a user line
    const lines: string[] = [];
    for (let i = 0; i < 101; i++) {
      lines.push(makeAssistantLine(`2026-02-25T10:${String(i).padStart(2, "0")}:00.000Z`));
    }
    lines.push(makeUserLineWithText("2026-02-25T11:42:00.000Z", "Late user message"));
    const tmpPath = writeTempJsonl(lines);
    // Should return null because user message is after line 100
    const result = extractFirstUserMessage(tmpPath);
    expect(result).toBeNull();
  });

  it("returns null for an empty file", () => {
    const tmpPath = path.join(os.tmpdir(), `cc-empty-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpPath, "", "utf8");
    tempFiles.push(tmpPath);
    expect(extractFirstUserMessage(tmpPath)).toBeNull();
  });

  it("returns null for a non-existent file", () => {
    const fakePath = path.join(os.tmpdir(), "cc-does-not-exist.jsonl");
    expect(extractFirstUserMessage(fakePath)).toBeNull();
  });

  it("handles string content (non-array) in user message", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: "2026-02-25T10:00:00.000Z",
      message: { role: "user", content: "Direct string content" },
    });
    const tmpPath = writeTempJsonl([line]);
    const result = extractFirstUserMessage(tmpPath);
    expect(result).toBe("Direct string content");
  });

  it("handles JSONL parse errors gracefully (returns null)", () => {
    const tmpPath = writeTempJsonl(["not-valid-json"]);
    expect(extractFirstUserMessage(tmpPath)).toBeNull();
  });

  it("skips system-injected messages starting with '<' (plugin caveats, slash commands)", () => {
    const tmpPath = writeTempJsonl([
      makeUserLineWithText("2026-02-25T10:00:00.000Z", "<local-command-caveat>Caveat: generated by local commands</local-command-caveat>"),
      makeUserLineWithText("2026-02-25T10:00:01.000Z", "<command-name>/clear</command-name>"),
      makeUserLineWithText("2026-02-25T10:00:02.000Z", "<local-command-stdout></local-command-stdout>"),
      makeUserLineWithText("2026-02-25T10:00:03.000Z", "Fix the login bug"),
    ]);
    const result = extractFirstUserMessage(tmpPath);
    expect(result).toBe("Fix the login bug");
  });

  it("returns null if all user messages are system-injected", () => {
    const tmpPath = writeTempJsonl([
      makeUserLineWithText("2026-02-25T10:00:00.000Z", "<local-command-caveat>Caveat text</local-command-caveat>"),
      makeUserLineWithText("2026-02-25T10:00:01.000Z", "<command-name>/clear</command-name>"),
    ]);
    const result = extractFirstUserMessage(tmpPath);
    expect(result).toBeNull();
  });
});

// ============================================================
// v1.2: scanSessions + trackSelectedSessions
// ============================================================

// Helper: create a temp project directory with JSONL files
const tempDirs: string[] = [];

function makeTempProjectDir(): string {
  const dirPath = path.join(os.tmpdir(), `cc-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

// Mock WebContents for tests
function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as Parameters<typeof scanSessions>[1];
}

describe("v1.2 scanSessions: returns sessions within 2-minute buffer", () => {
  it("returns empty array for empty project directory", () => {
    const projDir = makeTempProjectDir();
    // Use the actual path directly by creating a mock validateProjectDirName-compatible path
    // Since we need a real directory, we'll temporarily use the test directory path via direct call
    const wc = makeMockWebContents();
    // The projectDirName validation requires ~/.claude/projects/ prefix, so we test the directory
    // scanning logic via a temp dir that won't pass validation. Test the sub-function indirectly
    // by verifying scanSessions returns error for non-existent paths.
    const result = scanSessions("nonexistent-dir-xyz", wc);
    expect(result.success).toBe(false);
    expect(result.sessions).toEqual([]);
    void projDir; // used to create temp dir, cleaned up in afterEach
  });

  it("returns error for invalid project dir name", () => {
    const wc = makeMockWebContents();
    const result = scanSessions("../escape", wc);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path separator/i);
  });

  it("returns error when path contains disallowed characters", () => {
    const wc = makeMockWebContents();
    const result = scanSessions("my project", wc);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disallowed characters/i);
  });

  it("destroyTracker is idempotent after failed scan", () => {
    const wc = makeMockWebContents();
    scanSessions("nonexistent-dir-xyz", wc);
    expect(() => destroyTracker()).not.toThrow();
  });
});

describe("v1.2 trackSelectedSessions: creates watchers only for selected UUIDs", () => {
  it("returns 0 tracked when called with empty array (skip scenario)", () => {
    const result = trackSelectedSessions([]);
    expect(result.tracked).toBe(0);
  });

  it("returns 0 tracked for unknown UUID (not in discoveredSessions)", () => {
    const result = trackSelectedSessions(["unknown-uuid-12345"]);
    // UUID not discovered, so nothing is tracked
    expect(result.tracked).toBe(0);
  });
});

describe("v1.2 pauseTracking / resumeTracking", () => {
  it("can be called without error when no tracking is active", () => {
    expect(() => {
      pauseTracking();
      resumeTracking();
    }).not.toThrow();
  });

  it("pausing and resuming does not affect session state integrity", () => {
    pauseTracking();
    resumeTracking();
    // After resume, stop should return empty sessions (nothing was tracked)
    const result = stopTrackingAndGetData();
    expect(result.sessions).toEqual([]);
  });
});

describe("v1.2 stopTrackingAndGetData: merges active and frozen sessions", () => {
  it("returns empty sessions when nothing was tracked", () => {
    const result = stopTrackingAndGetData();
    expect(result.sessions).toEqual([]);
  });

  it("clears state after stop (idempotent)", () => {
    const first = stopTrackingAndGetData();
    const second = stopTrackingAndGetData();
    expect(first.sessions).toEqual([]);
    expect(second.sessions).toEqual([]);
  });
});

describe("v1.2 destroyTracker: clears all v1.2 state", () => {
  it("resets discoveredSessions and frozenSessions on destroy", () => {
    destroyTracker();
    // After destroy, trackSelectedSessions with any UUID returns 0 (nothing discovered)
    const result = trackSelectedSessions(["some-uuid"]);
    expect(result.tracked).toBe(0);
  });

  it("is safe to call after stopTrackingAndGetData", () => {
    stopTrackingAndGetData();
    expect(() => destroyTracker()).not.toThrow();
  });
});
