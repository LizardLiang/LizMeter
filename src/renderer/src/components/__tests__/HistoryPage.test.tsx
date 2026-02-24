import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Tag } from "../../../../shared/types.ts";
import { HistoryPage } from "../HistoryPage.tsx";

const mockElectronAPI = {
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
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

const defaultProps = {
  sessions: [] as Session[],
  total: 0,
  isLoading: false,
  error: null,
  allTags: [] as Tag[],
  activeTagFilter: undefined,
  onSetTagFilter: vi.fn(),
  onDeleteSession: vi.fn(),
  onLoadMore: vi.fn(),
  onAssignTag: vi.fn(),
  onUnassignTag: vi.fn(),
  onCreateTag: vi.fn(),
};

describe("HistoryPage grouping integration", () => {
  it("renders empty state when no sessions", () => {
    const { container } = render(<HistoryPage {...defaultProps} />);
    expect(within(container).getByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("renders ungrouped sessions (no linked issue) as flat cards", () => {
    const sessions = [
      makeSession("1"),
      makeSession("2"),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={2} />);
    expect(container.querySelector("[data-testid='issue-group-header']")).toBeNull();
    expect(within(container).getByText("Session 1")).toBeInTheDocument();
    expect(within(container).getByText("Session 2")).toBeInTheDocument();
  });

  it("renders issue group headers when sessions have linked issues", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", issueTitle: "Fix bug" }),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    // Issue group header shows the display ID and title
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader).not.toBeNull();
    expect(within(issueHeader).getByText("#42")).toBeInTheDocument();
    expect(within(issueHeader).getByText("Fix bug")).toBeInTheDocument();
  });

  it("renders ungrouped sessions after issue groups", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", issueTitle: "Issue A" }),
      makeSession("2"),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={2} />);
    expect(container.querySelector("[data-testid='issue-group-header']")).not.toBeNull();
    expect(within(container).getByText("Session 2")).toBeInTheDocument();
  });

  it("clicking issue group header expands to show date sub-groups", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42" }),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);

    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(issueHeader);
    expect(issueHeader.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-testid='date-subgroup-header']")).not.toBeNull();
  });

  it("clicking a date sub-group header expands it to show session cards", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", title: "Grouped work session" }),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);

    fireEvent.click(container.querySelector("[data-testid='issue-group-header']")!);
    fireEvent.click(container.querySelector("[data-testid='date-subgroup-header']")!);

    expect(within(container).getByText("Grouped work session")).toBeInTheDocument();
  });

  it("tag filter change resets expand/collapse state", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42" }),
    ];
    const { container, rerender } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={1} activeTagFilter={undefined} />,
    );

    // Expand
    fireEvent.click(container.querySelector("[data-testid='issue-group-header']")!);
    expect(container.querySelector("[data-testid='issue-group-header']")!.getAttribute("aria-expanded")).toBe("true");

    // Change filter - should reset
    rerender(<HistoryPage {...defaultProps} sessions={sessions} total={1} activeTagFilter={1} />);
    expect(container.querySelector("[data-testid='issue-group-header']")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the same grouping structure as Sidebar (issue groups then ungrouped)", () => {
    const sessions = [
      makeSession("linked", { issueProvider: "linear", issueId: "LIN-5", issueTitle: "Linear task" }),
      makeSession("ungrouped"),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={2} />);
    // Issue group header for Linear appears in the header
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader).not.toBeNull();
    expect(within(issueHeader).getByText("LIN-5")).toBeInTheDocument();
    expect(within(issueHeader).getByText("Linear task")).toBeInTheDocument();
    // Ungrouped session title appears in the flat section
    expect(within(container).getByText("Session ungrouped")).toBeInTheDocument();
  });

  it("IssueBadge renders correctly for legacy github provider within session card when expanded", () => {
    // Legacy GitHub sessions are grouped (hasLinkedIssue returns true for issueNumber set)
    // So to test IssueBadge inside a SessionCard we must expand the group
    const sessions = [
      makeSession("2", {
        issueProvider: null,
        issueNumber: 5,
        issueTitle: "Legacy issue",
        issueUrl: "https://github.com/owner/repo/issues/5",
      }),
    ];
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={1} />,
    );
    // Issue group header shows #5 (legacy github) - appears in group header
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader).not.toBeNull();
    expect(within(issueHeader).getByText("#5")).toBeInTheDocument();
    // Expand the group and date sub-group to see the SessionCard with IssueBadge
    fireEvent.click(issueHeader);
    const dateHeader = container.querySelector("[data-testid='date-subgroup-header']")!;
    fireEvent.click(dateHeader);
    // IssueBadge inside the SessionCard should also show #5 (now two occurrences: header + badge)
    const allFive = within(container).getAllByText("#5");
    expect(allFive.length).toBeGreaterThanOrEqual(2);
    // "Legacy issue" text appears multiple times: in header title + badge title
    const legacyTexts = within(container).getAllByText("Legacy issue");
    expect(legacyTexts.length).toBeGreaterThanOrEqual(2);
  });
});
