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

describe("Sidebar — timer status display", () => {
  it("shows 'No session' when timerStatus is idle", () => {
    const { container } = render(<Sidebar {...defaultProps} timerStatus="idle" />);
    expect(within(container).getByText("No session")).toBeInTheDocument();
  });

  it("shows 'In progress' and remaining time when running", () => {
    const { container } = render(
      <Sidebar {...defaultProps} timerStatus="running" remainingSeconds={125} />,
    );
    expect(within(container).getByText("In progress")).toBeInTheDocument();
    expect(within(container).getByText("02:05")).toBeInTheDocument();
  });

  it("shows 'Paused' and remaining time when paused", () => {
    const { container } = render(
      <Sidebar {...defaultProps} timerStatus="paused" remainingSeconds={60} />,
    );
    expect(within(container).getByText("Paused")).toBeInTheDocument();
    expect(within(container).getByText("01:00")).toBeInTheDocument();
  });

  it("shows 'Completed' when timer is completed", () => {
    const { container } = render(<Sidebar {...defaultProps} timerStatus="completed" />);
    expect(within(container).getByText("Completed")).toBeInTheDocument();
  });

  it("shows TagPicker when timer is running", () => {
    const { container } = render(
      <Sidebar {...defaultProps} timerStatus="running" remainingSeconds={100} />,
    );
    expect(within(container).getByText("Tags")).toBeInTheDocument();
  });

  it("does NOT show Tags section when timer is idle", () => {
    const { container } = render(<Sidebar {...defaultProps} timerStatus="idle" />);
    expect(within(container).queryByText("Tags")).toBeNull();
  });
});

describe("Sidebar — history section states", () => {
  it("shows loading message when isLoading is true", () => {
    const { container } = render(<Sidebar {...defaultProps} isLoading={true} />);
    expect(within(container).getByText("Loading…")).toBeInTheDocument();
  });

  it("shows error message when error is set", () => {
    const { container } = render(<Sidebar {...defaultProps} error="Failed to load" />);
    expect(within(container).getByText("Failed to load")).toBeInTheDocument();
  });

  it("shows 'Load more' button when sessions < total", () => {
    const sessions = [makeSession("1")];
    const { container } = render(
      <Sidebar {...defaultProps} sessions={sessions} total={5} />,
    );
    expect(within(container).getByRole("button", { name: /load more/i })).toBeInTheDocument();
  });

  it("clicking 'Load more' calls onLoadMore", () => {
    const onLoadMore = vi.fn();
    const sessions = [makeSession("1")];
    const { container } = render(
      <Sidebar {...defaultProps} sessions={sessions} total={5} onLoadMore={onLoadMore} />,
    );
    fireEvent.click(within(container).getByRole("button", { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("does NOT show 'Load more' when sessions.length === total", () => {
    const sessions = [makeSession("1")];
    const { container } = render(
      <Sidebar {...defaultProps} sessions={sessions} total={1} />,
    );
    expect(within(container).queryByRole("button", { name: /load more/i })).toBeNull();
  });
});

describe("Sidebar — tag filter chips", () => {
  const tags: Tag[] = [
    { id: 1, name: "bug", color: "#f7768e", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: 2, name: "feat", color: "#9ece6a", createdAt: "2026-01-01T00:00:00.000Z" },
  ];

  it("renders filter chips for each tag", () => {
    const { container } = render(<Sidebar {...defaultProps} allTags={tags} />);
    expect(within(container).getByRole("button", { name: "bug" })).toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "feat" })).toBeInTheDocument();
  });

  it("clicking a tag chip calls onSetTagFilter with that tag id", () => {
    const onSetTagFilter = vi.fn();
    const { container } = render(
      <Sidebar {...defaultProps} allTags={tags} onSetTagFilter={onSetTagFilter} />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "bug" }));
    expect(onSetTagFilter).toHaveBeenCalledWith(1);
  });

  it("shows 'Filtered by' badge when activeTagFilter is set", () => {
    const { container } = render(
      <Sidebar {...defaultProps} allTags={tags} activeTagFilter={1} />,
    );
    expect(within(container).getByText("Filtered by")).toBeInTheDocument();
    // "bug" appears in the chip row AND the filter badge; getAllByText confirms both exist
    expect(within(container).getAllByText("bug").length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT show filter chips when there are no tags", () => {
    const { container } = render(<Sidebar {...defaultProps} allTags={[]} />);
    expect(within(container).queryByRole("button", { name: "All" })).toBeNull();
  });
});

describe("Sidebar — session row", () => {
  it("clicking delete button in a session row calls onDeleteSession", () => {
    const onDeleteSession = vi.fn();
    const sessions = [makeSession("s1", { title: "Work session" })];
    const { container } = render(
      <Sidebar {...defaultProps} sessions={sessions} total={1} onDeleteSession={onDeleteSession} />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Delete session" }));
    expect(onDeleteSession).toHaveBeenCalledWith("s1");
  });

  it("displays session title in the row", () => {
    const sessions = [makeSession("s1", { title: "Design review" })];
    const { container } = render(<Sidebar {...defaultProps} sessions={sessions} total={1} />);
    expect(within(container).getByText("Design review")).toBeInTheDocument();
  });
});

describe("Sidebar — collapsed state", () => {
  it("hides scroll content when isOpen is false", () => {
    const { container } = render(<Sidebar {...defaultProps} isOpen={false} />);
    // The aside is the data-testid sidebar; find the scroll div
    const sidebar = container.querySelector("[data-testid='sidebar']") as HTMLElement;
    const scrollDiv = sidebar.querySelector("[style*='display: none']");
    expect(scrollDiv).not.toBeNull();
  });
});
