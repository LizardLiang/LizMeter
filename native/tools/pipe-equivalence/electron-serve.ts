// Runs the REAL pipe-server.ts (Electron build) on a test pipe over a scratch database, under node
// with the real better-sqlite3. Never opens the default pipe: LIZMETER_PIPE_PATH is required.
import { initDatabase } from "../../../electron/main/database.ts";
import { startPipeServer } from "../../../electron/main/pipe-server.ts";

const path = process.env["LIZMETER_PIPE_PATH"];
if (!path || /\\pipe\\lizmeter(-dev)?$/i.test(path)) throw new Error("set LIZMETER_PIPE_PATH to a test pipe");
initDatabase(process.argv[2] ?? ":memory:");
startPipeServer();
console.log("ready " + path);
setInterval(() => {}, 1 << 30); // serve until killed
