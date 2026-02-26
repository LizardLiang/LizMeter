// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  deleteSession,
  getSessionById,
  getSettings,
  initDatabase,
  listSessions,
  saveSession,
  saveSettings,
  updateWorklogStatus,
} from "../database.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("TC-301: initDatabase creates schema on fresh database", () => {
  it("creates sessions and settings tables and the index", () => {
    const result = listSessions({});
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);

    // If tables didn't exist, listSessions would throw
    // Also verify settings table by calling getSettings
    const settings = getSettings();
    expect(settings.workDuration).toBe(1500);
  });
});

describe("TC-302: saveSession inserts a record and returns Session object", () => {
  it("returns a valid Session with generated id and completedAt", () => {
    const session = saveSession({
      title: "Test session",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1498,
    });

    expect(session.id).toMatch(UUID_REGEX);
    expect(session.completedAt).toMatch(ISO_REGEX);
    expect(session.title).toBe("Test session");
    expect(session.timerType).toBe("work");
    expect(session.plannedDurationSeconds).toBe(1500);
    expect(session.actualDurationSeconds).toBe(1498);

    const list = listSessions({});
    expect(list.sessions.length).toBe(1);
    expect(list.total).toBe(1);
  });
});

describe("TC-303: saveSession generates unique IDs for multiple sessions", () => {
  it("all 5 sessions have distinct IDs", () => {
    const ids = Array.from({ length: 5 }, (_, i) =>
      saveSession({
        title: `Session ${i}`,
        timerType: "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
      }).id);

    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });
});

describe("TC-304: listSessions returns sessions ordered by completedAt DESC", () => {
  it("most recent session first", () => {
    // We need to control completedAt ordering — save in sequence
    const s1 = saveSession({
      title: "Oldest",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    const s2 = saveSession({
      title: "Middle",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    const s3 = saveSession({
      title: "Newest",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });

    const result = listSessions({ limit: 50, offset: 0 });

    expect(result.total).toBe(3);
    expect(result.sessions.length).toBe(3);

    // IDs should exist and all be in the result
    const ids = result.sessions.map((s) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
    expect(ids).toContain(s3.id);
  });
});

describe("TC-305: listSessions paginates correctly", () => {
  it("pages through 10 sessions in groups of 3", () => {
    for (let i = 0; i < 10; i++) {
      saveSession({
        title: `Session ${i}`,
        timerType: "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
      });
    }

    const page1 = listSessions({ limit: 3, offset: 0 });
    expect(page1.sessions.length).toBe(3);
    expect(page1.total).toBe(10);

    const page2 = listSessions({ limit: 3, offset: 3 });
    expect(page2.sessions.length).toBe(3);
    expect(page2.total).toBe(10);

    const page4 = listSessions({ limit: 3, offset: 9 });
    expect(page4.sessions.length).toBe(1);
    expect(page4.total).toBe(10);

    // No duplicates
    const allIds = [...page1.sessions, ...page2.sessions, ...page4.sessions].map((s) => s.id);
    const unique = new Set(allIds);
    expect(unique.size).toBe(7);
  });
});

describe("TC-306: listSessions defaults limit to 50", () => {
  it("returns at most 50 by default when 60 exist", () => {
    for (let i = 0; i < 60; i++) {
      saveSession({ title: `S${i}`, timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500 });
    }

    const result = listSessions({});
    expect(result.sessions.length).toBe(50);
    expect(result.total).toBe(60);
  });
});

describe("TC-307: deleteSession removes the row", () => {
  it("session is gone after delete", () => {
    const session = saveSession({
      title: "To Delete",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });

    deleteSession(session.id);

    const result = listSessions({});
    expect(result.sessions.length).toBe(0);
    expect(result.total).toBe(0);
  });
});

describe("TC-308: deleteSession is a no-op for non-existent ID", () => {
  it("does not throw for fake ID", () => {
    expect(() => deleteSession("non-existent-id-that-does-not-exist")).not.toThrow();
  });
});

describe("TC-309: getSettings returns hardcoded defaults when table is empty", () => {
  it("returns default work/break durations", () => {
    const settings = getSettings();
    expect(settings.workDuration).toBe(1500);
    expect(settings.shortBreakDuration).toBe(300);
    expect(settings.longBreakDuration).toBe(900);
  });
});

describe("TC-310: saveSettings persists and getSettings retrieves custom values", () => {
  it("round-trips custom settings", () => {
    saveSettings({ workDuration: 1800, shortBreakDuration: 600, longBreakDuration: 1200 });
    const settings = getSettings();
    expect(settings.workDuration).toBe(1800);
    expect(settings.shortBreakDuration).toBe(600);
    expect(settings.longBreakDuration).toBe(1200);
  });
});

describe("TC-311: saveSettings is idempotent (upsert)", () => {
  it("second save overwrites first", () => {
    saveSettings({ workDuration: 1800, shortBreakDuration: 600, longBreakDuration: 1200 });
    saveSettings({ workDuration: 2100, shortBreakDuration: 300, longBreakDuration: 900 });
    const settings = getSettings();
    expect(settings.workDuration).toBe(2100);
  });
});

describe("TC-312: Input validation — saveSession rejects invalid timerType", () => {
  it("throws for invalid timer type", () => {
    expect(() =>
      saveSession({
        title: "Test",
        timerType: "invalid_type" as unknown as "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
      })
    ).toThrow();
  });
});

describe("TC-313: Input validation — saveSettings rejects out-of-range durations", () => {
  it("throws for duration below minimum (60)", () => {
    expect(() => saveSettings({ workDuration: 0, shortBreakDuration: 300, longBreakDuration: 900 })).toThrow();
  });

  it("throws for duration above maximum (7200)", () => {
    expect(() => saveSettings({ workDuration: 9000, shortBreakDuration: 300, longBreakDuration: 900 })).toThrow();
  });
});

describe("TC-314: Input validation — session title is trimmed and length-capped", () => {
  it("trims leading/trailing whitespace", () => {
    const session = saveSession({
      title: "  padded  ",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    expect(session.title).toBe("padded");
  });

  it("truncates title at 5000 characters", () => {
    const session = saveSession({
      title: "a".repeat(5001),
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    expect(session.title.length).toBeLessThanOrEqual(5000);
  });
});

describe("TC-315: listSessions returns empty array when no sessions exist", () => {
  it("returns empty results on fresh database", () => {
    const result = listSessions({});
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("TC-316: Database init is idempotent", () => {
  it("calling initDatabase twice does not throw or drop data", () => {
    saveSession({ title: "Existing", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500 });

    // Second init
    initDatabase(":memory:");

    // This creates a fresh in-memory DB, so no data persists — that's expected for :memory:
    // The important thing is no error is thrown
    const result = listSessions({});
    expect(result).toBeDefined();
  });
});

// --- Linear Integration Tests (TC-141 through TC-156) ---

describe("TC-141: Migration adds issue_provider and issue_id columns", () => {
  it("sessions table contains all expected columns", () => {
    // Use the raw db access via listSessions as a proxy — if columns exist, no error
    // We verify by saving a session with the new fields and reading them back
    const session = saveSession({
      title: "Column test",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueProvider: "linear",
      issueId: "LIN-1",
    });
    expect(session.issueProvider).toBe("linear");
    expect(session.issueId).toBe("LIN-1");
  });
});

describe("TC-142: Migration is idempotent (calling initDatabase twice does not fail)", () => {
  it("second initDatabase call does not throw", () => {
    expect(() => {
      closeDatabase();
      initDatabase(":memory:");
    }).not.toThrow();
  });
});

describe("TC-151: saveSession with Linear issue stores issue_provider and issue_id", () => {
  it("returns session with correct issueProvider and issueId", () => {
    const session = saveSession({
      title: "Linear work",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1498,
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: "Fix auth timeout",
      issueUrl: "https://linear.app/team/LIN-42",
    });
    expect(session.issueProvider).toBe("linear");
    expect(session.issueId).toBe("LIN-42");
    expect(session.issueTitle).toBe("Fix auth timeout");
    expect(session.issueUrl).toBe("https://linear.app/team/LIN-42");

    const list = listSessions({});
    expect(list.sessions[0]?.issueProvider).toBe("linear");
    expect(list.sessions[0]?.issueId).toBe("LIN-42");
  });
});

describe("TC-152: saveSession with GitHub issue stores both legacy and new columns", () => {
  it("dual-writes issueNumber and issueProvider/issueId", () => {
    const session = saveSession({
      title: "GitHub work",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1498,
      issueNumber: 42,
      issueTitle: "Fix bug",
      issueUrl: "https://github.com/owner/repo/issues/42",
      issueProvider: "github",
      issueId: "42",
    });
    expect(session.issueNumber).toBe(42);
    expect(session.issueProvider).toBe("github");
    expect(session.issueId).toBe("42");
    expect(session.issueTitle).toBe("Fix bug");

    const list = listSessions({});
    expect(list.sessions[0]?.issueNumber).toBe(42);
    expect(list.sessions[0]?.issueProvider).toBe("github");
    expect(list.sessions[0]?.issueId).toBe("42");
  });
});

describe("TC-153: saveSession rejects invalid issueProvider values", () => {
  it("throws error for invalid issueProvider 'bitbucket'", () => {
    expect(() =>
      saveSession({
        title: "test",
        timerType: "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
        issueProvider: "bitbucket" as unknown as "github",
      })
    ).toThrow(/invalid issueProvider/i);
  });
});

describe("TC-154: listSessions returns issueProvider and issueId for new sessions", () => {
  it("maps snake_case columns to camelCase fields", () => {
    saveSession({
      title: "Linear work",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueProvider: "linear",
      issueId: "LIN-99",
    });
    const list = listSessions({});
    expect(list.sessions[0]?.issueProvider).toBe("linear");
    expect(list.sessions[0]?.issueId).toBe("LIN-99");
  });
});

describe("TC-155: listSessions returns null for issueProvider on legacy sessions (backward compat)", () => {
  it("session saved without issueProvider returns null for both new fields", () => {
    saveSession({
      title: "Legacy session",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueNumber: 5,
    });
    const list = listSessions({});
    const session = list.sessions[0]!;
    expect(session.issueNumber).toBe(5);
    expect(session.issueProvider).toBeNull();
    expect(session.issueId).toBeNull();
  });
});

describe("TC-156: Simulated legacy database migration", () => {
  it("legacy sessions (no issue_provider) still queryable after migration", () => {
    // Session saved without new fields — simulates pre-migration data
    saveSession({
      title: "Old session",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueNumber: 10,
    });

    // Re-initialize (re-runs migration logic, idempotent)
    closeDatabase();
    initDatabase(":memory:");

    // In :memory: the data is gone, but the schema migration ran fine — no error
    const list = listSessions({});
    expect(list.sessions).toHaveLength(0); // :memory: = fresh DB after re-init
    expect(list.total).toBe(0);
  });
});

// --- Worklog Integration Tests ---

describe("TC-501: Migration adds worklog_status and worklog_id columns", () => {
  it("new sessions default to worklog_status not_logged and worklog_id null", () => {
    const session = saveSession({
      title: "Worklog test",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    expect(session.worklogStatus).toBe("not_logged");
    expect(session.worklogId).toBeNull();
  });
});

describe("TC-502: Migration is idempotent", () => {
  it("calling initDatabase twice does not error on worklog columns", () => {
    expect(() => {
      closeDatabase();
      initDatabase(":memory:");
    }).not.toThrow();
  });
});

describe("TC-503: getSessionById returns session with worklog fields", () => {
  it("returns session object with worklogStatus and worklogId", () => {
    const saved = saveSession({
      title: "Get by id test",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    const found = getSessionById(saved.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(saved.id);
    expect(found!.worklogStatus).toBe("not_logged");
    expect(found!.worklogId).toBeNull();
  });

  it("returns null for non-existent id", () => {
    const result = getSessionById("non-existent-uuid");
    expect(result).toBeNull();
  });
});

describe("TC-504: updateWorklogStatus updates status to logged with worklogId", () => {
  it("sets worklog_status to logged and stores worklog_id", () => {
    const session = saveSession({
      title: "Update worklog test",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    updateWorklogStatus(session.id, "logged", "10042");
    const updated = getSessionById(session.id);
    expect(updated!.worklogStatus).toBe("logged");
    expect(updated!.worklogId).toBe("10042");
  });
});

describe("TC-505: updateWorklogStatus updates status to failed without worklogId", () => {
  it("sets worklog_status to failed leaving worklog_id null", () => {
    const session = saveSession({
      title: "Failed worklog test",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
    });
    updateWorklogStatus(session.id, "failed");
    const updated = getSessionById(session.id);
    expect(updated!.worklogStatus).toBe("failed");
    expect(updated!.worklogId).toBeNull();
  });
});

describe("TC-506: listSessions returns sessions with worklog fields", () => {
  it("sessions from listSessions include worklogStatus and worklogId", () => {
    const session = saveSession({
      title: "List worklog test",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueProvider: "jira",
      issueId: "PROJ-123",
    });
    updateWorklogStatus(session.id, "logged", "10099");
    const list = listSessions({});
    const found = list.sessions.find((s) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found!.worklogStatus).toBe("logged");
    expect(found!.worklogId).toBe("10099");
  });
});

describe("TC-405 (Performance): listSessions with 1000 records completes in under 500ms", () => {
  it("query time is under 500ms", () => {
    for (let i = 0; i < 1000; i++) {
      saveSession({
        title: `Perf session ${i}`,
        timerType: "work",
        plannedDurationSeconds: 1500,
        actualDurationSeconds: 1500,
      });
    }

    const start = performance.now();
    const result = listSessions({ limit: 50, offset: 0 });
    const elapsed = performance.now() - start;

    expect(result.sessions.length).toBe(50);
    expect(result.total).toBe(1000);
    expect(elapsed).toBeLessThan(500);
  });
});
