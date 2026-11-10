// usage: node compare.mjs <electron.jsonl> <native.jsonl>
// Diffs two reply logs byte for byte after masking timestamps and uuids.
import fs from "node:fs";

const mask = (s) =>
  s
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, "<TS>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<UUID>");
const [a, b] = process.argv.slice(2).map((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean));
let diffs = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  const x = mask(a[i] ?? "<missing>");
  const y = mask(b[i] ?? "<missing>");
  if (x !== y) {
    diffs++;
    console.log(`--- step ${i}\nelectron: ${x}\nnative:   ${y}`);
  }
}
console.log(diffs === 0 ? `IDENTICAL: ${a.length} steps` : `${diffs} of ${a.length} steps differ`);
process.exit(diffs === 0 ? 0 : 1);
