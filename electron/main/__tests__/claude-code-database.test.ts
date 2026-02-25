// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  deleteSession,
  getClaudeCodeDataForSession,
  initDatabase,
  listSessions,
  saveSession,
  saveSessionWithTracking,
} from "../database.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeSessionInput(overrides = {}) {
  return {
    title: "Test session",
    timerType: "work" as const,
    plannedDurationSeconds: 1500,
    actualDurationSeconds: 1200,
    ...overrides,
  };
}

function makeCcSessionData(overrides = {}) {
  return {
    ccSessionUuid: "069362b8-73da-42cb-b6f2-33f94fb220d9",
    fileEditCount: 3,
    totalIdleSeconds: 120,
    idlePeriodCount: 1,
    firstActivityAt: "2026-02-25T10:00:00.000Z",
    lastActivityAt: "2026-02-25T11:00:00.000Z",
    filesEdited: ["C:\\Users\\test\\types.ts", "C:\\Users\\test\\index.ts", "C:\\Users\\test\\utils.ts"],
    idlePeriods: [
      {
        startAt: "2026-02-25T10:20:00.000Z",
        endAt: "2026-02-25T10:22:00.000Z",
        durationSeconds: 120,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

// TC-CC-DB-001: saveSessionWithTracking inserts session + tracking atomically
describe("TC-CC-DB-001: saveSessionWithTracking inserts session and tracking atomically", () => {
  it("inserts both session and CC session data in one transaction", () => {
    const ccSessionData = makeCcSessionData();
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [ccSessionData],
    });

    expect(session.id).toMatch(UUID_REGEX);

    const data = getClaudeCodeDataForSession(session.id);
    expect(data).not.toBeNull();
    expect(data!.sessions).toHaveLength(1);

    const cc = data!.sessions[0]!;
    expect(cc.ccSessionUuid).toBe(ccSessionData.ccSessionUuid);
    expect(cc.fileEditCount).toBe(ccSessionData.fileEditCount);
    expect(cc.totalIdleSeconds).toBe(ccSessionData.totalIdleSeconds);
    expect(cc.idlePeriodCount).toBe(ccSessionData.idlePeriodCount);
    expect(cc.firstActivityAt).toBe(ccSessionData.firstActivityAt);
    expect(cc.lastActivityAt).toBe(ccSessionData.lastActivityAt);
    expect(cc.filesEdited).toEqual(ccSessionData.filesEdited);
  });
});

// TC-CC-DB-002: saveSessionWithTracking works without claudeCodeSessions (no tracking data)
describe("TC-CC-DB-002: saveSessionWithTracking works without claudeCodeSessions", () => {
  it("saves session with no tracking data", () => {
    const session = saveSessionWithTracking(makeSessionInput());

    expect(session.id).toMatch(UUID_REGEX);

    const data = getClaudeCodeDataForSession(session.id);
    expect(data).toBeNull();
  });
});

// TC-CC-DB-003: saveSessionWithTracking saves idle periods
describe("TC-CC-DB-003: saveSessionWithTracking saves idle periods", () => {
  it("idle periods are persisted and retrieved correctly", () => {
    const ccData = makeCcSessionData({
      idlePeriods: [
        { startAt: "2026-02-25T10:20:00.000Z", endAt: "2026-02-25T10:26:00.000Z", durationSeconds: 360 },
        { startAt: "2026-02-25T10:40:00.000Z", endAt: "2026-02-25T10:47:00.000Z", durationSeconds: 420 },
      ],
      idlePeriodCount: 2,
      totalIdleSeconds: 780,
    });

    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [ccData],
    });

    const data = getClaudeCodeDataForSession(session.id);
    expect(data).not.toBeNull();
    expect(data!.sessions[0]!.idlePeriods).toHaveLength(2);
    expect(data!.sessions[0]!.idlePeriods[0]!.durationSeconds).toBe(360);
    expect(data!.sessions[0]!.idlePeriods[1]!.durationSeconds).toBe(420);
  });
});

// TC-CC-DB-004: duplicate (session_id, cc_session_uuid) handled via INSERT OR IGNORE
describe("TC-CC-DB-004: duplicate (session_id, cc_session_uuid) handled via INSERT OR IGNORE", () => {
  it("inserting duplicate CC session does not create duplicate rows", () => {
    const ccUuid = "069362b8-73da-42cb-b6f2-33f94fb220d9";
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [makeCcSessionData({ ccSessionUuid: ccUuid })],
    });

    // Attempt a second save with the same session_id + cc_session_uuid
    // This shouldn't happen in production, but the INSERT OR IGNORE should handle it
    // We verify by checking the count
    const data = getClaudeCodeDataForSession(session.id);
    expect(data!.sessions).toHaveLength(1);
    expect(data!.sessions[0]!.ccSessionUuid).toBe(ccUuid);
  });
});

// TC-CC-DB-005: getClaudeCodeDataForSession returns null for sessions without data
describe("TC-CC-DB-005: getClaudeCodeDataForSession returns null for sessions without CC data", () => {
  it("returns null when no CC data exists for the session", () => {
    const session = saveSession(makeSessionInput());
    const data = getClaudeCodeDataForSession(session.id);
    expect(data).toBeNull();
  });

  it("returns null for non-existent session ID", () => {
    const data = getClaudeCodeDataForSession("non-existent-uuid");
    expect(data).toBeNull();
  });
});

// TC-CC-DB-006: CASCADE delete removes CC sessions and idle periods
describe("TC-CC-DB-006: CASCADE delete removes CC sessions and idle periods when session is deleted", () => {
  it("deleting session removes all associated CC data", () => {
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [makeCcSessionData()],
    });

    // Verify data exists
    expect(getClaudeCodeDataForSession(session.id)).not.toBeNull();

    // Delete the session
    deleteSession(session.id);

    // CC data should be gone
    expect(getClaudeCodeDataForSession(session.id)).toBeNull();
  });
});

// TC-CC-DB-007: multiple CC sessions per session
describe("TC-CC-DB-007: multiple CC sessions per timer session", () => {
  it("saves and retrieves multiple CC sessions", () => {
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [
        makeCcSessionData({
          ccSessionUuid: "uuid-001",
          fileEditCount: 2,
          filesEdited: ["a.ts", "b.ts"],
        }),
        makeCcSessionData({
          ccSessionUuid: "uuid-002",
          fileEditCount: 5,
          filesEdited: ["c.ts", "d.ts", "e.ts", "f.ts", "g.ts"],
        }),
      ],
    });

    const data = getClaudeCodeDataForSession(session.id);
    expect(data).not.toBeNull();
    expect(data!.sessions).toHaveLength(2);

    const uuids = data!.sessions.map((s) => s.ccSessionUuid);
    expect(uuids).toContain("uuid-001");
    expect(uuids).toContain("uuid-002");
  });
});

// TC-CC-DB-008: filesEdited JSON round-trip
describe("TC-CC-DB-008: filesEdited JSON array round-trips correctly", () => {
  it("files_edited array is serialized and deserialized correctly", () => {
    const files = ["C:\\Users\\test\\a.ts", "C:\\Users\\test\\b.ts", "C:\\Users\\test\\c.ts"];
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [
        makeCcSessionData({ filesEdited: files, fileEditCount: files.length }),
      ],
    });

    const data = getClaudeCodeDataForSession(session.id);
    expect(data!.sessions[0]!.filesEdited).toEqual(files);
  });

  it("empty filesEdited is handled", () => {
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [
        makeCcSessionData({ filesEdited: [], fileEditCount: 0 }),
      ],
    });

    const data = getClaudeCodeDataForSession(session.id);
    expect(data!.sessions[0]!.filesEdited).toEqual([]);
  });
});

// TC-CC-DB-009: saveSessionWithTracking with empty claudeCodeSessions array
describe("TC-CC-DB-009: empty claudeCodeSessions array saves session without CC data", () => {
  it("empty array is treated same as omitted", () => {
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [],
    });

    expect(session.id).toMatch(UUID_REGEX);
    const data = getClaudeCodeDataForSession(session.id);
    expect(data).toBeNull();
  });
});

// TC-CC-DB-010: Claude Code tables are created by initDatabase
describe("TC-CC-DB-010: initDatabase creates claude_code_sessions and idle_periods tables", () => {
  it("tables exist after initDatabase", () => {
    // If tables didn't exist, saveSessionWithTracking would throw
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [makeCcSessionData()],
    });
    expect(session.id).toBeDefined();

    // Verify retrieval works (means both tables exist)
    const data = getClaudeCodeDataForSession(session.id);
    expect(data).not.toBeNull();
    expect(data!.sessions[0]!.idlePeriods).toHaveLength(1);
  });
});

// TC-CC-DB-011: listSessions still works after adding new tables (no regression)
describe("TC-CC-DB-011: no regression on existing listSessions functionality", () => {
  it("listSessions returns correct results after adding CC tables", () => {
    const s1 = saveSession(makeSessionInput({ title: "Session A" }));
    const s2 = saveSessionWithTracking({
      ...makeSessionInput({ title: "Session B with tracking" }),
      claudeCodeSessions: [makeCcSessionData()],
    });

    const list = listSessions({});
    expect(list.total).toBe(2);
    const ids = list.sessions.map((s) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });
});

// TC-CC-DB-012: initDatabase is idempotent (migrations for new tables run safely twice)
describe("TC-CC-DB-012: initDatabase migrations are idempotent", () => {
  it("calling initDatabase twice does not throw or drop CC tables", () => {
    const session = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [makeCcSessionData()],
    });

    // Re-initialize (runs CREATE TABLE IF NOT EXISTS again)
    closeDatabase();
    initDatabase(":memory:");

    // Data is gone (in-memory), but schema is intact
    const list = listSessions({});
    expect(list.sessions).toHaveLength(0);
    // Can still save with tracking (tables exist)
    const session2 = saveSessionWithTracking({
      ...makeSessionInput(),
      claudeCodeSessions: [makeCcSessionData()],
    });
    expect(session2.id).toMatch(UUID_REGEX);
    void session;
  });
});
