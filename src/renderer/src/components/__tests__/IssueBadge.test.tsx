import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../../shared/types.ts";
import { IssueBadge } from "../IssueBadge.tsx";

const baseSession: Session = {
  id: "test-id",
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
};

function makeTodoFixture(id: number, title: string, stateColor = "#9ece6a", isCompleted = false) {
  return {
    id,
    title,
    notes: null,
    state: { id: 1, label: "Done", color: stateColor, position: 0, isCompleted, isDefault: false, createdAt: "" },
    project: null,
    labels: [],
    milestone: null,
    priority: 0,
    startDate: null,
    dueDate: null,
    source: "user" as const,
    sourceLabel: null,
    parentId: null,
    parentTitle: null,
    childCount: 0,
    completedChildCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
}

const mockElectronAPI = {
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  todo: {
    list: vi.fn().mockResolvedValue([]),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IssueBadge", () => {
  it("renders null for sessions without linked issues", () => {
    const { container } = render(<IssueBadge session={baseSession} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders GitHub issue badge with #id format", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "github",
      issueId: "42",
      issueTitle: "Fix bug",
      issueUrl: "https://github.com/owner/repo/issues/42",
    };
    const { container } = render(<IssueBadge session={session} />);
    expect(within(container).getByText("#42")).toBeInTheDocument();
    expect(within(container).getByText("Fix bug")).toBeInTheDocument();
  });

  it("renders Linear issue badge with identifier format", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: "Refactor auth",
      issueUrl: "https://linear.app/team/LIN-42",
    };
    const { container } = render(<IssueBadge session={session} />);
    expect(within(container).getByText("LIN-42")).toBeInTheDocument();
    expect(within(container).getByText("Refactor auth")).toBeInTheDocument();
    expect(within(container).queryByText("#42")).not.toBeInTheDocument();
  });

  it("renders Jira issue badge with key format", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "jira",
      issueId: "PROJ-123",
      issueTitle: "Jira task",
      issueUrl: "https://example.atlassian.net/browse/PROJ-123",
    };
    const { container } = render(<IssueBadge session={session} />);
    expect(within(container).getByText("PROJ-123")).toBeInTheDocument();
    expect(within(container).getByText("Jira task")).toBeInTheDocument();
  });

  it("renders legacy GitHub issue badge with #number format", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: null,
      issueNumber: 7,
      issueTitle: "Old issue",
      issueUrl: "https://github.com/owner/repo/issues/7",
    };
    const { container } = render(<IssueBadge session={session} />);
    expect(within(container).getByText("#7")).toBeInTheDocument();
    expect(within(container).getByText("Old issue")).toBeInTheDocument();
  });

  it("clicking badge with URL opens external URL", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "github",
      issueId: "42",
      issueTitle: "Fix bug",
      issueUrl: "https://github.com/owner/repo/issues/42",
    };
    const { container } = render(<IssueBadge session={session} />);
    const badge = container.firstChild as HTMLElement;
    fireEvent.click(badge);
    expect(mockElectronAPI.shell.openExternal).toHaveBeenCalledWith("https://github.com/owner/repo/issues/42");
  });

  it("does not render title if issueTitle is null", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: null,
      issueUrl: "https://linear.app/team/LIN-42",
    };
    const { container } = render(<IssueBadge session={session} />);
    expect(within(container).getByText("LIN-42")).toBeInTheDocument();
    // No extra text nodes
    expect(container.textContent).toBe("LIN-42");
  });

  it("renders Todo issue badge with #id format", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "todo",
      issueId: "42",
      issueTitle: "Buy milk (snapshot)",
      issueUrl: null,
    };
    mockElectronAPI.todo.list.mockResolvedValueOnce([]);
    const { container } = render(<IssueBadge session={session} />);
    expect(within(container).getByText("#42")).toBeInTheDocument();
  });

  it("shows the stored snapshot as a placeholder while the live todo lookup is in flight", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "todo",
      issueId: "42",
      issueTitle: "Buy milk (snapshot)",
      issueUrl: null,
    };
    mockElectronAPI.todo.list.mockReturnValue(new Promise(() => {})); // never resolves during this test
    const { container } = render(<IssueBadge session={session} />);
    // Rendered synchronously, before the lookup has a chance to resolve -- this must come from the
    // "loading" branch, not be confused with the "missing" (lookup failed) branch.
    expect(within(container).getByText("Buy milk (snapshot)")).toBeInTheDocument();
  });

  it("renders the todo's live current title instead of the stored snapshot when the lookup succeeds", async () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "todo",
      issueId: "42",
      issueTitle: "Buy milk (stale snapshot)",
      issueUrl: null,
    };
    mockElectronAPI.todo.list.mockResolvedValueOnce([makeTodoFixture(42, "Buy oat milk (current)")]);

    const { container } = render(<IssueBadge session={session} />);

    await waitFor(() => {
      expect(within(container).getByText("Buy oat milk (current)")).toBeInTheDocument();
    });
    expect(within(container).queryByText("Buy milk (stale snapshot)")).not.toBeInTheDocument();
  });

  it("falls back to the stored snapshot title when the live todo lookup finds nothing", async () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "todo",
      issueId: "999",
      issueTitle: "Deleted todo snapshot",
      issueUrl: null,
    };
    mockElectronAPI.todo.list.mockResolvedValueOnce([makeTodoFixture(1, "Some other todo")]);

    const { container } = render(<IssueBadge session={session} />);

    await waitFor(() => {
      expect(within(container).getByText("Deleted todo snapshot")).toBeInTheDocument();
    });
  });

  it("clicking a todo badge calls onNavigateToTodo with the numeric todo id instead of opening a URL", async () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "todo",
      issueId: "42",
      issueTitle: "Buy milk",
      issueUrl: null,
    };
    mockElectronAPI.todo.list.mockResolvedValueOnce([]);
    const onNavigateToTodo = vi.fn();

    const { container } = render(<IssueBadge session={session} onNavigateToTodo={onNavigateToTodo} />);
    await waitFor(() => expect(within(container).getByText("#42")).toBeInTheDocument());

    const badge = container.firstChild as HTMLElement;
    fireEvent.click(badge);

    expect(onNavigateToTodo).toHaveBeenCalledWith(42);
    expect(mockElectronAPI.shell.openExternal).not.toHaveBeenCalled();
  });
});
