// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearProvider } from "../linear-provider.ts";
import { IssueProviderError } from "../types.ts";

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

const mockViewerResponse = {
  data: { viewer: { id: "user-1", name: "Jane Dev", email: "jane@example.com" } },
};

const mockTeamsResponse = {
  data: {
    teams: {
      nodes: [
        { id: "t1", name: "Engineering", key: "ENG" },
        { id: "t2", name: "Design", key: "DES" },
      ],
    },
  },
};

const mockIssue1 = {
  id: "issue-uuid-1",
  identifier: "ENG-42",
  title: "Fix authentication timeout on mobile",
  url: "https://linear.app/team/issue/ENG-42",
  priority: 2,
  state: { name: "In Progress", type: "started" },
  updatedAt: "2026-02-23T10:00:00.000Z",
};

const mockIssue2 = {
  id: "issue-uuid-2",
  identifier: "ENG-43",
  title: "Update onboarding flow",
  url: "https://linear.app/team/issue/ENG-43",
  priority: 3,
  state: { name: "Todo", type: "unstarted" },
  updatedAt: "2026-02-23T09:00:00.000Z",
};

const mockTeamIssuesResponse = {
  data: {
    team: {
      issues: { nodes: [mockIssue1, mockIssue2] },
    },
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TC-101: LinearProvider constructor stores API key", () => {
  it("uses API key in Authorization header (no Bearer prefix)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockViewerResponse));
    const provider = new LinearProvider("lin_api_test_key");
    await provider.testConnection();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, options] = fetchSpy.mock.calls[0]!;
    const headers = options?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("lin_api_test_key");
    expect(headers["Authorization"]).not.toMatch(/^Bearer /);
    expect(headers["Content-Type"]).toBe("application/json");
  });
});

describe("TC-102: LinearProvider.testConnection returns displayName on success", () => {
  it("returns { displayName: 'Jane Dev' }", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockViewerResponse));
    const provider = new LinearProvider("valid_key");
    const result = await provider.testConnection();
    expect(result).toEqual({ displayName: "Jane Dev" });
  });
});

describe("TC-103: LinearProvider.testConnection throws AUTH_FAILED on 401", () => {
  it("throws IssueProviderError with code AUTH_FAILED", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(401));
    const provider = new LinearProvider("bad_key");
    await expect(provider.testConnection()).rejects.toThrow(IssueProviderError);
    await expect(provider.testConnection()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(provider.testConnection()).rejects.toThrow(/invalid|revoked/i);
  });
});

describe("TC-104: LinearProvider.testConnection throws RATE_LIMITED on 429", () => {
  it("throws IssueProviderError with code RATE_LIMITED", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(429));
    const provider = new LinearProvider("valid_key");
    await expect(provider.testConnection()).rejects.toThrow(IssueProviderError);
    await expect(provider.testConnection()).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(provider.testConnection()).rejects.toThrow(/rate limit/i);
  });
});

describe("TC-105: LinearProvider.testConnection throws QUERY_ERROR on GraphQL error array", () => {
  it("throws IssueProviderError when errors array is non-empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ errors: [{ message: "Unauthorized" }] }),
    );
    const provider = new LinearProvider("key");
    await expect(provider.testConnection()).rejects.toThrow(IssueProviderError);
    await expect(provider.testConnection()).rejects.toMatchObject({ code: "QUERY_ERROR" });
  });

  it("does NOT throw when errors array is empty (data present)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ data: mockViewerResponse.data, errors: [] }),
    );
    const provider = new LinearProvider("key");
    await expect(provider.testConnection()).resolves.toEqual({ displayName: "Jane Dev" });
  });
});

describe("TC-106: LinearProvider.listTeams returns team array", () => {
  it("maps response nodes to LinearTeam[]", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamsResponse));
    const provider = new LinearProvider("key");
    const teams = await provider.listTeams();
    expect(teams).toHaveLength(2);
    expect(teams[0]).toEqual({ id: "t1", name: "Engineering", key: "ENG" });
    expect(teams[1]).toEqual({ id: "t2", name: "Design", key: "DES" });
  });
});

describe("TC-107: LinearProvider.listTeams returns empty array when workspace has no teams", () => {
  it("returns [] without throwing", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ data: { teams: { nodes: [] } } }),
    );
    const provider = new LinearProvider("key");
    const teams = await provider.listTeams();
    expect(teams).toEqual([]);
  });
});

describe("TC-108: LinearProvider.fetchIssues returns mapped issues for a team", () => {
  it("returns mapped LinearIssue[] with all required fields", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const provider = new LinearProvider("key");
    const issues = await provider.fetchIssues("team-id-1");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      id: "issue-uuid-1",
      identifier: "ENG-42",
      title: "Fix authentication timeout on mobile",
      url: "https://linear.app/team/issue/ENG-42",
      priority: 2,
      state: { name: "In Progress", type: "started" },
      updatedAt: "2026-02-23T10:00:00.000Z",
    });
  });

  it("sends teamId in the GraphQL variables", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const provider = new LinearProvider("key");
    await provider.fetchIssues("team-id-1");
    const [, options] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(options?.body as string) as { variables: { teamId: string } };
    expect(body.variables.teamId).toBe("team-id-1");
  });
});

describe("TC-109: LinearProvider.fetchIssues uses cache on second call", () => {
  it("fetch is called exactly once for two identical calls", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const provider = new LinearProvider("key");
    const first = await provider.fetchIssues("team-id-1");
    const second = await provider.fetchIssues("team-id-1");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(first).toBe(second); // same reference from cache
  });
});

describe("TC-110: LinearProvider.fetchIssues bypasses cache on forceRefresh", () => {
  it("fetch is called twice when forceRefresh=true", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const provider = new LinearProvider("key");
    await provider.fetchIssues("team-id-1"); // first call — populates cache
    await provider.fetchIssues("team-id-1", true); // second call — force refresh
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("TC-111: LinearProvider.fetchIssues throws NETWORK_ERROR on network failure", () => {
  it("wraps fetch TypeError as NETWORK_ERROR", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const provider = new LinearProvider("key");
    await expect(provider.fetchIssues("team-id-1")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});

describe("TC-112: LinearProvider.clearCache removes all cached data", () => {
  it("forces a new fetch after clearCache()", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const provider = new LinearProvider("key");
    await provider.fetchIssues("team-id-1");
    provider.clearCache();
    await provider.fetchIssues("team-id-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("TC-113: LinearProvider.destroy clears cache", () => {
  it("forces a new fetch after destroy()", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const provider = new LinearProvider("key");
    await provider.fetchIssues("team-id-1");
    provider.destroy();
    await provider.fetchIssues("team-id-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("TC-114: LinearProvider never exposes API key via return value", () => {
  it("API key does not appear in any return values", async () => {
    const SECRET_KEY = "secret_key_do_not_expose";
    vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockViewerResponse));
    const provider = new LinearProvider(SECRET_KEY);

    const connectionResult = await provider.testConnection();
    expect(JSON.stringify(connectionResult)).not.toContain(SECRET_KEY);

    vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamsResponse));
    const teamsResult = await provider.listTeams();
    expect(JSON.stringify(teamsResult)).not.toContain(SECRET_KEY);

    vi.spyOn(global, "fetch").mockResolvedValue(makeOkResponse(mockTeamIssuesResponse));
    const issuesResult = await provider.fetchIssues("t1");
    expect(JSON.stringify(issuesResult)).not.toContain(SECRET_KEY);
  });
});
