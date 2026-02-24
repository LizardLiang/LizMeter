// electron/main/issue-providers/types.ts
// Provider abstraction for issue tracker integrations (GitHub, future: Linear)

import type { Issue, IssuesListInput } from "../../../src/shared/types.ts";

export interface IssueProvider {
  readonly providerName: string; // "github"
  listIssues(input: IssuesListInput): Promise<Issue[]>;
  testConnection(): Promise<{ username: string }>;
  clearCache(): void;
  destroy(): void;
}

export class IssueProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NO_TOKEN"
      | "AUTH_FAILED"
      | "NETWORK_ERROR"
      | "RATE_LIMITED"
      | "QUERY_ERROR"
      | "NOT_FOUND"
      | "INELIGIBLE",
  ) {
    super(message);
    this.name = "IssueProviderError";
  }
}
