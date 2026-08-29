// @vitest-environment node
// Milestone 9: a migration test against a *populated* pre-sync database, not `:memory:` from
// empty. The Arena explicitly flagged that this class of test did not exist before this feature
// and migration bugs passed CI silently -- this file closes that gap.
//
// The sql.js test shim always opens a brand-new in-memory database regardless of the path given
// to it (see src/test/better-sqlite3-shim.ts), so a *real* pre-existing file can never be opened
// through `initDatabase()` in this environment. The established pattern for testing a migration
// here (see todo-projects-labels-database.test.ts's `makeLegacyProjectColumn`) is instead: start
// from the current, fully-migrated schema, mechanically reshape it back to the pre-migration
// column layout, populate it as if it were a real, already-in-use database, then re-run the
// migration and assert the result. `backupBeforeSyncMigration`'s actual file-copy mechanics are
// tested separately below, against a real file on disk, since that part genuinely is I/O and
// does not depend on the shim at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  createTag,
  createTodo,
  createTodoLabel,
  createTodoProject,
  createTodoState,
  getDb,
  initDatabase,
  listTodoLabels,
  listTodoProjects,
  listTodos,
  listTodoStates,
  migrateSyncColumnsNow,
  saveSession,
} from "../../database.ts";
import { getDataDir, invalidateDataDirCache } from "../../data-location.ts";
import { invalidateDeviceIdCache } from "../device-identity.ts";
import { getSyncDevicesDir, readOplogEntries } from "../oplog.ts";
import { backupBeforeSyncMigration, enableSyncOnExistingMachine } from "../migration.ts";
import { isSyncEnabled } from "../sync-writer.ts";

/** Rebuilds the pre-Milestone-1 shape: no `uuid` column (and no unique index on it) anywhere. */
function makeLegacyPreSyncSchema(): void {
  const db = getDb();
  for (const table of ["todos", "tags", "todo_labels", "todo_states", "todo_projects"]) {
    db.exec(`DROP INDEX IF EXISTS idx_${table}_uuid`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN uuid`);
  }
}

describe("backupBeforeSyncMigration", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-migration-backup-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("copies the db file and its -wal/-shm siblings, when present, to a timestamped .bak", () => {
    const dbPath = path.join(dir, "lizmeter.db");
    fs.writeFileSync(dbPath, "pretend sqlite bytes");
    fs.writeFileSync(`${dbPath}-wal`, "pretend wal bytes");
    // No -shm file this time -- must not be required.

    const backupPath = backupBeforeSyncMigration(dbPath);

    expect(backupPath).toMatch(/\.pre-sync-.*\.bak$/);
    expect(fs.readFileSync(backupPath, "utf8")).toBe("pretend sqlite bytes");
    expect(fs.readFileSync(`${backupPath}-wal`, "utf8")).toBe("pretend wal bytes");
    expect(fs.existsSync(`${backupPath}-shm`)).toBe(false);
  });
});

describe("migrating a populated pre-sync database", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-migration-fixture-"));
    mockPaths.userData = root;
    invalidateDataDirCache();
    invalidateDeviceIdCache();
    initDatabase(":memory:");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("backfills a uuid for every existing row without touching any existing todo id (FR-016)", () => {
    // Populate as if this were a real, already-in-use database: several todos across different
    // states and a project, a label, a tag, and a session -- the shape Athena's PRD explicitly
    // worried migration tests never exercise. Created *before* the schema is rolled back to its
    // pre-uuid shape, exactly mirroring how a real database accumulated this data long before
    // this feature (and its uuid column) ever existed.
    const project = createTodoProject({ name: "LizMeter" });
    const state = createTodoState({ label: "In Review" });
    const label = createTodoLabel({ name: "bug" });
    createTag({ name: "focus", color: "#7aa2f7" });
    saveSession({ title: "Focus session", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500 });

    const first = createTodo({ title: "#1", projectId: project.id });
    const second = createTodo({ title: "#2", stateId: state.id, labelIds: [label.id] });
    const existingIds = [first.id, second.id];

    makeLegacyPreSyncSchema();
    migrateSyncColumnsNow();

    const backfill = enableSyncOnExistingMachine(getDb(), undefined, getDataDir()); // :memory: -> no backup path
    expect(backfill.backupPath).toBeNull();
    expect(backfill.deviceNumber).toBe(0); // this machine already has data -- FR-016's "legacy machine"

    // FR-016: existing ids are exactly unchanged after migration.
    const afterIds = listTodos().map((t) => t.id).sort((a, b) => a - b);
    expect(afterIds).toEqual([...existingIds].sort((a, b) => a - b));
    expect(listTodos().find((t) => t.title === "#1")?.project?.name).toBe("LizMeter");
    expect(listTodos().find((t) => t.title === "#2")?.state.label).toBe("In Review");
    expect(listTodos().find((t) => t.title === "#2")?.labels.map((l) => l.name)).toEqual(["bug"]);

    // Every row across every synced table now has a uuid -- including the seeded default states
    // and every row this test itself created before migration ran.
    const db = getDb();
    for (const table of ["todos", "tags", "todo_labels", "todo_states", "todo_projects"]) {
      const { missing } = db.prepare(`SELECT COUNT(*) AS missing FROM ${table} WHERE uuid IS NULL`).get() as
        { missing: number };
      expect(missing, `${table} should have no rows missing a uuid`).toBe(0);
    }

    expect(listTodoProjects().length).toBeGreaterThan(0);
    expect(listTodoLabels().length).toBeGreaterThan(0);
    expect(listTodoStates().length).toBeGreaterThan(0);
  });

  it("turns sync on and publishes every existing row so a second machine has something to merge", () => {
    createTodo({ title: "already here before sync existed" });
    makeLegacyPreSyncSchema();
    migrateSyncColumnsNow();

    enableSyncOnExistingMachine(getDb(), undefined, getDataDir());

    expect(isSyncEnabled(getDb())).toBe(true);

    const oplogDir = getSyncDevicesDir(root);
    const files = fs.readdirSync(oplogDir).filter((f) => f.endsWith(".oplog.jsonl"));
    expect(files.length).toBe(1);

    const { entries } = readOplogEntries(`${oplogDir}/${files[0]}`);
    const published = entries.find(
      (e) => e.op === "upsert" && e.table === "todos" && e.fields["title"]?.value === "already here before sync existed",
    );
    expect(published).toBeDefined();
  });

  it("is idempotent: adding the uuid column twice never throws a duplicate-column error", () => {
    createTodo({ title: "only todo" });
    makeLegacyPreSyncSchema();

    migrateSyncColumnsNow();
    // Re-run, exactly as initDatabase() does on every subsequent app start. A guard-less
    // `ALTER TABLE ... ADD COLUMN uuid` here would throw "duplicate column name" the second time.
    expect(() => migrateSyncColumnsNow()).not.toThrow();

    const db = getDb();
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM todos").get() as { count: number };
    expect(count).toBe(1); // the row itself was never duplicated or lost either

    // backfillUuids (a separate step, run once via enableSyncOnExistingMachine) is what actually
    // fills the value in -- covered by the "backfills a uuid..." test above. Running it twice
    // must not re-generate a *different* uuid for a row that already has one.
    const before = enableSyncOnExistingMachine(getDb(), undefined, getDataDir());
    const uuidAfterFirstBackfill = (db.prepare("SELECT uuid FROM todos LIMIT 1").get() as { uuid: string }).uuid;
    const after = enableSyncOnExistingMachine(getDb(), undefined, getDataDir());
    const uuidAfterSecondBackfill = (db.prepare("SELECT uuid FROM todos LIMIT 1").get() as { uuid: string }).uuid;
    expect(uuidAfterSecondBackfill).toBe(uuidAfterFirstBackfill);
    expect(before.deviceNumber).toBe(after.deviceNumber);
  });
});
