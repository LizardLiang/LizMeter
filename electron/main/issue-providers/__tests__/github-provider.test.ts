// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Octokit mock (must use vi.hoisted to avoid TDZ with module-level consts) ──

const { mockOctokit } = vi.hoisted(() => {
  const mockOctokit = {
    rest: {
      issues: {
        listForAuthenticatedUser: vi.fn(),
        listForRepo: vi.fn(),
        listComments: vi.fn(),
      },
      users: {
        getAuthenticated: vi.fn(),
      },
    },
  };
  return { mockOctokit };
});

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(function MockOctokit() {
    return mockOctokit;
  }),
}));

import { GitHubProvider } from "../github-provider.ts";
import { IssueProviderError } from "../types.ts";

// ── Helpers ──

function makeIssueData(n: number, title = `Issue ${n}`) {
  return {
    number: n,
    title,
    html_url: `https://github.com/owner/repo/issues/${n}`,
    state: "open",
    repository_url: "https://api.github.com/repos/owner/repo",
    pull_request: undefined,
    labels: [],
    updated_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOctokit.rest.users.getAuthenticated.mockResolvedValue({ data: { login: "testuser" } });
  mockOctokit.rest.issues.listForAuthenticatedUser.mockResolvedValue({
    data: [makeIssueData(1, "Test issue")],
  });
  mockOctokit.rest.issues.listForRepo.mockResolvedValue({
    data: [makeIssueData(2, "Repo issue")],
  });
  mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
});

// ── Tests ──

describe("GitHubProvider — listIssues (all repos)", () => {
  it("fetches issues for authenticated user", async () => {
    const provider = new GitHubProvider("token-123");
    const issues = await provider.listIssues();

    expect(mockOctokit.rest.issues.listForAuthenticatedUser).toHaveBeenCalledOnce();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("Test issue");
    expect(issues[0]!.number).toBe(1);
    expect(issues[0]!.repo).toBe("owner/repo");
  });

  it("filters out pull requests from results", async () => {
    mockOctokit.rest.issues.listForAuthenticatedUser.mockResolvedValue({
      data: [
        makeIssueData(1, "Real issue"),
        { ...makeIssueData(2, "PR"), pull_request: { url: "..." } },
      ],
    });

    const provider = new GitHubProvider("token");
    const issues = await provider.listIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("Real issue");
  });

  it("maps string labels correctly", async () => {
    mockOctokit.rest.issues.listForAuthenticatedUser.mockResolvedValue({
      data: [{
        ...makeIssueData(1),
        labels: [
          "string-label",
          { name: "bug", color: "f7768e" },
        ],
      }],
    });

    const provider = new GitHubProvider("token");
    const issues = await provider.listIssues();

    expect(issues[0]!.labels).toEqual([
      { name: "string-label", color: "7aa2f7" },
      { name: "bug", color: "f7768e" },
    ]);
  });

  it("caches results on second call", async () => {
    const provider = new GitHubProvider("token");
    await provider.listIssues();
    await provider.listIssues();

    expect(mockOctokit.rest.issues.listForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("forceRefresh bypasses cache", async () => {
    const provider = new GitHubProvider("token");
    await provider.listIssues();
    await provider.listIssues({ forceRefresh: true });

    expect(mockOctokit.rest.issues.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});

describe("GitHubProvider — listIssues (specific repo)", () => {
  it("fetches issues for a specific repo with owner/repo format", async () => {
    const provider = new GitHubProvider("token");
    const issues = await provider.listIssues({ repo: "owner/myrepo" });

    expect(mockOctokit.rest.issues.listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "myrepo" }),
    );
    expect(issues[0]!.title).toBe("Repo issue");
  });

  it("throws IssueProviderError for invalid repo format (missing slash)", async () => {
    const provider = new GitHubProvider("token");

    await expect(provider.listIssues({ repo: "invalid-no-slash" })).rejects.toThrow(IssueProviderError);
  });
});

describe("GitHubProvider — error handling", () => {
  it("throws AUTH_FAILED error on 401 status", async () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    mockOctokit.rest.issues.listForAuthenticatedUser.mockRejectedValue(err);

    const provider = new GitHubProvider("bad-token");
    await expect(provider.listIssues()).rejects.toThrow("invalid or has been revoked");
  });

  it("throws RATE_LIMITED error on 403 status", async () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    mockOctokit.rest.issues.listForAuthenticatedUser.mockRejectedValue(err);

    const provider = new GitHubProvider("token");
    await expect(provider.listIssues()).rejects.toThrow("rate limit");
  });

  it("wraps unknown errors as NETWORK_ERROR with the original message", async () => {
    mockOctokit.rest.issues.listForAuthenticatedUser.mockRejectedValue(new Error("timeout"));

    const provider = new GitHubProvider("token");
    const err = await provider.listIssues().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssueProviderError);
    expect((err as IssueProviderError).message).toBe("timeout");
  });

  it("re-throws IssueProviderError without wrapping", async () => {
    const original = new IssueProviderError("already wrapped", "NETWORK_ERROR");
    mockOctokit.rest.issues.listForAuthenticatedUser.mockRejectedValue(original);

    const provider = new GitHubProvider("token");
    await expect(provider.listIssues()).rejects.toBe(original);
  });
});

describe("GitHubProvider — fetchComments", () => {
  it("fetches comments for an issue", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [{
        id: 101,
        user: { login: "alice" },
        body: "LGTM!",
        created_at: "2026-01-02T00:00:00Z",
      }],
    });

    const provider = new GitHubProvider("token");
    const comments = await provider.fetchComments("owner/repo", 42);

    expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "repo", issue_number: 42 }),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]!.author).toBe("alice");
    expect(comments[0]!.body).toBe("LGTM!");
  });

  it("throws IssueProviderError for invalid repo format in fetchComments", async () => {
    const provider = new GitHubProvider("token");
    await expect(provider.fetchComments("invalid", 1)).rejects.toThrow(IssueProviderError);
  });

  it("handles null user and null body in comment", async () => {
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [{ id: 1, user: null, body: null, created_at: "2026-01-01T00:00:00Z" }],
    });

    const provider = new GitHubProvider("token");
    const comments = await provider.fetchComments("owner/repo", 1);
    expect(comments[0]!.author).toBe("unknown");
    expect(comments[0]!.body).toBe("");
  });

  it("throws AUTH_FAILED on 401 in fetchComments", async () => {
    mockOctokit.rest.issues.listComments.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    const provider = new GitHubProvider("token");
    await expect(provider.fetchComments("owner/repo", 1)).rejects.toThrow("invalid or has been revoked");
  });
});

describe("GitHubProvider — testConnection", () => {
  it("returns username on success", async () => {
    const provider = new GitHubProvider("token");
    const result = await provider.testConnection();
    expect(result.username).toBe("testuser");
  });

  it("caches authenticated username", async () => {
    const provider = new GitHubProvider("token");
    await provider.testConnection();
    await provider.testConnection();
    expect(mockOctokit.rest.users.getAuthenticated).toHaveBeenCalledTimes(1);
  });

  it("throws AUTH_FAILED on 401", async () => {
    mockOctokit.rest.users.getAuthenticated.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    const provider = new GitHubProvider("bad-token");
    await expect(provider.testConnection()).rejects.toThrow("invalid or has been revoked");
  });

  it("throws RATE_LIMITED on 403", async () => {
    mockOctokit.rest.users.getAuthenticated.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    const provider = new GitHubProvider("token");
    await expect(provider.testConnection()).rejects.toThrow("rate limit");
  });
});

describe("GitHubProvider — clearCache / destroy", () => {
  it("clearCache forces a fresh fetch on next listIssues", async () => {
    const provider = new GitHubProvider("token");
    await provider.listIssues();
    provider.clearCache();
    await provider.listIssues();
    expect(mockOctokit.rest.issues.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it("destroy clears cache and resets username", async () => {
    const provider = new GitHubProvider("token");
    await provider.testConnection();
    provider.destroy();
    await provider.testConnection();
    expect(mockOctokit.rest.users.getAuthenticated).toHaveBeenCalledTimes(2);
  });
});
