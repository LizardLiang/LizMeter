// electron/main/claude-code-tracker.ts
// Core Claude Code tracking module: file watching, JSONL parsing, state management

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeCodeLiveStats, ClaudeCodeProject, ClaudeCodeSessionData } from "../../src/shared/types.ts";
import type { WebContents } from "electron";

// --- Types ---

export interface SessionState {
  ccSessionUuid: string;
  filesEdited: Set<string>;
  lastMessageTimestamp: string | null;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  idlePeriods: Array<{ startAt: string; endAt: string; durationSeconds: number }>;
  // for incremental reading
  bytesRead: number;
  filePath: string;
  partialLine: string;
}

// --- Module-level singleton state ---

let directoryWatcher: fs.FSWatcher | null = null;
const fileWatchers: Map<string, fs.FSWatcher> = new Map();
const debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let fallbackPollInterval: ReturnType<typeof setInterval> | null = null;
const sessionState: Map<string, SessionState> = new Map(); // keyed by ccSessionUuid
let targetWebContents: WebContents | null = null;
let idleThresholdMs: number = 5 * 60 * 1000; // default 5 minutes
let timerStartTime: number = 0;

const DEBOUNCE_MS = 500;
const FALLBACK_POLL_MS = 30_000;
const SESSION_BUFFER_MS = 120_000; // 2-minute buffer
const MAX_PARTIAL_LINE_BYTES = 1_048_576; // 1MB cap

// --- Path Utilities ---

/**
 * Validates and resolves a project directory name to its full path.
 * Defends against path traversal via allowlist regex and path.resolve + startsWith check.
 */
export function validateProjectDirName(dirName: string): string {
  // 1. Reject empty or whitespace-only input
  if (!dirName || dirName.trim().length === 0) {
    throw new Error("Project directory name cannot be empty");
  }

  // 2. Reject any path separator characters (forward slash, backslash, ..)
  if (/[/\\]/.test(dirName) || dirName.includes("..")) {
    throw new Error("Invalid project directory name: contains path separators");
  }

  // 3. Reject names that are not simple directory names
  //    Allow only: A-Z, a-z, 0-9, hyphens, periods, underscores
  if (!/^[A-Za-z0-9._-]+$/.test(dirName)) {
    throw new Error("Invalid project directory name: contains disallowed characters");
  }

  // 4. Construct the path and verify it resolves to a child of ~/.claude/projects/
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  const resolvedPath = path.resolve(projectsRoot, dirName);

  if (!resolvedPath.startsWith(projectsRoot + path.sep)) {
    throw new Error("Invalid project directory name: path escapes projects directory");
  }

  return resolvedPath;
}

/**
 * Decodes an encoded Claude Code project directory name to a human-readable path.
 * This is lossy and best-effort (see tech spec Appendix B).
 */
export function decodeProjectPath(dirName: string): string {
  // Pattern: "C--Users-lizard-liang-personal-PersonalTool-LizMeter"
  // Step 1: Detect drive letter prefix (e.g., "C--")
  const driveMatch = dirName.match(/^([A-Z])--(.+)$/);
  if (driveMatch) {
    const drive = driveMatch[1];
    const rest = driveMatch[2];
    // Step 2: Replace hyphens with backslashes (Windows — lossy)
    return `${drive}:\\${rest.replace(/-/g, "\\")}`;
  }
  // Fallback for non-drive paths (e.g., Linux/macOS)
  return `/${dirName.replace(/-/g, "/")}`;
}

// --- JSONL Parsing ---

export interface JsonlLine {
  type: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name: string;
  input?: {
    file_path?: string;
    [key: string]: unknown;
  };
}

export function parseJsonlLine(raw: string): JsonlLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonlLine;
  } catch {
    return null;
  }
}

export function extractFileEditsFromLine(line: JsonlLine): string[] {
  const edited: string[] = [];
  if (line.type !== "assistant") return edited;

  const content = line.message?.content;
  if (!Array.isArray(content)) return edited;

  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as ToolUseBlock).type === "tool_use" &&
      ((block as ToolUseBlock).name === "Write" || (block as ToolUseBlock).name === "Edit")
    ) {
      const filePath = (block as ToolUseBlock).input?.file_path;
      if (typeof filePath === "string" && filePath.trim().length > 0) {
        edited.push(filePath);
      }
    }
  }
  return edited;
}

// --- Incremental File Reader ---

/**
 * Reads new content from a JSONL file starting at the known byte offset.
 * Returns parsed complete lines and any partial line remaining at EOF.
 * EBUSY/EACCES errors are caught and the file is skipped with a warning.
 */
export function readNewLines(filePath: string, startOffset: number, partialLineBuf: string): {
  lines: JsonlLine[];
  newOffset: number;
  newPartialLine: string;
} {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize <= startOffset) {
      return { lines: [], newOffset: startOffset, newPartialLine: partialLineBuf };
    }

    const bytesToRead = fileSize - startOffset;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
    fs.closeSync(fd);
    fd = null;

    const newContent = partialLineBuf + buffer.subarray(0, bytesRead).toString("utf8");
    const rawLines = newContent.split("\n");
    // Last element may be incomplete (no trailing newline yet)
    const incompleteEnd = rawLines.pop() ?? "";

    // Cap partial line buffer to prevent memory issues
    const newPartialLine = incompleteEnd.length > MAX_PARTIAL_LINE_BYTES
      ? (console.warn(`[claude-tracker] Partial line exceeds 1MB cap in ${filePath}, discarding`), "")
      : incompleteEnd;

    const lines: JsonlLine[] = [];
    for (const raw of rawLines) {
      const parsed = parseJsonlLine(raw);
      if (parsed) lines.push(parsed);
    }

    return { lines, newOffset: startOffset + bytesRead, newPartialLine };
  } catch (err: unknown) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EACCES") {
      console.warn(`[claude-tracker] File locked (${code}), skipping ${filePath}`);
      return { lines: [], newOffset: startOffset, newPartialLine: partialLineBuf };
    }
    throw err;
  }
}

// --- Last Line Reader (for initial scan buffer check) ---

function readLastLineTimestamp(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) {
      fs.closeSync(fd);
      return null;
    }

    // Read the last 4KB to find the last complete line
    const readSize = Math.min(4096, fileSize);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, fileSize - readSize);
    fs.closeSync(fd);

    const chunk = buffer.toString("utf8");
    const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
    // Try from the end to find a valid JSONL line with a timestamp
    for (let i = lines.length - 1; i >= 0; i--) {
      const parsed = parseJsonlLine(lines[i]!);
      if (parsed?.timestamp) return parsed.timestamp;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Session State Processing ---

export function processLines(state: SessionState, lines: JsonlLine[], idleThresholdMs2: number): void {
  for (const line of lines) {
    if (!line.timestamp) continue;

    // Track activity timestamps
    if (!state.firstActivityAt) {
      state.firstActivityAt = line.timestamp;
    }
    state.lastActivityAt = line.timestamp;

    // Idle detection: check gap from last message
    if (state.lastMessageTimestamp) {
      const gap = new Date(line.timestamp).getTime() - new Date(state.lastMessageTimestamp).getTime();
      if (gap >= idleThresholdMs2) {
        state.idlePeriods.push({
          startAt: state.lastMessageTimestamp,
          endAt: line.timestamp,
          durationSeconds: Math.round(gap / 1000),
        });
      }
    }
    state.lastMessageTimestamp = line.timestamp;

    // Extract file edits from Write/Edit tool_use blocks
    const edited = extractFileEditsFromLine(line);
    for (const fp of edited) {
      state.filesEdited.add(fp);
    }
  }
}

// --- Aggregation ---

function aggregateStats(): ClaudeCodeLiveStats {
  const states = Array.from(sessionState.values());
  const allFiles = new Set<string>();
  for (const s of states) {
    for (const f of s.filesEdited) {
      allFiles.add(f);
    }
  }

  const now = Date.now();
  let lastActivityTimestamp: string | null = null;
  let idleSessions = 0;

  for (const s of states) {
    if (s.lastActivityAt) {
      if (!lastActivityTimestamp || s.lastActivityAt > lastActivityTimestamp) {
        lastActivityTimestamp = s.lastActivityAt;
      }
      const age = now - new Date(s.lastActivityAt).getTime();
      if (age > idleThresholdMs) {
        idleSessions++;
      }
    }
  }

  return {
    activeSessions: states.length,
    totalFilesEdited: allFiles.size,
    filesEditedList: Array.from(allFiles),
    lastActivityTimestamp,
    idleSessions,
  };
}

function pushUpdate(): void {
  if (!targetWebContents || targetWebContents.isDestroyed()) return;
  const stats = aggregateStats();
  targetWebContents.send("claude-tracker:update", stats);
}

// --- File Watcher ---

function processFile(ccSessionUuid: string): void {
  const state = sessionState.get(ccSessionUuid);
  if (!state) return;

  const { lines, newOffset, newPartialLine } = readNewLines(
    state.filePath,
    state.bytesRead,
    state.partialLine,
  );

  state.bytesRead = newOffset;
  state.partialLine = newPartialLine;

  if (lines.length > 0) {
    processLines(state, lines, idleThresholdMs);
  }
}

function scheduleDebounced(ccSessionUuid: string): void {
  const existing = debounceTimers.get(ccSessionUuid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(ccSessionUuid);
    processFile(ccSessionUuid);
    pushUpdate();
  }, DEBOUNCE_MS);

  debounceTimers.set(ccSessionUuid, timer);
}

function watchFile(state: SessionState): void {
  if (fileWatchers.has(state.ccSessionUuid)) return;

  try {
    const watcher = fs.watch(state.filePath, () => {
      scheduleDebounced(state.ccSessionUuid);
    });
    watcher.on("error", (err) => {
      console.warn(`[claude-tracker] File watcher error for ${state.filePath}:`, err);
    });
    fileWatchers.set(state.ccSessionUuid, watcher);
  } catch (err) {
    console.warn(`[claude-tracker] Failed to watch file ${state.filePath}:`, err);
  }
}

// --- Initial Scan ---

function scanAndInitialize(projectPath: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    console.warn(`[claude-tracker] Cannot read project directory: ${projectPath}`);
    return;
  }

  const now = Date.now();
  const bufferStart = timerStartTime - SESSION_BUFFER_MS;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    const filePath = path.join(projectPath, entry.name);
    const ccSessionUuid = entry.name.replace(/\.jsonl$/, "");

    // Check if this session was active within the 2-minute buffer
    const lastTs = readLastLineTimestamp(filePath);
    if (lastTs) {
      const tsMs = new Date(lastTs).getTime();
      if (tsMs < bufferStart || tsMs > now) continue; // outside buffer window
    } else {
      continue; // no valid timestamp found, skip
    }

    // Get file size to start incremental reading from current position
    let fileSize: number;
    try {
      const stat = fs.statSync(filePath);
      fileSize = stat.size;
    } catch {
      continue;
    }

    const state: SessionState = {
      ccSessionUuid,
      filesEdited: new Set(),
      lastMessageTimestamp: null,
      firstActivityAt: null,
      lastActivityAt: null,
      idlePeriods: [],
      bytesRead: fileSize, // start at current end (only track new activity)
      filePath,
      partialLine: "",
    };

    sessionState.set(ccSessionUuid, state);
    watchFile(state);
  }
}

// --- Directory Watcher (for new files) ---

function watchDirectory(projectPath: string): void {
  if (directoryWatcher) {
    directoryWatcher.close();
    directoryWatcher = null;
  }

  try {
    directoryWatcher = fs.watch(projectPath, (eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;

      const ccSessionUuid = filename.replace(/\.jsonl$/, "");
      if (sessionState.has(ccSessionUuid)) return; // already tracking

      const filePath = path.join(projectPath, filename);

      // Check if the file exists (may be a delete event)
      try {
        fs.statSync(filePath);
      } catch {
        return;
      }

      const state: SessionState = {
        ccSessionUuid,
        filesEdited: new Set(),
        lastMessageTimestamp: null,
        firstActivityAt: null,
        lastActivityAt: null,
        idlePeriods: [],
        bytesRead: 0,
        filePath,
        partialLine: "",
      };

      sessionState.set(ccSessionUuid, state);
      watchFile(state);
      scheduleDebounced(ccSessionUuid);
    });

    directoryWatcher.on("error", (err) => {
      console.warn(`[claude-tracker] Directory watcher error:`, err);
    });
  } catch (err) {
    console.warn(`[claude-tracker] Failed to watch directory ${projectPath}:`, err);
  }
}

// --- Fallback Poll ---

function startFallbackPoll(): void {
  if (fallbackPollInterval) {
    clearInterval(fallbackPollInterval);
  }

  fallbackPollInterval = setInterval(() => {
    let hasChanges = false;
    for (const [uuid, state] of sessionState.entries()) {
      const prevOffset = state.bytesRead;
      processFile(uuid);
      if (state.bytesRead !== prevOffset) hasChanges = true;
    }
    if (hasChanges) pushUpdate();
  }, FALLBACK_POLL_MS);
}

// --- Public API ---

function stopTracking(): ClaudeCodeSessionData[] {
  // Clear debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  // Close file watchers
  for (const watcher of fileWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  fileWatchers.clear();

  // Close directory watcher
  if (directoryWatcher) {
    try {
      directoryWatcher.close();
    } catch {
      // ignore
    }
    directoryWatcher = null;
  }

  // Clear fallback poll
  if (fallbackPollInterval) {
    clearInterval(fallbackPollInterval);
    fallbackPollInterval = null;
  }

  // Do final read of all files
  for (const uuid of sessionState.keys()) {
    processFile(uuid);
  }

  // Serialize session state to ClaudeCodeSessionData[]
  const result: ClaudeCodeSessionData[] = Array.from(sessionState.values()).map((s) => ({
    ccSessionUuid: s.ccSessionUuid,
    fileEditCount: s.filesEdited.size,
    totalIdleSeconds: s.idlePeriods.reduce((acc, p) => acc + p.durationSeconds, 0),
    idlePeriodCount: s.idlePeriods.length,
    firstActivityAt: s.firstActivityAt,
    lastActivityAt: s.lastActivityAt,
    filesEdited: Array.from(s.filesEdited),
    idlePeriods: s.idlePeriods,
  }));

  sessionState.clear();
  // watchedProjectPath cleared (tracking stopped)

  return result;
}

export function startTracking(
  projectDirName: string,
  webContents: WebContents,
  idleThresholdMinutes?: number,
): { started: boolean; error?: string } {
  // If already tracking, stop first (implicit stop-then-start).
  // Check all resource types including debounce timers and fallback poll interval.
  if (
    sessionState.size > 0 ||
    directoryWatcher !== null ||
    fileWatchers.size > 0 ||
    debounceTimers.size > 0 ||
    fallbackPollInterval !== null
  ) {
    console.warn("[claude-tracker] Tracker already active — stopping previous session");
    stopTracking();
  }

  let resolvedPath: string;
  try {
    resolvedPath = validateProjectDirName(projectDirName);
  } catch (err) {
    return { started: false, error: err instanceof Error ? err.message : "Invalid project directory name" };
  }

  // Check if directory exists
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return { started: false, error: "Project not found" };
    }
  } catch {
    return { started: false, error: "Project not found" };
  }

  targetWebContents = webContents;
  timerStartTime = Date.now();
  idleThresholdMs = (idleThresholdMinutes ?? 5) * 60 * 1000;

  scanAndInitialize(resolvedPath);
  watchDirectory(resolvedPath);
  startFallbackPoll();

  return { started: true };
}

export function stopTrackingAndGetData(): { sessions: ClaudeCodeSessionData[] } {
  const sessions = stopTracking();
  return { sessions };
}

export function getProjects(): { projects: ClaudeCodeProject[] } {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return { projects: [] };
  }

  const projects: ClaudeCodeProject[] = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dirName: e.name,
      displayPath: decodeProjectPath(e.name),
    }))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));

  return { projects };
}

/**
 * Unconditionally releases all tracker resources.
 * Called on app quit, renderer crash, or renderer reload.
 * Safe to call multiple times (idempotent).
 */
export function destroyTracker(): void {
  // Clear debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  // Close file watchers
  for (const watcher of fileWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
  }
  fileWatchers.clear();

  // Close directory watcher
  if (directoryWatcher) {
    try {
      directoryWatcher.close();
    } catch {
      // ignore
    }
    directoryWatcher = null;
  }

  // Clear fallback poll interval
  if (fallbackPollInterval) {
    clearInterval(fallbackPollInterval);
    fallbackPollInterval = null;
  }

  // Clear in-memory state
  sessionState.clear();
  targetWebContents = null;
  // watchedProjectPath cleared (tracking stopped)
}
