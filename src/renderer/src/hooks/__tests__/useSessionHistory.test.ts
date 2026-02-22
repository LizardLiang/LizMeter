import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../../shared/types.ts";
import { useSessionHistory } from "../useSessionHistory.ts";

const mockSession: Session = {
  id: "mock-id",
  title: "Test session",
  timerType: "work",
  plannedDurationSeconds: 1500,
  actualDurationSeconds: 1498,
  completedAt: "2026-02-19T10:00:00.000Z",
  tags: [],
  issueNumber: null,
  issueTitle: null,
  issueUrl: null,
};

const mockElectronAPI = {
  platform: "linux",
  session: {
    save: vi.fn().mockResolvedValue(mockSession),
    list: vi.fn().mockResolvedValue({ sessions: [mockSession], total: 1 }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue({ workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  issues: {
    list: vi.fn().mockResolvedValue({ issues: [] }),
    providerStatus: vi.fn().mockResolvedValue({ configured: false, provider: null }),
    setToken: vi.fn().mockResolvedValue(undefined),
    deleteToken: vi.fn().mockResolvedValue(undefined),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
  mockElectronAPI.session.list.mockResolvedValue({ sessions: [mockSession], total: 1 });
  mockElectronAPI.session.delete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TC-402: useSessionHistory fetches sessions on mount", () => {
  it("loads sessions and exposes them", async () => {
    const { result } = renderHook(() => useSessionHistory());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.sessions.length).toBe(1);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toBeNull();
  });
});

describe("TC-403: useSessionHistory deleteSession calls IPC and refreshes", () => {
  it("deletes session and refreshes list", async () => {
    // After delete, the list returns empty
    mockElectronAPI.session.list
      .mockResolvedValueOnce({ sessions: [mockSession], total: 1 })
      .mockResolvedValueOnce({ sessions: [], total: 0 });

    const { result } = renderHook(() => useSessionHistory());
    await waitFor(() => expect(result.current.sessions.length).toBe(1));

    act(() => {
      result.current.deleteSession("mock-id");
    });

    await waitFor(() => expect(result.current.sessions.length).toBe(0));

    expect(mockElectronAPI.session.delete).toHaveBeenCalledWith("mock-id");
    expect(mockElectronAPI.session.list).toHaveBeenCalledTimes(2);
  });
});

describe("TC-405: useSessionHistory handles IPC error gracefully", () => {
  it("sets error state and does not reject", async () => {
    mockElectronAPI.session.list.mockRejectedValueOnce(new Error("DB read failed"));

    const { result } = renderHook(() => useSessionHistory());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeTruthy();
    expect(result.current.sessions).toEqual([]);
  });
});
