// electron/main/issue-providers/jira-provider.ts
// Jira REST API provider — supports both Cloud (v3) and Server (v2, basic auth)

import type { IssueComment, JiraAuthType, JiraIssue } from "../../../src/shared/types.ts";
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

export class JiraProvider {
  private baseUrl: string;
  private authHeader: string;
  private authType: JiraAuthType;
  private cache = new Map<string, JiraIssue[]>();

  constructor(domain: string, email: string, secret: string, authType: JiraAuthType = "cloud") {
    this.authType = authType;

    if (authType === "server") {
      // Server: domain is the full hostname (e.g., jira.mycompany.com or jira.mycompany.com:8080)
      const normalized = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      this.baseUrl = `https://${normalized}`;
      // Server basic auth: username:password
      this.authHeader = `Basic ${Buffer.from(`${email}:${secret}`).toString("base64")}`;
    } else {
      // Cloud: domain is the Atlassian subdomain (e.g., mycompany.atlassian.net)
      const normalized = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      this.baseUrl = `https://${normalized}`;
      // Cloud basic auth: email:apiToken
      this.authHeader = `Basic ${Buffer.from(`${email}:${secret}`).toString("base64")}`;
    }
  }

  private get apiVersion(): string {
    return this.authType === "server" ? "2" : "3";
  }

  private get browseBaseUrl(): string {
    return this.baseUrl;
  }

  async testConnection(): Promise<{ displayName: string }> {
    const response = await this.request(`/rest/api/${this.apiVersion}/myself`);
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

    const response = await this.request(`/rest/api/${this.apiVersion}/search?${params}`);
    const data = await response.json();
    const issues = (data.issues ?? []).map((raw: RawJiraIssue) => this.mapToJiraIssue(raw));
    this.cache.set(cacheKey, issues);
    return issues;
  }

  private mapToJiraIssue(raw: RawJiraIssue): JiraIssue {
    return {
      id: raw.id,
      key: raw.key,
      title: raw.fields.summary,
      url: `${this.browseBaseUrl}/browse/${raw.key}`,
      status: raw.fields.status.name,
      priority: raw.fields.priority?.name ?? null,
      assignee: raw.fields.assignee?.displayName ?? null,
      issueType: raw.fields.issuetype?.name ?? null,
      labels: raw.fields.labels ?? [],
    };
  }

  private async request(path: string, options?: { method?: string; body?: unknown }): Promise<Response> {
    const method = options?.method ?? "GET";
    const headers: Record<string, string> = {
      "Authorization": this.authHeader,
      "Accept": "application/json",
    };
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new IssueProviderError(
        `Could not reach ${this.baseUrl}. Check the domain and your internet connection.`,
        "NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      if (response.status === 401) {
        const hint = this.authType === "server"
          ? "Jira credentials are invalid. Check your username and password."
          : "Jira credentials are invalid. Check your email and API token.";
        throw new IssueProviderError(hint, "AUTH_FAILED");
      }
      if (response.status === 403) {
        throw new IssueProviderError(
          "Access denied. Your account may lack permissions for this resource.",
          "AUTH_FAILED",
        );
      }
      if (response.status === 404) {
        throw new IssueProviderError(
          "Resource not found in Jira. The issue may have been deleted.",
          "NOT_FOUND",
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

  async addWorklog(
    issueKey: string,
    timeSpentSeconds: number,
    started: string,
    comment: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      timeSpentSeconds,
      started: this.formatJiraTimestamp(started),
    };

    if (this.authType === "server") {
      // Server v2: plain string comment
      body.comment = comment;
    } else {
      // Cloud v3: ADF format
      body.comment = {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: comment },
            ],
          },
        ],
      };
    }

    const response = await this.request(
      `/rest/api/${this.apiVersion}/issue/${issueKey}/worklog`,
      { method: "POST", body },
    );
    const data = await response.json() as { id: string | number };
    return { id: String(data.id) };
  }

  private formatJiraTimestamp(isoString: string): string {
    // Jira expects: "2026-02-24T10:30:00.000+0000"
    const date = new Date(isoString);
    return date.toISOString().replace("Z", "+0000");
  }

  async fetchComments(issueKey: string): Promise<IssueComment[]> {
    const response = await this.request(
      `/rest/api/${this.apiVersion}/issue/${issueKey}/comment?orderBy=created`,
    );
    const data = await response.json();
    return (data.comments ?? []).map((c: { id: string; author?: { displayName?: string }; body: unknown; created: string }) => ({
      id: c.id,
      author: c.author?.displayName ?? "Unknown",
      body: typeof c.body === "string" ? c.body : this.extractJiraBody(c.body),
      createdAt: c.created,
    }));
  }

  private extractJiraBody(body: unknown): string {
    // Jira Cloud v3 uses ADF (Atlassian Document Format), v2 uses plain string
    if (typeof body === "string") return body;
    if (body && typeof body === "object" && "content" in body) {
      return this.flattenAdf(body as { content: unknown[] });
    }
    return "";
  }

  private flattenAdf(node: { type?: string; text?: string; content?: unknown[] }): string {
    if (node.text) return node.text;
    if (!node.content || !Array.isArray(node.content)) return "";
    return node.content
      .map((child) => this.flattenAdf(child as { type?: string; text?: string; content?: unknown[] }))
      .join("");
  }

  clearCache(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.clear();
  }
}