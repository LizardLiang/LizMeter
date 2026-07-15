// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraProvider } from "../jira-provider.ts";
import { IssueProviderError } from "../types.ts";

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    statusText: "OK",
  } as unknown as Response;
}

function makeErrorResponse(status: number, statusText = "Error"): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({ errorMessages: [] }),
  } as unknown as Response;
}

function makeCloudProvider(): JiraProvider {
  return new JiraProvider("mycompany.atlassian.net", "user@example.com", "api-token-123", "cloud");
}

function makeServerProvider(): JiraProvider {
  return new JiraProvider("jira.mycompany.com", "jirauser", "password123", "server");
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- GET request regression tests ---

describe("TC-560: request() still works correctly for GET requests", () => {
  it("testConnection GET request succeeds without body", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ displayName: "John Doe" }),
    );
    const provider = makeCloudProvider();
    const result = await provider.testConnection();
    expect(result).toEqual({ displayName: "John Doe" });
    const [, options] = fetchSpy.mock.calls[0]!;
    // After refactoring, method defaults to "GET" explicitly
    expect(options?.method).toBe("GET");
    expect(options?.body).toBeUndefined();
  });
});

// --- addWorklog Cloud v3 ---

describe("TC-561: addWorklog sends correct body for Cloud v3 (ADF comment)", () => {
  it("sends ADF-formatted comment for Cloud provider", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ id: "10042", timeSpentSeconds: 1500, started: "2026-02-24T10:00:00.000+0000" }),
    );
    const provider = makeCloudProvider();
    await provider.addWorklog("PROJ-123", 1500, "2026-02-24T10:30:00.000Z", "LizMeter: Fix login bug");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/rest/api/3/issue/PROJ-123/worklog");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string) as {
      timeSpentSeconds: number;
      started: string;
      comment: { type: string; version: number; content: unknown[] };
    };
    expect(body.timeSpentSeconds).toBe(1500);
    expect(body.started).toMatch(/\+0000$/);
    expect(body.comment).toMatchObject({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "LizMeter: Fix login bug" }],
        },
      ],
    });
  });
});

// --- addWorklog Server v2 ---

describe("TC-562: addWorklog sends correct body for Server v2 (plain string comment)", () => {
  it("sends plain string comment for Server provider", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ id: "20001", timeSpentSeconds: 3600, started: "2026-02-24T09:00:00.000+0000" }),
    );
    const provider = makeServerProvider();
    await provider.addWorklog("ENG-42", 3600, "2026-02-24T10:00:00.000Z", "Logged via LizMeter");

    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/rest/api/2/issue/ENG-42/worklog");
    expect(options?.method).toBe("POST");

    const body = JSON.parse(options?.body as string) as {
      timeSpentSeconds: number;
      started: string;
      comment: string;
    };
    expect(body.comment).toBe("Logged via LizMeter");
    expect(typeof body.comment).toBe("string");
  });
});

// --- addWorklog started timestamp ---

describe("TC-563: addWorklog includes started timestamp in correct format", () => {
  it("converts ISO 8601 to Jira format (replaces Z with +0000)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ id: "10042" }),
    );
    const provider = makeCloudProvider();
    await provider.addWorklog("PROJ-1", 600, "2026-02-24T08:00:00.000Z", "test");

    const [, options] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(options?.body as string) as { started: string };
    expect(body.started).toBe("2026-02-24T08:00:00.000+0000");
  });
});

// --- addWorklog return value ---

describe("TC-564: addWorklog returns worklog ID from response", () => {
  it("returns { id: string } from Jira response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ id: 10042, timeSpentSeconds: 1500 }),
    );
    const provider = makeCloudProvider();
    const result = await provider.addWorklog("PROJ-1", 1500, "2026-02-24T10:00:00.000Z", "test");
    expect(result).toEqual({ id: "10042" });
    expect(typeof result.id).toBe("string");
  });
});

// --- addWorklog error handling ---

describe("TC-565: addWorklog throws IssueProviderError on 404", () => {
  it("throws NOT_FOUND error when Jira returns 404", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(404, "Not Found"));
    const provider = makeCloudProvider();
    await expect(provider.addWorklog("PROJ-999", 1500, "2026-02-24T10:00:00.000Z", "test")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("TC-566: addWorklog throws AUTH_FAILED on 401", () => {
  it("throws AUTH_FAILED when credentials are wrong", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(401, "Unauthorized"));
    const provider = makeCloudProvider();
    await expect(provider.addWorklog("PROJ-1", 1500, "2026-02-24T10:00:00.000Z", "test")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });
});

describe("TC-567: addWorklog throws NETWORK_ERROR on network failure", () => {
  it("throws NETWORK_ERROR when fetch rejects", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const provider = makeCloudProvider();
    await expect(provider.addWorklog("PROJ-1", 1500, "2026-02-24T10:00:00.000Z", "test")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });
});

describe("TC-568: addWorklog throws RATE_LIMITED on 429", () => {
  it("throws RATE_LIMITED on 429 response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(429, "Too Many Requests"));
    const provider = makeCloudProvider();
    await expect(provider.addWorklog("PROJ-1", 1500, "2026-02-24T10:00:00.000Z", "test")).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("TC-569: IssueProviderError includes NOT_FOUND and INELIGIBLE codes", () => {
  it("NOT_FOUND and INELIGIBLE are valid error codes", () => {
    expect(() => new IssueProviderError("Not found", "NOT_FOUND")).not.toThrow();
    expect(() => new IssueProviderError("Ineligible", "INELIGIBLE")).not.toThrow();
  });
});

// --- fetchIssues ---

describe("TC-570: fetchIssues returns mapped issues", () => {
  it("fetches and maps Jira issues from search API", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({
        issues: [
          {
            id: "10001",
            key: "PROJ-1",
            fields: {
              summary: "Fix login bug",
              status: { name: "In Progress" },
              priority: { name: "High" },
              assignee: { displayName: "Alice" },
              issuetype: { name: "Bug" },
              labels: ["backend"],
            },
          },
        ],
      }),
    );
    const provider = makeCloudProvider();
    const issues = await provider.fetchIssues(null, null);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.key).toBe("PROJ-1");
    expect(issues[0]!.title).toBe("Fix login bug");
    expect(issues[0]!.status).toBe("In Progress");
    expect(issues[0]!.priority).toBe("High");
    expect(issues[0]!.assignee).toBe("Alice");
    expect(issues[0]!.labels).toEqual(["backend"]);
  });

  it("uses projectKey JQL when provided", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ issues: [] }),
    );
    const provider = makeCloudProvider();
    await provider.fetchIssues("PROJ", null);

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("project");
  });

  it("uses jqlFilter when provided", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ issues: [] }),
    );
    const provider = makeCloudProvider();
    await provider.fetchIssues(null, "assignee = currentUser()");

    const [url] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("assignee");
  });

  it("caches results on second call", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ issues: [] }),
    );
    const provider = makeCloudProvider();
    await provider.fetchIssues(null, null);
    await provider.fetchIssues(null, null);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forceRefresh bypasses cache", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ issues: [] }),
    );
    const provider = makeCloudProvider();
    await provider.fetchIssues(null, null);
    await provider.fetchIssues(null, null, true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("handles null fields gracefully (priority, assignee, issuetype)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({
        issues: [{
          id: "10002",
          key: "PROJ-2",
          fields: {
            summary: "No optional fields",
            status: { name: "Open" },
            priority: null,
            assignee: null,
            issuetype: null,
            labels: [],
          },
        }],
      }),
    );
    const provider = makeCloudProvider();
    const issues = await provider.fetchIssues(null, null);
    expect(issues[0]!.priority).toBeNull();
    expect(issues[0]!.assignee).toBeNull();
    expect(issues[0]!.issueType).toBeNull();
  });
});

describe("TC-571: fetchIssues error handling — 400 with errorMessages", () => {
  it("throws QUERY_ERROR with first errorMessages entry on 400", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.resolve({ errorMessages: ["Invalid JQL: unknown field"] }),
    } as unknown as Response);

    const provider = makeCloudProvider();
    await expect(provider.fetchIssues(null, "bad jql")).rejects.toMatchObject({
      code: "QUERY_ERROR",
      message: "Invalid JQL: unknown field",
    });
  });

  it("throws AUTH_FAILED with server-specific message on 401 for server provider", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(401, "Unauthorized"));
    const provider = makeServerProvider();
    const err = await provider.fetchIssues(null, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IssueProviderError);
    expect((err as IssueProviderError).message).toContain("username and password");
  });

  it("throws AUTH_FAILED on 403", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(makeErrorResponse(403, "Forbidden"));
    const provider = makeCloudProvider();
    await expect(provider.fetchIssues(null, null)).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});

// --- fetchComments ---

describe("TC-572: fetchComments returns mapped comments", () => {
  it("returns comments with author, body, and createdAt", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({
        comments: [
          {
            id: "comment-1",
            author: { displayName: "Bob" },
            body: "Looks good to me!",
            created: "2026-03-01T09:00:00.000Z",
          },
        ],
      }),
    );
    const provider = makeCloudProvider();
    const comments = await provider.fetchComments("PROJ-42");

    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe("comment-1");
    expect(comments[0]!.author).toBe("Bob");
    expect(comments[0]!.body).toBe("Looks good to me!");
  });

  it("extracts ADF body from Cloud v3 comment", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({
        comments: [
          {
            id: "c2",
            author: { displayName: "Alice" },
            body: {
              type: "doc",
              version: 1,
              content: [
                { type: "paragraph", content: [{ type: "text", text: "ADF content" }] },
              ],
            },
            created: "2026-03-01T10:00:00.000Z",
          },
        ],
      }),
    );
    const provider = makeCloudProvider();
    const comments = await provider.fetchComments("PROJ-1");
    expect(comments[0]!.body).toBe("ADF content");
  });

  it("handles missing author gracefully", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({
        comments: [{ id: "c3", body: "text", created: "2026-01-01T00:00:00.000Z" }],
      }),
    );
    const provider = makeCloudProvider();
    const comments = await provider.fetchComments("PROJ-1");
    expect(comments[0]!.author).toBe("Unknown");
  });
});

// --- clearCache / destroy ---

describe("TC-573: clearCache and destroy", () => {
  it("clearCache forces a fresh fetch on next fetchIssues", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ issues: [] }),
    );
    const provider = makeCloudProvider();
    await provider.fetchIssues(null, null);
    provider.clearCache();
    await provider.fetchIssues(null, null);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("destroy clears cache", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      makeOkResponse({ issues: [] }),
    );
    const provider = makeCloudProvider();
    await provider.fetchIssues(null, null);
    provider.destroy();
    await provider.fetchIssues(null, null);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
