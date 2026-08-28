// electron/main/sync/notices.ts
// The user-visible automatic-resolution log (FR-009, FR-031, FR-041): a discard, a clock-drift
// clamp, a placeholder block, a stray file, or a stale-machine rebuild. One shared writer so
// every part of the sync engine (merge-engine.ts, sync-manager.ts, snapshot.ts) raises notices
// through the same table and shape.

import type Database from "better-sqlite3";

type DbHandle = Database.Database;

export type SyncNoticeKind =
  | "discard-after-delete"
  | "clock-drift"
  | "placeholder-blocked"
  | "stray-file"
  | "stale-machine-rebuild";

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
