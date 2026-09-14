// electron/main/sync/row-codec.ts
// Converts between a database row's raw columns and the oplog's field representation.
//
// A foreign key column (state_id, project_id, parent_id, ...) only means something on the
// machine that assigned it -- another device's numeric ids for "the same" row are not
// guaranteed to match. Every foreign key is therefore carried in the oplog by the referenced
// row's own permanent uuid, and resolved back to a local numeric id (through the alias table,
// so a converged duplicate still resolves correctly) only when a merge actually applies it. See
// merge-engine.ts's `resolveForeignKeyUuid`.

import type Database from "better-sqlite3";
import type { OplogFieldValue, SyncedRowTable } from "./oplog.ts";

type DbHandle = Database.Database;

/** Columns that exist locally but must never leave this device: dense positions, and the id itself. */
const LOCAL_ONLY_COLUMNS: Partial<Record<SyncedRowTable, readonly string[]>> = {
  todo_states: ["position"],
  todo_projects: ["position"],
};

/** Every foreign key in this codebase's synced tables happens to reference a uuid-bearing table -- never `sessions`. */
export type ForeignKeyRefTable = Exclude<SyncedRowTable, "sessions">;

export interface ForeignKeySpec {
  /** The table the referenced id belongs to. */
  refTable: ForeignKeyRefTable;
  /** The name this reference is carried under in the oplog, e.g. "state_id" -> "state_uuid". */
  fieldName: string;
}

/** Foreign key columns, and which table their uuid resolves against. Only `todos` has any. */
const FOREIGN_KEYS: Partial<Record<SyncedRowTable, Record<string, ForeignKeySpec>>> = {
  todos: {
    state_id: { refTable: "todo_states", fieldName: "state_uuid" },
    project_id: { refTable: "todo_projects", fieldName: "project_uuid" },
    parent_id: { refTable: "todos", fieldName: "parent_uuid" },
  },
};

export function foreignKeysFor(table: SyncedRowTable): Record<string, ForeignKeySpec> {
  return FOREIGN_KEYS[table] ?? {};
}

/** The reverse map: oplog field name (e.g. "state_uuid") -> the spec, for applying a merge. */
export function foreignKeyByFieldName(table: SyncedRowTable): Record<string, { column: string; refTable: ForeignKeyRefTable }> {
  const result: Record<string, { column: string; refTable: ForeignKeyRefTable }> = {};
  for (const [column, spec] of Object.entries(foreignKeysFor(table))) {
    result[spec.fieldName] = { column, refTable: spec.refTable };
  }
  return result;
}

function scalarValue(value: unknown): OplogFieldValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return null;
}

/** Resolves a local numeric id to its permanent uuid. Null in, null out. */
export function uuidForLocalId(database: DbHandle, table: SyncedRowTable, id: number | null): string | null {
  if (id === null) return null;
  const row = database.prepare(`SELECT uuid FROM ${table} WHERE id = ?`).get(id) as
    | { uuid: string | null }
    | undefined;
  return row?.uuid ?? null;
}

/**
 * Builds the oplog `fields` map for a row, given its raw column values. Only the columns named
 * in `changedColumns` are included -- callers pass every persisted column on first publish, or
 * just the columns a specific update touched.
 */
export function encodeRowFields(
  database: DbHandle,
  table: SyncedRowTable,
  row: Record<string, unknown>,
  changedColumns: readonly string[],
): Record<string, OplogFieldValue> {
  const localOnly = new Set(LOCAL_ONLY_COLUMNS[table] ?? []);
  const foreignKeys = foreignKeysFor(table);
  const fields: Record<string, OplogFieldValue> = {};

  for (const column of changedColumns) {
    if (column === "id" || column === "uuid" || localOnly.has(column)) continue;

    const fk = foreignKeys[column];
    if (fk) {
      fields[fk.fieldName] = uuidForLocalId(database, fk.refTable, (row[column] as number | null) ?? null);
      continue;
    }

    fields[column] = scalarValue(row[column]);
  }

  return fields;
}

/** Every persisted column for a table (excluding sqlite internals), for a first full publish. */
export function allColumnsFor(database: DbHandle, table: SyncedRowTable): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/**
 * Coerces an oplog field value into something better-sqlite3's bind layer will actually accept.
 *
 * `OplogFieldValue` (oplog.ts) legally includes `boolean` -- and `createTodoState`/
 * `updateTodoState` (database.ts) really did publish raw JS `true`/`false` for
 * `is_completed`/`is_default` before that producer was fixed alongside this helper. A peer still
 * running an older build, or an oplog file already sitting in the shared folder from before that
 * fix, keeps carrying those raw booleans regardless of what a current build writes going
 * forward -- so the coercion has to live here, at the point a peer-authored field value is bound
 * into a SQL statement, not only at the producer. Real `better-sqlite3` throws
 * `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null` the instant a
 * raw JS boolean reaches `.run()`/`.get()`/`.all()` -- unlike the Vitest sql.js shim, which
 * silently tolerates one -- so every merge-engine.ts apply site that binds a `change.value` calls
 * this first (see merge-engine.ts's `applyFieldsLww` and `applySessionUpsert`).
 */
export function toBindValue(value: OplogFieldValue): string | number | null {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}
