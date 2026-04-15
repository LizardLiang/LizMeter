import { describe, expect, it } from "vitest";
import type { Session } from "../types.ts";
import { buildMergedWorklogBlocks, summarizeMergedWorklogSessions } from "../worklog.ts";

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    timerType: "work",
    plannedDurationSeconds: 1500,
    actualDurationSeconds: 1500,
    completedAt: "2026-02-24T10:25:00.000Z",
    tags: [],
    issueNumber: null,
    issueTitle: "Jira task",
    issueUrl: "https://example.atlassian.net/browse/PROJ-1",
    issueProvider: "jira",
    issueId: "PROJ-1",
    worklogStatus: "not_logged",
    worklogId: null,
    ...overrides,
  };
}

describe("worklog merge helpers", () => {
  it("merges a break between uploadable sessions into one bulk worklog block", () => {
    const work1 = makeSession("work-1", {
      actualDurationSeconds: 1500,
      completedAt: "2026-02-24T10:25:00.000Z",
    });
    const break1 = makeSession("break-1", {
      timerType: "short_break",
      actualDurationSeconds: 300,
      completedAt: "2026-02-24T10:30:00.000Z",
    });
    const work2 = makeSession("work-2", {
      actualDurationSeconds: 1200,
      completedAt: "2026-02-24T10:50:00.000Z",
    });

    const summary = summarizeMergedWorklogSessions([work1, break1, work2]);

    expect(summary.blocks).toHaveLength(1);
    expect(summary.totalDurationSeconds).toBe(3000);
    expect(summary.totalBreakSeconds).toBe(300);
    expect(summary.uploadableSessionIds).toEqual(["work-1", "work-2"]);
    expect(summary.breakSessionIds).toEqual(["break-1"]);
  });

  it("does not merge a trailing break without a following uploadable session", () => {
    const work = makeSession("work-1", {
      actualDurationSeconds: 1500,
      completedAt: "2026-02-24T10:25:00.000Z",
    });
    const trailingBreak = makeSession("break-1", {
      timerType: "long_break",
      actualDurationSeconds: 900,
      completedAt: "2026-02-24T10:40:00.000Z",
    });

    const blocks = buildMergedWorklogBlocks([work, trailingBreak]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.durationSeconds).toBe(1500);
    expect(blocks[0]?.breakSeconds).toBe(0);
    expect(blocks[0]?.breakSessionIds).toEqual([]);
  });
});
