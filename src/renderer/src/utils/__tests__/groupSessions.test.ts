import { describe, expect, it } from "vitest";
import type { Session } from "../../../../shared/types.ts";
import { formatDateLabel, getIssueGroupKey, groupSessionsByIssue, hasLinkedIssue } from "../groupSessions.ts";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> & { id: string; }): Session {
  return {
    title: "Test session",
    timerType: "work",
    plannedDurationSeconds: 1500,
    actualDurationSeconds: 1500,
    completedAt: "2026-02-24T10:00:00.000Z",
    tags: [],
    issueNumber: null,
    issueTitle: null,
    issueUrl: null,
    issueProvider: null,
    issueId: null,
    ...overrides,
  };
}

// ─── hasLinkedIssue ──────────────────────────────────────────────────────

describe("hasLinkedIssue", () => {
  it("returns true for sessions with issueProvider and issueId set", () => {
    expect(hasLinkedIssue(makeSession({ id: "1", issueProvider: "github", issueId: "42" }))).toBe(true);
    expect(hasLinkedIssue(makeSession({ id: "2", issueProvider: "linear", issueId: "LIN-42" }))).toBe(true);
    expect(hasLinkedIssue(makeSession({ id: "3", issueProvider: "jira", issueId: "PROJ-123" }))).toBe(true);
  });

  it("returns true for legacy GitHub sessions (issueProvider null, issueNumber set)", () => {
    expect(hasLinkedIssue(makeSession({ id: "4", issueProvider: null, issueNumber: 7 }))).toBe(true);
  });

  it("returns false for sessions with no linked issue", () => {
    expect(hasLinkedIssue(makeSession({ id: "5" }))).toBe(false);
  });

  it("returns false when issueProvider set but issueId is null", () => {
    expect(hasLinkedIssue(makeSession({ id: "6", issueProvider: "github", issueId: null }))).toBe(false);
  });

  it("returns false when issueProvider is null and issueNumber is null", () => {
    expect(hasLinkedIssue(makeSession({ id: "7", issueProvider: null, issueNumber: null }))).toBe(false);
  });
});

// ─── getIssueGroupKey ────────────────────────────────────────────────────

describe("getIssueGroupKey", () => {
  it("returns correct key for github provider", () => {
    const session = makeSession({
      id: "1",
      issueProvider: "github",
      issueId: "42",
      issueTitle: "Fix bug",
      issueUrl: "https://github.com/owner/repo/issues/42",
    });
    const key = getIssueGroupKey(session);
    expect(key.key).toBe("github:42");
    expect(key.provider).toBe("github");
    expect(key.displayId).toBe("#42");
    expect(key.title).toBe("Fix bug");
    expect(key.url).toBe("https://github.com/owner/repo/issues/42");
  });

  it("returns correct key for linear provider", () => {
    const session = makeSession({
      id: "2",
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: "Refactor auth",
      issueUrl: "https://linear.app/team/LIN-42",
    });
    const key = getIssueGroupKey(session);
    expect(key.key).toBe("linear:LIN-42");
    expect(key.provider).toBe("linear");
    expect(key.displayId).toBe("LIN-42");
    expect(key.title).toBe("Refactor auth");
  });

  it("returns correct key for jira provider", () => {
    const session = makeSession({
      id: "3",
      issueProvider: "jira",
      issueId: "PROJ-123",
      issueTitle: "Jira task",
      issueUrl: "https://example.atlassian.net/browse/PROJ-123",
    });
    const key = getIssueGroupKey(session);
    expect(key.key).toBe("jira:PROJ-123");
    expect(key.provider).toBe("jira");
    expect(key.displayId).toBe("PROJ-123");
    expect(key.title).toBe("Jira task");
  });

  it("returns correct key for legacy-github with issueUrl", () => {
    const session = makeSession({
      id: "4",
      issueProvider: null,
      issueNumber: 7,
      issueUrl: "https://github.com/owner/repo/issues/7",
    });
    const key = getIssueGroupKey(session);
    expect(key.key).toBe("legacy-github-url:https://github.com/owner/repo/issues/7");
    expect(key.provider).toBe("legacy-github");
    expect(key.displayId).toBe("#7");
  });

  it("returns correct key for legacy-github without issueUrl (fallback to number)", () => {
    const session = makeSession({ id: "5", issueProvider: null, issueNumber: 99, issueUrl: null });
    const key = getIssueGroupKey(session);
    expect(key.key).toBe("legacy-github-num:99");
    expect(key.provider).toBe("legacy-github");
    expect(key.displayId).toBe("#99");
  });
});

// ─── formatDateLabel ─────────────────────────────────────────────────────

describe("formatDateLabel", () => {
  const fixedNow = new Date("2026-02-24T15:00:00.000Z");

  it("returns 'Today' for the current date key", () => {
    // We need to compute today's key the same way the function does (local time)
    const d = new Date(fixedNow);
    const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
    expect(formatDateLabel(todayKey, fixedNow)).toBe("Today");
  });

  it("returns 'Yesterday' for the previous date key", () => {
    const d = new Date(fixedNow);
    d.setDate(d.getDate() - 1);
    const yesterdayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
    expect(formatDateLabel(yesterdayKey, fixedNow)).toBe("Yesterday");
  });

  it("returns absolute format without year for dates in current year", () => {
    const label = formatDateLabel("2026-02-10", fixedNow);
    // Should NOT contain a year (2026), should contain month and day
    expect(label).not.toMatch(/2026/);
    expect(label).toMatch(/Feb|2月|february/i);
    expect(label).toMatch(/10/);
  });

  it("returns absolute format with year for dates in a different year", () => {
    const label = formatDateLabel("2025-12-15", fixedNow);
    expect(label).toMatch(/2025/);
    expect(label).toMatch(/Dec|12月|december/i);
    expect(label).toMatch(/15/);
  });
});

// ─── groupSessionsByIssue ────────────────────────────────────────────────

describe("groupSessionsByIssue", () => {
  it("returns empty issueGroups and ungroupedSessions for empty input", () => {
    const result = groupSessionsByIssue([]);
    expect(result.issueGroups).toHaveLength(0);
    expect(result.ungroupedSessions).toHaveLength(0);
  });

  it("places sessions without issues into ungroupedSessions", () => {
    const sessions = [
      makeSession({ id: "1", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "2", completedAt: "2026-02-24T11:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(0);
    expect(result.ungroupedSessions).toHaveLength(2);
  });

  it("creates one issueGroup for sessions all linked to same issue", () => {
    const sessions = [
      makeSession({
        id: "1",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 900,
        completedAt: "2026-02-24T09:00:00.000Z",
      }),
      makeSession({
        id: "2",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 600,
        completedAt: "2026-02-24T10:00:00.000Z",
      }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(1);
    expect(result.ungroupedSessions).toHaveLength(0);
    expect(result.issueGroups[0]!.totalSeconds).toBe(1500);
    expect(result.issueGroups[0]!.sessionCount).toBe(2);
    expect(result.issueGroups[0]!.issueKey.displayId).toBe("#42");
  });

  it("creates multiple date sub-groups when same issue has sessions on different dates", () => {
    const sessions = [
      makeSession({
        id: "1",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 900,
        completedAt: "2026-02-24T10:00:00.000Z",
      }),
      makeSession({
        id: "2",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 600,
        completedAt: "2026-02-23T10:00:00.000Z",
      }),
      makeSession({
        id: "3",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 300,
        completedAt: "2026-02-23T11:00:00.000Z",
      }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(1);
    const group = result.issueGroups[0]!;
    expect(group.dateSubGroups).toHaveLength(2);
    // Most recent date first
    expect(group.dateSubGroups[0]!.sessionCount).toBe(1);
    expect(group.dateSubGroups[1]!.sessionCount).toBe(2);
    expect(group.dateSubGroups[1]!.totalSeconds).toBe(900);
  });

  it("creates multiple issueGroups for sessions with different issues", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "github", issueId: "99", completedAt: "2026-02-23T10:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(2);
    // Most recently active issue comes first
    expect(result.issueGroups[0]!.issueKey.displayId).toBe("#42");
    expect(result.issueGroups[1]!.issueKey.displayId).toBe("#99");
  });

  it("correctly partitions mixed sessions into groups and ungrouped", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "2", completedAt: "2026-02-24T11:00:00.000Z" }),
      makeSession({ id: "3", issueProvider: "linear", issueId: "LIN-1", completedAt: "2026-02-24T12:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(2);
    expect(result.ungroupedSessions).toHaveLength(1);
    expect(result.ungroupedSessions[0]!.id).toBe("2");
  });

  it("groups legacy GitHub sessions correctly", () => {
    const sessions = [
      makeSession({
        id: "1",
        issueProvider: null,
        issueNumber: 7,
        issueUrl: "https://github.com/owner/repo/issues/7",
        completedAt: "2026-02-24T10:00:00.000Z",
      }),
      makeSession({
        id: "2",
        issueProvider: null,
        issueNumber: 7,
        issueUrl: "https://github.com/owner/repo/issues/7",
        completedAt: "2026-02-24T11:00:00.000Z",
      }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(1);
    expect(result.issueGroups[0]!.sessionCount).toBe(2);
    expect(result.issueGroups[0]!.issueKey.provider).toBe("legacy-github");
    expect(result.issueGroups[0]!.issueKey.displayId).toBe("#7");
  });

  it("separates legacy GitHub sessions with different issueUrls into different groups", () => {
    const sessions = [
      makeSession({
        id: "1",
        issueProvider: null,
        issueNumber: 7,
        issueUrl: "https://github.com/owner/repo-a/issues/7",
        completedAt: "2026-02-24T10:00:00.000Z",
      }),
      makeSession({
        id: "2",
        issueProvider: null,
        issueNumber: 7,
        issueUrl: "https://github.com/owner/repo-b/issues/7",
        completedAt: "2026-02-24T11:00:00.000Z",
      }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(2);
  });

  it("groups Linear sessions by issueId", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "linear", issueId: "LIN-10", completedAt: "2026-02-24T09:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "linear", issueId: "LIN-10", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "3", issueProvider: "linear", issueId: "LIN-20", completedAt: "2026-02-24T11:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(2);
    const lin10 = result.issueGroups.find((g) => g.issueKey.displayId === "LIN-10");
    expect(lin10?.sessionCount).toBe(2);
  });

  it("groups Jira sessions by issueId", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "jira", issueId: "PROJ-123", completedAt: "2026-02-24T09:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "jira", issueId: "PROJ-123", completedAt: "2026-02-24T10:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(1);
    expect(result.issueGroups[0]!.issueKey.displayId).toBe("PROJ-123");
    expect(result.issueGroups[0]!.sessionCount).toBe(2);
  });

  it("keeps sessions from different providers with same coincidental issueId as separate groups", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "linear", issueId: "42", completedAt: "2026-02-24T11:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups).toHaveLength(2);
    const keys = result.issueGroups.map((g) => g.issueKey.key);
    expect(keys).toContain("github:42");
    expect(keys).toContain("linear:42");
  });

  it("DateSubGroup.dateKey is in YYYY-MM-DD format", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T23:59:59.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    const dateKey = result.issueGroups[0]!.dateSubGroups[0]!.dateKey;
    expect(dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("DateSubGroup.sessionCount matches sessions.length", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T09:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "3", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T11:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    const subGroup = result.issueGroups[0]!.dateSubGroups[0]!;
    expect(subGroup.sessionCount).toBe(subGroup.sessions.length);
    expect(subGroup.sessionCount).toBe(3);
  });

  it("total seconds aggregation is mathematically correct", () => {
    const sessions = [
      makeSession({
        id: "1",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 1234,
        completedAt: "2026-02-24T09:00:00.000Z",
      }),
      makeSession({
        id: "2",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 567,
        completedAt: "2026-02-24T10:00:00.000Z",
      }),
      makeSession({
        id: "3",
        issueProvider: "github",
        issueId: "42",
        actualDurationSeconds: 890,
        completedAt: "2026-02-23T10:00:00.000Z",
      }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups[0]!.totalSeconds).toBe(1234 + 567 + 890);
  });

  it("orders issue groups by most recent session descending", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "old", completedAt: "2026-02-20T10:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "github", issueId: "new", completedAt: "2026-02-24T10:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    expect(result.issueGroups[0]!.issueKey.displayId).toBe("#new");
    expect(result.issueGroups[1]!.issueKey.displayId).toBe("#old");
  });

  it("orders date sub-groups by date descending (most recent first)", () => {
    const sessions = [
      makeSession({ id: "1", issueProvider: "github", issueId: "42", completedAt: "2026-02-20T10:00:00.000Z" }),
      makeSession({ id: "2", issueProvider: "github", issueId: "42", completedAt: "2026-02-24T10:00:00.000Z" }),
      makeSession({ id: "3", issueProvider: "github", issueId: "42", completedAt: "2026-02-22T10:00:00.000Z" }),
    ];
    const result = groupSessionsByIssue(sessions);
    const dateKeys = result.issueGroups[0]!.dateSubGroups.map((sg) => sg.dateKey);
    expect(dateKeys[0]! > dateKeys[1]!).toBe(true);
    expect(dateKeys[1]! > dateKeys[2]!).toBe(true);
  });
});
