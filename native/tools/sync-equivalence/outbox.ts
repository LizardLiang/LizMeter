// The TypeScript side of the outbox scenarios (see outbox.mjs). Mirrors `outbox_scenario` in
// native/crates/sync/src/bin/sync_cli.rs: each scenario returns the same JSON shape on both engines.
// Bundled and imported by outbox.mjs; every path comes from the caller.

import fs from "node:fs";
import path from "node:path";
import {
  closeDatabase,
  createTag,
  createTodo,
  getDb,
  initDatabase,
  listTags,
  listTodos,
} from "../../../electron/main/database.ts";
import { getDataDir, invalidateDataDirCache } from "../../../electron/main/data-location.ts";
import { getDeviceId, invalidateDeviceIdCache } from "../../../electron/main/sync/device-identity.ts";
import { runMergePass } from "../../../electron/main/sync/merge-pass.ts";
import { enableSyncOnExistingMachine } from "../../../electron/main/sync/migration.ts";
import { flushOutbox, flushOutboxIfSyncEnabled, setSyncEnabled } from "../../../electron/main/sync/sync-writer.ts";

export interface OutboxDirs {
  dbPath: string;
  userData: string;
  shared: string;
}

function openDevice(d: OutboxDirs): void {
  process.env["LIZMETER_REAL_DB_USER_DATA"] = d.userData;
  fs.mkdirSync(d.userData, { recursive: true });
  fs.writeFileSync(path.join(d.userData, "data-location.json"), `${JSON.stringify({ dataDir: d.shared })}\n`, "utf8");
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  initDatabase(d.dbPath);
}

function initSyncDevice(d: OutboxDirs): void {
  openDevice(d);
  const db = getDb();
  db.prepare("UPDATE todo_states SET uuid = 'seed-state-' || id, created_at = '2026-01-01T00:00:00.000Z'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync.deviceNumber', '941')").run();
  setSyncEnabled(db, true);
}

const count = (sql: string): number => (getDb().prepare(sql).get() as { n: number }).n;

function checkpoint() {
  return {
    outbox: count("SELECT COUNT(*) AS n FROM sync_outbox"),
    notices: (getDb().prepare("SELECT message FROM sync_notices WHERE kind = 'publish-pending'").all() as Array<
      { message: string }
    >).map((n) => n.message),
    tags: listTags().map((t) => t.name).sort(),
    todos: listTodos().map((t) => t.title).sort(),
  };
}

function ownOplog(d: OutboxDirs): string[] {
  const file = path.join(d.shared, "sync", "devices", `${getDeviceId()}.oplog.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
}

function block(d: OutboxDirs): string {
  const blocker = path.join(d.shared, "sync");
  fs.rmSync(blocker, { recursive: true, force: true });
  fs.writeFileSync(blocker, "not a folder");
  return blocker;
}

/** A fresh sync-enabled device in a different database merges the shared folder twice. */
function peerView(d: OutboxDirs) {
  closeDatabase();
  const peer: OutboxDirs = { dbPath: `${d.dbPath}.peer`, userData: `${d.userData}-peer`, shared: d.shared };
  initSyncDevice(peer);
  const first = runMergePass(getDb(), peer.shared, getDeviceId());
  const second = runMergePass(getDb(), peer.shared, getDeviceId());
  return {
    firstApplied: first.applied,
    secondApplied: second.applied,
    appliedOps: count("SELECT COUNT(*) AS n FROM sync_applied_ops"),
    tags: listTags().map((t) => t.name).sort(),
    todos: listTodos().map((t) => t.title).sort(),
  };
}

export function tsOutboxScenario(d: OutboxDirs, name: string): Record<string, unknown> {
  if (name === "enable-sync-resume") {
    openDevice(d);
    createTodo({ title: "one" });
    createTodo({ title: "two" });
    createTag({ name: "tag-one", color: "#7aa2f7" });
    const blocker = block(d);
    enableSyncOnExistingMachine(getDb(), undefined, getDataDir());
    const enabled = (getDb().prepare("SELECT value FROM settings WHERE key = 'sync.enabled'").get() as
      | { value: string }
      | undefined)?.value;
    const blocked = { ...checkpoint(), enabled };
    fs.rmSync(blocker, { force: true });
    flushOutbox(getDb());
    const recovered = checkpoint();
    const oplog = ownOplog(d);
    return { blocked, recovered, oplog, peer: peerView(d) };
  }

  initSyncDevice(d);
  if (name === "write-fails-after-record") {
    const db = getDb();
    db.exec("CREATE TRIGGER fail_clock BEFORE INSERT ON sync_field_clocks BEGIN SELECT RAISE(ABORT, 'boom'); END");
    let failed = false;
    try {
      createTag({ name: "ghost", color: "#7aa2f7" });
    } catch {
      failed = true;
    }
    const afterFailure = checkpoint();
    const oplogAfterFailure = ownOplog(d);
    db.exec("DROP TRIGGER fail_clock");
    createTag({ name: "kept", color: "#7aa2f7" });
    return { failed, afterFailure, oplogAfterFailure, final: checkpoint(), oplog: ownOplog(d), peer: peerView(d) };
  }
  if (name === "unreachable-then-recovers") {
    const blocker = block(d);
    createTodo({ title: "first" });
    createTag({ name: "t", color: "#7aa2f7" });
    createTodo({ title: "second" });
    const blocked = checkpoint();
    const oplogWhileBlocked = fs.existsSync(path.join(d.shared, "sync", "devices"));
    fs.rmSync(blocker, { force: true });
    flushOutbox(getDb());
    return { blocked, oplogWhileBlocked, recovered: checkpoint(), oplog: ownOplog(d), peer: peerView(d) };
  }
  if (name === "duplicate-flush") {
    createTag({ name: "deep", color: "#7aa2f7" });
    createTodo({ title: "x" });
    const once = ownOplog(d);
    const insert = getDb().prepare("INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)");
    for (const line of once) insert.run(line, "2026-01-01T00:00:00.000Z");
    flushOutbox(getDb());
    return { onceLength: once.length, final: checkpoint(), oplog: ownOplog(d), peer: peerView(d) };
  }
  if (name === "quit-with-sync-off") {
    const blocker = block(d);
    createTag({ name: "queued", color: "#7aa2f7" });
    const queued = checkpoint();
    setSyncEnabled(getDb(), false);
    fs.rmSync(blocker, { force: true });
    flushOutboxIfSyncEnabled(getDb());
    const afterQuitOff = checkpoint();
    const oplogAfterQuitOff = ownOplog(d);
    setSyncEnabled(getDb(), true);
    flushOutboxIfSyncEnabled(getDb());
    return { queued, afterQuitOff, oplogAfterQuitOff, final: checkpoint(), oplog: ownOplog(d), peer: peerView(d) };
  }
  if (name === "failed-append-undone") {
    createTag({ name: "before", color: "#7aa2f7" });
    getDb().prepare("INSERT INTO sync_outbox (line, created_at) VALUES (?, ?)").run(
      '{"v":1,"torn":true}',
      "2026-01-01T00:00:00.000Z",
    );
    const realAppend = fs.appendFileSync;
    fs.appendFileSync = ((file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
      realAppend(file, String(data).slice(0, 10), options);
      throw new Error("disk full");
    }) as typeof fs.appendFileSync;
    try {
      flushOutbox(getDb());
    } finally {
      fs.appendFileSync = realAppend;
    }
    const afterFailure = checkpoint();
    const oplogAfterFailure = ownOplog(d);
    flushOutbox(getDb());
    return { afterFailure, oplogAfterFailure, final: checkpoint(), oplog: ownOplog(d), peer: peerView(d) };
  }
  throw new Error(`unknown outbox scenario ${name}`);
}

export function tsOutboxClose(): void {
  closeDatabase();
}
