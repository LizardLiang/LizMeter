// electron/main/issue-providers/jira-provider.ts
// Jira Cloud REST API v3 provider — standalone class (follows LinearProvider pattern)

import type { JiraIssue } from "../../../src/shared/types.ts";
import { IssueProviderError } from "./types.ts";

interface RawJiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
    issuetype?: { name: string } | null;
    labels: string[];
  };
}

function mapToJiraIssue(raw: RawJiraIssue, domain: string): JiraIssue {
  return {
    id: raw.id,
    key: raw.key,
    title: raw.fields.summary,
    url: `https://${domain}/browse/${raw.key}`,
    status: raw.fields.status.name,
    priority: raw.fields.priority?.name ?? null,
    assignee: raw.fields.assignee?.displayName ?? null,
    issueType: raw.fields.issuetype?.name ?? null,
    labels: raw.fields.labels ?? [],
  };
}

export class JiraProvider {
  private domain: string;
  private authHeader: string;
  private cache = new Map<string, JiraIssue[]>();

  constructor(domain: string, email: string, apiToken: string) {
    // Normalize domain: strip protocol and trailing slashes
    this.domain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  async testConnection(): Promise<{ displayName: string }> {
    const response = await this.request("/rest/api/3/myself");
    const data = await response.json();
    return { displayName: data.displayName };
  }

  async fetchIssues(projectKey: string | null, jqlFilter: string | null, forceRefresh = false): Promise<JiraIssue[]> {
    const cacheKey = jqlFilter ?? projectKey ?? "__all__";
    if (forceRefresh) this.cache.delete(cacheKey);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let jql: string;
    if (jqlFilter) {
      jql = jqlFilter;
    } else if (projectKey) {
      jql = `project = ${projectKey} ORDER BY updated DESC`;
    } else {
      jql = "assignee = currentUser() ORDER BY updated DESC";
    }

    const params = new URLSearchParams({
      jql,
      maxResults: "50",
      fields: "summary,status,priority,assignee,issuetype,labels",
    });

    const response = await this.request(`/rest/api/3/search?${params}`);
    const data = await response.json();
    const issues = (data.issues ?? []).map((raw: RawJiraIssue) => mapToJiraIssue(raw, this.domain));
    this.cache.set(cacheKey, issues);
    return issues;
  }

  private async request(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`https://${this.domain}${path}`, {
        headers: {
          "Authorization": this.authHeader,
          "Accept": "application/json",
        },
      });
    } catch {
      throw new IssueProviderError(
        `Could not reach ${this.domain}. Check the domain and your internet connection.`,
        "NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new IssueProviderError(
          "Jira credentials are invalid. Check your email and API token.",
          "AUTH_FAILED",
        );
      }
      if (response.status === 403) {
        throw new IssueProviderError(
          "Access denied. Your API token may lack permissions for this resource.",
          "AUTH_FAILED",
        );
      }
      if (response.status === 429) {
        throw new IssueProviderError(
          "Jira API rate limit reached. Try again in a few minutes.",
          "RATE_LIMITED",
        );
      }
      if (response.status === 400) {
        try {
          const errBody = await response.json();
          const msgs = errBody.errorMessages ?? [];
          throw new IssueProviderError(
            msgs.length > 0 ? msgs[0] : "Invalid request to Jira API",
            "QUERY_ERROR",
          );
        } catch (e) {
          if (e instanceof IssueProviderError) throw e;
        }
      }
      throw new IssueProviderError(
        `Jira API error: ${response.status} ${response.statusText}`,
        "NETWORK_ERROR",
      );
    }

    return response;
  }

  clearCache(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.clear();
  }
}
