// @vitest-environment node
// Guards the mechanism that lets a todo's primary key move while three tables reference it.
//
// `moveTodoRowId` (merge-engine.ts) relies on `PRAGMA defer_foreign_keys` postponing foreign-key
// enforcement to COMMIT, so a row and its referencing rows can move together inside one
// transaction. If that ever stopped working, todo renumbering would throw -- and
// `runMergePassSafely` funnels a throw there into a bare `console.warn`, so it would fail
// silently on every merge pass forever rather than surfacing. These tests are the tripwire.
//
// This started life as a probe for `ON UPDATE CASCADE`, which also works but would have meant
// rebuilding `todos` (a ~15-column table three migrations contribute to) plus both referencing
// tables on every existing install, purely to change one constraint. The deferral gets the same
// guarantee with no migration at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, getDb, initDatabase } from "../../database.ts";

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

describe("deferred foreign keys", () => {
  it("has foreign key enforcement switched on at all", () => {
    // Everything below is only meaningful if constraints are actually being checked.
    const row = getDb().prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
    expect(row?.foreign_keys).toBe(1);
  });

  it("rejects a primary-key move that orphans a child, when not deferred", () => {
    const db = getDb();
    db.exec(`
      CREATE TABLE probe_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE probe_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES probe_parent(id));
    `);
    db.prepare("INSERT INTO probe_parent (id) VALUES (1)").run();
    db.prepare("INSERT INTO probe_child (id, parent_id) VALUES (10, 1)").run();

    // The failure mode the deferral exists to avoid -- proving it is real is what makes the next
    // test meaningful rather than incidental.
    expect(() => db.prepare("UPDATE probe_parent SET id = 2 WHERE id = 1").run()).toThrow();
  });

  it("allows the same move when the parent and its children travel together in one transaction", () => {
    const db = getDb();
    db.exec(`
      CREATE TABLE probe_p (id INTEGER PRIMARY KEY);
      CREATE TABLE probe_c (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES probe_p(id));
    `);
    db.prepare("INSERT INTO probe_p (id) VALUES (1)").run();
    db.prepare("INSERT INTO probe_c (id, parent_id) VALUES (10, 1)").run();

    const move = db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      db.prepare("UPDATE probe_p SET id = 77 WHERE id = 1").run();
      db.prepare("UPDATE probe_c SET parent_id = 77 WHERE parent_id = 1").run();
    });
    expect(() => move()).not.toThrow();

    const child = db.prepare("SELECT parent_id FROM probe_c WHERE id = 10").get() as { parent_id: number };
    expect(child.parent_id).toBe(77);
  });

  it("still fails the commit if the references are left genuinely inconsistent", () => {
    // The deferral must postpone the check, not remove it.
    const db = getDb();
    db.exec(`
      CREATE TABLE probe_p2 (id INTEGER PRIMARY KEY);
      CREATE TABLE probe_c2 (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES probe_p2(id));
    `);
    db.prepare("INSERT INTO probe_p2 (id) VALUES (1)").run();
    db.prepare("INSERT INTO probe_c2 (id, parent_id) VALUES (10, 1)").run();

    const broken = db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      db.prepare("UPDATE probe_p2 SET id = 5 WHERE id = 1").run();
      // deliberately does NOT repoint the child
    });
    expect(() => broken()).toThrow();
  });
});
