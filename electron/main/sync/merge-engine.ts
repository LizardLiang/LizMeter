// electron/main/sync/merge-engine.ts
// Applies oplog entries read from every peer's file into this device's local database
// (FR-007, FR-008, FR-009, FR-010, FR-011). Called by the watcher (Milestone 5) whenever new
// entries are read.
//
// Every apply runs inside one transaction, matching the existing transaction discipline already
// used elsewhere in database.ts (`reorderTodoStates`, `seedTodoStates`) -- this is what gives
// field-level LWW its correctness, and it means a merge can never be observed half-applied by a
// concurrent MCP write on the same connection, since better-sqlite3 is synchronous and a
// transaction blocks the connection for its duration.

import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { collectAttachmentBlobs } from "../attachment-store.ts";
import { advanceTodoIdWatermark, getOrAssignDeviceNumber } from "./device-identity.ts";
import { compareHlc, receive, type Hlc } from "./hlc.ts";
import { generateOrderedKeys } from "./lexorank.ts";
import type { OplogEntry, OplogFieldValue, OplogUpsertEntry } from "./oplog.ts";
import { foreignKeyByFieldName } from "./row-codec.ts";
import { addSyncNotice } from "./notices.ts";

type DbHandle = Database.Database;

/** The five tables that carry their own permanent `uuid` column (Milestone 1). */
export type UuidTable = "todos" | "tags" | "todo_labels" | "todo_states" | "todo_projects";

/** Tables whose rows converge on a shared name (FR-010) -- all four carry `UNIQUE(name COLLATE NOCASE)`. */
const NAME_UNIQUE_FIELD: Partial<Record<UuidTable, string>> = {
  tags: "name",
  todo_labels: "name",
  todo_projects: "name",
  todo_states: "label",
};

// Note: convergence never needs to repoint dependent foreign keys (todo_label_links.label_id,
// todos.project_id/state_id, session_tags.tag_id). Whichever row survives keeps its own local
// numeric id in every case below -- only its `uuid` column ever moves -- so every existing local
// reference by numeric id stays valid without touching a single dependent row.

export interface ApplyResult {
  applied: number;
  skippedAlreadyApplied: number;
  notices: number;
}

function isAlreadyApplied(database: DbHandle, opId: string): boolean {
  return database.prepare("SELECT 1 FROM sync_applied_ops WHERE op_id = ?").get(opId) !== undefined;
}

function markApplied(database: DbHandle, opId: string, hlc: Hlc): void {
  database
    .prepare("INSERT OR IGNORE INTO sync_applied_ops (op_id, device_id, applied_at) VALUES (?, ?, ?)")
    .run(opId, String(hlc.deviceNumber), new Date().toISOString());
}

/** Follows old_uuid -> new_uuid chains left by name-unique convergence, to the final live uuid. */
function resolveAlias(database: DbHandle, table: string, uuid: string): string {
  let current = uuid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current; // defensive: a cycle should never exist
    seen.add(current);
    const row = database
      .prepare("SELECT new_uuid FROM sync_id_aliases WHERE table_name = ? AND old_uuid = ?")
      .get(table, current) as { new_uuid: string } | undefined;
    if (!row) return current;
    current = row.new_uuid;
  }
}

function isTombstoned(database: DbHandle, table: string, rowUuid: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sync_tombstones WHERE table_name = ? AND row_uuid = ?").get(table, rowUuid)
      !== undefined
  );
}

function localIdByUuid(database: DbHandle, table: UuidTable, uuid: string): number | null {
  const row = database.prepare(`SELECT id FROM ${table} WHERE uuid = ?`).get(uuid) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Per-table allow-list of real column names, read once via `PRAGMA table_info` and cached for
 * the process lifetime -- a table's own columns only ever change via this app's own migrations,
 * never at runtime. This is the second half of B-1's fix: `entry.table` is already restricted to
 * a known table by `oplog.ts`'s `isPlausibleEntry`, but a field *name* inside `entry.fields` is
 * still whatever key a peer's (possibly corrupt, possibly malicious) oplog or snapshot file
 * happened to carry, and it reaches `UPDATE ${table} SET ${fieldName} = ?` in `applyFieldsLww`/
 * `applySessionUpsert` with no other check in between.
 */
const knownColumnsCache = new Map<string, ReadonlySet<string>>();

function knownColumnsFor(database: DbHandle, table: string): ReadonlySet<string> {
  const cached = knownColumnsCache.get(table);
  if (cached) return cached;
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  knownColumnsCache.set(table, columns);
  return columns;
}

/**
 * True when `fieldName` is a real column of `table`. A field that fails this check is skipped,
 * not fatal -- mirroring FR-020's "skip and log, never fatal" posture for anything unrecognized
 * arriving from a peer, and closing the same hole a `console.warn`-then-abort would have left
 * (Hermes's B-1: an unknown column previously threw and killed every future merge pass silently).
 */
function isKnownColumn(database: DbHandle, table: string, fieldName: string): boolean {
  return knownColumnsFor(database, table).has(fieldName);
}

/**
 * Applies every entry not already recorded in `sync_applied_ops`, in HLC order, inside one
 * transaction. Safe to call repeatedly with overlapping or duplicate entries -- idempotent by
 * `opId` (Milestone 3).
 */
export function applyOplogEntries(database: DbHandle, entries: readonly OplogEntry[]): ApplyResult {
  const pending = entries.filter((e) => !isAlreadyApplied(database, e.opId));
  const sorted = [...pending].sort((a, b) => compareHlc(a.hlc, b.hlc));

  let applied = 0;
  let notices = 0;
  const deviceNumber = getOrAssignDeviceNumber(database);

  const run = database.transaction(() => {
    // Captured before anything is applied, so the renumbering notice can tell "this todo moved
    // under the user" apart from "this todo arrived and was placed".
    const todoIdsBefore = snapshotTodoIds(database);

    for (const entry of sorted) {
      const { clamped } = receive(database, deviceNumber, entry.hlc);
      if (clamped) {
        addSyncNotice(
          database,
          "clock-drift",
          `A change from device ${entry.hlc.deviceNumber} arrived with a clock far ahead of this one and was clamped`,
          `entry ${entry.opId}, table ${entry.table}`,
        );
        notices += 1;
      }

      // B-5: markApplied only runs when the entry's work is actually done. `sync_applied_ops`
      // is what `merge-pass.ts`'s `isAlreadyApplied` filters future passes on, so marking an
      // entry whose real work was skipped (a link whose todo has not arrived, a field whose
      // foreign key is unresolved) makes that skip permanent -- the comment this used to carry,
      // claiming such a field is "retried on the next pass", was not actually true: nothing ever
      // re-read this specific entry again once it was marked. Leaving it unmarked here is what
      // makes the retry real, since a future pass re-reads the same peer file and re-considers
      // every entry `sync_applied_ops` does not yet contain.
      let fullyApplied = true;
      if (entry.op === "delete") {
        applyDelete(database, entry.table, entry.rowUuid, entry.hlc);
      } else if (entry.op === "upsert") {
        const outcome = applyUpsert(database, entry);
        if (outcome.noticeRaised) notices += 1;
        fullyApplied = outcome.fullyApplied;
      } else {
        fullyApplied = applyLink(database, entry.table, entry.op, entry.fields.fromUuid, entry.fields.toUuid);
      }

      if (fullyApplied) {
        markApplied(database, entry.opId, entry.hlc);
      }
      // Counts toward "did this pass do anything" (used to decide whether to refresh the
      // renderer) regardless of fullyApplied -- a partially-applied upsert (some fields written,
      // one FK still unresolved) is real, visible work even though the entry itself is retried.
      applied += 1;
    }

    recomputeLocalPositionFromSyncOrder(database, "todo_states");
    recomputeLocalPositionFromSyncOrder(database, "todo_projects");

    // Derive every todo's visible id from the full set of claims now that the whole pass has been
    // applied -- once, over the settled set, rather than per-entry as rows stream in.
    reconcileTodoIds(database);
    noticeUserVisibleRenumbering(database, todoIdsBefore);

    // Take this device's todo counter past everything the pass just learned about, so a machine
    // returning from an offline window does not immediately re-claim numbers its peer already
    // used. Reads the table after reconciliation, so it clears the derived ids too.
    const { maxId } = database.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos").get() as { maxId: number };
    advanceTodoIdWatermark(database, maxId);
  });
  run();

  return { applied, skippedAlreadyApplied: entries.length - pending.length, notices };
}

// --- Delete (FR-007) ---

function applyDelete(database: DbHandle, table: OplogEntry["table"], rowUuid: string, hlc: Hlc): void {
  const canonicalUuid = table === "todo_attachments" ? rowUuid : resolveAlias(database, table, rowUuid);

  database
    .prepare(
      `INSERT OR REPLACE INTO sync_tombstones
         (table_name, row_uuid, deleted_at, hlc_physical_ms, hlc_counter, hlc_device_number)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(table, canonicalUuid, new Date().toISOString(), hlc.physicalMs, hlc.counter, hlc.deviceNumber);
  database.prepare("DELETE FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ?").run(table, canonicalUuid);

  if (table === "sessions") {
    database.prepare("DELETE FROM sessions WHERE id = ?").run(canonicalUuid);
    return;
  }
  if (table === "todo_attachments") {
    const [todoUuid, sha256] = splitAttachmentKey(canonicalUuid);
    const row = database
      .prepare(`SELECT a.id FROM todo_attachments a INNER JOIN todos t ON t.id = a.todo_id WHERE t.uuid = ? AND a.sha256 = ?`)
      .get(todoUuid, sha256) as { id: number } | undefined;
    if (row) database.prepare("DELETE FROM todo_attachments WHERE id = ?").run(row.id);
    collectAttachmentBlobs([sha256]);
    return;
  }

  const localId = localIdByUuid(database, table as UuidTable, canonicalUuid);
  if (localId === null) return;

  if (table === "todos") {
    const shas = database
      .prepare("SELECT sha256 FROM todo_attachments WHERE todo_id = ?")
      .all(localId)
      .map((r) => (r as { sha256: string }).sha256);
    database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId);
    collectAttachmentBlobs(shas);
    return;
  }

  if (table === "todo_states") {
    // Unlike `project_id` (ON DELETE SET NULL in the schema), `state_id` has no delete action --
    // a bare DELETE would violate the foreign key while a todo still points at this state, since
    // `foreign_keys = ON`. Reassign to another state first, mirroring what `deleteTodoState`
    // already does for a local delete.
    const fallback = database
      .prepare("SELECT id FROM todo_states WHERE id != ? AND is_default = 1 LIMIT 1")
      .get(localId) as { id: number } | undefined
      ?? database.prepare("SELECT id FROM todo_states WHERE id != ? ORDER BY position ASC LIMIT 1").get(localId) as
        | { id: number }
        | undefined;
    database.prepare("UPDATE todos SET state_id = ? WHERE state_id = ?").run(fallback?.id ?? null, localId);
  }

  database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId);
}

function splitAttachmentKey(key: string): [string, string] {
  const idx = key.lastIndexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// --- Link / unlink ---

/**
 * Returns whether the link/unlink actually happened. `false` (the referenced row has not arrived
 * yet -- see notes in row-codec.ts) must leave the entry unmarked in `sync_applied_ops` (B-5), or
 * it is lost the moment the referenced row *does* arrive, since nothing will ever reconsider it.
 */
function applyLink(database: DbHandle, table: OplogEntry["table"], op: "link" | "unlink", fromUuid: string, toUuid: string): boolean {
  if (table === "todo_label_links") {
    const todoId = localIdByUuid(database, "todos", resolveAlias(database, "todos", fromUuid));
    const labelId = localIdByUuid(database, "todo_labels", resolveAlias(database, "todo_labels", toUuid));
    if (todoId === null || labelId === null) return false;
    if (op === "link") {
      database.prepare("INSERT OR IGNORE INTO todo_label_links (todo_id, label_id) VALUES (?, ?)").run(todoId, labelId);
    } else {
      database.prepare("DELETE FROM todo_label_links WHERE todo_id = ? AND label_id = ?").run(todoId, labelId);
    }
    return true;
  }

  if (table === "session_tags") {
    const tagId = localIdByUuid(database, "tags", resolveAlias(database, "tags", toUuid));
    if (tagId === null) return false;
    const sessionExists = database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(fromUuid) !== undefined;
    if (!sessionExists) return false;
    if (op === "link") {
      database.prepare("INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)").run(fromUuid, tagId);
    } else {
      database.prepare("DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?").run(fromUuid, tagId);
    }
    return true;
  }

  return true; // unreachable given oplog.ts's KNOWN_TABLES gate; exhaustive for the type checker
}

// --- Upsert (FR-008, FR-010) ---

/**
 * `fullyApplied` (B-5) is false only when some part of this entry's work is waiting on
 * something that has not arrived yet (an unresolved foreign key) -- the caller must leave such
 * an entry unmarked in `sync_applied_ops` so a later pass reconsiders it, or the deferred part is
 * lost forever the moment the row it was waiting on does arrive. A discard-after-delete or an
 * already-satisfied no-op is a *final* outcome, not a deferral, and is always fully applied.
 */
interface ApplyOutcome {
  fullyApplied: boolean;
  noticeRaised: boolean;
}

function applyUpsert(database: DbHandle, entry: OplogUpsertEntry): ApplyOutcome {
  if (entry.table === "todo_attachments") {
    return applyAttachmentUpsert(database, entry);
  }
  if (entry.table === "sessions") {
    return applySessionUpsert(database, entry);
  }

  const table = entry.table as UuidTable;
  const canonicalUuid = resolveAlias(database, table, entry.rowUuid);

  if (isTombstoned(database, table, canonicalUuid)) {
    addSyncNotice(
      database,
      "discard-after-delete",
      `An edit to a deleted ${table} record was discarded`,
      `row ${canonicalUuid}, fields ${Object.keys(entry.fields).join(", ")}, from device ${entry.hlc.deviceNumber}`,
    );
    return { fullyApplied: true, noticeRaised: true };
  }

  let localId = localIdByUuid(database, table, canonicalUuid);
  let effectiveUuid = canonicalUuid;

  if (localId === null) {
    const converged = convergeOnName(database, table, canonicalUuid, entry);
    if (converged) {
      localId = converged.localId;
      effectiveUuid = converged.uuid;
    } else {
      // The peer's *claim* on a number, not a final id: two machines working apart routinely claim
      // the same one. The row is parked on any free number here and `reconcileTodoIds` (run once
      // at the end of the pass, over the whole set) decides what it actually ends up holding.
      // `id` is read as a fallback for entries written before `claimed_id` existed.
      const claimedId = table === "todos" ? incomingClaimedId(entry) : null;
      localId = insertPlaceholderRow(database, table, canonicalUuid, freeTodoIdNear(database, claimedId));
      if (claimedId !== null) {
        database.prepare("UPDATE todos SET claimed_id = ? WHERE id = ?").run(claimedId, localId);
      }
    }
  }

  const fullyApplied = applyFieldsLww(database, table, effectiveUuid, localId, entry.fields);
  return { fullyApplied, noticeRaised: false };
}

/**
 * Name-unique convergence (FR-010): if a row with the same normalized name already exists
 * locally under a different uuid, exactly one of the two survives. The row created earlier
 * (compared by its `created_at` field, with the uuid as a final deterministic tie-break so both
 * devices land on the same winner) is canonical; the other's uuid becomes an alias.
 */
function convergeOnName(
  database: DbHandle,
  table: UuidTable,
  incomingUuid: string,
  entry: OplogUpsertEntry,
): { localId: number; uuid: string } | null {
  const nameField = NAME_UNIQUE_FIELD[table];
  if (nameField === undefined) return null;

  const incomingName = entry.fields[nameField]?.value;
  if (typeof incomingName !== "string") return null;

  const existing = database
    .prepare(`SELECT id, uuid, created_at FROM ${table} WHERE ${nameField} = ? COLLATE NOCASE`)
    .get(incomingName) as { id: number; uuid: string | null; created_at: string } | undefined;
  if (!existing) return null;

  // Every row should always carry a uuid from the moment it is created (seeded defaults
  // included) -- but this is cheap insurance against any insert path that ever forgets to: a
  // row still missing one at merge time gets one now, so it can converge instead of silently
  // colliding with the incoming row's name a moment later.
  if (existing.uuid === null) {
    existing.uuid = crypto.randomUUID();
    database.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`).run(existing.uuid, existing.id);
  }
  if (existing.uuid === incomingUuid) return null;

  const incomingCreatedAt = typeof entry.fields["created_at"]?.value === "string"
    ? (entry.fields["created_at"]!.value as string)
    : new Date(entry.hlc.physicalMs).toISOString();

  const incomingIsEarlier = incomingCreatedAt < existing.created_at
    || (incomingCreatedAt === existing.created_at && incomingUuid < existing.uuid);

  if (incomingIsEarlier) {
    // The incoming row is actually the canonical one. The existing local row keeps its numeric
    // id (every local reference already points at it) but its uuid moves to the incoming one,
    // and the old uuid becomes the alias.
    database
      .prepare("INSERT OR REPLACE INTO sync_id_aliases (table_name, old_uuid, new_uuid, created_at) VALUES (?, ?, ?, ?)")
      .run(table, existing.uuid, incomingUuid, new Date().toISOString());
    database.prepare(`UPDATE ${table} SET uuid = ? WHERE id = ?`).run(incomingUuid, existing.id);
    database
      .prepare("UPDATE sync_field_clocks SET row_uuid = ? WHERE table_name = ? AND row_uuid = ?")
      .run(incomingUuid, table, existing.uuid);
    return { localId: existing.id, uuid: incomingUuid };
  }

  // The existing local row is canonical; the incoming row loses. Alias it, and apply its fields
  // onto the survivor via the normal field-LWW path below.
  database
    .prepare("INSERT OR REPLACE INTO sync_id_aliases (table_name, old_uuid, new_uuid, created_at) VALUES (?, ?, ?, ?)")
    .run(table, incomingUuid, existing.uuid, new Date().toISOString());
  return { localId: existing.id, uuid: existing.uuid };
}

// --- Dense todo id collision resolution ---

/**
 * Moves a todo row from one numeric id to another, carrying every reference with it.
 *
 * `foreign_keys = ON` (database.ts) makes the obvious `UPDATE todos SET id = ?` throw the moment
 * any child row points at the old id, and `runMergePassSafely` funnels a throw here into a bare
 * `console.warn` -- so getting this wrong fails *silently, on every merge pass, forever*. Exactly
 * the shape of the shipped R2-B3 bug, where a bare DELETE's foreign-key violation rolled back a
 * whole wipe unnoticed.
 *
 * `defer_foreign_keys` postpones the constraint check to COMMIT, so the row and its three
 * referencing sites can move together inside the transaction `applyOplogEntries` already holds and
 * be consistent by the time anything is verified. This is deliberately used instead of declaring
 * `ON UPDATE CASCADE`: that would mean rebuilding `todos` (a ~15-column table assembled by three
 * separate migrations) plus both referencing tables on every existing install, to change one
 * constraint. Primary-key uniqueness is NOT deferred, so the caller must always vacate the target
 * id before calling this.
 */
export function moveTodoRowId(database: DbHandle, fromId: number, toId: number): void {
  if (fromId === toId) return;
  database.pragma("defer_foreign_keys = ON");
  database.prepare("UPDATE todos SET id = ? WHERE id = ?").run(toId, fromId);
  database.prepare("UPDATE todos SET parent_id = ? WHERE parent_id = ?").run(toId, fromId);
  database.prepare("UPDATE todo_label_links SET todo_id = ? WHERE todo_id = ?").run(toId, fromId);
  database.prepare("UPDATE todo_attachments SET todo_id = ? WHERE todo_id = ?").run(toId, fromId);
}

/** FR-031 posture: recorded for the user to find in Settings, never an OS notification. */
function noteReassignment(database: DbHandle, oldId: number, newId: number): void {
  addSyncNotice(
    database,
    "todo-id-reassigned",
    `Todo #${oldId} was renumbered to #${newId} because another machine had already used that number.`,
    `old id ${oldId}, new id ${newId}`,
  );
}

/** The number a peer's entry claims, tolerating the pre-`claimed_id` entries that carried `id`. */
function incomingClaimedId(entry: OplogUpsertEntry): number | null {
  const claimed = entry.fields["claimed_id"]?.value;
  if (typeof claimed === "number") return claimed;
  const legacy = entry.fields["id"]?.value;
  return typeof legacy === "number" ? legacy : null;
}

/**
 * A number this row can be parked on right now: its claim when that happens to be free, otherwise
 * any unused number. Nothing about this choice is load-bearing -- `reconcileTodoIds` overwrites it
 * with the derived answer before the merge transaction commits -- it only has to not collide.
 */
function freeTodoIdNear(database: DbHandle, claimedId: number | null): number | null {
  if (claimedId === null) return null;
  const taken = database.prepare("SELECT 1 FROM todos WHERE id = ?").get(claimedId) !== undefined;
  if (!taken) return claimedId;
  const { maxId } = database.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM todos").get() as { maxId: number };
  return maxId + 1;
}

interface TodoIdRow {
  id: number;
  claimed_id: number | null;
  created_at: string;
  uuid: string | null;
}

/** The total order both machines sort by. Same rule `convergeOnName` uses for FR-010. */
function compareTodoIdRows(a: TodoIdRow, b: TodoIdRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  const au = a.uuid ?? "";
  const bu = b.uuid ?? "";
  if (au !== bu) return au < bu ? -1 : 1;
  return a.id - b.id;
}

/**
 * Derives every todo's visible id from the full set of claims, and applies the result.
 *
 * This is the heart of dense-id convergence, and it is a **pure function of the merged set**: the
 * earliest-created claimant of a number keeps it, and every later claimant of an already-taken
 * number is placed after the highest claim, in the same order. Two machines holding the same set
 * of todos therefore compute byte-identical assignments without exchanging a single message about
 * it.
 *
 * The design this replaced tried to negotiate instead -- each machine picked a replacement number
 * from its own counter and published it as a last-write-wins field. That never converged: a
 * machine's own write always carries a newer clock than the peer's, so each side permanently
 * rejected the other's answer and the two stayed stably, silently disagreed. Deriving rather than
 * negotiating removes the arbitration entirely.
 *
 * Uncontested todos keep their number forever -- their claim is always free, so they are assigned
 * it on every pass and never move. Only a genuinely contested number can shift, and only until
 * both machines have seen the same todos.
 */
export function reconcileTodoIds(database: DbHandle): number {
  const rows = database
    .prepare("SELECT id, claimed_id, created_at, uuid FROM todos")
    .all() as TodoIdRow[];
  if (rows.length === 0) return 0;

  const ordered = [...rows].sort(compareTodoIdRows);
  const claimOf = (r: TodoIdRow): number => r.claimed_id ?? r.id;

  const taken = new Set<number>();
  const desired = new Map<number, number>(); // current id -> id it should hold
  const contested: TodoIdRow[] = [];

  for (const row of ordered) {
    const claim = claimOf(row);
    if (taken.has(claim)) {
      contested.push(row);
      continue;
    }
    taken.add(claim);
    desired.set(row.id, claim);
  }

  let next = Math.max(...ordered.map(claimOf), 0) + 1;
  for (const row of contested) {
    while (taken.has(next)) next += 1;
    taken.add(next);
    desired.set(row.id, next);
    next += 1;
  }

  const moves = [...desired.entries()].filter(([from, to]) => from !== to);
  if (moves.length === 0) return 0;

  // Two phases via temporary negative ids: primary-key uniqueness is NOT deferrable, so a row
  // cannot move onto a number another row has not vacated yet. Negatives can never collide with a
  // real id, which makes the intermediate state safe regardless of how the moves permute.
  database.pragma("defer_foreign_keys = ON");
  moves.forEach(([from], index) => moveTodoRowId(database, from, -(index + 1)));
  moves.forEach(([, to], index) => moveTodoRowId(database, -(index + 1), to));

  return moves.length;
}

/** uuid -> visible id, for the before/after comparison that decides what is worth telling the user. */
function snapshotTodoIds(database: DbHandle): Map<string, number> {
  const rows = database.prepare("SELECT id, uuid FROM todos WHERE uuid IS NOT NULL").all() as Array<
    { id: number; uuid: string }
  >;
  return new Map(rows.map((r) => [r.uuid, r.id]));
}

/**
 * Reports only the renumberings this machine's user would actually notice: a todo that was already
 * on screen under one number and is now under another. A row that arrived during this same pass
 * has no "before" here, so the parking slot it briefly occupied on its way to its derived id is
 * never mentioned -- that is bookkeeping, not something the user saw.
 */
function noticeUserVisibleRenumbering(database: DbHandle, before: Map<string, number>): void {
  const after = snapshotTodoIds(database);
  for (const [uuid, previousId] of before) {
    const currentId = after.get(uuid);
    if (currentId !== undefined && currentId !== previousId) noteReassignment(database, previousId, currentId);
  }
}

function placeholderText(uuid: string): string {
  return `(unnamed ${uuid.slice(0, 8)})`;
}

function lastInsertRowid(database: DbHandle): number {
  const { id } = database.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
  return id;
}

/**
 * Inserts a minimal row satisfying schema constraints; `applyFieldsLww` fills in real values
 * right after. `explicitId` is only ever set for `todos` -- see the comment at this function's
 * call site.
 */
function insertPlaceholderRow(database: DbHandle, table: UuidTable, uuid: string, explicitId: number | null = null): number {
  // `last_insert_rowid()` read via a follow-up SELECT rather than the statement result's
  // `lastInsertRowid`: the same statement then works under both better-sqlite3 and the sql.js
  // test shim, which does not populate that field -- matching the convention already
  // established everywhere else in database.ts's own create functions.
  const now = new Date().toISOString();
  switch (table) {
    case "todos": {
      const defaultState = database.prepare("SELECT id FROM todo_states ORDER BY position ASC LIMIT 1").get() as
        | { id: number }
        | undefined;
      if (explicitId !== null) {
        database
          .prepare("INSERT INTO todos (id, title, state_id, source, created_at, uuid) VALUES (?, ?, ?, 'user', ?, ?)")
          .run(explicitId, "", defaultState?.id ?? null, now, uuid);
        return explicitId;
      }
      database
        .prepare("INSERT INTO todos (title, state_id, source, created_at, uuid) VALUES (?, ?, 'user', ?, ?)")
        .run("", defaultState?.id ?? null, now, uuid);
      return lastInsertRowid(database);
    }
    case "tags": {
      database
        .prepare("INSERT INTO tags (name, created_at, uuid) VALUES (?, ?, ?)")
        .run(placeholderText(uuid), now, uuid);
      return lastInsertRowid(database);
    }
    case "todo_labels": {
      database
        .prepare("INSERT INTO todo_labels (name, created_at, uuid) VALUES (?, ?, ?)")
        .run(placeholderText(uuid), now, uuid);
      return lastInsertRowid(database);
    }
    case "todo_states": {
      const { next } = database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_states").get() as
        { next: number };
      database
        .prepare("INSERT INTO todo_states (label, position, created_at, uuid) VALUES (?, ?, ?, ?)")
        .run(placeholderText(uuid), next, now, uuid);
      return lastInsertRowid(database);
    }
    case "todo_projects": {
      const { next } = database.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects").get() as
        { next: number };
      database
        .prepare("INSERT INTO todo_projects (name, position, created_at, uuid) VALUES (?, ?, ?, ?)")
        .run(placeholderText(uuid), next, now, uuid);
      return lastInsertRowid(database);
    }
  }
}

/**
 * Field-level LWW (FR-008): for each field the entry touches, compares against the persisted
 * high-water mark in `sync_field_clocks` and applies only when the incoming value is newer.
 * Foreign key fields (`state_uuid`, `project_uuid`, `parent_uuid`) are resolved back to a local
 * numeric id through the alias table; an unresolvable reference (the referenced row has not
 * synced to this device yet) is skipped for now rather than blocking the rest of the entry --
 * see row-codec.ts's header comment.
 *
 * Returns `false` (B-5) when any field was skipped for that reason, so the caller leaves the
 * whole entry unmarked in `sync_applied_ops` and a later pass reconsiders it -- already-applied
 * fields simply no-op again via their own clock check, so re-attempting the entry is always safe.
 * An unknown field name (B-1) is a *permanent*, not temporary, skip -- retrying it can never
 * succeed, so it does not by itself make the return value `false`.
 */
function applyFieldsLww(
  database: DbHandle,
  table: UuidTable,
  rowUuid: string,
  localId: number,
  fields: Record<string, { value: OplogFieldValue; hlc: Hlc }>,
): boolean {
  const currentId = localId;
  const fkByFieldName = foreignKeyByFieldName(table);
  const getClock = database.prepare(
    "SELECT hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks WHERE table_name = ? AND row_uuid = ? AND field_name = ?",
  );
  const setClock = database.prepare(
    `INSERT OR REPLACE INTO sync_field_clocks
       (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let fullyApplied = true;

  for (const [fieldName, change] of Object.entries(fields)) {
    const existingClock = getClock.get(table, rowUuid, fieldName) as
      | { hlc_physical_ms: number; hlc_counter: number; hlc_device_number: number }
      | undefined;
    if (existingClock) {
      const existingHlc: Hlc = {
        physicalMs: existingClock.hlc_physical_ms,
        counter: existingClock.hlc_counter,
        deviceNumber: existingClock.hlc_device_number,
      };
      if (compareHlc(change.hlc, existingHlc) <= 0) continue; // not newer -- this field keeps its current value
    }

    // `id` never travels as a value to write: the visible id is derived by `reconcileTodoIds`.
    // A peer running an older build still publishes one, so it is folded into that row's claim
    // instead of being written to the primary key.
    if (fieldName === "id") {
      if (table === "todos" && typeof change.value === "number") {
        database.prepare("UPDATE todos SET claimed_id = ? WHERE id = ? AND claimed_id IS NULL")
          .run(change.value, currentId);
      }
      continue;
    }

    const fk = fkByFieldName[fieldName];
    if (fk) {
      // fk.column comes from row-codec.ts's own static FOREIGN_KEYS config, never from the
      // entry -- safe to interpolate regardless of what fieldName itself is.
      if (change.value === null) {
        database.prepare(`UPDATE ${table} SET ${fk.column} = NULL WHERE id = ?`).run(currentId);
      } else if (typeof change.value === "string") {
        const refId = localIdByUuid(database, fk.refTable, resolveAlias(database, fk.refTable, change.value));
        if (refId === null) {
          fullyApplied = false; // referenced row not synced yet -- retry this entry on a later pass (B-5)
          continue;
        }
        database.prepare(`UPDATE ${table} SET ${fk.column} = ? WHERE id = ?`).run(refId, currentId);
      } else {
        continue;
      }
    } else {
      // B-1: fieldName here is not one of row-codec.ts's known foreign keys, so it is about to
      // be interpolated verbatim -- it must be a real column of this table first. Permanently
      // skipped, not deferred: no future pass can make an unknown column become known.
      if (!isKnownColumn(database, table, fieldName)) {
        console.warn(`[sync] skipping unknown field "${fieldName}" for table "${table}" (row ${rowUuid})`);
        continue;
      }
      database.prepare(`UPDATE ${table} SET ${fieldName} = ? WHERE id = ?`).run(change.value, currentId);
    }

    setClock.run(table, rowUuid, fieldName, change.hlc.physicalMs, change.hlc.counter, change.hlc.deviceNumber);
  }

  return fullyApplied;
}

function applySessionUpsert(database: DbHandle, entry: OplogUpsertEntry): ApplyOutcome {
  const sessionId = entry.rowUuid;
  if (isTombstoned(database, "sessions", sessionId)) {
    addSyncNotice(database, "discard-after-delete", "An edit to a deleted session was discarded", `session ${sessionId}`);
    return { fullyApplied: true, noticeRaised: true };
  }

  const exists = database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId) !== undefined;
  if (!exists) {
    database
      .prepare(
        "INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at) VALUES (?, '', 'work', 0, 0, ?)",
      )
      .run(sessionId, new Date().toISOString());
  }

  const getClock = database.prepare(
    "SELECT hlc_physical_ms, hlc_counter, hlc_device_number FROM sync_field_clocks WHERE table_name = 'sessions' AND row_uuid = ? AND field_name = ?",
  );
  const setClock = database.prepare(
    "INSERT OR REPLACE INTO sync_field_clocks (table_name, row_uuid, field_name, hlc_physical_ms, hlc_counter, hlc_device_number) VALUES ('sessions', ?, ?, ?, ?, ?)",
  );

  for (const [fieldName, change] of Object.entries(entry.fields)) {
    const existingClock = getClock.get(sessionId, fieldName) as
      | { hlc_physical_ms: number; hlc_counter: number; hlc_device_number: number }
      | undefined;
    if (existingClock) {
      const existingHlc: Hlc = {
        physicalMs: existingClock.hlc_physical_ms,
        counter: existingClock.hlc_counter,
        deviceNumber: existingClock.hlc_device_number,
      };
      if (compareHlc(change.hlc, existingHlc) <= 0) continue;
    }
    // B-1: same guard as applyFieldsLww -- fieldName is about to be interpolated verbatim.
    if (!isKnownColumn(database, "sessions", fieldName)) {
      console.warn(`[sync] skipping unknown field "${fieldName}" for table "sessions" (row ${sessionId})`);
      continue;
    }
    database.prepare(`UPDATE sessions SET ${fieldName} = ? WHERE id = ?`).run(change.value, sessionId);
    setClock.run(sessionId, fieldName, change.hlc.physicalMs, change.hlc.counter, change.hlc.deviceNumber);
  }
  // Sessions carry no foreign keys (row-codec.ts's FOREIGN_KEYS only names todos), so there is
  // no "waiting on an unresolved reference" case here -- always a final outcome.
  return { fullyApplied: true, noticeRaised: false };
}

function applyAttachmentUpsert(database: DbHandle, entry: OplogUpsertEntry): ApplyOutcome {
  const [todoUuid, sha256] = splitAttachmentKey(entry.rowUuid);
  if (isTombstoned(database, "todo_attachments", entry.rowUuid)) {
    addSyncNotice(
      database,
      "discard-after-delete",
      "An edit to a deleted attachment was discarded",
      `attachment ${entry.rowUuid}, from device ${entry.hlc.deviceNumber}`,
    );
    return { fullyApplied: true, noticeRaised: true };
  }

  const todoId = localIdByUuid(database, "todos", resolveAlias(database, "todos", todoUuid));
  if (todoId === null) return { fullyApplied: false, noticeRaised: false }; // parent todo has not synced yet -- retried whenever this file is re-read (B-5)

  const existing = database
    .prepare("SELECT id FROM todo_attachments WHERE todo_id = ? AND sha256 = ?")
    .get(todoId, sha256) as { id: number } | undefined;
  if (existing) return { fullyApplied: true, noticeRaised: false }; // content-addressed: identical bytes already recorded, nothing to update

  const fileName = typeof entry.fields["file_name"]?.value === "string" ? entry.fields["file_name"]!.value as string : sha256;
  const mimeType = typeof entry.fields["mime_type"]?.value === "string"
    ? entry.fields["mime_type"]!.value as string
    : "application/octet-stream";
  const sizeBytes = typeof entry.fields["size_bytes"]?.value === "number" ? entry.fields["size_bytes"]!.value : 0;
  const kind = typeof entry.fields["kind"]?.value === "string" ? entry.fields["kind"]!.value as string : "file";

  database
    .prepare(
      "INSERT OR IGNORE INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(todoId, sha256, fileName, mimeType, sizeBytes, kind, new Date().toISOString());
  return { fullyApplied: true, noticeRaised: false };
}

// --- Ordering convergence (FR-011) ---

/**
 * After a merge brings in new `sync_order` values, sorts every row by that key and rewrites the
 * dense integer `position` column 0..N-1 -- reusing the exact shape `reorderTodoStates` /
 * `reorderTodoProjects` already produce, so the rendering code and its existing tests need no
 * changes. Rows without a `sync_order` yet (never touched by a synced reorder) sort after every
 * row that has one, keeping their existing relative order among themselves.
 */
export function recomputeLocalPositionFromSyncOrder(database: DbHandle, table: "todo_states" | "todo_projects"): void {
  const rows = database.prepare(`SELECT id, sync_order, position FROM ${table} ORDER BY position ASC`).all() as Array<
    { id: number; sync_order: string | null; position: number }
  >;
  if (rows.length === 0) return;
  if (rows.every((r) => r.sync_order === null)) return; // nothing has ever synced an order -- leave local positions untouched

  const sorted = [...rows].sort((a, b) => {
    if (a.sync_order === null && b.sync_order === null) return a.position - b.position;
    if (a.sync_order === null) return 1;
    if (b.sync_order === null) return -1;
    return a.sync_order < b.sync_order ? -1 : a.sync_order > b.sync_order ? 1 : 0;
  });

  const setPosition = database.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
  sorted.forEach((row, index) => {
    if (row.position !== index) setPosition.run(index, row.id);
  });
}

/**
 * Generates a brand new set of `sync_order` values for a full local reorder, one call per
 * `reorderTodoStates`/`reorderTodoProjects` call -- see sync-writer.ts's `recordReorder`.
 */
export function generateSyncOrderForReorder(count: number): string[] {
  return generateOrderedKeys(count);
}
