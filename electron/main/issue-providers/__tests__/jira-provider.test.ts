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
