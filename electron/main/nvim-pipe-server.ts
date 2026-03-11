// electron/main/nvim-pipe-server.ts
// Named pipe server for receiving Neovim file edit events

import net from "node:net";
import fs from "node:fs";
import { insertNvimActivity, isDuplicateNvimActivity } from "./database.ts";

// --- Constants ---

const PIPE_PATH =
  process.platform === "win32" ? "\\\\.\\pipe\\lizmeter" : "/tmp/lizmeter.sock";

const MAX_BUFFER_SIZE = 4096;

// --- Module-level singleton state ---

let pipeServer: net.Server | null = null;

// --- Payload Validation ---

function validatePayload(data: unknown): { project: string; file: string } | null {
  if (typeof data !== "object" || data === null) return null;

  const obj = data as Record<string, unknown>;
  const project = obj.project;
  const file = obj.file;

  if (typeof project !== "string" || typeof file !== "string") return null;

  const trimmedProject = project.trim();
  const trimmedFile = file.trim();

  if (trimmedProject.length === 0 || trimmedFile.length === 0) return null;
  if (trimmedProject.length > 1000 || trimmedFile.length > 1000) return null;

  return { project: trimmedProject, file: trimmedFile };
}

// --- Connection Handler ---

function handleConnection(socket: net.Socket): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    // Guard against oversized payloads (max 4KB per connection)
    if (buffer.length > MAX_BUFFER_SIZE) {
      socket.destroy();
      return;
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const payload = JSON.parse(trimmed) as unknown;
        const validated = validatePayload(payload);
        if (!validated) continue;

        // Dedup check: skip if same (project, file) was recorded within last 60 seconds
        if (isDuplicateNvimActivity(validated.project, validated.file)) continue;

        // Insert into database
        insertNvimActivity(validated.project, validated.file);
      } catch {
        // Malformed JSON or DB error -- silently discard
      }
    }
  });

  socket.on("end", () => {
    // Process any remaining buffered data when the connection closes
    const trimmed = buffer.trim();
    if (!trimmed) return;

    try {
      const payload = JSON.parse(trimmed) as unknown;
      const validated = validatePayload(payload);
      if (!validated) return;

      if (isDuplicateNvimActivity(validated.project, validated.file)) return;

      insertNvimActivity(validated.project, validated.file);
    } catch {
      // Malformed JSON or DB error -- silently discard
    }
  });

  socket.on("error", () => {
    // Client disconnected abruptly -- ignore
  });
}

// --- Stale Socket Cleanup (Unix only) ---

function cleanupStaleSocket(): void {
  if (process.platform === "win32") return;

  try {
    fs.unlinkSync(PIPE_PATH);
  } catch {
    // File doesn't exist or can't be removed -- fine either way
  }
}

// --- Public API ---

export function startNvimPipeServer(): void {
  if (pipeServer) {
    console.warn("[nvim-pipe] Server already running");
    return;
  }

  cleanupStaleSocket();

  pipeServer = net.createServer(handleConnection);

  pipeServer.on("error", (err) => {
    console.error("[nvim-pipe] Server error:", err);
  });

  pipeServer.listen(PIPE_PATH, () => {
    console.log(`[nvim-pipe] Listening on ${PIPE_PATH}`);
  });
}

export function destroyNvimPipeServer(): void {
  if (!pipeServer) return;

  const server = pipeServer;
  pipeServer = null;

  // Prevent the server from keeping the process alive during shutdown
  server.unref();

  try {
    server.close(() => {
      cleanupStaleSocket();
    });
  } catch {
    // If close throws synchronously, still attempt cleanup
    cleanupStaleSocket();
  }
}
