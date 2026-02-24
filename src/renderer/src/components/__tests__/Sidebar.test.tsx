import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Tag } from "../../../../shared/types.ts";
import { Sidebar } from "../Sidebar.tsx";

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
  isOpen: true,
  onToggle: vi.fn(),
  timerStatus: "idle" as const,
  remainingSeconds: 0,
  allTags: [] as Tag[],
  pendingTagIds: [],
  onPendingTagAdd: vi.fn(),
  onPendingTagRemove: vi.fn(),
  onCreateTag: vi.fn(),
  onUpdateTag: vi.fn(),
  onDeleteTag: vi.fn(),
  sessions: [] as Session[],
  total: 0,
  isLoading: false,
  error: null,
  activeTagFilter: undefined,
  onSetTagFilter: vi.fn(),
  onDeleteSession: vi.fn(),
  onLoadMore: vi.fn(),
  onAssignTag: vi.fn(),
  onUnassignTag: vi.fn(),
};

describe("Sidebar grouping integration", () => {
  it("renders empty state when no sessions", () => {
    const { container } = render(<Sidebar {...defaultProps} />);
    expect(within(container).getByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("renders ungrouped sessions (no linked issue) as flat rows", () => {
    const sessions = [
      makeSession("1"),
      makeSession("2"),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={2} />);
    // No issue group headers
    expect(container.querySelector("[data-testid='issue-group-header']")).toBeNull();
    // Session titles visible
    expect(within(container).getByText("Session 1")).toBeInTheDocument();
    expect(within(container).getByText("Session 2")).toBeInTheDocument();
  });

  it("renders issue group headers when sessions have linked issues", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", issueTitle: "Fix bug" }),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={1} />);
    expect(within(container).getByText("#42")).toBeInTheDocument();
    expect(within(container).getByText("Fix bug")).toBeInTheDocument();
  });

  it("renders ungrouped sessions after issue groups", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", issueTitle: "Issue A" }),
      makeSession("2"),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={2} />);
    // Issue group header present
    expect(container.querySelector("[data-testid='issue-group-header']")).not.toBeNull();
    // Ungrouped session title present
    expect(within(container).getByText("Session 2")).toBeInTheDocument();
  });

  it("clicking issue group header expands to show date sub-groups", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", issueTitle: "Fix bug" }),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={1} />);

    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(issueHeader);
    expect(issueHeader.getAttribute("aria-expanded")).toBe("true");

    // Date sub-group header should appear
    expect(container.querySelector("[data-testid='date-subgroup-header']")).not.toBeNull();
  });

  it("clicking a date sub-group header expands it to show session rows", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", issueTitle: "Fix bug", title: "My session" }),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={1} />);

    // Expand issue group first
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    fireEvent.click(issueHeader);

    // Expand date sub-group
    const dateHeader = container.querySelector("[data-testid='date-subgroup-header']")!;
    expect(dateHeader.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(dateHeader);
    expect(dateHeader.getAttribute("aria-expanded")).toBe("true");

    // Session title should be visible
    expect(within(container).getByText("My session")).toBeInTheDocument();
  });

  it("clicking expanded issue group header collapses it", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42" }),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={1} />);

    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;

    // Expand
    fireEvent.click(issueHeader);
    expect(issueHeader.getAttribute("aria-expanded")).toBe("true");

    // Collapse
    fireEvent.click(issueHeader);
    expect(issueHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("tag filter change resets expand/collapse state (all groups collapsed)", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42" }),
    ];
    const { container, rerender } = render(
      <Sidebar {...defaultProps} sessions={sessions} total={1} activeTagFilter={undefined} />,
    );

    // Expand issue group
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    fireEvent.click(issueHeader);
    expect(issueHeader.getAttribute("aria-expanded")).toBe("true");

    // Change filter
    rerender(<Sidebar {...defaultProps} sessions={sessions} total={1} activeTagFilter={1} />);

    // Groups should be collapsed again
    const issueHeaderAfter = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeaderAfter.getAttribute("aria-expanded")).toBe("false");
  });

  it("DateSubGroupHeader displays session count", () => {
    const sessions = [
      makeSession("1", { issueProvider: "github", issueId: "42", completedAt: "2026-02-24T09:00:00.000Z" }),
      makeSession("2", { issueProvider: "github", issueId: "42", completedAt: "2026-02-24T10:00:00.000Z" }),
    ];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={2} />);

    // Expand issue group to reveal date sub-group header
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    fireEvent.click(issueHeader);

    const dateHeader = container.querySelector("[data-testid='date-subgroup-header']")!;
    expect(dateHeader.textContent).toContain("2 sessions");
  });
});
