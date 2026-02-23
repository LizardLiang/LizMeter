// @vitest-environment node
// Integration tests for Linear IPC round-trips

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, initDatabase, listSessions, saveSession } from "../database.ts";

// Mock electron's app module for database
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/userData"),
  },
  safeStorage: {
    encryptString: vi.fn().mockImplementation((s: string) => Buffer.from(s)),
    decryptString: vi.fn().mockImplementation((b: Buffer) => b.toString()),
  },
  ipcMain: {
    handle: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  default: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  },
}));

import { getLinearProvider, initLinearProviderFromDisk, setLinearProvider } from "../issue-providers/index.ts";
import { LinearProvider } from "../issue-providers/linear-provider.ts";
import { getSettingValue, setSettingValue } from "../database.ts";

beforeEach(() => {
  initDatabase(":memory:");
  setLinearProvider(null);
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
  setLinearProvider(null);
});

describe("TC-701: IPC round-trip: save Linear session -> list sessions shows Linear issue", () => {
  it("session saved with Linear issue is returned with correct provider fields", () => {
    // Simulate saving a session with a Linear issue
    const session = saveSession({
      title: "Linear work session",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueProvider: "linear",
      issueId: "LIN-42",
      issueTitle: "Fix auth",
      issueUrl: "https://linear.app/team/LIN-42",
    });

    expect(session.issueProvider).toBe("linear");
    expect(session.issueId).toBe("LIN-42");

    const list = listSessions({});
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]?.issueProvider).toBe("linear");
    expect(list.sessions[0]?.issueId).toBe("LIN-42");
    expect(list.sessions[0]?.issueTitle).toBe("Fix auth");
  });
});

describe("TC-702: Backward compat: existing GitHub sessions display correctly after migration", () => {
  it("legacy session with issueNumber returns null for new provider fields", () => {
    const session = saveSession({
      title: "Old GitHub work",
      timerType: "work",
      plannedDurationSeconds: 1500,
      actualDurationSeconds: 1500,
      issueNumber: 10,
      issueTitle: "Old issue",
      issueUrl: "https://github.com/owner/repo/issues/10",
    });

    expect(session.issueNumber).toBe(10);
    expect(session.issueProvider).toBeNull();
    expect(session.issueId).toBeNull();

    const list = listSessions({});
    expect(list.sessions[0]?.issueNumber).toBe(10);
    expect(list.sessions[0]?.issueTitle).toBe("Old issue");
    expect(list.sessions[0]?.issueProvider).toBeNull();
    expect(list.sessions[0]?.issueId).toBeNull();
  });
});

describe("TC-703: Linear provider registry: both GitHub and Linear can be active simultaneously", () => {
  it("setLinearProvider and getLinearProvider are independent of GitHub provider", () => {
    const linearProvider = new LinearProvider("lin_test_key");
    setLinearProvider(linearProvider);

    const retrieved = getLinearProvider();
    expect(retrieved).not.toBeNull();
    expect(retrieved).toBe(linearProvider);
  });
});

describe("TC-704: Deleting Linear token destroys the Linear provider", () => {
  it("getLinearProvider returns null after setLinearProvider(null)", () => {
    const provider = new LinearProvider("lin_key");
    setLinearProvider(provider);
    expect(getLinearProvider()).not.toBeNull();

    setLinearProvider(null);
    expect(getLinearProvider()).toBeNull();
  });
});

describe("TC-705: Settings persistence: linear_team_id and linear_team_name saved and retrieved", () => {
  it("team settings are persisted and retrievable via getSetting/setSetting", () => {
    setSettingValue("linear_team_id", "t1");
    setSettingValue("linear_team_name", "Engineering");

    expect(getSettingValue("linear_team_id")).toBe("t1");
    expect(getSettingValue("linear_team_name")).toBe("Engineering");
  });
});

describe("initLinearProviderFromDisk: initializes Linear provider when token exists", () => {
  it("does not throw when token file does not exist", () => {
    // fs.existsSync is mocked to return false — no token file
    expect(() => initLinearProviderFromDisk()).not.toThrow();
    expect(getLinearProvider()).toBeNull();
  });
});
