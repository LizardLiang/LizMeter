import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const mockElectronAPI = {
  platform: "linux",
  session: {
    save: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue({
      workDuration: 1500,
      shortBreakDuration: 300,
      longBreakDuration: 900,
    }),
    save: vi.fn().mockResolvedValue(undefined),
  },
  tag: {
    create: vi.fn().mockResolvedValue({ id: 1, name: "test", color: "#7aa2f7", createdAt: "" }),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: 1, name: "test", color: "#7aa2f7", createdAt: "" }),
    delete: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    unassign: vi.fn().mockResolvedValue(undefined),
    listForSession: vi.fn().mockResolvedValue([]),
  },
  window: {
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
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
});

test("renders the timer UI after settings load", async () => {
  render(<App />);
  // App renders "Loading..." first while settings load, then TomatoClock with timer UI
  await waitFor(() => expect(screen.getByText("Timer")).toBeInTheDocument());
});
