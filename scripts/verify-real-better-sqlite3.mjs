import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDir);
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lizmeter-real-db-bundle-"));
const outputFile = path.join(temporaryDirectory, "harness.mjs");

try {
  await build({
    entryPoints: [path.join(scriptsDir, "real-better-sqlite3-harness.ts")],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    absWorkingDir: repositoryRoot,
    alias: { electron: path.join(scriptsDir, "electron-stub.mjs") },
    external: ["better-sqlite3"],
    logLevel: "warning",
  });

  await import(pathToFileURL(outputFile).href);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
