import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Tag } from "../../../../shared/types.ts";
import { HistoryPage } from "../HistoryPage.tsx";

const mockWorklogLog = vi.fn();
const mockWorklogMarkLogged = vi.fn();

const mockElectronAPI = {
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  worklog: {
    log: mockWorklogLog,
    markLogged: mockWorklogMarkLogged,
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
  mockWorklogLog.mockResolvedValue({ worklogId: "wl-123" });
  mockWorklogMarkLogged.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
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
    worklogStatus: "not_logged",
    worklogId: null,
    ...overrides,
  };
}

function makeTag(id: number, name: string): Tag {
  return { id, name, color: "#7aa2f7", createdAt: "2026-01-01T00:00:00.000Z" };
}

function makeJiraSession(id: string, worklogStatus: Session["worklogStatus"] = "not_logged"): Session {
  return makeSession(id, {
    issueProvider: "jira",
    issueId: "PROJ-123",
    issueTitle: "Test Issue",
    timerType: "work",
    actualDurationSeconds: 1500,
    worklogStatus,
  });
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
  onAssignTag: vi.fn().mockResolvedValue(undefined),
  onUnassignTag: vi.fn().mockResolvedValue(undefined),
  onCreateTag: vi.fn(),
};

function expandIssueGroup(container: HTMLElement): void {
  fireEvent.click(container.querySelector("[data-testid='issue-group-header']")!);
}

function expandDateSubGroup(container: HTMLElement): void {
  fireEvent.click(container.querySelector("[data-testid='date-subgroup-header']")!);
}

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

    fireEvent.click(container.querySelector("[data-testid='issue-group-header']")!);
    expect(container.querySelector("[data-testid='issue-group-header']")!.getAttribute("aria-expanded")).toBe("true");

    rerender(<HistoryPage {...defaultProps} sessions={sessions} total={1} activeTagFilter={1} />);
    expect(container.querySelector("[data-testid='issue-group-header']")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the same grouping structure as Sidebar (issue groups then ungrouped)", () => {
    const sessions = [
      makeSession("linked", { issueProvider: "linear", issueId: "LIN-5", issueTitle: "Linear task" }),
      makeSession("ungrouped"),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={2} />);
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader).not.toBeNull();
    expect(within(issueHeader).getByText("LIN-5")).toBeInTheDocument();
    expect(within(issueHeader).getByText("Linear task")).toBeInTheDocument();
    expect(within(container).getByText("Session ungrouped")).toBeInTheDocument();
  });

  it("IssueBadge renders correctly for legacy github provider within session card when expanded", () => {
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
    const issueHeader = container.querySelector("[data-testid='issue-group-header']")!;
    expect(issueHeader).not.toBeNull();
    expect(within(issueHeader).getByText("#5")).toBeInTheDocument();
    fireEvent.click(issueHeader);
    const dateHeader = container.querySelector("[data-testid='date-subgroup-header']")!;
    fireEvent.click(dateHeader);
    const allFive = within(container).getAllByText("#5");
    expect(allFive.length).toBeGreaterThanOrEqual(2);
    const legacyTexts = within(container).getAllByText("Legacy issue");
    expect(legacyTexts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("HistoryPage - loading and error states", () => {
  it("shows loading message when isLoading is true", () => {
    const { container } = render(<HistoryPage {...defaultProps} isLoading />);
    expect(within(container).getByText("Loading…")).toBeInTheDocument();
  });

  it("shows error message when error is provided", () => {
    const { container } = render(<HistoryPage {...defaultProps} error="Something went wrong" />);
    expect(within(container).getByText("Something went wrong")).toBeInTheDocument();
  });
});

describe("HistoryPage - tag filter", () => {
  it("shows All chip and tag chips when allTags is non-empty", () => {
    const tags = [makeTag(1, "Backend"), makeTag(2, "Personal")];
    const { container } = render(<HistoryPage {...defaultProps} allTags={tags} />);
    // Use role-based queries to target filter chip buttons specifically
    expect(within(container).getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "Backend" })).toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "Personal" })).toBeInTheDocument();
  });

  it("does not render filter row when allTags is empty", () => {
    const { container } = render(<HistoryPage {...defaultProps} allTags={[]} />);
    expect(within(container).queryByRole("button", { name: "All" })).toBeNull();
  });

  it("clicking All chip calls onSetTagFilter(undefined)", () => {
    const onSetTagFilter = vi.fn();
    const { container } = render(
      <HistoryPage {...defaultProps} allTags={[makeTag(1, "Backend")]} onSetTagFilter={onSetTagFilter} />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "All" }));
    expect(onSetTagFilter).toHaveBeenCalledWith(undefined);
  });

  it("clicking an inactive tag chip calls onSetTagFilter with the tag id", () => {
    const onSetTagFilter = vi.fn();
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        allTags={[makeTag(1, "Backend")]}
        activeTagFilter={undefined}
        onSetTagFilter={onSetTagFilter}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Backend" }));
    expect(onSetTagFilter).toHaveBeenCalledWith(1);
  });

  it("clicking an active tag chip calls onSetTagFilter(undefined) to deactivate", () => {
    const onSetTagFilter = vi.fn();
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        allTags={[makeTag(1, "Backend")]}
        activeTagFilter={1}
        onSetTagFilter={onSetTagFilter}
      />,
    );
    // The filter chip button (not the TagBadge remove button)
    fireEvent.click(within(container).getByRole("button", { name: "Backend" }));
    expect(onSetTagFilter).toHaveBeenCalledWith(undefined);
  });

  it("shows Filtered by label when activeTagFilter is set", () => {
    const tags = [makeTag(1, "Backend")];
    const { container } = render(<HistoryPage {...defaultProps} allTags={tags} activeTagFilter={1} />);
    expect(within(container).getByText("Filtered by")).toBeInTheDocument();
  });

  it("clicking the TagBadge remove button in filterBy calls onSetTagFilter(undefined)", () => {
    const onSetTagFilter = vi.fn();
    const tags = [makeTag(1, "Backend")];
    const { container } = render(
      <HistoryPage {...defaultProps} allTags={tags} activeTagFilter={1} onSetTagFilter={onSetTagFilter} />,
    );
    fireEvent.click(within(container).getByLabelText("Remove tag Backend"));
    expect(onSetTagFilter).toHaveBeenCalledWith(undefined);
  });
});

describe("HistoryPage - load more", () => {
  it("shows load more button when sessions.length < total", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={5} />);
    expect(within(container).getByText("Load more (4 remaining)")).toBeInTheDocument();
  });

  it("does not show load more button when all sessions are loaded", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    expect(within(container).queryByText(/load more/i)).toBeNull();
  });

  it("clicking load more calls onLoadMore", () => {
    const onLoadMore = vi.fn();
    const sessions = [makeSession("1")];
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={5} onLoadMore={onLoadMore} />,
    );
    fireEvent.click(within(container).getByText("Load more (4 remaining)"));
    expect(onLoadMore).toHaveBeenCalled();
  });
});

describe("HistoryPage - day groups (ungrouped sessions)", () => {
  it("groups ungrouped sessions by calendar day with a collapsible header", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    expect(container.querySelector("[role='button'][aria-expanded]")).not.toBeNull();
  });

  it("most recent day group is expanded by default (auto-seeded)", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    const dayHeader = container.querySelector("[role='button'][aria-expanded]")!;
    expect(dayHeader.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking an expanded day group header collapses it", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    const dayHeader = container.querySelector("[role='button'][aria-expanded]")!;
    fireEvent.click(dayHeader); // starts expanded → collapse
    expect(dayHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking a collapsed day group header re-expands it", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    const dayHeader = container.querySelector("[role='button'][aria-expanded]")!;
    fireEvent.click(dayHeader); // collapse
    fireEvent.click(dayHeader); // re-expand
    expect(dayHeader.getAttribute("aria-expanded")).toBe("true");
  });

  it("pressing Enter key toggles the day group (collapses when expanded)", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    const dayHeader = container.querySelector("[role='button'][aria-expanded]")!;
    fireEvent.keyDown(dayHeader, { key: "Enter" }); // starts expanded → collapse
    expect(dayHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("pressing Space key toggles the day group (collapses when expanded)", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    const dayHeader = container.querySelector("[role='button'][aria-expanded]")!;
    fireEvent.keyDown(dayHeader, { key: " " }); // starts expanded → collapse
    expect(dayHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows session count in day group header (plural)", () => {
    const sessions = [makeSession("1"), makeSession("2")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={2} />);
    expect(within(container).getByText("2 sessions")).toBeInTheDocument();
  });

  it("shows singular '1 session' in day group header", () => {
    const sessions = [makeSession("1")];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    expect(within(container).getByText("1 session")).toBeInTheDocument();
  });
});

describe("SessionCard - delete button", () => {
  it("clicking delete button calls onDeleteSession with the session id", () => {
    const onDeleteSession = vi.fn();
    const sessions = [makeSession("abc")];
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={1} onDeleteSession={onDeleteSession} />,
    );
    // Day group is expanded by default (auto-seeded), session card is visible
    fireEvent.click(within(container).getByLabelText("Delete session"));
    expect(onDeleteSession).toHaveBeenCalledWith("abc");
  });
});

describe("SessionCard - resume button", () => {
  it("shows resume button when onResumeSession is provided", () => {
    const sessions = [makeSession("1")];
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={1} onResumeSession={vi.fn()} />,
    );
    expect(within(container).getByLabelText("Resume session: Session 1")).toBeInTheDocument();
  });

  it("clicking resume button calls onResumeSession with the session", () => {
    const onResumeSession = vi.fn();
    const sessions = [makeSession("1")];
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        sessions={sessions}
        total={1}
        onResumeSession={onResumeSession}
        timerStatus="idle"
      />,
    );
    fireEvent.click(within(container).getByLabelText("Resume session: Session 1"));
    expect(onResumeSession).toHaveBeenCalledWith(sessions[0]);
  });

  it("resume button is disabled when timer is running", () => {
    const sessions = [makeSession("1")];
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        sessions={sessions}
        total={1}
        onResumeSession={vi.fn()}
        timerStatus="running"
      />,
    );
    const resumeBtn = within(container).getByLabelText("Resume session: Session 1") as HTMLButtonElement;
    expect(resumeBtn.disabled).toBe(true);
  });

  it("resume button is disabled when timer is paused", () => {
    const sessions = [makeSession("1")];
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        sessions={sessions}
        total={1}
        onResumeSession={vi.fn()}
        timerStatus="paused"
      />,
    );
    const resumeBtn = within(container).getByLabelText("Resume session: Session 1") as HTMLButtonElement;
    expect(resumeBtn.disabled).toBe(true);
  });

  it("resume button is enabled when timer is idle", () => {
    const sessions = [makeSession("1")];
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        sessions={sessions}
        total={1}
        onResumeSession={vi.fn()}
        timerStatus="idle"
      />,
    );
    const resumeBtn = within(container).getByLabelText("Resume session: Session 1") as HTMLButtonElement;
    expect(resumeBtn.disabled).toBe(false);
  });
});

describe("SessionCard - title rendering", () => {
  it("renders plain text title", () => {
    const sessions = [makeSession("1", { title: "My focus session" })];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    // Day group is auto-expanded; session card is immediately visible
    expect(within(container).getByText("My focus session")).toBeInTheDocument();
  });

  it("renders rich HTML title using dangerouslySetInnerHTML", () => {
    const sessions = [makeSession("1", { title: "<strong>Bold</strong> title" })];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    expect(container.querySelector("strong")).toBeInTheDocument();
    expect(container.querySelector("strong")!.textContent).toBe("Bold");
  });

  it("does not render a title element when title is empty string", () => {
    const sessions = [makeSession("1", { title: "" })];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    expect(container.querySelector("[class*='cardTitle']")).toBeNull();
  });
});

describe("SessionCard - date/time display", () => {
  it("shows time only (no date separator) in day groups (hideDate=true)", () => {
    const sessions = [makeSession("1", { completedAt: "2026-02-24T10:30:00.000Z" })];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    // Day group auto-expands; meta element is directly accessible
    const meta = container.querySelector("[class*='cardMeta']")!;
    // hideDate=true means only time, no "Date · Time" format
    expect(meta.textContent).not.toMatch(/·/);
  });

  it("shows full date + time separator in issue groups (hideDate=false)", () => {
    const sessions = [
      makeSession("1", {
        issueProvider: "github",
        issueId: "42",
        completedAt: "2026-02-24T10:00:00.000Z",
      }),
    ];
    const { container } = render(<HistoryPage {...defaultProps} sessions={sessions} total={1} />);
    expandIssueGroup(container);
    expandDateSubGroup(container);
    const meta = container.querySelector("[class*='cardMeta']")!;
    expect(meta.textContent).toMatch(/·/);
  });
});

describe("SessionCard - worklog UI", () => {
  function setupJiraSession(worklogStatus: Session["worklogStatus"]) {
    const session = makeJiraSession("s1", worklogStatus);
    const onLogWork = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} onLogWork={onLogWork} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    return { container, session, onLogWork };
  }

  it("shows Log Work button for a not_logged jira work session", () => {
    const { container } = setupJiraSession("not_logged");
    expect(within(container).getByLabelText("Log work to Jira for: Session s1")).toBeInTheDocument();
  });

  it("shows Logged badge and Re-log button for a logged jira work session", () => {
    const { container } = setupJiraSession("logged");
    expect(within(container).getByLabelText("Work logged to Jira")).toBeInTheDocument();
    expect(within(container).getByLabelText("Re-log to Jira for: Session s1")).toBeInTheDocument();
  });

  it("shows Retry button for a failed jira work session", () => {
    const { container } = setupJiraSession("failed");
    expect(within(container).getByLabelText("Retry logging work to Jira for: Session s1")).toBeInTheDocument();
  });

  it("shows '...' and disables button when worklogLoading is true", () => {
    const session = makeJiraSession("s1", "not_logged");
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        sessions={[session]}
        total={1}
        onLogWork={vi.fn()}
        worklogLoading={{ s1: true }}
      />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    const logBtn = within(container).getByLabelText("Log work to Jira for: Session s1") as HTMLButtonElement;
    expect(logBtn.textContent).toBe("...");
    expect(logBtn.disabled).toBe(true);
  });

  it("worklog button renders but clicking it opens no dialog when onLogWork prop is not provided", () => {
    const session = makeJiraSession("s1", "not_logged");
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    const logBtn = within(container).getByLabelText("Log work to Jira for: Session s1");
    expect(logBtn).toBeInTheDocument();
    fireEvent.click(logBtn);
    // No dialog should open since HistoryPage has no onLogWork handler
    expect(within(container).queryByRole("heading", { name: /Log Work to PROJ-123/ })).toBeNull();
  });

  it("does not show worklog UI for non-jira sessions", () => {
    const session = makeSession("1", {
      issueProvider: "github",
      issueId: "42",
      timerType: "work",
      actualDurationSeconds: 1500,
    });
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} onLogWork={vi.fn()} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    expect(within(container).queryByLabelText(/log work to jira/i)).toBeNull();
  });

  it("does not show worklog UI for sessions shorter than 60 seconds", () => {
    const session = makeJiraSession("s1", "not_logged");
    session.actualDurationSeconds = 30;
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} onLogWork={vi.fn()} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    expect(within(container).queryByLabelText("Log work to Jira for: Session s1")).toBeNull();
  });
});

describe("HistoryPage - worklog dialog open/close", () => {
  function openWorklogDialog(worklogStatus: Session["worklogStatus"] = "not_logged") {
    const session = makeJiraSession("s1", worklogStatus);
    const onLogWork = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} onLogWork={onLogWork} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    const ariaLabel = worklogStatus === "logged"
      ? "Re-log to Jira for: Session s1"
      : worklogStatus === "failed"
      ? "Retry logging work to Jira for: Session s1"
      : "Log work to Jira for: Session s1";
    fireEvent.click(within(container).getByLabelText(ariaLabel));
    return { container, session, onLogWork };
  }

  it("opens the worklog dialog when Log Work button is clicked", () => {
    const { container } = openWorklogDialog("not_logged");
    expect(within(container).getByRole("heading", { name: /Log Work to PROJ-123/ })).toBeInTheDocument();
  });

  it("opens re-log dialog for a logged session", () => {
    const { container } = openWorklogDialog("logged");
    expect(within(container).getByRole("heading", { name: /Re-log Work to PROJ-123/ })).toBeInTheDocument();
  });

  it("closes the dialog when Cancel is clicked", () => {
    const { container } = openWorklogDialog("not_logged");
    fireEvent.click(within(container).getByRole("button", { name: "Cancel" }));
    expect(within(container).queryByRole("heading", { name: /Log Work to PROJ-123/ })).toBeNull();
  });

  it("closes the dialog when the overlay is clicked", () => {
    const { container } = openWorklogDialog("not_logged");
    const overlay = container.querySelector("[class*='overlay']")!;
    fireEvent.click(overlay);
    expect(within(container).queryByRole("heading", { name: /Log Work to PROJ-123/ })).toBeNull();
  });
});

describe("HistoryPage - worklog confirm (single session)", () => {
  function setupAndOpenDialog(onLogWork: ReturnType<typeof vi.fn>) {
    const session = makeJiraSession("s1", "not_logged");
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} onLogWork={onLogWork} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    fireEvent.click(within(container).getByLabelText("Log work to Jira for: Session s1"));
    // Dialog confirm button has text "Log Work" with no aria-label
    const confirmBtn = within(container).getByRole("button", { name: "Log Work" });
    fireEvent.click(confirmBtn);
    return { container, session };
  }

  it("calls onLogWork after confirming the dialog", async () => {
    const onLogWork = vi.fn().mockResolvedValue(undefined);
    setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(onLogWork).toHaveBeenCalled();
    });
  });

  it("shows a success toast with duration and issue key after confirming", async () => {
    const onLogWork = vi.fn().mockResolvedValue(undefined);
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert")).toBeInTheDocument();
    });
    expect(within(container).getByRole("alert").textContent).toMatch(/Logged 25m to PROJ-123/);
  });

  it("closes the dialog after confirming", async () => {
    const onLogWork = vi.fn().mockResolvedValue(undefined);
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).queryByRole("heading", { name: /Log Work to PROJ-123/ })).toBeNull();
    });
  });

  it("shows generic error toast on unexpected failure", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("unexpected failure"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe("Failed to log work to Jira.");
    });
  });

  it("shows authentication error for auth failures", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("authentication failed"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe(
        "Jira authentication failed. Check your credentials.",
      );
    });
  });

  it("shows authentication error for credentials failures", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("invalid credentials provided"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe(
        "Jira authentication failed. Check your credentials.",
      );
    });
  });

  it("shows issue not found message for not found errors", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("issue not found in project"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe("Issue PROJ-123 not found in Jira.");
    });
  });

  it("shows rate limit message for rate limited errors", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("rate limit exceeded"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe("Jira rate limit reached. Try again later.");
    });
  });

  it("shows network error message when Jira is unreachable", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("cannot reach Jira server"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe("Could not reach Jira. Check your connection.");
    });
  });

  it("shows already logged message for INELIGIBLE errors", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("already logged for this session"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe("Worklog already logged for this session.");
    });
  });

  it("shows minimum duration message for 60 seconds errors", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("must be at least 60 seconds"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe(
        "Session too short (minimum 60 seconds for Jira).",
      );
    });
  });

  it("shows minimum duration message for 'minimum' keyword errors", async () => {
    const onLogWork = vi.fn().mockRejectedValue(new Error("below minimum threshold"));
    const { container } = setupAndOpenDialog(onLogWork);
    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe(
        "Session too short (minimum 60 seconds for Jira).",
      );
    });
  });
});

describe("HistoryPage - handleLogDate and bulk worklog", () => {
  function setupBulkJiraSessions() {
    const session1 = makeJiraSession("s1", "not_logged");
    const session2 = makeJiraSession("s2", "not_logged");
    session2.completedAt = "2026-02-24T11:00:00.000Z"; // Same date, different time
    return [session1, session2];
  }

  it("date sub-group Log button opens worklog dialog", () => {
    const sessions = setupBulkJiraSessions();
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={2} onLogWork={vi.fn()} />,
    );
    expandIssueGroup(container);
    fireEvent.click(container.querySelector("[data-testid='log-date-btn']")!);
    expect(within(container).getByRole("heading", { name: /Log Work to PROJ-123/ })).toBeInTheDocument();
  });

  it("date sub-group Log button is not shown when onLogWork is not provided", () => {
    const sessions = setupBulkJiraSessions();
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={2} />,
    );
    expandIssueGroup(container);
    expect(container.querySelector("[data-testid='log-date-btn']")).toBeNull();
  });

  it("confirms bulk worklog via electronAPI.worklog.log and shows combined toast", async () => {
    const sessions = setupBulkJiraSessions();
    const onRefresh = vi.fn();
    const { container } = render(
      <HistoryPage
        {...defaultProps}
        sessions={sessions}
        total={2}
        onLogWork={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    expandIssueGroup(container);
    fireEvent.click(container.querySelector("[data-testid='log-date-btn']")!);
    fireEvent.click(within(container).getByRole("button", { name: "Log Work" }));

    await waitFor(() => {
      expect(mockWorklogLog).toHaveBeenCalledWith(
        expect.objectContaining({
          issueKey: "PROJ-123",
          selectedSessionIds: expect.arrayContaining(["s1", "s2"]),
        }),
      );
    });

    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toMatch(/work sessions combined/);
    });

    expect(onRefresh).toHaveBeenCalled();
  });

  it("shows error toast when bulk worklog API call fails", async () => {
    mockWorklogLog.mockRejectedValueOnce(new Error("Server error"));
    const sessions = setupBulkJiraSessions();
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={sessions} total={2} onLogWork={vi.fn()} />,
    );
    expandIssueGroup(container);
    fireEvent.click(container.querySelector("[data-testid='log-date-btn']")!);
    fireEvent.click(within(container).getByRole("button", { name: "Log Work" }));

    await waitFor(() => {
      expect(within(container).getByRole("alert").textContent).toBe("Server error");
    });
  });
});

describe("HistoryPage - toast dismissal", () => {
  it("clicking a toast dismisses it", async () => {
    const onLogWork = vi.fn().mockResolvedValue(undefined);
    const session = makeJiraSession("s1", "not_logged");
    const { container } = render(
      <HistoryPage {...defaultProps} sessions={[session]} total={1} onLogWork={onLogWork} />,
    );
    expandIssueGroup(container);
    expandDateSubGroup(container);
    fireEvent.click(within(container).getByLabelText("Log work to Jira for: Session s1"));
    fireEvent.click(within(container).getByRole("button", { name: "Log Work" }));

    await waitFor(() => {
      expect(within(container).getByRole("alert")).toBeInTheDocument();
    });

    fireEvent.click(within(container).getByRole("alert"));
    expect(within(container).queryByRole("alert")).toBeNull();
  });
});
