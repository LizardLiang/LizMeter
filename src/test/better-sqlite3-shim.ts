// Shim that provides a better-sqlite3-compatible API using sql.js (pure WebAssembly).
// Used by Vitest to avoid native ABI conflicts between Bun (NMV 137) and Electron (NMV 143).
//
// Path handling (Fix Round, see implementation-notes.md): a real (non-":memory:") path loads
// existing bytes from disk if present, and every mutating call (`run`, `exec`, a committed
// `transaction`) persists the current contents back to that same path. `close()` also persists,
// so a normal open -> write -> close -> reopen sequence round-trips real bytes through the real
// filesystem path given -- this is what lets a test actually exercise path *resolution* (does
// device B's `initDatabase()` open device A's file at the same path, does a relocate leave the
// old file readable at its old path, etc.), which no test in this codebase could previously do:
// the shim used to open a fresh in-memory database regardless of what path it was given.
// `:memory:"` is untouched by any of this and behaves exactly as before -- every existing test
// passes it explicitly and none of them need or expect cross-instance persistence.
import fs from "node:fs";
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
    private _persist: () => void,
  ) {}

  run(...params: unknown[]): this {
    if (params.length > 0) {
      this._db.run(this._sql, params as BindParam[]);
    } else {
      this._db.run(this._sql);
    }
    // Most callers in this codebase run a single statement outside any explicit transaction
    // wrapper (better-sqlite3 auto-commits each one), so persistence cannot wait for a
    // `transaction()` commit that may never come -- see this file's header comment.
    this._persist();
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
  private _path: string;
  private _persistent: boolean;
  // sql.js's own `export()` cannot run while a transaction is open -- it implicitly ends it,
  // which then makes this shim's own explicit COMMIT/ROLLBACK fail with "no transaction is
  // active". Every write inside a `transaction()` call therefore defers persistence until that
  // wrapper's own single post-commit/post-rollback `persist()` call, via this flag.
  private _inTransaction = false;

  constructor(dbPath: string) {
    this._path = dbPath;
    this._persistent = dbPath !== ":memory:";

    if (this._persistent && fs.existsSync(dbPath)) {
      this._db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      this._db = new SQL.Database();
      // A real path that does not exist yet is created empty immediately, matching
      // better-sqlite3's own behavior of creating the file the moment it is opened -- a test
      // that checks `fs.existsSync(path)` right after `new Database(path)`, before any write,
      // must see the same thing it would against the real engine.
      if (this._persistent) this.persist();
    }
  }

  /** Writes the database's current full contents to `_path`. A no-op for ":memory:" or mid-transaction. */
  private persist(): void {
    if (!this._persistent || this._inTransaction) return;
    fs.writeFileSync(this._path, Buffer.from(this._db.export()));
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
    this.persist();
    return this;
  }

  prepare(sql: string): Statement {
    return new Statement(this._db, sql, () => this.persist());
  }

  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
    return (...args: unknown[]): T => {
      this._db.run("BEGIN");
      this._inTransaction = true;
      try {
        const result = fn(...args);
        this._db.run("COMMIT");
        this._inTransaction = false;
        this.persist();
        return result;
      } catch (err) {
        try {
          this._db.run("ROLLBACK");
        } catch {
          // ignore rollback errors
        }
        this._inTransaction = false;
        // Every statement inside this transaction deferred its own persist() while
        // `_inTransaction` was true, so the file on disk is still whatever it was before this
        // transaction started -- already correct after a rollback, but persisting again here
        // keeps this branch symmetric with the commit branch rather than relying on that as an
        // implicit invariant.
        this.persist();
        throw err;
      }
    };
  }

  close(): void {
    this.persist();
    this._db.close();
  }
}

export default Database;
