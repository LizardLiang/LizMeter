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
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
});

test("renders the Tomato Clock heading", async () => {
  render(<App />);
  // App renders "Loading..." first while settings load, then TomatoClock
  await waitFor(() => expect(screen.getByText("Tomato Clock")).toBeInTheDocument());
});
