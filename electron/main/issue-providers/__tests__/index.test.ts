// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──

vi.mock("../token-storage.ts", () => ({
  loadToken: vi.fn(),
}));

vi.mock("../../database.ts", () => ({
  getSettingValue: vi.fn(),
}));

// Use vi.hoisted so the mock instances are available to vi.mock factories
const { fakeGitHubProvider, fakeLinearProvider, fakeJiraProvider } = vi.hoisted(() => ({
  fakeGitHubProvider: {},
  fakeLinearProvider: {},
  fakeJiraProvider: {},
}));

vi.mock("../github-provider.ts", () => ({
  GitHubProvider: vi.fn(function MockGitHubProvider() {
    return fakeGitHubProvider;
  }),
}));

vi.mock("../linear-provider.ts", () => ({
  LinearProvider: vi.fn(function MockLinearProvider() {
    return fakeLinearProvider;
  }),
}));

vi.mock("../jira-provider.ts", () => ({
  JiraProvider: vi.fn(function MockJiraProvider() {
    return fakeJiraProvider;
  }),
}));

import { loadToken } from "../token-storage.ts";
import { getSettingValue } from "../../database.ts";
import { GitHubProvider } from "../github-provider.ts";
import { LinearProvider } from "../linear-provider.ts";
import { JiraProvider } from "../jira-provider.ts";
import {
  getGitHubProvider,
  getJiraProvider,
  getLinearProvider,
  getProvider,
  initJiraProviderFromDisk,
  initLinearProviderFromDisk,
  initProviderFromDisk,
  setJiraProvider,
  setLinearProvider,
  setProvider,
} from "../index.ts";

const mockedLoadToken = vi.mocked(loadToken);
const mockedGetSettingValue = vi.mocked(getSettingValue);
const MockedGitHubProvider = vi.mocked(GitHubProvider);
const MockedLinearProvider = vi.mocked(LinearProvider);
const MockedJiraProvider = vi.mocked(JiraProvider);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset singletons between tests
  setProvider(null);
  setLinearProvider(null);
  setJiraProvider(null);
});

// ── GitHub provider ──

describe("initProviderFromDisk — GitHub", () => {
  it("initialises GitHub provider when token exists", () => {
    mockedLoadToken.mockReturnValue("gh-token");

    initProviderFromDisk();

    expect(MockedGitHubProvider).toHaveBeenCalledWith("gh-token");
    expect(getProvider()).toBe(fakeGitHubProvider);
    expect(getGitHubProvider()).toBe(fakeGitHubProvider);
  });

  it("leaves provider as null when no token", () => {
    mockedLoadToken.mockReturnValue(null);

    initProviderFromDisk();

    expect(getProvider()).toBeNull();
  });
});

describe("setProvider / getProvider", () => {
  it("setProvider stores and getProvider retrieves", () => {
    setProvider(fakeGitHubProvider as ReturnType<typeof GitHubProvider>);
    expect(getProvider()).toBe(fakeGitHubProvider);
  });

  it("setProvider(null) clears the provider", () => {
    setProvider(fakeGitHubProvider as ReturnType<typeof GitHubProvider>);
    setProvider(null);
    expect(getProvider()).toBeNull();
  });
});

// ── Linear provider ──

describe("initLinearProviderFromDisk", () => {
  it("initialises Linear provider when token exists", () => {
    mockedLoadToken.mockReturnValue("linear-token");

    initLinearProviderFromDisk();

    expect(MockedLinearProvider).toHaveBeenCalledWith("linear-token");
    expect(getLinearProvider()).toBe(fakeLinearProvider);
  });

  it("leaves Linear provider as null when no token", () => {
    mockedLoadToken.mockReturnValue(null);
    initLinearProviderFromDisk();
    expect(getLinearProvider()).toBeNull();
  });
});

describe("setLinearProvider / getLinearProvider", () => {
  it("stores and retrieves Linear provider", () => {
    setLinearProvider(fakeLinearProvider as ReturnType<typeof LinearProvider>);
    expect(getLinearProvider()).toBe(fakeLinearProvider);
  });
});

// ── Jira provider ──

describe("initJiraProviderFromDisk", () => {
  it("initialises Jira provider when token, domain, and email are all set", () => {
    mockedLoadToken.mockImplementation((key) => key === "jira" ? "jira-token" : null);
    mockedGetSettingValue.mockImplementation((key) => {
      if (key === "jira_domain") return "company.atlassian.net";
      if (key === "jira_email") return "user@example.com";
      if (key === "jira_auth_type") return "cloud";
      return null;
    });

    initJiraProviderFromDisk();

    expect(MockedJiraProvider).toHaveBeenCalledWith(
      "company.atlassian.net",
      "user@example.com",
      "jira-token",
      "cloud",
    );
    expect(getJiraProvider()).toBe(fakeJiraProvider);
  });

  it("defaults authType to 'cloud' when jira_auth_type setting is not set", () => {
    mockedLoadToken.mockImplementation((key) => key === "jira" ? "jira-token" : null);
    mockedGetSettingValue.mockImplementation((key) => {
      if (key === "jira_domain") return "company.atlassian.net";
      if (key === "jira_email") return "user@example.com";
      return null;
    });

    initJiraProviderFromDisk();

    expect(MockedJiraProvider).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "cloud",
    );
  });

  it("leaves Jira provider as null when token is missing", () => {
    mockedLoadToken.mockReturnValue(null);
    mockedGetSettingValue.mockReturnValue("some-value");

    initJiraProviderFromDisk();

    expect(getJiraProvider()).toBeNull();
  });

  it("leaves Jira provider as null when domain is missing", () => {
    mockedLoadToken.mockImplementation((key) => key === "jira" ? "jira-token" : null);
    mockedGetSettingValue.mockImplementation((key) => key === "jira_email" ? "user@example.com" : null);

    initJiraProviderFromDisk();

    expect(getJiraProvider()).toBeNull();
  });
});

describe("setJiraProvider / getJiraProvider", () => {
  it("stores and retrieves Jira provider", () => {
    setJiraProvider(fakeJiraProvider as ReturnType<typeof JiraProvider>);
    expect(getJiraProvider()).toBe(fakeJiraProvider);
  });
});
