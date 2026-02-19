// Shim that provides a better-sqlite3-compatible API using sql.js (pure WebAssembly).
// Used by Vitest to avoid native ABI conflicts between Bun (NMV 137) and Electron (NMV 143).
import initSqlJs from "sql.js";
import type { Database as SqlJsDb } from "sql.js";

// Top-level await: resolved before any test imports this module
const SQL = await initSqlJs();

type BindParam = string | number | null | Uint8Array;
type Row = Record<string, unknown>;

class Statement {
  constructor(
    private _db: SqlJsDb,
    private _sql: string,
  ) {}

  run(...params: unknown[]): this {
    if (params.length > 0) {
      this._db.run(this._sql, params as BindParam[]);
    } else {
      this._db.run(this._sql);
    }
    return this;
  }

  get(...params: unknown[]): Row | undefined {
    const stmt = this._db.prepare(this._sql);
    try {
      if (params.length > 0) stmt.bind(params as BindParam[]);
      // getAsObject() with no args returns the current row without re-binding
      return stmt.step() ? (stmt.getAsObject() as Row) : undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params: unknown[]): Row[] {
    const stmt = this._db.prepare(this._sql);
    const rows: Row[] = [];
    try {
      if (params.length > 0) stmt.bind(params as BindParam[]);
      // getAsObject() with no args returns current row without re-binding
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
    } finally {
      stmt.free();
    }
    return rows;
  }
}

class Database {
  private _db: SqlJsDb;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_path: string) {
    // Always in-memory regardless of path; tests pass ":memory:"
    this._db = new SQL.Database();
  }

  pragma(_str: string): null {
    try {
      this._db.run(`PRAGMA ${_str}`);
    } catch {
      // WAL and filesystem pragmas are no-ops for in-memory databases
    }
    return null;
  }

  exec(sql: string): this {
    // sql.js exec handles multi-statement SQL (unlike run which handles one)
    this._db.exec(sql);
    return this;
  }

  prepare(sql: string): Statement {
    return new Statement(this._db, sql);
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]): T => {
      this._db.run("BEGIN");
      try {
        const result = fn(...args);
        this._db.run("COMMIT");
        return result;
      } catch (err) {
        try {
          this._db.run("ROLLBACK");
        } catch {
          // ignore rollback errors
        }
        throw err;
      }
    };
  }

  close(): void {
    this._db.close();
  }
}

export default Database;
