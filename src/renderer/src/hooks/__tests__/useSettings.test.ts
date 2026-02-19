import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "../useSettings.ts";

const mockElectronAPI = {
  platform: "linux",
  session: {
    save: vi.fn(),
    list: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue({ workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 }),
    save: vi.fn().mockResolvedValue(undefined),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
  mockElectronAPI.settings.get.mockResolvedValue({
    workDuration: 1500,
    shortBreakDuration: 300,
    longBreakDuration: 900,
  });
  mockElectronAPI.settings.save.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TC-401: useSettings loads settings on mount", () => {
  it("fetches settings and exposes them", async () => {
    const { result } = renderHook(() => useSettings());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockElectronAPI.settings.get).toHaveBeenCalledOnce();
    expect(result.current.settings?.workDuration).toBe(1500);
    expect(result.current.settings?.shortBreakDuration).toBe(300);
    expect(result.current.settings?.longBreakDuration).toBe(900);
  });
});

describe("TC-404: useSettings saveSettings calls IPC", () => {
  it("calls settings.save with the provided settings", async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.saveSettings({
        workDuration: 1800,
        shortBreakDuration: 600,
        longBreakDuration: 1200,
      });
    });

    expect(mockElectronAPI.settings.save).toHaveBeenCalledWith({
      workDuration: 1800,
      shortBreakDuration: 600,
      longBreakDuration: 1200,
    });
  });
});
