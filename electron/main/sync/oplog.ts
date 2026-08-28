// electron/main/sync/oplog.ts
// The oplog format, one JSON Lines file per device, and the read/write primitives around it.
//
// A device writes ONLY its own file, ever -- that is the entire safety property this design
// rests on, so the cloud drive only ever has to copy files, never merge them. Every entry is
// schema-versioned from day one (FR-020): a version this build does not understand is skipped
// and logged, never fatal.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hlc } from "./hlc.ts";
import { readFileGuarded } from "./hydration-guard.ts";

export const CURRENT_OPLOG_VERSION = 1;

/** Tables carrying their own permanent uuid, synced field-by-field. */
export type SyncedRowTable = "todos" | "tags" | "todo_labels" | "todo_states" | "todo_projects" | "sessions";

/**
 * `todo_attachments` carries no uuid of its own (Milestone 1) -- its merge key is the pair
 * `(todo_uuid, sha256)` already used for content addressing, joined here into one string.
 */
export type SyncedAttachmentTable = "todo_attachments";

/** Join tables expressed as link/unlink rather than field upserts. */
export type SyncedLinkTable = "todo_label_links" | "session_tags";

export type OplogFieldValue = string | number | boolean | null;

export interface OplogFieldChange {
  value: OplogFieldValue;
  hlc: Hlc;
}

export interface OplogUpsertEntry {
  v: number;
  opId: string;
  hlc: Hlc;
  table: SyncedRowTable | SyncedAttachmentTable;
  op: "upsert";
  rowUuid: string;
  fields: Record<string, OplogFieldChange>;
}

export interface OplogDeleteEntry {
  v: number;
  opId: string;
  hlc: Hlc;
  table: SyncedRowTable | SyncedAttachmentTable;
  op: "delete";
  rowUuid: string;
}

export interface OplogLinkEntry {
  v: number;
  opId: string;
  hlc: Hlc;
  table: SyncedLinkTable;
  op: "link" | "unlink";
  fields: { fromUuid: string; toUuid: string };
}

export type OplogEntry = OplogUpsertEntry | OplogDeleteEntry | OplogLinkEntry;

/** Joins an attachment's composite merge key into the string `rowUuid` upsert/delete entries carry. */
export function attachmentRowKey(todoUuid: string, sha256: string): string {
  return `${todoUuid}:${sha256}`;
}

export function buildUpsertEntry(
  hlc: Hlc,
  table: OplogUpsertEntry["table"],
  rowUuid: string,
  fields: Record<string, OplogFieldChange>,
): OplogUpsertEntry {
  return { v: CURRENT_OPLOG_VERSION, opId: crypto.randomUUID(), hlc, table, op: "upsert", rowUuid, fields };
}

export function buildDeleteEntry(hlc: Hlc, table: OplogDeleteEntry["table"], rowUuid: string): OplogDeleteEntry {
  return { v: CURRENT_OPLOG_VERSION, opId: crypto.randomUUID(), hlc, table, op: "delete", rowUuid };
}

export function buildLinkEntry(
  hlc: Hlc,
  table: SyncedLinkTable,
  op: "link" | "unlink",
  fromUuid: string,
  toUuid: string,
): OplogLinkEntry {
  return { v: CURRENT_OPLOG_VERSION, opId: crypto.randomUUID(), hlc, table, op, fields: { fromUuid, toUuid } };
}

const SYNC_SUBDIR = "sync";
const DEVICES_SUBDIR = "devices";

export function getSyncDevicesDir(dataDir: string): string {
  return path.join(dataDir, SYNC_SUBDIR, DEVICES_SUBDIR);
}

export function getOplogFilePath(dataDir: string, deviceId: string): string {
  return path.join(getSyncDevicesDir(dataDir), `${deviceId}.oplog.jsonl`);
}

export function getSnapshotFilePath(dataDir: string, deviceId: string): string {
  return path.join(getSyncDevicesDir(dataDir), `${deviceId}.snapshot.json`);
}

/**
 * Appends one entry to this device's own oplog file. Never opens, and must never be called
 * against, another device's file -- that invariant is what makes the cloud drive's "just copy
 * files" behavior safe.
 */
export function appendOplogEntry(dataDir: string, deviceId: string, entry: OplogEntry): void {
  const dir = getSyncDevicesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(getOplogFilePath(dataDir, deviceId), `${JSON.stringify(entry)}\n`, "utf8");
}

const KNOWN_OPS = new Set(["upsert", "delete", "link", "unlink"]);

export interface ReadOplogResult {
  entries: OplogEntry[];
  /** Lines skipped because of a future schema version or malformed JSON -- never fatal (FR-020). */
  skipped: number;
}

/**
 * Reads and parses a device's oplog file, applying the hydration guard first (FR-014) -- a
 * caller that gets a `NotFullyHydratedError` out of this must halt the entire sync pass, per
 * the tactical plan's Milestone 5.
 *
 * Returns an empty result (not an error) for a file that does not exist yet -- a brand-new peer
 * that has not published anything is a normal, expected state, not a fault.
 */
export function readOplogEntries(filePath: string): ReadOplogResult {
  if (!fs.existsSync(filePath)) return { entries: [], skipped: 0 };

  const buf = readFileGuarded(filePath);
  const text = buf.toString("utf8");
  const lines = text.split("\n");

  const entries: OplogEntry[] = [];
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      console.warn(`[sync] skipping unparseable oplog line in ${filePath}:`, err);
      skipped += 1;
      continue;
    }

    if (!isPlausibleEntry(parsed)) {
      skipped += 1;
      continue;
    }

    if (parsed.v > CURRENT_OPLOG_VERSION) {
      console.warn(`[sync] skipping oplog entry with future schema version ${parsed.v} (this build understands ${CURRENT_OPLOG_VERSION})`);
      skipped += 1;
      continue;
    }

    entries.push(parsed as OplogEntry);
  }

  return { entries, skipped };
}

function isPlausibleEntry(value: unknown): value is OplogEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["v"] === "number" &&
    typeof v["opId"] === "string" &&
    typeof v["op"] === "string" &&
    KNOWN_OPS.has(v["op"]) &&
    typeof v["table"] === "string" &&
    typeof v["hlc"] === "object" &&
    v["hlc"] !== null
  );
}
