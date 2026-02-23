// electron/main/issue-providers/linear-provider.ts
// Linear GraphQL client — fetches issues, teams, and user info from Linear API.
// Uses raw fetch instead of @linear/sdk to avoid CJS/ESM issues in Electron main process.

import type { LinearIssue, LinearIssueState, LinearTeam } from "../../../src/shared/types.ts";
import { IssueProviderError } from "./types.ts";

// --- GraphQL Queries ---

const VIEWER_QUERY = `
  query Viewer {
    viewer {
      id
      name
      email
    }
  }
`;

const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes {
        id
        name
        key
      }
    }
  }
`;

const TEAM_ISSUES_QUERY = `
  query TeamIssues($teamId: String!, $first: Int!) {
    team(id: $teamId) {
      issues(
        first: $first
        orderBy: updatedAt
        filter: { state: { type: { nin: ["completed", "cancelled"] } } }
      ) {
        nodes {
          id
          identifier
          title
          url
          priority
          state {
            name
            type
          }
          updatedAt
        }
      }
    }
  }
`;

// --- Raw GraphQL response shapes ---

interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  state: LinearIssueState;
  updatedAt: string;
}

function mapToLinearIssue(raw: RawLinearIssue): LinearIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    priority: raw.priority,
    state: {
      name: raw.state.name,
      type: raw.state.type,
    },
    updatedAt: raw.updatedAt,
  };
}

// --- LinearProvider class ---

export class LinearProvider {
  private apiKey: string;
  private cache = new Map<string, LinearIssue[]>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async testConnection(): Promise<{ displayName: string }> {
    const data = await this.graphql<{ viewer: { id: string; name: string; email: string } }>(VIEWER_QUERY);
    return { displayName: data.viewer.name };
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(TEAMS_QUERY);
    return data.teams.nodes;
  }

  async fetchIssues(teamId: string, forceRefresh = false): Promise<LinearIssue[]> {
    if (forceRefresh) {
      this.cache.delete(teamId);
    }
    const cached = this.cache.get(teamId);
    if (cached) return cached;

    const data = await this.graphql<{ team: { issues: { nodes: RawLinearIssue[] } } }>(
      TEAM_ISSUES_QUERY,
      { teamId, first: 100 },
    );
    const issues = data.team.issues.nodes.map(mapToLinearIssue);
    this.cache.set(teamId, issues);
    return issues;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new IssueProviderError("Could not reach Linear. Check your internet connection.", "NETWORK_ERROR");
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new IssueProviderError(
          "Linear API key is invalid or has been revoked. Check Settings > Account > API in Linear.",
          "AUTH_FAILED",
        );
      }
      if (response.status === 429) {
        throw new IssueProviderError("Linear API rate limit reached. Try again in a few minutes.", "RATE_LIMITED");
      }
      throw new IssueProviderError("Could not reach Linear. Check your internet connection.", "NETWORK_ERROR");
    }

    const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new IssueProviderError(json.errors[0].message, "QUERY_ERROR");
    }
    return json.data as T;
  }

  clearCache(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.clear();
  }
}