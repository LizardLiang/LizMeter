// electron/main/issue-providers/github-provider.ts
// GitHub Issues provider using @octokit/rest v20 (CJS-compatible)

import { Octokit } from "@octokit/rest";
import type { Issue, IssueComment, IssuesListInput } from "../../../src/shared/types.ts";
import { IssueProviderError } from "./types.ts";
import type { IssueProvider } from "./types.ts";

export class GitHubProvider implements IssueProvider {
  readonly providerName = "github";

  private octokit: Octokit;
  private cache = new Map<string, Issue[]>();
  private authenticatedUsername: string | null = null;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async listIssues(input: IssuesListInput = {}): Promise<Issue[]> {
    const cacheKey = input.repo ?? "__all__";

    if (input.forceRefresh) {
      this.cache.delete(cacheKey);
    }

    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      let items: Awaited<ReturnType<typeof this.octokit.rest.issues.listForAuthenticatedUser>>["data"];

      if (input.repo) {
        const [owner, repo] = input.repo.split("/");
        if (!owner || !repo) {
          throw new IssueProviderError(`Invalid repo format: "${input.repo}". Expected "owner/repo"`, "NETWORK_ERROR");
        }
        const username = await this.getUsername();
        const response = await this.octokit.rest.issues.listForRepo({
          owner,
          repo,
          assignee: username,
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 100,
        });
        items = response.data;
      } else {
        const response = await this.octokit.rest.issues.listForAuthenticatedUser({
          filter: "assigned",
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 100,
        });
        items = response.data;
      }

      // Filter out pull requests (GitHub API mixes PRs and issues on /issues endpoint)
      const issues: Issue[] = items
        .filter((item) => !item.pull_request)
        .map((item) => {
          const repoUrl = item.repository_url ?? "";
          const repoParts = repoUrl.split("/repos/")[1] ?? "";
          return {
            number: item.number,
            title: item.title,
            url: item.html_url,
            repo: repoParts || (input.repo ?? ""),
            state: item.state as "open" | "closed",
            labels: (item.labels ?? []).map((label) => {
              if (typeof label === "string") {
                return { name: label, color: "7aa2f7" };
              }
              return {
                name: label.name ?? "",
                color: label.color ?? "7aa2f7",
              };
            }),
            updatedAt: item.updated_at ?? new Date().toISOString(),
          };
        });

      this.cache.set(cacheKey, issues);
      return issues;
    } catch (err) {
      if (err instanceof IssueProviderError) throw err;
      if (err instanceof Error && "status" in err) {
        const status = (err as { status: number }).status;
        if (status === 401) {
          throw new IssueProviderError("GitHub token is invalid or has been revoked", "AUTH_FAILED");
        }
        if (status === 403) {
          throw new IssueProviderError("GitHub API rate limit reached. Try again in a few minutes.", "RATE_LIMITED");
        }
      }
      throw new IssueProviderError(
        err instanceof Error ? err.message : "Could not reach GitHub. Check your internet connection.",
        "NETWORK_ERROR",
      );
    }
  }

  private async getUsername(): Promise<string> {
    if (!this.authenticatedUsername) {
      const { data } = await this.octokit.rest.users.getAuthenticated();
      this.authenticatedUsername = data.login;
    }
    return this.authenticatedUsername;
  }

  async fetchComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
    try {
      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) {
        throw new IssueProviderError(`Invalid repo format: "${repo}". Expected "owner/repo"`, "NETWORK_ERROR");
      }
      const response = await this.octokit.rest.issues.listComments({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        per_page: 100,
        sort: "created",
        direction: "asc",
      });
      return response.data.map((c) => ({
        id: String(c.id),
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        createdAt: c.created_at,
      }));
    } catch (err) {
      if (err instanceof IssueProviderError) throw err;
      if (err instanceof Error && "status" in err) {
        const status = (err as { status: number }).status;
        if (status === 401) throw new IssueProviderError("GitHub token is invalid or has been revoked", "AUTH_FAILED");
        if (status === 403) throw new IssueProviderError("GitHub API rate limit reached.", "RATE_LIMITED");
      }
      throw new IssueProviderError(
        err instanceof Error ? err.message : "Could not fetch comments from GitHub.",
        "NETWORK_ERROR",
      );
    }
  }

  async testConnection(): Promise<{ username: string }> {
    try {
      const username = await this.getUsername();
      return { username };
    } catch (err) {
      if (err instanceof IssueProviderError) throw err;
      if (err instanceof Error && "status" in err) {
        const status = (err as { status: number }).status;
        if (status === 401) {
          throw new IssueProviderError("GitHub token is invalid or has been revoked", "AUTH_FAILED");
        }
        if (status === 403) {
          throw new IssueProviderError("GitHub API rate limit reached. Try again in a few minutes.", "RATE_LIMITED");
        }
      }
      throw new IssueProviderError(
        err instanceof Error ? err.message : "Could not reach GitHub. Check your internet connection.",
        "NETWORK_ERROR",
      );
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.clear();
    this.authenticatedUsername = null;
  }
}
