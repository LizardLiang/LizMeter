// "Clear N done" scenario for the equivalence harness. Each engine clears completed todos locally;
// the other engine must merge the published deletes and end with the same rows.
//
//   node native/tools/sync-equivalence/clear-completed.mjs [--cli <sync_cli.exe>] [--tmp <dir>] [--keep]
//
// Same prerequisites and temp-folder rules as run.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const cli = path.resolve(opt("cli", path.join(repo, "native", "target", "debug", "sync_cli.exe")));
const tmpRoot = path.resolve(opt("tmp", fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-clear-equiv-"))));
if (/onedrive|appdata/i.test(tmpRoot) && !tmpRoot.toLowerCase().split(path.sep).includes("temp")) {
  throw new Error(`refusing ${tmpRoot}: the harness only writes to temp folders`);
}
if (!fs.existsSync(cli)) throw new Error(`sync_cli not found at ${cli}: run cargo build -p lizmeter-sync --bin sync_cli`);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-clear-equiv-bundle-"));
const bundle = path.join(bundleDir, "engine.bundle.mjs");
const spec = (f) => JSON.stringify(path.join(here, f).replaceAll("\\", "/"));
fs.writeFileSync(
  path.join(bundleDir, "entry.ts"),
  `export * from ${spec("engine.ts")};\nexport * from ${spec("clear-completed.ts")};\n`,
);
await build({
  entryPoints: [path.join(bundleDir, "entry.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  absWorkingDir: repo,
  alias: { electron: path.join(here, "electron-stub.mjs") },
  external: ["better-sqlite3"],
  logLevel: "warning",
});
const ts = await import(pathToFileURL(bundle).href);

const root = path.join(tmpRoot, "clear");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "shared"), { recursive: true });
const device = (name) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dbPath: path.join(dir, "lizmeter.db"), userData: path.join(dir, "user"), shared: path.join(root, "shared") };
};
const rs = (command, d, extra = []) => {
  const out = execFileSync(
    cli,
    [command, "--db", d.dbPath, "--user-data", d.userData, "--shared", d.shared, ...extra],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out.trim() === "" ? null : JSON.parse(out.trim().split("\n").pop());
};
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};
const same = (label, left, right) => {
  assert.equal(JSON.stringify(canon(left)), JSON.stringify(canon(right)), `MISMATCH in ${label}`);
};

const a = device("ts-a");
const b = device("rs-b");
ts.tsSetup(a, "originate");
rs("setup", b, ["--role", "adopt"]);

assert.equal(ts.tsClearScenario(a, "ts").cleared, 2);
assert.equal(rs("clear-scenario", b, ["--tag", "rs"]).cleared, 2);

const dumpRs = (d, name) => {
  const out = path.join(root, `${name}.json`);
  rs("dump", d, ["--out", out, "--mode", "mixed"]);
  return JSON.parse(fs.readFileSync(out, "utf8"));
};

for (let pass = 0; pass < 2; pass++) {
  assert.equal(ts.tsMerge(a).ok, true);
  rs("merge", b);
}

const onTs = ts.tsDump(a, true);
const onRs = dumpRs(b, "rs-dump");
same("both engines after merging each other's clear-completed", onTs, onRs);

const titles = onTs.todos.map((t) => t.title).sort();
assert.deepEqual(titles, ["rs-child", "rs-open", "ts-child", "ts-open"], "only open todos and lifted children remain");
assert.ok(onTs.todos.every((t) => t.parent_uuid == null), "children of cleared todos sit at the top level");
const tombstones = onTs.sync_tombstones.filter((t) => t.table_name === "todos");
assert.equal(tombstones.length, 4, "one tombstone per cleared todo, from both engines");

// A fresh machine rebuilt from the shared folder must not get the cleared todos back.
const c = device("rs-c");
rs("setup", c, ["--role", "adopt"]);
same("fresh Rust device adopting the folder", dumpRs(c, "rs-c-dump"), onTs);
const d = device("ts-d");
ts.tsSetup(d, "adopt");
same("fresh TypeScript device adopting the folder", ts.tsDump(d, true), onTs);

ts.tsClose();
console.log(`PASS clear-completed equivalence: ${titles.length} todos remain on every device, 4 tombstones`);
fs.rmSync(bundleDir, { recursive: true, force: true });
if (!argv.includes("--keep")) fs.rmSync(tmpRoot, { recursive: true, force: true });
