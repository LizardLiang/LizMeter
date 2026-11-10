// usage: node run-script.mjs <pipe-path> <out.jsonl>
// Sends request-script.mjs to a server on <pipe-path> and writes every raw reply line.
import fs from "node:fs";
import net from "node:net";
import { steps } from "./request-script.mjs";

const [pipePath, outFile] = process.argv.slice(2);
if (!pipePath || !outFile) throw new Error("usage: run-script.mjs <pipe-path> <out.jsonl>");
if (/\\pipe\\lizmeter(-dev)?$/i.test(pipePath)) throw new Error("refusing the default pipe path");

/** Writes `chunks` (with a gap between them), collects reply bytes until quiet, closes. */
function exchange(chunks, { idleMs = 250, firstMs = 600, halfClose = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let data = "";
    let lastData = 0;
    const started = Date.now();
    socket.on("data", (c) => {
      data += c.toString("utf8");
      lastData = Date.now();
    });
    socket.on("error", (e) => reject(e));
    socket.on("connect", async () => {
      for (const c of chunks) {
        socket.write(c);
        await new Promise((r) => setTimeout(r, 40));
      }
      if (halfClose) socket.end();
      const tick = setInterval(() => {
        const now = Date.now();
        const quiet = lastData ? now - lastData > idleMs : now - started > firstMs;
        if (quiet || socket.destroyed) {
          clearInterval(tick);
          socket.destroy();
          resolve(data);
        }
      }, 20);
    });
  });
}

const out = [];
for (const [index, step] of steps.entries()) {
  let reply = "";
  if (step.m) reply = await exchange([JSON.stringify(step.m) + "\n"]);
  else if (step.raw !== undefined) reply = await exchange([step.raw + "\n"]);
  else if (step.multi) reply = await exchange([step.multi.join("\n") + "\n"]);
  else if (step.split) reply = await exchange(step.split);
  else if (step.trailing) reply = await exchange([step.trailing], { halfClose: true });
  else if (step.big) reply = await exchange(["x".repeat(262145)], { idleMs: 300 });
  out.push(JSON.stringify({ step: index, reply: reply.split("\n").filter((l) => l.length > 0) }));
}
fs.writeFileSync(outFile, out.join("\n") + "\n");
console.log(`wrote ${out.length} steps to ${outFile}`);
