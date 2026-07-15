import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueProviderStatus } from "../../../../shared/types.ts";
import { useIssues } from "../useIssues.ts";

const notConfiguredStatus: IssueProviderStatus = {
  configured: false,
  provider: null,
  linearConfigured: false,
  linearTeamSelected: false,
};

const githubConfiguredStatus: IssueProviderStatus = {
  configured: true,
  provider: "github",
  linearConfigured: false,
  linearTeamSelected: false,
};

const sampleIssues: Issue[] = [
  { number: 1, title: "Fix login bug", url: "https://github.com/repo/issues/1", state: "open", repo: "repo" },
  { number: 2, title: "Add dark mode", url: "https://github.com/repo/issues/2", state: "open", repo: "repo" },
];

const mockIssuesAPI = {
  providerStatus: vi.fn(),
  list: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", { issues: mockIssuesAPI });
  mockIssuesAPI.providerStatus.mockResolvedValue(notConfiguredStatus);
  mockIssuesAPI.list.mockResolvedValue({ issues: sampleIssues });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useIssues — provider not configured", () => {
  it("initializes with empty issues and not loading", async () => {
    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(mockIssuesAPI.providerStatus).toHaveBeenCalled());

    expect(result.current.issues).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does NOT call issues.list when provider is not configured", async () => {
    const { result } = renderHook(() => useIssues());

    await waitFor(() => {
      expect(result.current.status.configured).toBe(false);
    });

    expect(mockIssuesAPI.list).not.toHaveBeenCalled();
  });
});

describe("useIssues — provider configured", () => {
  beforeEach(() => {
    mockIssuesAPI.providerStatus.mockResolvedValue(githubConfiguredStatus);
  });

  it("fetches issues when provider is configured", async () => {
    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.issues).toEqual(sampleIssues));

    expect(mockIssuesAPI.list).toHaveBeenCalledOnce();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("calls list with forceRefresh: false on first load", async () => {
    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.issues.length).toBeGreaterThan(0));

    const callArg = mockIssuesAPI.list.mock.calls[0]![0];
    expect(callArg.forceRefresh).toBe(false);
  });

  it("passes input filters to list()", async () => {
    const { result } = renderHook(() => useIssues({ query: "bug" }));

    await waitFor(() => expect(result.current.issues.length).toBeGreaterThan(0));

    const callArg = mockIssuesAPI.list.mock.calls[0]![0];
    expect(callArg.query).toBe("bug");
  });

  it("shows error when list() rejects", async () => {
    mockIssuesAPI.list.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.error).toBe("Network error"));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.issues).toEqual([]);
  });

  it("sets generic error for non-Error rejection", async () => {
    mockIssuesAPI.list.mockRejectedValueOnce("plain string");

    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.error).toBe("Failed to fetch issues"));
  });
});

describe("useIssues — refresh()", () => {
  beforeEach(() => {
    mockIssuesAPI.providerStatus.mockResolvedValue(githubConfiguredStatus);
  });

  it("calling refresh() re-fetches issues with forceRefresh: true", async () => {
    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.issues.length).toBeGreaterThan(0));
    expect(mockIssuesAPI.list).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refresh();
    });

    await waitFor(() => expect(mockIssuesAPI.list).toHaveBeenCalledTimes(2));

    const secondCallArg = mockIssuesAPI.list.mock.calls[1]![0];
    expect(secondCallArg.forceRefresh).toBe(true);
  });
});

describe("useIssues — status shape", () => {
  it("exposes the full provider status object", async () => {
    mockIssuesAPI.providerStatus.mockResolvedValue(githubConfiguredStatus);

    const { result } = renderHook(() => useIssues());

    await waitFor(() => expect(result.current.status.configured).toBe(true));

    expect(result.current.status.provider).toBe("github");
  });
});
