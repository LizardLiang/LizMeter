// Bundles dump.ts against the Electron stub and runs it under node with real better-sqlite3.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-schema-dump-"));
const out = path.join(tmp, "dump.mjs");
process.env.LIZMETER_REAL_DB_USER_DATA = tmp;
try {
  await build({
    entryPoints: [path.join(here, "dump.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    absWorkingDir: repo,
    alias: { electron: path.join(repo, "scripts", "electron-stub.mjs") },
    external: ["better-sqlite3"],
    logLevel: "warning",
  });
  await import(pathToFileURL(out).href);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
