// The TypeScript side of the sync equivalence harness: drives the real Electron sync engine and
// database module under node with real better-sqlite3 (never the Vitest sql.js shim, which tolerates
// bind-type bugs). Every path comes from the caller; this file never reads a default data folder.
//
// Bundled and imported by run.mjs. Keep `dump` in step with `dump()` in
// native/crates/sync/src/bin/sync_cli.rs.

import fs from "node:fs";
import path from "node:path";
import {
  assignTag,
  closeDatabase,
  createTag,
  createTodo,
  createTodoLabel,
  createTodoProject,
  deleteSession,
  deleteTodo,
  getDb,
  initDatabase,
  listSessions,
  listTags,
  listTodoLabels,
  listTodoProjects,
  listTodos,
  listTodoStates,
  reorderTodoProjects,
  reorderTodoStates,
  saveSession,
  updateTodo,
} from "../../../electron/main/database.ts";
import { invalidateDataDirCache } from "../../../electron/main/data-location.ts";
import { getDeviceId, invalidateDeviceIdCache } from "../../../electron/main/sync/device-identity.ts";
import { runMergePass } from "../../../electron/main/sync/merge-pass.ts";
import { enableSyncOnExistingMachine } from "../../../electron/main/sync/migration.ts";
import { buildSnapshotEntries, rebuildFromSnapshot, writeSnapshotIfDue } from "../../../electron/main/sync/snapshot.ts";
import { applyPendingSyncActionAfterInit } from "../../../electron/main/sync/sync-manager.ts";
import { getDataDir } from "../../../electron/main/data-location.ts";
import { setSyncEnabled } from "../../../electron/main/sync/sync-writer.ts";

export interface DeviceDirs {
  dbPath: string;
  userData: string;
  shared: string;
}

/** Points every module-level cache at this device, then opens its database file. */
function openDevice(d: DeviceDirs): void {
  process.env["LIZMETER_REAL_DB_USER_DATA"] = d.userData;
  fs.mkdirSync(d.userData, { recursive: true });
  fs.writeFileSync(path.join(d.userData, "data-location.json"), `${JSON.stringify({ dataDir: d.shared })}\n`, "utf8");
  invalidateDataDirCache();
  invalidateDeviceIdCache();
  initDatabase(d.dbPath);
}

export function tsInit(d: DeviceDirs): void {
  openDevice(d);
  const db = getDb();
  db.prepare("UPDATE todo_states SET uuid = 'seed-state-' || id, created_at = '2026-01-01T00:00:00.000Z'").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync.deviceNumber', '941')").run();
  setSyncEnabled(db, true);
}

export function tsSetup(d: DeviceDirs, role: "originate" | "adopt"): void {
  openDevice(d);
  if (role === "originate") {
    enableSyncOnExistingMachine(getDb(), undefined, getDataDir());
  } else {
    applyPendingSyncActionAfterInit({ action: "adopt", targetDir: d.shared });
  }
}

export interface MergeOutcome {
  ok: boolean;
  applied?: number;
  skipped?: number;
  notices?: number;
  error?: string;
}

export function tsMerge(d: DeviceDirs): MergeOutcome {
  openDevice(d);
  try {
    const r = runMergePass(getDb(), d.shared, getDeviceId());
    return { ok: true, applied: r.applied, skipped: r.skippedAlreadyApplied, notices: r.notices };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function tsWriteSnapshot(d: DeviceDirs): boolean {
  openDevice(d);
  return writeSnapshotIfDue(getDb(), d.shared, getDeviceId());
}

export function tsRebuild(d: DeviceDirs): boolean {
  openDevice(d);
  return rebuildFromSnapshot(getDb(), d.shared, getDeviceId());
}

export function tsClose(): void {
  closeDatabase();
}

// --- normalized dump ---

type Row = Record<string, unknown>;

function rows(sql: string): Row[] {
  return getDb().prepare(sql).all() as Row[];
}

function dropKeys(list: Row[], keys: string[]): Row[] {
  return list.map((r) => {
    const copy = { ...r };
    for (const k of keys) delete copy[k];
    return copy;
  });
}

export function tsDump(d: DeviceDirs, mixed: boolean): Record<string, unknown> {
  openDevice(d);
  const out: Record<string, unknown> = {};

  out["todos"] = dropKeys(
    rows(
      `SELECT t.*,
              (SELECT uuid FROM todo_states x WHERE x.id = t.state_id) AS state_uuid,
              (SELECT uuid FROM todo_projects x WHERE x.id = t.project_id) AS project_uuid,
              (SELECT uuid FROM todos x WHERE x.id = t.parent_id) AS parent_uuid
       FROM todos t`,
    ),
    ["state_id", "project_id", "parent_id"],
  );
  for (const table of ["todo_states", "todo_projects", "todo_labels", "tags"]) {
    out[table] = dropKeys(rows(`SELECT * FROM ${table}`), ["id", "position"]);
  }
  out["sessions"] = rows("SELECT * FROM sessions");
  out["todo_label_links"] = rows(
    "SELECT t.uuid AS todo_uuid, l.uuid AS label_uuid FROM todo_label_links k INNER JOIN todos t ON t.id = k.todo_id INNER JOIN todo_labels l ON l.id = k.label_id",
  );
  out["session_tags"] = rows(
    "SELECT st.session_id AS session_id, t.uuid AS tag_uuid FROM session_tags st INNER JOIN tags t ON t.id = st.tag_id",
  );
  out["todo_attachments"] = rows(
    "SELECT t.uuid AS todo_uuid, a.sha256, a.file_name, a.mime_type, a.size_bytes, a.kind FROM todo_attachments a INNER JOIN todos t ON t.id = a.todo_id",
  );
  // Two devices that delete the same row each end up holding the OTHER device's tombstone clock
  // (a merged delete replaces the local tombstone), so in a mixed run only the identity is compared.
  out["sync_tombstones"] = rows(
    mixed
      ? "SELECT table_name, row_uuid FROM sync_tombstones"
      : "SELECT table_name, row_uuid, hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_tombstones",
  );
  if (!mixed) {
    out["sync_field_clocks"] = rows(
      "SELECT table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks",
    );
  }
  if (!mixed) {
    out["sync_id_aliases"] = rows("SELECT table_name, old_uuid, new_uuid FROM sync_id_aliases");
    out["sync_applied_ops"] = rows("SELECT op_id, device_id FROM sync_applied_ops");
    out["sync_notices"] = rows("SELECT kind, message, detail FROM sync_notices");
    out["settings"] = rows("SELECT key, value FROM settings WHERE key = 'sync.nextTodoId'");
  }
  return out;
}

/** A snapshot's own HLC is wall-clock, so only tombstone (delete) entries keep theirs. */
export function tsSnapshotEntries(d: DeviceDirs): unknown[] {
  openDevice(d);
  return buildSnapshotEntries(getDb()).map((e) => {
    const copy = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    delete copy["opId"];
    if (copy["op"] !== "delete") delete copy["hlc"];
    const fields = copy["fields"] as Record<string, Record<string, unknown>> | undefined;
    if (fields && copy["op"] !== "link" && copy["op"] !== "unlink") {
      for (const change of Object.values(fields)) delete change["hlc"];
    }
    return copy;
  });
}

// --- random edits ---

function rngFor(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ["bug", "urgent", "idea", "chore", "docs"];
const PROJECTS = ["Alpha", "Beta", "Gamma", "Delta"];
const TAGS = ["focus", "deep", "review"];

export function tsEdit(d: DeviceDirs, seed: number, ops: number): { done: number } {
  openDevice(d);
  const next = rngFor(seed);
  const below = (n: number): number => Math.floor(next() * Math.max(n, 1));
  const pick = <T>(items: T[]): T | undefined => (items.length === 0 ? undefined : items[below(items.length)]);
  const label = `ts-${seed}`;
  let done = 0;

  for (let n = 0; n < ops; n++) {
    const roll = below(100);
    const todos = listTodos();
    try {
      if (roll <= 34) {
        const labelIds: number[] = [];
        if (below(3) === 0) {
          const l = pick(listTodoLabels());
          if (l) labelIds.push(l.id);
        }
        createTodo({
          title: `${label}-${n}`,
          ...(below(2) === 0 ? { stateId: pick(listTodoStates())?.id } : {}),
          ...(below(3) === 0 ? { projectId: pick(listTodoProjects())?.id } : {}),
          ...(labelIds.length > 0 ? { labelIds } : {}),
          ...(below(5) === 0 ? { parentId: pick(todos)?.id } : {}),
          ...(below(4) === 0 ? { dueDate: `2026-0${1 + below(9)}-1${below(9)}` } : {}),
        });
      } else if (roll <= 59) {
        const t = pick(todos);
        if (t) {
          switch (below(6)) {
            case 0:
              updateTodo({ id: t.id, title: `${label}-edit-${n}` });
              break;
            case 1:
              updateTodo({ id: t.id, notes: `note ${label} ${n}` });
              break;
            case 2:
              updateTodo({ id: t.id, priority: below(4) });
              break;
            case 3:
              updateTodo({ id: t.id, dueDate: below(2) === 0 ? null : "2026-12-24" });
              break;
            case 4: {
              const s = pick(listTodoStates());
              if (s) updateTodo({ id: t.id, stateId: s.id });
              break;
            }
            default: {
              const l = pick(listTodoLabels());
              updateTodo({ id: t.id, labelIds: l ? [l.id] : [] });
            }
          }
        }
      } else if (roll <= 67) {
        const t = pick(todos);
        if (t) deleteTodo(t.id);
      } else if (roll <= 73) {
        createTodoLabel({ name: LABELS[below(LABELS.length)]!, color: "#9ece6a" });
      } else if (roll <= 78) {
        createTodoProject({ name: PROJECTS[below(PROJECTS.length)]! });
      } else if (roll <= 82) {
        createTag({ name: TAGS[below(TAGS.length)]!, color: "#bb9af7" });
      } else if (roll <= 86) {
        const ids = listTodoProjects().map((p) => p.id);
        for (let i = ids.length - 1; i >= 1; i--) {
          const j = below(i + 1);
          [ids[i], ids[j]] = [ids[j]!, ids[i]!];
        }
        if (ids.length > 0) reorderTodoProjects(ids);
      } else if (roll <= 89) {
        const ids = listTodoStates().map((p) => p.id);
        for (let i = ids.length - 1; i >= 1; i--) {
          const j = below(i + 1);
          [ids[i], ids[j]] = [ids[j]!, ids[i]!];
        }
        reorderTodoStates(ids);
      } else if (roll <= 95) {
        const session = saveSession({
          title: `${label}-session-${n}`,
          timerType: "work",
          plannedDurationSeconds: 1500,
          actualDurationSeconds: 60 + below(1400),
        });
        const tag = pick(listTags());
        if (tag) assignTag({ sessionId: session.id, tagId: tag.id });
      } else {
        const s = pick(listSessions({}).sessions);
        if (s) deleteSession(s.id);
      }
      done += 1;
    } catch {
      // A rejected edit (duplicate name, missing parent) changes nothing and is not counted.
    }
  }
  return { done };
}
