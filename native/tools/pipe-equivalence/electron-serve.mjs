// Bundles electron-serve.ts against the Electron stub (index.ts and the attachment store are the
// only Electron-bound imports) and runs it with the real better-sqlite3.
// usage: LIZMETER_EQUIV_DIR=<dir with node_modules/better-sqlite3> LIZMETER_PIPE_PATH=<test pipe path> node electron-serve.mjs [db-file]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
// The bundle must sit under a folder whose node_modules holds a Node-ABI better-sqlite3.
const tmp = process.env.LIZMETER_EQUIV_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-pipe-equiv-"));
const out = path.join(tmp, "serve.mjs");
process.env.LIZMETER_REAL_DB_USER_DATA = tmp;
const noWindow = {
  name: "no-main-window",
  setup(b) {
    b.onResolve({ filter: /\/index\.ts$/ }, (a) => (a.importer.endsWith("pipe-server.ts") ? { path: "no-window", namespace: "stub" } : null));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const getMainWindow = () => null;", loader: "js" }));
  },
};
await build({
  entryPoints: [path.join(here, "electron-serve.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  absWorkingDir: repo,
  alias: { electron: path.join(repo, "scripts", "electron-stub.mjs") },
  plugins: [noWindow],
  external: ["better-sqlite3"],
  logLevel: "warning",
});
await import(pathToFileURL(out).href);
