// electron/main/sync/notices.ts
// The user-visible automatic-resolution log (FR-009, FR-031, FR-041): a discard, a clock-drift
// clamp, a placeholder block, a stray file, or a stale-machine rebuild. One shared writer so
// every part of the sync engine (merge-engine.ts, sync-manager.ts, snapshot.ts) raises notices
// through the same table and shape.

import type Database from "better-sqlite3";

type DbHandle = Database.Database;

// Deliberately duplicated in src/shared/types.ts (the renderer cannot import this main-process
// module) -- keep the two lists identical. They had already drifted once before this comment was
// added: src/shared/types.ts carried "todo-id-reassigned" while this list did not, which made
// every real addSyncNotice(..., "todo-id-reassigned", ...) call (merge-engine.ts, migration.ts) a
// type error under `tsc --noEmit -p tsconfig.main.json` -- silent otherwise, since neither `bun
// run build` nor `bun run lint` type-checks electron/ this strictly. Fixed here alongside adding
// "merge-failed" (2026-09-14 stuck-merge-pass follow-up).
export type SyncNoticeKind =
  | "discard-after-delete"
  | "clock-drift"
  | "placeholder-blocked"
  | "stray-file"
  | "stale-machine-rebuild"
  | "adopted-backup"
  /** A todo's visible number changed because another machine had already claimed it. */
  | "todo-id-reassigned"
  /** A merge pass failed for a reason with no dedicated notice kind of its own (sync-manager.ts). */
  | "merge-failed";

export function addSyncNotice(database: DbHandle, kind: SyncNoticeKind, message: string, detail?: string): void {
  database
    .prepare("INSERT INTO sync_notices (kind, message, detail, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, message, detail ?? null, new Date().toISOString());
}

export interface SyncNoticeRow {
  id: number;
  kind: SyncNoticeKind;
  message: string;
  detail: string | null;
  createdAt: string;
  dismissed: boolean;
}

export function listSyncNotices(database: DbHandle, includeDismissed = false): SyncNoticeRow[] {
  const rows = database
    .prepare(
      includeDismissed
        ? "SELECT id, kind, message, detail, created_at, dismissed FROM sync_notices ORDER BY created_at DESC"
        : "SELECT id, kind, message, detail, created_at, dismissed FROM sync_notices WHERE dismissed = 0 ORDER BY created_at DESC",
    )
    .all() as Array<
      { id: number; kind: string; message: string; detail: string | null; created_at: string; dismissed: number }
    >;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as SyncNoticeKind,
    message: r.message,
    detail: r.detail,
    createdAt: r.created_at,
    dismissed: r.dismissed === 1,
  }));
}

export function dismissSyncNotice(database: DbHandle, id: number): void {
  database.prepare("UPDATE sync_notices SET dismissed = 1 WHERE id = ?").run(id);
}
