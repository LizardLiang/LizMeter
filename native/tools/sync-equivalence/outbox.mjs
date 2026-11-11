// Outbox scenarios for the equivalence harness: both engines run the same steps on their own device and
// shared folder, and must produce the same oplog files (opId, hlc, uuids and timestamps masked), the same
// rows, the same outbox and notice states at every checkpoint, and the same view on a fresh peer.
//
//   node native/tools/sync-equivalence/outbox.mjs [--cli <sync_cli.exe>] [--tmp <dir>] [--keep]
//
// Scenarios: write-fails-after-record, unreachable-then-recovers, duplicate-flush, enable-sync-resume,
// quit-with-sync-off, failed-append-undone.
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
const tmpRoot = path.resolve(opt("tmp", fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-outbox-equiv-"))));
if (/onedrive|appdata/i.test(tmpRoot) && !tmpRoot.toLowerCase().split(path.sep).includes("temp")) {
  throw new Error(`refusing ${tmpRoot}: the harness only writes to temp folders`);
}
if (!fs.existsSync(cli)) throw new Error(`sync_cli not found at ${cli}: run cargo build -p lizmeter-sync --bin sync_cli`);

const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-outbox-equiv-bundle-"));
const bundle = path.join(bundleDir, "engine.bundle.mjs");
fs.writeFileSync(
  path.join(bundleDir, "entry.ts"),
  `export * from ${JSON.stringify(path.join(here, "outbox.ts").replaceAll("\\", "/"))};\n`,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** One oplog line as an object with the run-specific values replaced by placeholders. */
function mask(v, key = "") {
  if (key === "opId") return "<op>";
  if (key === "hlc") return "<hlc>";
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, mask(v[k], k)]));
  if (typeof v === "string") return UUID.test(v) ? "<uuid>" : ISO.test(v) ? "<ts>" : v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
  return v;
}

function maskResult(result) {
  const copy = { ...result };
  copy.oplog = result.oplog.map((line) => mask(JSON.parse(line)));
  if (result.oplogAfterFailure) copy.oplogAfterFailure = result.oplogAfterFailure.map((line) => mask(JSON.parse(line)));
  return copy;
}

const names = ["write-fails-after-record", "unreachable-then-recovers", "duplicate-flush", "enable-sync-resume", "quit-with-sync-off", "failed-append-undone"];

for (const name of names) {
  const root = path.join(tmpRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  const dirs = (engine) => {
    const dir = path.join(root, engine);
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
    return { dbPath: path.join(dir, "lizmeter.db"), userData: path.join(dir, "user"), shared: path.join(dir, "shared") };
  };
  const t = dirs("ts");
  const r = dirs("rs");

  const tsResult = ts.tsOutboxScenario(t, name);
  ts.tsOutboxClose();
  const out = execFileSync(
    cli,
    ["outbox-scenario", "--db", r.dbPath, "--user-data", r.userData, "--shared", r.shared, "--name", name],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const rsResult = JSON.parse(out.trim().split("\n").pop());

  const a = maskResult(JSON.parse(JSON.stringify(tsResult)));
  const b = maskResult(rsResult);
  assert.deepEqual(a, b, `MISMATCH in outbox scenario ${name}\nTS:   ${JSON.stringify(a)}\nRust: ${JSON.stringify(b)}`);

  // The point of each scenario, asserted on the shared result.
  if (name === "write-fails-after-record") {
    assert.equal(a.failed, true);
    assert.deepEqual(a.oplogAfterFailure, [], "a failed write leaves no public line");
    assert.equal(a.afterFailure.outbox, 0);
    assert.deepEqual(a.final.tags, ["kept"]);
  } else if (name === "unreachable-then-recovers") {
    assert.ok(a.blocked.outbox >= 3 && a.blocked.notices.length === 1, "edits queue and one notice shows the count");
    assert.equal(a.recovered.outbox, 0);
    assert.deepEqual(a.recovered.notices, []);
    assert.equal(a.oplog.length, a.blocked.outbox, "every queued line is published, once");
    assert.deepEqual(a.peer.todos, ["first", "second"]);
  } else if (name === "duplicate-flush") {
    assert.equal(a.oplog.length, a.onceLength * 2, "each line reaches the file twice");
    assert.equal(a.peer.appliedOps, a.onceLength, "the peer applies each opId once");
  } else if (name === "quit-with-sync-off") {
    assert.ok(a.queued.outbox > 0, "the edit queued while the folder was unreachable");
    assert.deepEqual(a.oplogAfterQuitOff, [], "quit with sync off publishes nothing");
    assert.equal(a.afterQuitOff.outbox, a.queued.outbox, "the queue is kept for when sync is turned on");
    assert.equal(a.final.outbox, 0, "quit with sync on publishes the queue");
    assert.deepEqual(a.peer.tags, ["queued"]);
  } else if (name === "failed-append-undone") {
    assert.equal(a.afterFailure.outbox, 1, "the failed line stays queued");
    assert.equal(a.oplogAfterFailure.length, 1, "no torn fragment stays in the file");
    assert.equal(a.final.outbox, 0);
    assert.equal(a.oplog.length, 2);
  } else {
    assert.equal(a.blocked.enabled, "true");
    assert.ok(a.blocked.outbox > 0, "the publish lines wait in the outbox");
    assert.equal(a.recovered.outbox, 0);
    assert.deepEqual(a.peer.todos, ["one", "two"]);
  }
  console.log(`PASS outbox scenario ${name}: ${a.oplog.length} oplog lines match on both engines`);
}

console.log(`PASS outbox equivalence: ${names.length} scenarios`);
fs.rmSync(bundleDir, { recursive: true, force: true });
if (!argv.includes("--keep")) fs.rmSync(tmpRoot, { recursive: true, force: true });
