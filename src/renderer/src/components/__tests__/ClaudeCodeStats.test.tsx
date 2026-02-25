import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeLiveStats, ClaudeCodeSessionPreview } from "../../../../shared/types.ts";
import { ClaudeCodeStats } from "../ClaudeCodeStats.tsx";

afterEach(() => {
  cleanup();
});

function makeLiveStats(overrides: Partial<ClaudeCodeLiveStats> = {}): ClaudeCodeLiveStats {
  return {
    activeSessions: 1,
    totalFilesEdited: 3,
    filesEditedList: ["a.ts", "b.ts", "c.ts"],
    lastActivityTimestamp: new Date().toISOString(),
    idleSessions: 0,
    ...overrides,
  };
}

// TC-CC-UI-001: Component does not render when isTracking is false
describe("TC-CC-UI-001: ClaudeCodeStats does not render when isTracking is false", () => {
  it("returns null when not tracking", () => {
    const { container } = render(
      <ClaudeCodeStats liveStats={null} isTracking={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null even with liveStats when not tracking", () => {
    const { container } = render(
      <ClaudeCodeStats liveStats={makeLiveStats()} isTracking={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// TC-CC-UI-002: Shows "Waiting for Claude Code activity" when tracking but no stats yet
describe("TC-CC-UI-002: Shows waiting message when tracking but no liveStats", () => {
  it("displays waiting message when liveStats is null", () => {
    const { getByText } = render(
      <ClaudeCodeStats liveStats={null} isTracking={true} />,
    );
    expect(getByText(/waiting for claude code activity/i)).toBeInTheDocument();
  });
});

// TC-CC-UI-003: Renders session count and file count
describe("TC-CC-UI-003: Renders session count and file count from liveStats", () => {
  it("displays activeSessions and totalFilesEdited", () => {
    const stats = makeLiveStats({ activeSessions: 2, totalFilesEdited: 7 });
    const { getByText } = render(
      <ClaudeCodeStats liveStats={stats} isTracking={true} />,
    );
    expect(getByText("2")).toBeInTheDocument();
    expect(getByText("7")).toBeInTheDocument();
  });
});

// TC-CC-UI-004: Shows error message when liveStats.error is set
describe("TC-CC-UI-004: Shows error message when liveStats.error is set", () => {
  it("displays the error message", () => {
    const stats = makeLiveStats({ error: "Project not found" });
    const { getByText } = render(
      <ClaudeCodeStats liveStats={stats} isTracking={true} />,
    );
    expect(getByText("Project not found")).toBeInTheDocument();
  });
});

// TC-CC-UI-005: Shows "Active" status when within idle threshold
describe("TC-CC-UI-005: Shows Active status when within idle threshold", () => {
  it("shows Active when last activity was recent", () => {
    const recentTimestamp = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const stats = makeLiveStats({ lastActivityTimestamp: recentTimestamp });
    const { getAllByText } = render(
      <ClaudeCodeStats liveStats={stats} isTracking={true} idleThresholdMinutes={5} />,
    );
    const activeEls = getAllByText(/active/i);
    expect(activeEls.length).toBeGreaterThan(0);
    // Should NOT show idle
    activeEls.forEach((el) => {
      expect(el.textContent).not.toMatch(/idle for/i);
    });
  });
});

// TC-CC-UI-006: Shows idle status when exceeds threshold
describe("TC-CC-UI-006: Shows Idle status when lastActivityTimestamp exceeds threshold", () => {
  it("shows Idle for X min when past idle threshold", () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 minutes ago
    const stats = makeLiveStats({ lastActivityTimestamp: oldTimestamp });
    const { getByText } = render(
      <ClaudeCodeStats liveStats={stats} isTracking={true} idleThresholdMinutes={5} />,
    );
    // Should show "Idle for X min"
    const idleEl = getByText(/idle for/i);
    expect(idleEl).toBeInTheDocument();
  });
});

// TC-CC-UI-007: Shows idle sessions count when > 0
describe("TC-CC-UI-007: Shows idle sessions count when greater than 0", () => {
  it("displays idle sessions label when count is > 0", () => {
    const stats = makeLiveStats({ idleSessions: 2 });
    const { getByText } = render(
      <ClaudeCodeStats liveStats={stats} isTracking={true} />,
    );
    // Check the label is rendered
    expect(getByText(/idle sessions/i)).toBeInTheDocument();
  });

  it("does not show idle sessions row when count is 0", () => {
    const stats = makeLiveStats({ idleSessions: 0 });
    const { queryByText } = render(
      <ClaudeCodeStats liveStats={stats} isTracking={true} />,
    );
    // "Idle sessions" label should not appear when count is 0
    expect(queryByText(/idle sessions/i)).toBeNull();
  });
});

// TC-CC-UI-008: Header always shows "Claude Code" label
describe("TC-CC-UI-008: Header always shows Claude Code label", () => {
  it("displays Claude Code header when tracking", () => {
    const { getAllByText } = render(
      <ClaudeCodeStats liveStats={makeLiveStats()} isTracking={true} />,
    );
    // There may be multiple elements (e.g., due to text-transform: uppercase rendering)
    const claudeEls = getAllByText(/claude code/i);
    expect(claudeEls.length).toBeGreaterThan(0);
  });
});

// TC-CC-UI-009: v1.2 "Manage Sessions" button
describe("TC-CC-UI-009 (v1.2): Manage Sessions button", () => {
  it("shows Manage Sessions button when onManageSessions is provided", () => {
    render(
      <ClaudeCodeStats
        liveStats={makeLiveStats()}
        isTracking={true}
        onManageSessions={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Manage Sessions/i })).toBeInTheDocument();
  });

  it("calls onManageSessions when Manage Sessions is clicked", () => {
    const onManage = vi.fn();
    render(
      <ClaudeCodeStats
        liveStats={makeLiveStats()}
        isTracking={true}
        onManageSessions={onManage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Manage Sessions/i }));
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("does not show Manage Sessions button when onManageSessions is not provided", () => {
    render(
      <ClaudeCodeStats liveStats={makeLiveStats()} isTracking={true} />,
    );
    expect(screen.queryByRole("button", { name: /Manage Sessions/i })).toBeNull();
  });
});

// TC-CC-UI-010: v1.2 NewSessionNotification rendering
describe("TC-CC-UI-010 (v1.2): NewSessionNotification rendering", () => {
  const mockSession: ClaudeCodeSessionPreview = {
    ccSessionUuid: "new-session-uuid",
    lastActivityAt: new Date().toISOString(),
    firstUserMessage: "Implement new feature",
    filePath: "/home/user/.claude/projects/MyProject/new.jsonl",
  };

  it("renders NewSessionNotification when newSession prop is set", () => {
    render(
      <ClaudeCodeStats
        liveStats={makeLiveStats()}
        isTracking={true}
        newSession={mockSession}
        onAddNewSession={vi.fn()}
        onDismissNewSession={vi.fn()}
      />,
    );
    expect(screen.getByText("New CC session detected")).toBeInTheDocument();
  });

  it("does not render notification when newSession is null", () => {
    render(
      <ClaudeCodeStats
        liveStats={makeLiveStats()}
        isTracking={true}
        newSession={null}
        onAddNewSession={vi.fn()}
        onDismissNewSession={vi.fn()}
      />,
    );
    expect(screen.queryByText("New CC session detected")).toBeNull();
  });

  it("calls onAddNewSession when Add is clicked in notification", () => {
    const onAdd = vi.fn();
    render(
      <ClaudeCodeStats
        liveStats={makeLiveStats()}
        isTracking={true}
        newSession={mockSession}
        onAddNewSession={onAdd}
        onDismissNewSession={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
