import { render, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRef, JiraIssue, LinearIssue } from "../../../../shared/types.ts";
import { IssuePromptDialog } from "../IssuePromptDialog.tsx";

// ---- helpers ----------------------------------------------------------------

function makeLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "linear-1",
    identifier: "LIN-42",
    title: "Fix the bug",
    url: "https://linear.app/team/issue/LIN-42",
    priority: 2,
    state: { name: "In Progress", type: "started" },
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeJiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: "jira-1",
    key: "PROJ-99",
    title: "Deploy to prod",
    url: "https://example.atlassian.net/browse/PROJ-99",
    status: "In Progress",
    priority: "Medium",
    assignee: null,
    issueType: "Task",
    labels: [],
    ...overrides,
  };
}

// Default: neither provider configured, no issues
function buildElectronAPI(overrides: {
  linearConfigured?: boolean;
  linearTeamSelected?: boolean;
  linearIssues?: LinearIssue[];
  jiraConfigured?: boolean;
  jiraIssues?: JiraIssue[];
  linearError?: boolean;
  jiraError?: boolean;
} = {}) {
  const {
    linearConfigured = false,
    linearTeamSelected = false,
    linearIssues = [],
    jiraConfigured = false,
    jiraIssues = [],
    linearError = false,
    jiraError = false,
  } = overrides;

  return {
    linear: {
      providerStatus: vi.fn().mockResolvedValue({ configured: linearConfigured, teamSelected: linearTeamSelected }),
      fetchIssues: linearError
        ? vi.fn().mockRejectedValue(new Error("Linear fetch failed"))
        : vi.fn().mockResolvedValue(linearIssues),
    },
    jira: {
      providerStatus: vi.fn().mockResolvedValue({ configured: jiraConfigured }),
      fetchIssues: jiraError
        ? vi.fn().mockRejectedValue(new Error("Jira fetch failed"))
        : vi.fn().mockResolvedValue(jiraIssues),
    },
  };
}

// ---- lifecycle --------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- tests ------------------------------------------------------------------

describe("IssuePromptDialog: loading state", () => {
  it("shows 'Loading issues...' initially before promises resolve", () => {
    // Use a never-resolving promise to freeze loading state
    vi.stubGlobal("electronAPI", {
      linear: {
        providerStatus: vi.fn().mockReturnValue(new Promise(() => {})),
        fetchIssues: vi.fn().mockReturnValue(new Promise(() => {})),
      },
      jira: {
        providerStatus: vi.fn().mockReturnValue(new Promise(() => {})),
        fetchIssues: vi.fn().mockReturnValue(new Promise(() => {})),
      },
    });

    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={vi.fn()} />);
    expect(within(container).getByText("Loading issues...")).toBeInTheDocument();
  });
});

describe("IssuePromptDialog: no providers configured", () => {
  it("shows 'No issue providers configured' when neither linear nor jira is configured", async () => {
    vi.stubGlobal("electronAPI", buildElectronAPI());
    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    expect(
      within(container).getByText("No issue providers configured. Set up Linear or Jira in Settings."),
    ).toBeInTheDocument();
  });
});

describe("IssuePromptDialog: linear issues", () => {
  it("renders linear issue buttons with identifier and title", async () => {
    const issue = makeLinearIssue();
    vi.stubGlobal(
      "electronAPI",
      buildElectronAPI({ linearConfigured: true, linearTeamSelected: true, linearIssues: [issue] }),
    );

    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    expect(within(container).getByText(issue.identifier)).toBeInTheDocument();
    expect(within(container).getByText(issue.title)).toBeInTheDocument();
  });

  it("calls onSelect with correct IssueRef when a linear issue is clicked", async () => {
    const issue = makeLinearIssue({
      id: "linear-2",
      identifier: "LIN-10",
      title: "Auth refactor",
      url: "https://linear.app/LIN-10",
    });
    const onSelect = vi.fn();
    vi.stubGlobal(
      "electronAPI",
      buildElectronAPI({ linearConfigured: true, linearTeamSelected: true, linearIssues: [issue] }),
    );

    const { container } = render(<IssuePromptDialog onSelect={onSelect} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    // The button containing the identifier text
    const identifierEl = within(container).getByText(issue.identifier);
    fireEvent.click(identifierEl.closest("button")!);

    const expected: IssueRef = {
      provider: "linear",
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    };
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(expected);
  });
});

describe("IssuePromptDialog: jira issues", () => {
  it("renders jira issue buttons with key and title", async () => {
    const issue = makeJiraIssue();
    vi.stubGlobal("electronAPI", buildElectronAPI({ jiraConfigured: true, jiraIssues: [issue] }));

    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    expect(within(container).getByText(issue.key)).toBeInTheDocument();
    expect(within(container).getByText(issue.title)).toBeInTheDocument();
  });

  it("calls onSelect with correct IssueRef when a jira issue is clicked", async () => {
    const issue = makeJiraIssue({
      id: "jira-2",
      key: "ENG-7",
      title: "Database migration",
      url: "https://jira.example.com/ENG-7",
    });
    const onSelect = vi.fn();
    vi.stubGlobal("electronAPI", buildElectronAPI({ jiraConfigured: true, jiraIssues: [issue] }));

    const { container } = render(<IssuePromptDialog onSelect={onSelect} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    const keyEl = within(container).getByText(issue.key);
    fireEvent.click(keyEl.closest("button")!);

    const expected: IssueRef = {
      provider: "jira",
      key: issue.key,
      title: issue.title,
      url: issue.url,
    };
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(expected);
  });
});

describe("IssuePromptDialog: skip action", () => {
  it("calls onSkip when the Skip button is clicked", async () => {
    vi.stubGlobal("electronAPI", buildElectronAPI());
    const onSkip = vi.fn();
    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={onSkip} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    fireEvent.click(within(container).getByRole("button", { name: /skip/i }));
    expect(onSkip).toHaveBeenCalledOnce();
  });
});

describe("IssuePromptDialog: empty results", () => {
  it("shows 'No issues found.' when providers are configured but return no issues", async () => {
    vi.stubGlobal(
      "electronAPI",
      buildElectronAPI({ linearConfigured: true, linearTeamSelected: true, linearIssues: [] }),
    );

    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    expect(within(container).getByText("No issues found.")).toBeInTheDocument();
  });
});

describe("IssuePromptDialog: error state", () => {
  it("shows error message when provider status fetch fails", async () => {
    vi.stubGlobal("electronAPI", {
      linear: {
        providerStatus: vi.fn().mockRejectedValue(new Error("Network error")),
        fetchIssues: vi.fn().mockResolvedValue([]),
      },
      jira: {
        providerStatus: vi.fn().mockRejectedValue(new Error("Network error")),
        fetchIssues: vi.fn().mockResolvedValue([]),
      },
    });

    const { container } = render(<IssuePromptDialog onSelect={vi.fn()} onSkip={vi.fn()} />);

    await waitFor(() => {
      expect(within(container).queryByText("Loading issues...")).toBeNull();
    });

    expect(within(container).getByText("Network error")).toBeInTheDocument();
  });
});
