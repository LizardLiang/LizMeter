// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock electron module before any imports
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/userData"),
  },
  safeStorage: {
    encryptString: vi.fn().mockImplementation((str: string) => Buffer.from(str)),
    decryptString: vi.fn().mockImplementation((buf: Buffer) => buf.toString()),
  },
}));

// Mock fs module
vi.mock("node:fs", () => ({
  default: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

import fs from "node:fs";
import { deleteToken, hasToken, loadToken, saveToken } from "../token-storage.ts";

const mockFs = fs as unknown as {
  writeFileSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  unlinkSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TC-121: saveToken('github') writes to .github-token file", () => {
  it("backward-compatible call (no provider arg) writes to .github-token", () => {
    saveToken("gh_token_123");
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const [path] = mockFs.writeFileSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.github-token$/);
  });

  it("explicit 'github' provider writes to .github-token", () => {
    saveToken("gh_token_123", "github");
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const [path] = mockFs.writeFileSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.github-token$/);
  });
});

describe("TC-122: saveToken('linear') writes to .linear-token file", () => {
  it("writes to .linear-token and NOT .github-token", () => {
    saveToken("lin_api_key", "linear");
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const [path] = mockFs.writeFileSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.linear-token$/);
    expect(String(path)).not.toMatch(/\.github-token$/);
  });
});

describe("TC-123: loadToken('linear') returns decrypted token when file exists", () => {
  it("reads and decrypts .linear-token", () => {
    mockFs.readFileSync.mockReturnValue(Buffer.from("lin_api_key_decrypted"));
    const result = loadToken("linear");
    expect(result).toBe("lin_api_key_decrypted");
    const [path] = mockFs.readFileSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.linear-token$/);
  });
});

describe("TC-124: loadToken('linear') returns null when .linear-token does not exist", () => {
  it("returns null without throwing when file is missing", () => {
    mockFs.readFileSync.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const result = loadToken("linear");
    expect(result).toBeNull();
  });
});

describe("TC-125: deleteToken('linear') removes .linear-token file", () => {
  it("calls unlinkSync with path ending in .linear-token", () => {
    deleteToken("linear");
    expect(mockFs.unlinkSync).toHaveBeenCalledOnce();
    const [path] = mockFs.unlinkSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.linear-token$/);
    expect(String(path)).not.toMatch(/\.github-token$/);
  });
});

describe("TC-126: deleteToken('linear') is a no-op if .linear-token does not exist", () => {
  it("does not throw if file is missing", () => {
    mockFs.unlinkSync.mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => deleteToken("linear")).not.toThrow();
  });
});

describe("TC-127: hasToken('linear') returns true when .linear-token exists", () => {
  it("checks .linear-token path", () => {
    mockFs.existsSync.mockReturnValue(true);
    const result = hasToken("linear");
    expect(result).toBe(true);
    const [path] = mockFs.existsSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.linear-token$/);
  });
});

describe("TC-128: hasToken with no argument checks .github-token", () => {
  it("defaults to github provider", () => {
    mockFs.existsSync.mockReturnValue(false);
    hasToken();
    const [path] = mockFs.existsSync.mock.calls[0]!;
    expect(String(path)).toMatch(/\.github-token$/);
  });
});
