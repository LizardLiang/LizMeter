// Cross-implementation sync harness: the TypeScript engine (real better-sqlite3, under node) against
// the Rust engine (`sync_cli`). Exits non-zero on the first difference.
//
//   node native/tools/sync-equivalence/run.mjs [--cli <sync_cli.exe>] [--tmp <dir>] [--fuzz <n>] [--rounds <n>]
//
// (a) Fixture oplog sets: both engines read the same files; every table must dump identically.
// (b) Mixed run: one TypeScript device and one Rust device on one shared folder, random edits on
//     both sides, ids must converge; then each engine rebuilds a fresh device from a snapshot the
//     other one wrote.
//
// Never points at the real OneDrive folder or %APPDATA%/lizmeter: every path is under --tmp (default a
// fresh folder in the OS temp directory), and the script refuses a --tmp that looks like real data.

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
const fuzzCount = Number(opt("fuzz", "6"));
const rounds = Number(opt("rounds", "6"));
const tmpRoot = path.resolve(opt("tmp", fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-sync-equiv-"))));

for (const forbidden of ["onedrive", "appdata", "lizmeter\\lizmeter", "/lizmeter/lizmeter"]) {
  if (tmpRoot.toLowerCase().includes(forbidden) && !tmpRoot.toLowerCase().includes("\\temp\\")) {
    throw new Error(`refusing ${tmpRoot}: the harness only writes to temp folders`);
  }
}
if (!fs.existsSync(cli)) throw new Error(`sync_cli not found at ${cli}: run cargo build -p lizmeter-sync --bin sync_cli`);

// Every run starts from empty folders: a database left from an earlier run would hide differences.
fs.rmSync(path.join(tmpRoot, "fixtures"), { recursive: true, force: true });
fs.rmSync(path.join(tmpRoot, "mixed"), { recursive: true, force: true });

// --- load the TypeScript engine ---
// The bundle lives directly under the OS temp folder, like scripts/verify-real-better-sqlite3.mjs: the
// repo's better-sqlite3 is built for Electron's ABI, so node must find a Node-ABI copy at
// <temp>/node_modules/better-sqlite3 (install it with `bun add better-sqlite3` run inside the temp folder).
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-sync-equiv-bundle-"));
const bundle = path.join(bundleDir, "engine.bundle.mjs");
fs.writeFileSync(
  path.join(bundleDir, "entry.ts"),
  `export * from ${JSON.stringify(path.join(here, "engine.ts").replaceAll("\\", "/"))};\nexport * from ${JSON.stringify(path.join(here, "fixtures.ts").replaceAll("\\", "/"))};\n`,
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
let ts;
try {
  ts = await import(pathToFileURL(bundle).href);
} catch (err) {
  throw new Error(
    `could not load the TypeScript engine (${String(err.message).split(String.fromCharCode(10))[0]}). better-sqlite3 for the Node ABI must be installed at ${path.join(os.tmpdir(), "node_modules")}`,
  );
}

// --- helpers ---
function rs(command, dirs, extra = []) {
  const args = [command, "--db", dirs.dbPath, "--user-data", dirs.userData, "--shared", dirs.shared, ...extra];
  const out = execFileSync(cli, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim() === "" ? null : JSON.parse(out.trim().split("\n").pop());
}

function device(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dbPath: path.join(dir, "lizmeter.db"), userData: path.join(dir, "user"), shared: path.join(root, "shared") };
}

/** Stable form for comparison: object keys sorted, arrays sorted by their own JSON. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
}

function same(label, left, right) {
  const a = canon(left);
  const b = canon(right);
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const report = [`MISMATCH in ${label}`];
  if (a && typeof a === "object" && !Array.isArray(a)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) {
      if (JSON.stringify(a[key]) === JSON.stringify(b?.[key])) continue;
      const ra = new Set((a[key] ?? []).map((r) => JSON.stringify(r)));
      const rb = new Set((b?.[key] ?? []).map((r) => JSON.stringify(r)));
      report.push(`  table ${key}:`);
      for (const r of [...ra].filter((r) => !rb.has(r)).slice(0, 4)) report.push(`    only TS:   ${r}`);
      for (const r of [...rb].filter((r) => !ra.has(r)).slice(0, 4)) report.push(`    only Rust: ${r}`);
    }
  } else {
    report.push(`  TS:   ${JSON.stringify(a).slice(0, 600)}`);
    report.push(`  Rust: ${JSON.stringify(b).slice(0, 600)}`);
  }
  console.error(report.join("\n"));
  process.exitCode = 1;
  throw new Error(`MISMATCH in ${label}`);
}

function writeFixtureFiles(shared, files, append) {
  const dir = path.join(shared, "sync", "devices");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, lines] of Object.entries(files)) {
    if (lines.length === 0) continue;
    const text = lines.join("\n") + "\n";
    if (append) fs.appendFileSync(path.join(dir, name), text, "utf8");
    else fs.writeFileSync(path.join(dir, name), text, "utf8");
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// --- (a) fixture oplog sets ---
const scenarios = ts.makeScenarios(Array.from({ length: fuzzCount }, (_, i) => i + 1));
let fixtureRows = 0;
for (const scenario of scenarios) {
  const root = path.join(tmpRoot, "fixtures", scenario.name);
  const t = device(root, "ts");
  const r = device(root, "rs");
  // each engine gets its own copy of the shared folder, so neither sees the other's own-device files
  t.shared = path.join(root, "shared-ts");
  r.shared = path.join(root, "shared-rs");
  for (const d of [t, r]) writeFixtureFiles(d.shared, scenario.phase1, false);

  ts.tsInit(t);
  rs("init", r);

  const passes = [];
  const runPass = (label) => {
    const a = ts.tsMerge(t);
    const b = rs("merge", r);
    const bb = b ?? { ok: true };
    assert.equal(a.ok, true, `${scenario.name} ${label}: TS merge failed: ${a.error}`);
    same(`${scenario.name} ${label} merge result`, { applied: a.applied, skipped: a.skipped, notices: a.notices }, bb);
    passes.push(`${label}:${a.applied}`);
  };
  runPass("pass1");
  for (const d of [t, r]) writeFixtureFiles(d.shared, scenario.phase2, true);
  runPass("pass2");
  runPass("pass3-idempotent");

  const rsOut = path.join(root, "rs-dump.json");
  rs("dump", r, ["--out", rsOut, "--mode", "fixture"]);
  const dumpTs = ts.tsDump(t, false);
  const dumpRs = readJson(rsOut);
  same(`${scenario.name} table dump`, dumpTs, dumpRs);
  fixtureRows += Object.values(dumpTs).reduce((n, rows) => n + rows.length, 0);

  const rsSnap = path.join(root, "rs-snapshot.json");
  rs("snapshot-entries", r, ["--out", rsSnap]);
  const snapTs = ts.tsSnapshotEntries(t);
  const snapRs = readJson(rsSnap).map((s) => JSON.parse(s));
  same(`${scenario.name} snapshot entries`, snapTs, snapRs);

  console.log(`PASS fixture ${scenario.name}: ${passes.join(" ")} | ${Object.entries(dumpTs).map(([k, v]) => `${k}=${v.length}`).join(" ")}`);
}
ts.tsClose();

// --- (b) mixed run: one TypeScript device, one Rust device, one shared folder ---
{
  const root = path.join(tmpRoot, "mixed");
  const shared = path.join(root, "shared");
  fs.mkdirSync(shared, { recursive: true });
  const a = device(root, "ts-a");
  const b = device(root, "rs-b");

  ts.tsSetup(a, "originate");
  rs("setup", b, ["--role", "adopt"]);

  const compare = (label) => {
    const outFile = path.join(root, "rs-dump.json");
    rs("dump", b, ["--out", outFile, "--mode", "mixed"]);
    const dumpA = ts.tsDump(a, true);
    const dumpB = readJson(outFile);
    same(label, dumpA, dumpB);
    return dumpA;
  };

  let edits = 0;
  for (let round = 1; round <= rounds; round++) {
    edits += ts.tsEdit(a, 1000 + round, 25).done;
    edits += rs("edit", b, ["--seed", String(2000 + round), "--ops", "25"]).done;

    for (let pass = 0; pass < 2; pass++) {
      const ma = ts.tsMerge(a);
      assert.equal(ma.ok, true, `round ${round}: TS merge failed: ${ma.error}`);
      rs("merge", b);
    }
    const dump = compare(`mixed round ${round}`);

    if (round === Math.ceil(rounds / 2)) {
      assert.equal(ts.tsWriteSnapshot(a), true);
      assert.equal(rs("write-snapshot", b).wrote, true);
    }
    console.log(`PASS mixed round ${round}: todos=${dump.todos.length} ids=${dump.todos.map((t) => t.id).sort((x, y) => x - y).join(",")}`);
  }

  const todos = ts.tsDump(a, true).todos;
  const ids = todos.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "todo ids are unique");
  assert.ok(edits > rounds * 10, `the run made real edits (${edits})`);

  // Fresh devices rebuilt from the snapshots the two engines wrote: one Rust, one TypeScript. They must
  // agree with each other row for row (the snapshot format and the rebuild are shared contract).
  const c = device(root, "rs-c");
  rs("setup", c, ["--role", "adopt"]);
  const outC = path.join(root, "rs-c-dump.json");
  rs("dump", c, ["--out", outC, "--mode", "mixed"]);

  const d = device(root, "ts-d");
  ts.tsSetup(d, "adopt");
  same("fresh Rust device vs fresh TypeScript device, both adopting the mixed folder", ts.tsDump(d, true), readJson(outC));

  // And against the converged devices: a rebuild may only differ where a todo's parent link could not
  // be restored (see the finding in the README), never in ids or any other row.
  const strip = (dump) => ({ ...dump, todos: dump.todos.map(({ parent_uuid, ...rest }) => rest) });
  same("fresh TypeScript device vs converged devices (parent links aside)", strip(ts.tsDump(d, true)), strip(ts.tsDump(a, true)));
  console.log(`PASS mixed adopt: fresh Rust and fresh TS devices match each other and the converged state (${todos.length} todos)`);
}
ts.tsClose();

console.log(`PASS sync equivalence: ${scenarios.length} fixture scenarios (${fixtureRows} dumped rows), 1 mixed two-device run`);
console.log(`temp folder: ${tmpRoot}`);
fs.rmSync(bundleDir, { recursive: true, force: true });
if (!argv.includes("--keep")) fs.rmSync(tmpRoot, { recursive: true, force: true });
