// Dumps sqlite_master + PRAGMA table_info from the REAL better-sqlite3 after Electron's initDatabase().
// Run from the repo root: node native/tools/schema-dump/dump.mjs <out.json> [existing-db-copy]
// With a db path it opens that file (a COPY, never the live data folder) so migrations run on real data.
import fs from "node:fs";
import { closeDatabase, getDb, initDatabase } from "../../../electron/main/database.ts";

const [outFile, dbPath] = process.argv.slice(2);
if (!outFile) throw new Error("usage: dump.mjs <out.json> [db-copy]");

initDatabase(dbPath ?? ":memory:");
const db = getDb();
const master = db
  .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
  .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
const tables = master.filter((r) => r.type === "table").map((r) => r.name);
const columns: Record<string, unknown[]> = {};
for (const t of tables) columns[t] = db.prepare(`PRAGMA table_info(${t})`).all();
const sqliteVersion = (db.prepare("select sqlite_version() as v").get() as { v: string }).v;
fs.writeFileSync(outFile, JSON.stringify({ sqliteVersion, master, columns }, null, 2) + "\n");
closeDatabase();
