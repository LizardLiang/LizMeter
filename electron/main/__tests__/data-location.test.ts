// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mutable so each test can point Electron's userData at a fresh temp folder. */
const mockPaths = { userData: "" };

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return mockPaths.userData;
      throw new Error(`unexpected app.getPath(${name})`);
    },
  },
}));

import {
  ATTACHMENTS_DIR_NAME,
  backupExistingPrivateDbBeforeAdopt,
  clearCustomDataDir,
  DB_FILE_NAME,
  getDataDir,
  getDataDirStatus,
  getDbDir,
  hasPrivateDb,
  invalidateDataDirCache,
  markDeviceAsAdopted,
  markPrivateDb,
  moveDataTo,
  relocateDbToPrivateStorage,
} from "../data-location.ts";

const POINTER_FILE = "data-location.json";

let root: string;
let userData: string;

/** Writes a database file and one attachment blob so a move has something real to carry. */
function seedData(dir: string, dbContents = "db-bytes"): void {
  fs.mkdirSync(path.join(dir, ATTACHMENTS_DIR_NAME), { recursive: true });
  fs.writeFileSync(path.join(dir, DB_FILE_NAME), dbContents);
  fs.writeFileSync(path.join(dir, ATTACHMENTS_DIR_NAME, "abc123.png"), "blob-bytes");
}

function pointerPath(): string {
  return path.join(userData, POINTER_FILE);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-data-loc-"));
  userData = path.join(root, "userData");
  fs.mkdirSync(userData, { recursive: true });
  mockPaths.userData = userData;
  invalidateDataDirCache();
});

afterEach(() => {
  invalidateDataDirCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("getDataDir / getDataDirStatus", () => {
  it("uses Electron's userData folder when the user never moved the data", () => {
    expect(getDataDir()).toBe(userData);
    expect(getDataDirStatus()).toEqual({
      dataDir: userData,
      defaultDataDir: userData,
      isCustom: false,
      available: true,
    });
  });

  it("uses the folder named by the pointer file", () => {
    const custom = path.join(root, "custom");
    fs.mkdirSync(custom);
    fs.writeFileSync(pointerPath(), JSON.stringify({ dataDir: custom }));

    const status = getDataDirStatus();
    expect(status.dataDir).toBe(custom);
    expect(status.isCustom).toBe(true);
    expect(status.available).toBe(true);
  });

  it("falls back to the default folder when the pointer file is unreadable", () => {
    fs.writeFileSync(pointerPath(), "{ not json");
    expect(getDataDir()).toBe(userData);
  });

  it("falls back to the default folder when the pointer holds no usable path", () => {
    fs.writeFileSync(pointerPath(), JSON.stringify({ dataDir: "   " }));
    expect(getDataDir()).toBe(userData);
  });

  it("keeps naming a missing custom folder rather than silently reverting to the default", () => {
    // Reverting here would open an empty database and read as total data loss, so the missing
    // folder has to stay visible for the startup guard to act on.
    const gone = path.join(root, "unplugged-drive");
    fs.writeFileSync(pointerPath(), JSON.stringify({ dataDir: gone }));

    const status = getDataDirStatus();
    expect(status.dataDir).toBe(gone);
    expect(status.isCustom).toBe(true);
    expect(status.available).toBe(false);
  });
});

describe("moveDataTo", () => {
  it("copies the database and attachments, then records the new folder", () => {
    seedData(userData);
    const target = path.join(root, "elsewhere");

    const result = moveDataTo(target);

    expect(result).toEqual({ ok: true, dataDir: target });
    expect(fs.readFileSync(path.join(target, DB_FILE_NAME), "utf8")).toBe("db-bytes");
    expect(fs.readFileSync(path.join(target, ATTACHMENTS_DIR_NAME, "abc123.png"), "utf8"))
      .toBe("blob-bytes");
    expect(JSON.parse(fs.readFileSync(pointerPath(), "utf8"))).toEqual({ dataDir: target });
    expect(getDataDir()).toBe(target);
  });

  it("carries the WAL sidecars when a checkpoint left them behind", () => {
    seedData(userData);
    fs.writeFileSync(path.join(userData, `${DB_FILE_NAME}-wal`), "wal-bytes");
    const target = path.join(root, "elsewhere");

    expect(moveDataTo(target).ok).toBe(true);
    expect(fs.readFileSync(path.join(target, `${DB_FILE_NAME}-wal`), "utf8")).toBe("wal-bytes");
  });

  it("creates the target folder when it does not exist yet", () => {
    seedData(userData);
    const target = path.join(root, "new", "nested", "folder");

    expect(moveDataTo(target).ok).toBe(true);
    expect(fs.existsSync(path.join(target, DB_FILE_NAME))).toBe(true);
  });

  it("leaves the original files in place", () => {
    seedData(userData);
    expect(moveDataTo(path.join(root, "elsewhere")).ok).toBe(true);
    expect(fs.existsSync(path.join(userData, DB_FILE_NAME))).toBe(true);
  });

  it("refuses the folder the data already lives in", () => {
    seedData(userData);
    expect(moveDataTo(userData)).toEqual({
      ok: false,
      code: "SAME_DIR",
      message: expect.any(String),
    });
  });

  it("refuses a folder inside the current data folder", () => {
    seedData(userData);
    const result = moveDataTo(path.join(userData, "inner"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("NESTED");
  });

  it("refuses a folder that already holds a database", () => {
    seedData(userData);
    const target = path.join(root, "occupied");
    seedData(target, "other-db-bytes");

    const result = moveDataTo(target);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("TARGET_HAS_DATA");
    // The refusal must not have touched either side.
    expect(fs.readFileSync(path.join(target, DB_FILE_NAME), "utf8")).toBe("other-db-bytes");
    expect(fs.existsSync(pointerPath())).toBe(false);
    expect(getDataDir()).toBe(userData);
  });

  it("adopts a database already in the target when useExisting is set, without copying over it", () => {
    seedData(userData);
    const target = path.join(root, "occupied");
    seedData(target, "other-db-bytes");

    expect(moveDataTo(target, { useExisting: true })).toEqual({ ok: true, dataDir: target });
    expect(fs.readFileSync(path.join(target, DB_FILE_NAME), "utf8")).toBe("other-db-bytes");
    expect(getDataDir()).toBe(target);
  });

  it("removes the pointer file when the data moves back to the default folder", () => {
    const custom = path.join(root, "custom");
    seedData(custom);
    fs.writeFileSync(pointerPath(), JSON.stringify({ dataDir: custom }));
    // The default folder must be empty, or the move is refused as TARGET_HAS_DATA.
    fs.rmSync(path.join(userData, DB_FILE_NAME), { force: true });

    expect(moveDataTo(userData)).toEqual({ ok: true, dataDir: userData });
    expect(fs.existsSync(pointerPath())).toBe(false);
    expect(getDataDirStatus().isCustom).toBe(false);
  });

  it("merges attachments instead of overwriting blobs already in the target", () => {
    seedData(userData);
    const target = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(target, ATTACHMENTS_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(target, ATTACHMENTS_DIR_NAME, "abc123.png"), "already-there");
    fs.writeFileSync(path.join(target, ATTACHMENTS_DIR_NAME, "def456.png"), "target-only");

    expect(moveDataTo(target).ok).toBe(true);
    // Blobs are named by their own sha256, so a same-named file is byte-identical anyway.
    expect(fs.readFileSync(path.join(target, ATTACHMENTS_DIR_NAME, "abc123.png"), "utf8"))
      .toBe("already-there");
    expect(fs.readFileSync(path.join(target, ATTACHMENTS_DIR_NAME, "def456.png"), "utf8"))
      .toBe("target-only");
  });
});

describe("clearCustomDataDir", () => {
  it("goes back to the default folder without deleting anything", () => {
    const custom = path.join(root, "custom");
    seedData(custom);
    fs.writeFileSync(pointerPath(), JSON.stringify({ dataDir: custom }));
    expect(getDataDir()).toBe(custom);

    clearCustomDataDir();

    expect(getDataDir()).toBe(userData);
    expect(fs.existsSync(pointerPath())).toBe(false);
    expect(fs.existsSync(path.join(custom, DB_FILE_NAME))).toBe(true);
  });
});

// --- Fix Round: every device's live db moves to a private, never-shared location the moment
// sync is enabled on it, by either path (markDeviceAsAdopted or markPrivateDb) -- see this
// module's own header comment on getDbDir for the full rationale (C-001/B-2/H-001). ---

describe("hasPrivateDb / markPrivateDb / markDeviceAsAdopted / getDbDir", () => {
  it("matches getDataDir() until sync has ever been enabled on this device", () => {
    expect(hasPrivateDb()).toBe(false);
    expect(getDbDir()).toBe(getDataDir());
  });

  it("markPrivateDb switches getDbDir() to userData without claiming this device adopted anything", () => {
    markPrivateDb();
    expect(hasPrivateDb()).toBe(true);
    expect(getDbDir()).toBe(userData);
  });

  it("markDeviceAsAdopted implies hasPrivateDb", () => {
    markDeviceAsAdopted();
    expect(hasPrivateDb()).toBe(true);
    expect(getDbDir()).toBe(userData);
  });
});

describe("backupExistingPrivateDbBeforeAdopt", () => {
  it("renames a pre-existing database at the private location out of the way and returns its new path", () => {
    seedData(userData); // userData IS the private location (getDefaultDataDir())
    const dbPath = path.join(userData, DB_FILE_NAME);

    const backupPath = backupExistingPrivateDbBeforeAdopt();

    expect(backupPath).not.toBeNull();
    expect(backupPath).toMatch(/\.pre-adopt-.*\.bak$/);
    expect(fs.existsSync(dbPath)).toBe(false); // renamed away, not left for initDatabase() to reopen
    expect(fs.readFileSync(backupPath!, "utf8")).toBe("db-bytes");
  });

  it("also carries the -wal/-shm siblings, when present", () => {
    seedData(userData);
    fs.writeFileSync(path.join(userData, `${DB_FILE_NAME}-wal`), "wal-bytes");

    const backupPath = backupExistingPrivateDbBeforeAdopt();

    expect(fs.readFileSync(`${backupPath}-wal`, "utf8")).toBe("wal-bytes");
  });

  it("returns null when there is nothing at the private location to back up", () => {
    expect(backupExistingPrivateDbBeforeAdopt()).toBeNull();
  });
});

describe("relocateDbToPrivateStorage", () => {
  it("copies the db and its -wal/-shm siblings from sourceDir into userData, leaving the original in place", () => {
    const source = path.join(root, "old-custom-folder");
    seedData(source);
    fs.writeFileSync(path.join(source, `${DB_FILE_NAME}-wal`), "wal-bytes");

    relocateDbToPrivateStorage(source);

    expect(fs.readFileSync(path.join(userData, DB_FILE_NAME), "utf8")).toBe("db-bytes");
    expect(fs.readFileSync(path.join(userData, `${DB_FILE_NAME}-wal`), "utf8")).toBe("wal-bytes");
    // The old copy is left where it is -- same "leave the original" convention as moveDataTo.
    expect(fs.existsSync(path.join(source, DB_FILE_NAME))).toBe(true);
  });

  it("is a no-op when the source is already the private location", () => {
    seedData(userData);
    expect(() => relocateDbToPrivateStorage(userData)).not.toThrow();
    expect(fs.readFileSync(path.join(userData, DB_FILE_NAME), "utf8")).toBe("db-bytes");
  });
});

describe("moveDataTo with copyDb / copyAttachments (sync enable/adopt paths)", () => {
  it("copyDb: false never copies a database into the target, even when the source has one", () => {
    seedData(userData);
    const target = path.join(root, "shared-target");

    const result = moveDataTo(target, { copyDb: false });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(target, DB_FILE_NAME))).toBe(false);
    // Attachments still copy by default -- only the db copy is suppressed.
    expect(fs.existsSync(path.join(target, ATTACHMENTS_DIR_NAME, "abc123.png"))).toBe(true);
  });

  it("copyDb: false bypasses the TARGET_HAS_DATA refusal, since there is nothing to conflict with", () => {
    seedData(userData);
    const target = path.join(root, "shared-target");
    fs.mkdirSync(target, { recursive: true }); // no db file here, only the folder exists

    expect(moveDataTo(target, { copyDb: false }).ok).toBe(true);
  });

  it("copyAttachments: false skips attachments too (the adopt path: nothing of this device's own local data belongs in the shared pool)", () => {
    seedData(userData);
    const target = path.join(root, "shared-target");
    fs.mkdirSync(target, { recursive: true });

    const result = moveDataTo(target, { copyDb: false, copyAttachments: false });

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(target, DB_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(target, ATTACHMENTS_DIR_NAME))).toBe(false);
  });

  it("sources the db copy from getDbDir(), not unconditionally getDataDir() (H-001)", () => {
    // Once this device already has a private db, getDataDir() no longer holds a database file
    // at all -- moveDataTo must not silently source an ordinary relocate's db copy from a
    // location a peer's data could otherwise occupy.
    markPrivateDb();
    seedData(userData); // userData is both the default data dir AND (now) the private db location
    const target = path.join(root, "elsewhere");

    expect(moveDataTo(target).ok).toBe(true);
    expect(fs.readFileSync(path.join(target, DB_FILE_NAME), "utf8")).toBe("db-bytes");
  });
});
