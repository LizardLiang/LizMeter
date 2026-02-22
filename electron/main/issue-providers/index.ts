// electron/main/issue-providers/index.ts
// Provider manager: singleton instance lifecycle

import { loadToken } from "./token-storage.ts";
import { GitHubProvider } from "./github-provider.ts";
import type { IssueProvider } from "./types.ts";

let currentProvider: IssueProvider | null = null;

export function initProviderFromDisk(): void {
  const token = loadToken();
  if (token) {
    currentProvider = new GitHubProvider(token);
  }
}

export function getProvider(): IssueProvider | null {
  return currentProvider;
}

export function setProvider(provider: IssueProvider | null): void {
  currentProvider = provider;
}
