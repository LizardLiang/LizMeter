// electron/main/issue-providers/index.ts
// Provider manager: multi-provider registry supporting GitHub and Linear simultaneously

import { loadToken } from "./token-storage.ts";
import { GitHubProvider } from "./github-provider.ts";
import { JiraProvider } from "./jira-provider.ts";
import { LinearProvider } from "./linear-provider.ts";
import type { IssueProvider } from "./types.ts";
import { getSettingValue } from "../database.ts";

// GitHub provider (singleton, implements IssueProvider interface)
let githubProvider: IssueProvider | null = null;

// Linear provider (standalone class, not constrained by IssueProvider interface)
let linearProvider: LinearProvider | null = null;

// --- GitHub provider functions ---

export function initProviderFromDisk(): void {
  const token = loadToken("github");
  if (token) {
    githubProvider = new GitHubProvider(token);
  }
}

export function getProvider(): IssueProvider | null {
  return githubProvider;
}

export function setProvider(provider: IssueProvider | null): void {
  githubProvider = provider;
}

export function getGitHubProvider(): IssueProvider | null {
  return githubProvider;
}

// --- Linear provider functions ---

export function initLinearProviderFromDisk(): void {
  const token = loadToken("linear");
  if (token) {
    linearProvider = new LinearProvider(token);
  }
}

export function getLinearProvider(): LinearProvider | null {
  return linearProvider;
}

export function setLinearProvider(provider: LinearProvider | null): void {
  linearProvider = provider;
}

// --- Jira provider functions ---

let jiraProvider: JiraProvider | null = null;

export function initJiraProviderFromDisk(): void {
  const token = loadToken("jira");
  const domain = getSettingValue("jira_domain");
  const email = getSettingValue("jira_email");
  if (token && domain && email) {
    jiraProvider = new JiraProvider(domain, email, token);
  }
}

export function getJiraProvider(): JiraProvider | null {
  return jiraProvider;
}

export function setJiraProvider(provider: JiraProvider | null): void {
  jiraProvider = provider;
}