import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../../shared/types.ts";
import { SessionHistoryItem } from "../SessionHistoryItem.tsx";

const baseSession: Session = {
  id: "test-id-123",
  title: "Focus session",
  timerType: "work",
  plannedDurationSeconds: 1500,
  actualDurationSeconds: 1498,
  completedAt: "2026-02-19T10:00:00.000Z",
  tags: [],
  issueNumber: null,
  issueTitle: null,
  issueUrl: null,
  issueProvider: null,
  issueId: null,
  worklogStatus: "not_logged",
  worklogId: null,
};

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

describe("TC-323 (original): SessionHistoryItem shows delete button and calls onDelete", () => {
  it("renders delete button and calls onDelete with session id", () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionHistoryItem session={baseSession} onDelete={onDelete} />);

    const deleteBtn = within(container).getByRole("button", { name: /delete/i });
    expect(deleteBtn).toBeInTheDocument();

    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith("test-id-123");
  });

  it("displays session title", () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionHistoryItem session={baseSession} onDelete={onDelete} />);
    expect(within(container).getByText("Focus session")).toBeInTheDocument();
  });
});

describe("TC-Linear-321: SessionHistoryItem shows Linear issue badge for sessions with issueProvider 'linear'", () => {
  it("shows LIN-42 identifier and issue title, not #42", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: "Fix auth timeout",
      issueUrl: "https://linear.app/team/LIN-42",
      issueNumber: null,
    };
    const { container } = render(<SessionHistoryItem session={session} onDelete={vi.fn()} />);
    expect(within(container).getByText("LIN-42")).toBeInTheDocument();
    expect(within(container).getByText("Fix auth timeout")).toBeInTheDocument();
    // Should NOT show #42
    expect(within(container).queryByText("#42")).not.toBeInTheDocument();
  });
});

describe("TC-Linear-322: SessionHistoryItem shows GitHub issue badge for sessions with issueProvider 'github'", () => {
  it("shows #42 badge and issue title", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "github",
      issueId: "42",
      issueNumber: 42,
      issueTitle: "Fix bug",
      issueUrl: "https://github.com/owner/repo/issues/42",
    };
    const { container } = render(<SessionHistoryItem session={session} onDelete={vi.fn()} />);
    expect(within(container).getByText("#42")).toBeInTheDocument();
    expect(within(container).getByText("Fix bug")).toBeInTheDocument();
  });
});

describe("TC-Linear-323: SessionHistoryItem shows legacy GitHub issue badge (issueProvider null, issueNumber set)", () => {
  it("falls back to issueNumber when issueProvider is null", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: null,
      issueId: null,
      issueNumber: 7,
      issueTitle: "Old GitHub issue",
      issueUrl: "https://github.com/owner/repo/issues/7",
    };
    const { container } = render(<SessionHistoryItem session={session} onDelete={vi.fn()} />);
    expect(within(container).getByText("#7")).toBeInTheDocument();
    expect(within(container).getByText("Old GitHub issue")).toBeInTheDocument();
  });
});

describe("TC-Linear-324: SessionHistoryItem shows no issue badge for sessions without linked issues", () => {
  it("no badge shown when no issue is linked", () => {
    const { container } = render(<SessionHistoryItem session={baseSession} onDelete={vi.fn()} />);
    // No issue-related identifiers
    expect(within(container).queryByText(/#\d+/)).not.toBeInTheDocument();
    expect(within(container).queryByText(/LIN-/)).not.toBeInTheDocument();
    // Title still renders
    expect(within(container).getByText("Focus session")).toBeInTheDocument();
  });
});

describe("TC-Linear-325: SessionHistoryItem issue badge opens URL in browser on click", () => {
  it("clicking LIN-42 badge calls shell.openExternal with the Linear URL", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: "Fix auth timeout",
      issueUrl: "https://linear.app/team/LIN-42",
      issueNumber: null,
    };
    const { container } = render(<SessionHistoryItem session={session} onDelete={vi.fn()} />);
    const badge = within(container).getByText("LIN-42");
    fireEvent.click(badge.closest("[class]")!);
    expect(mockElectronAPI.shell.openExternal).toHaveBeenCalledWith("https://linear.app/team/LIN-42");
  });
});

// --- Worklog UI Tests ---

const jiraSession: Session = {
  id: "jira-session-1",
  title: "Fix login bug",
  timerType: "work",
  plannedDurationSeconds: 1500,
  actualDurationSeconds: 1500,
  completedAt: "2026-02-24T10:00:00.000Z",
  tags: [],
  issueNumber: null,
  issueTitle: "Fix login bug",
  issueUrl: "https://mycompany.atlassian.net/browse/PROJ-123",
  issueProvider: "jira",
  issueId: "PROJ-123",
  worklogStatus: "not_logged",
  worklogId: null,
};

describe("TC-501: Log Work button visible for Jira sessions with not_logged status", () => {
  it("shows Log Work button for Jira-linked sessions with worklogStatus not_logged", () => {
    const { container } = render(
      <SessionHistoryItem session={jiraSession} onDelete={vi.fn()} onLogWork={vi.fn()} />,
    );
    expect(within(container).getByRole("button", { name: /log work/i })).toBeInTheDocument();
  });
});

describe("TC-502: Log Work button hidden for non-Jira sessions", () => {
  it("does not show Log Work button when issueProvider is null", () => {
    const { container } = render(<SessionHistoryItem session={baseSession} onDelete={vi.fn()} onLogWork={vi.fn()} />);
    expect(within(container).queryByRole("button", { name: /log work/i })).not.toBeInTheDocument();
  });

  it("does not show Log Work button when issueProvider is linear", () => {
    const session: Session = {
      ...baseSession,
      issueProvider: "linear",
      issueId: "LIN-42",
    };
    const { container } = render(<SessionHistoryItem session={session} onDelete={vi.fn()} onLogWork={vi.fn()} />);
    expect(within(container).queryByRole("button", { name: /log work/i })).not.toBeInTheDocument();
  });
});

describe("TC-503: Log Work button hidden for sessions under 60 seconds", () => {
  it("hides Log Work button when actualDurationSeconds < 60", () => {
    const shortSession: Session = { ...jiraSession, actualDurationSeconds: 59 };
    const { container } = render(
      <SessionHistoryItem session={shortSession} onDelete={vi.fn()} onLogWork={vi.fn()} />,
    );
    expect(within(container).queryByRole("button", { name: /log work/i })).not.toBeInTheDocument();
  });
});

describe("TC-504: Logged indicator shown for worklogStatus logged", () => {
  it("shows Logged indicator instead of Log Work button", () => {
    const loggedSession: Session = { ...jiraSession, worklogStatus: "logged", worklogId: "10042" };
    const { container } = render(
      <SessionHistoryItem session={loggedSession} onDelete={vi.fn()} onLogWork={vi.fn()} />,
    );
    expect(within(container).getByText("Logged")).toBeInTheDocument();
    expect(within(container).queryByRole("button", { name: /log work/i })).not.toBeInTheDocument();
  });
});

describe("TC-505: Retry button shown for worklogStatus failed", () => {
  it("shows Retry button when worklogStatus is failed", () => {
    const failedSession: Session = { ...jiraSession, worklogStatus: "failed" };
    const { container } = render(
      <SessionHistoryItem session={failedSession} onDelete={vi.fn()} onLogWork={vi.fn()} />,
    );
    expect(within(container).getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(within(container).queryByRole("button", { name: /log work/i })).not.toBeInTheDocument();
  });
});

describe("TC-506: Loading state disables Log Work button", () => {
  it("disables button and shows loading indicator when worklogLoading is true", () => {
    const { container } = render(
      <SessionHistoryItem session={jiraSession} onDelete={vi.fn()} onLogWork={vi.fn()} worklogLoading={true} />,
    );
    const btn = within(container).getByText("...");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });
});

describe("TC-507: onLogWork callback fires with correct sessionId and issueKey", () => {
  it("calls onLogWork with sessionId and issueKey when Log Work clicked", () => {
    const onLogWork = vi.fn();
    const { container } = render(
      <SessionHistoryItem session={jiraSession} onDelete={vi.fn()} onLogWork={onLogWork} />,
    );
    const btn = within(container).getByRole("button", { name: /log work/i });
    fireEvent.click(btn);
    expect(onLogWork).toHaveBeenCalledWith("jira-session-1", "PROJ-123");
  });
});
