// useLinearIssues hook tests
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearIssue } from "../../../../../shared/types.ts";
import { useLinearIssues } from "../useLinearIssues.ts";

const mockLinearIssue: LinearIssue = {
  id: "issue-uuid-1",
  identifier: "ENG-42",
  title: "Fix authentication timeout on mobile",
  url: "https://linear.app/team/issue/ENG-42",
  priority: 2,
  state: { name: "In Progress", type: "started" },
  updatedAt: "2026-02-23T10:00:00.000Z",
};

const mockLinearIssue2: LinearIssue = {
  id: "issue-uuid-2",
  identifier: "ENG-43",
  title: "Update onboarding flow",
  url: "https://linear.app/team/issue/ENG-43",
  priority: 3,
  state: { name: "Todo", type: "unstarted" },
  updatedAt: "2026-02-23T09:00:00.000Z",
};

const mockLinearIssue3: LinearIssue = {
  id: "issue-uuid-3",
  identifier: "ENG-44",
  title: "Fix payment gateway",
  url: "https://linear.app/team/issue/ENG-44",
  priority: 1,
  state: { name: "In Progress", type: "started" },
  updatedAt: "2026-02-23T08:00:00.000Z",
};

const mockElectronAPI = {
  linear: {
    fetchIssues: vi.fn(),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TC-201: useLinearIssues shows loading state initially", () => {
  it("starts in loading state before IPC resolves", () => {
    mockElectronAPI.linear.fetchIssues.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useLinearIssues());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.issues).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe("TC-202: useLinearIssues populates issues on success", () => {
  it("issues are populated after fetchIssues resolves", async () => {
    mockElectronAPI.linear.fetchIssues.mockResolvedValue([mockLinearIssue, mockLinearIssue2, mockLinearIssue3]);
    const { result } = renderHook(() => useLinearIssues());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.issues).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });
});

describe("TC-203: useLinearIssues sets error on IPC failure", () => {
  it("sets error when fetchIssues rejects", async () => {
    mockElectronAPI.linear.fetchIssues.mockRejectedValue(new Error("AUTH_FAILED"));
    const { result } = renderHook(() => useLinearIssues());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeTruthy();
    expect(result.current.issues).toEqual([]);
  });
});

describe("TC-204: useLinearIssues calls fetchIssues with forceRefresh when refresh is triggered", () => {
  it("second call includes forceRefresh: true", async () => {
    mockElectronAPI.linear.fetchIssues.mockResolvedValue([mockLinearIssue]);
    const { result } = renderHook(() => useLinearIssues());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.refresh());
    await waitFor(() => {
      expect(mockElectronAPI.linear.fetchIssues).toHaveBeenCalledTimes(2);
    });

    const secondCallArg = mockElectronAPI.linear.fetchIssues.mock.calls[1]?.[0] as { forceRefresh: boolean; };
    expect(secondCallArg?.forceRefresh).toBe(true);
  });
});
