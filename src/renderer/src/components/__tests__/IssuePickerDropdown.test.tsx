import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueProviderStatus, IssueRef, JiraIssue, LinearIssue } from "../../../../shared/types.ts";
import type { UseIssuesReturn } from "../../hooks/useIssues.ts";
import type { UseJiraIssuesReturn } from "../../hooks/useJiraIssues.ts";
import type { UseLinearIssuesReturn } from "../../hooks/useLinearIssues.ts";
import { IssuePickerDropdown } from "../IssuePickerDropdown.tsx";

afterEach(cleanup);

// ── Module mocks ──

vi.mock("../../hooks/useIssues.ts");
vi.mock("../../hooks/useLinearIssues.ts");
vi.mock("../../hooks/useJiraIssues.ts");
vi.mock("../ProviderTabs.tsx", () => ({
  ProviderTabs: ({
    providers,
    activeProvider,
    onSwitch,
  }: {
    providers: string[];
    activeProvider: string;
    onSwitch: (p: string) => void;
  }) => (
    <div data-testid="provider-tabs">
      {providers.map((p) => (
        <button key={p} onClick={() => onSwitch(p)} aria-pressed={p === activeProvider}>
          {p}
        </button>
      ))}
    </div>
  ),
}));

// ── Helpers ──

const notConfiguredStatus: IssueProviderStatus = {
  configured: false,
  provider: null,
  linearConfigured: false,
  linearTeamSelected: false,
  jiraConfigured: false,
  jiraDomainSet: false,
};

const githubConfiguredStatus: IssueProviderStatus = {
  ...notConfiguredStatus,
  configured: true,
  provider: "github",
};

const linearConfiguredStatus: IssueProviderStatus = {
  ...notConfiguredStatus,
  linearConfigured: true,
  linearTeamSelected: true,
};

function makeGitHubIssue(n: number, title = `Issue ${n}`): Issue {
  return { number: n, title, url: `https://github.com/repo/issues/${n}`, state: "open", repo: "repo" };
}

function makeLinearIssue(id: string, title = `Task ${id}`): LinearIssue {
  return {
    id,
    identifier: `LIN-${id}`,
    title,
    url: `https://linear.app/team/issue/LIN-${id}`,
    priority: 2,
    state: { name: "In Progress", type: "started" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeJiraIssue(key: string, title = `Jira ${key}`): JiraIssue {
  return {
    id: key,
    key,
    title,
    url: `https://jira.example.com/browse/${key}`,
    status: "Open",
    priority: null,
    assignee: null,
    issueType: null,
    labels: [],
  };
}

function makeGitHubHookReturn(overrides: Partial<UseIssuesReturn> = {}): UseIssuesReturn {
  return {
    issues: [],
    status: notConfiguredStatus,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

function makeLinearHookReturn(overrides: Partial<UseLinearIssuesReturn> = {}): UseLinearIssuesReturn {
  return {
    issues: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

function makeJiraHookReturn(overrides: Partial<UseJiraIssuesReturn> = {}): UseJiraIssuesReturn {
  return {
    issues: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

// Import mocked modules for stubbing
import { useIssues } from "../../hooks/useIssues.ts";
import { useJiraIssues } from "../../hooks/useJiraIssues.ts";
import { useLinearIssues } from "../../hooks/useLinearIssues.ts";

const mockedUseIssues = vi.mocked(useIssues);
const mockedUseLinearIssues = vi.mocked(useLinearIssues);
const mockedUseJiraIssues = vi.mocked(useJiraIssues);

function setupNoProviders() {
  mockedUseIssues.mockReturnValue(makeGitHubHookReturn());
  mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn());
  mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn());
}

function setupGitHubOnly(issues: Issue[] = []) {
  mockedUseIssues.mockReturnValue(makeGitHubHookReturn({ status: githubConfiguredStatus, issues }));
  mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn());
  mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn());
}

function setupLinearOnly(issues: LinearIssue[] = []) {
  mockedUseIssues.mockReturnValue(makeGitHubHookReturn({ status: linearConfiguredStatus }));
  mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn({ issues }));
  mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn());
}

beforeEach(() => {
  setupNoProviders();
});

// ── Tests ──

describe("IssuePickerDropdown — no providers configured", () => {
  it("renders nothing when no providers are configured", () => {
    const { container } = render(
      <IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("IssuePickerDropdown — shows Link issue button", () => {
  it("shows 'Link issue' button when GitHub is configured", () => {
    setupGitHubOnly();
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /link issue/i })).toBeInTheDocument();
  });
});

describe("IssuePickerDropdown — dropdown open/close", () => {
  it("clicking 'Link issue' opens the dropdown with search input", () => {
    setupGitHubOnly([makeGitHubIssue(1, "Fix bug")]);
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    expect(screen.getByPlaceholderText("Search issues…")).toBeInTheDocument();
  });

  it("clicking outside closes the dropdown", () => {
    setupGitHubOnly([makeGitHubIssue(1)]);
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));
    expect(screen.getByPlaceholderText("Search issues…")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByPlaceholderText("Search issues…")).toBeNull();
  });
});

describe("IssuePickerDropdown — GitHub issue list", () => {
  it("renders GitHub issues in the dropdown", () => {
    const issues = [makeGitHubIssue(1, "Fix login bug"), makeGitHubIssue(2, "Add dark mode")];
    setupGitHubOnly(issues);

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("Add dark mode")).toBeInTheDocument();
  });

  it("shows 'No open issues' when list is empty", () => {
    setupGitHubOnly([]);
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    expect(screen.getByText("No open issues")).toBeInTheDocument();
  });

  it("clicking an issue calls onSelect with correct IssueRef shape", () => {
    const issue = makeGitHubIssue(42, "Deploy to prod");
    setupGitHubOnly([issue]);
    const onSelect = vi.fn();

    render(<IssuePickerDropdown selectedIssue={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));
    fireEvent.click(screen.getByText("Deploy to prod"));

    expect(onSelect).toHaveBeenCalledWith({
      provider: "github",
      number: 42,
      title: "Deploy to prod",
      url: issue.url,
    });
  });

  it("filters issues by search text", () => {
    const issues = [makeGitHubIssue(1, "Fix login bug"), makeGitHubIssue(2, "Add dark mode")];
    setupGitHubOnly(issues);

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    fireEvent.change(screen.getByPlaceholderText("Search issues…"), { target: { value: "dark" } });

    expect(screen.getByText("Add dark mode")).toBeInTheDocument();
    expect(screen.queryByText("Fix login bug")).toBeNull();
  });

  it("shows 'No matching issues' when search has no matches", () => {
    setupGitHubOnly([makeGitHubIssue(1, "Fix login bug")]);
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    fireEvent.change(screen.getByPlaceholderText("Search issues…"), { target: { value: "zzznomatch" } });

    expect(screen.getByText("No matching issues")).toBeInTheDocument();
  });
});

describe("IssuePickerDropdown — Linear issue list", () => {
  it("renders Linear issues and calls onSelect with Linear IssueRef", () => {
    const issue = makeLinearIssue("42", "Refactor auth");
    setupLinearOnly([issue]);
    const onSelect = vi.fn();

    render(<IssuePickerDropdown selectedIssue={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));
    fireEvent.click(screen.getByText("Refactor auth"));

    expect(onSelect).toHaveBeenCalledWith({
      provider: "linear",
      identifier: "LIN-42",
      title: "Refactor auth",
      url: issue.url,
    });
  });
});

describe("IssuePickerDropdown — selected issue display", () => {
  it("shows selected GitHub issue with Unlink button instead of dropdown trigger", () => {
    setupGitHubOnly();
    const selectedIssue: IssueRef = {
      provider: "github",
      number: 7,
      title: "Fix logout flow",
      url: "https://github.com/repo/issues/7",
    };

    render(<IssuePickerDropdown selectedIssue={selectedIssue} onSelect={vi.fn()} />);

    expect(screen.getByText("Fix logout flow")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlink issue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^link issue$/i })).toBeNull();
  });

  it("clicking Unlink calls onSelect(null)", () => {
    setupGitHubOnly();
    const onSelect = vi.fn();
    const selectedIssue: IssueRef = {
      provider: "github",
      number: 7,
      title: "Fix logout flow",
      url: "https://github.com/repo/issues/7",
    };

    render(<IssuePickerDropdown selectedIssue={selectedIssue} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink issue" }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("shows Linear identifier for selected Linear issue", () => {
    setupLinearOnly();
    const selectedIssue: IssueRef = {
      provider: "linear",
      identifier: "LIN-99",
      title: "Ship it",
      url: "https://linear.app/team/issue/LIN-99",
    };

    render(<IssuePickerDropdown selectedIssue={selectedIssue} onSelect={vi.fn()} />);

    expect(screen.getByText("LIN-99")).toBeInTheDocument();
    expect(screen.getByText("Ship it")).toBeInTheDocument();
  });
});

describe("IssuePickerDropdown — Escape key closes dropdown", () => {
  it("pressing Escape closes the dropdown", () => {
    setupGitHubOnly([makeGitHubIssue(1)]);
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));
    const dropdown = screen.getByPlaceholderText("Search issues…").closest("[class]") as HTMLElement;
    expect(dropdown).not.toBeNull();

    fireEvent.keyDown(dropdown!.parentElement!, { key: "Escape" });

    expect(screen.queryByPlaceholderText("Search issues…")).toBeNull();
  });
});

describe("IssuePickerDropdown — loading state", () => {
  it("Link issue button is disabled while loading", () => {
    mockedUseIssues.mockReturnValue(
      makeGitHubHookReturn({ status: githubConfiguredStatus, isLoading: true }),
    );
    mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn());
    mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn());

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: /link issue/i })).toBeDisabled();
  });
});

describe("IssuePickerDropdown — multi-provider shows tabs", () => {
  it("renders provider tabs when both GitHub and Linear are configured", () => {
    const bothConfiguredStatus: IssueProviderStatus = {
      configured: true,
      provider: "github",
      linearConfigured: true,
      linearTeamSelected: true,
      jiraConfigured: false,
      jiraDomainSet: false,
    };
    mockedUseIssues.mockReturnValue(
      makeGitHubHookReturn({ status: bothConfiguredStatus, issues: [makeGitHubIssue(1)] }),
    );
    mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn({ issues: [makeLinearIssue("1")] }));
    mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn());

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    expect(screen.getByTestId("provider-tabs")).toBeInTheDocument();
  });

  it("switching provider tab via ProviderTabs changes the active tab", () => {
    const bothConfiguredStatus: IssueProviderStatus = {
      configured: true,
      provider: "github",
      linearConfigured: true,
      linearTeamSelected: true,
      jiraConfigured: false,
      jiraDomainSet: false,
    };
    const linearIssue = makeLinearIssue("7", "Linear task");
    mockedUseIssues.mockReturnValue(
      makeGitHubHookReturn({ status: bothConfiguredStatus, issues: [makeGitHubIssue(1, "GitHub bug")] }),
    );
    mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn({ issues: [linearIssue] }));
    mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn());

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    // GitHub issues visible initially
    expect(screen.getByText("GitHub bug")).toBeInTheDocument();

    // Switch to linear tab
    fireEvent.click(screen.getByRole("button", { name: "linear" }));

    // Linear issue now visible
    expect(screen.getByText("Linear task")).toBeInTheDocument();
  });
});

describe("IssuePickerDropdown — Jira issues", () => {
  function setupJiraOnly(issues: JiraIssue[] = []) {
    const jiraConfiguredStatus: IssueProviderStatus = {
      configured: false,
      provider: null,
      linearConfigured: false,
      linearTeamSelected: false,
      jiraConfigured: true,
      jiraDomainSet: true,
    };
    mockedUseIssues.mockReturnValue(makeGitHubHookReturn({ status: jiraConfiguredStatus }));
    mockedUseLinearIssues.mockReturnValue(makeLinearHookReturn());
    mockedUseJiraIssues.mockReturnValue(makeJiraHookReturn({ issues }));
  }

  it("renders Jira issues in the dropdown", () => {
    const issue = makeJiraIssue("PROJ-5", "Fix API timeout");
    setupJiraOnly([issue]);

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    expect(screen.getByText("Fix API timeout")).toBeInTheDocument();
    expect(screen.getByText("PROJ-5")).toBeInTheDocument();
  });

  it("shows 'No issues found' when Jira list is empty", () => {
    setupJiraOnly([]);
    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    expect(screen.getByText("No issues found")).toBeInTheDocument();
  });

  it("clicking a Jira issue calls onSelect with Jira IssueRef shape", () => {
    const issue = makeJiraIssue("PROJ-12", "Update docs");
    setupJiraOnly([issue]);
    const onSelect = vi.fn();

    render(<IssuePickerDropdown selectedIssue={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));
    fireEvent.click(screen.getByText("Update docs"));

    expect(onSelect).toHaveBeenCalledWith({
      provider: "jira",
      key: "PROJ-12",
      title: "Update docs",
      url: issue.url,
    });
  });

  it("filters Jira issues by search text", () => {
    const issues = [makeJiraIssue("PROJ-1", "API timeout"), makeJiraIssue("PROJ-2", "UI refresh")];
    setupJiraOnly(issues);

    render(<IssuePickerDropdown selectedIssue={null} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    fireEvent.change(screen.getByPlaceholderText("Search issues…"), { target: { value: "API" } });

    expect(screen.getByText("API timeout")).toBeInTheDocument();
    expect(screen.queryByText("UI refresh")).toBeNull();
  });

  it("shows selected Jira issue with its key as identifier", () => {
    setupJiraOnly();
    const selectedIssue: IssueRef = {
      provider: "jira",
      key: "PROJ-42",
      title: "Deploy hotfix",
      url: "https://jira.example.com/browse/PROJ-42",
    };

    render(<IssuePickerDropdown selectedIssue={selectedIssue} onSelect={vi.fn()} />);

    expect(screen.getByText("PROJ-42")).toBeInTheDocument();
    expect(screen.getByText("Deploy hotfix")).toBeInTheDocument();
  });
});

describe("IssuePickerDropdown — keyboard navigation", () => {
  it("ArrowDown/ArrowUp/Enter navigate and select issues", () => {
    const issues = [makeGitHubIssue(1, "First issue"), makeGitHubIssue(2, "Second issue")];
    setupGitHubOnly(issues);
    const onSelect = vi.fn();

    render(<IssuePickerDropdown selectedIssue={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    // The dropdown div is the direct parent of the search input
    const dropdown = screen.getByPlaceholderText("Search issues…").parentElement!;

    // ArrowDown moves focus to index 0
    fireEvent.keyDown(dropdown, { key: "ArrowDown" });
    // ArrowDown again moves to index 1
    fireEvent.keyDown(dropdown, { key: "ArrowDown" });
    // ArrowUp moves back to index 0
    fireEvent.keyDown(dropdown, { key: "ArrowUp" });
    // Enter selects index 0 ("First issue")
    fireEvent.keyDown(dropdown, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", number: 1 }),
    );
  });

  it("Enter with no focusedIndex (−1) does NOT select anything", () => {
    setupGitHubOnly([makeGitHubIssue(1, "Issue")]);
    const onSelect = vi.fn();

    render(<IssuePickerDropdown selectedIssue={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /link issue/i }));

    const dropdown = screen.getByPlaceholderText("Search issues…").parentElement!;
    // Press Enter without navigating first (focusedIndex stays at -1)
    fireEvent.keyDown(dropdown, { key: "Enter" });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
