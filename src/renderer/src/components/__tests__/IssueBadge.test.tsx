import { fireEvent, render, within } from "@testing-library/react";
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
});
