// electron/main/claude-code-tracker.ts
// Core Claude Code tracking module: file watching, JSONL parsing, state management

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ClaudeCodeLiveStats,
  ClaudeCodeProject,
  ClaudeCodeSessionData,
  ClaudeSessionActivity,
  ClaudeCodeSessionPreview,
} from "../../src/shared/types.ts";
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
  // Activity tracking: inferred from last JSONL line
  lastLineType: string | null; // "user", "assistant", etc.
  lastToolNames: string[]; // tool names from last assistant message with tool_use blocks
}

// --- Module-level singleton state ---

let directoryWatcher: fs.FSWatcher | null = null;
const fileWatchers: Map<string, fs.FSWatcher> = new Map();
const debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let fallbackPollInterval: ReturnType<typeof setInterval> | null = null;
const sessionState: Map<string, SessionState> = new Map(); // keyed by ccSessionUuid (active tracked)
const frozenSessions: Map<string, SessionState> = new Map(); // removed mid-run (preserve data)
let discoveredSessions: ClaudeCodeSessionPreview[] = []; // scan results (v1.2)
const trackedUuids: Set<string> = new Set(); // user-selected session UUIDs (v1.2)
let targetWebContents: WebContents | null = null;
let idleThresholdMs: number = 5 * 60 * 1000; // default 5 minutes
// watchedProjectPath is set at scan time and cleared at stop; used as sentinel for active-scan state
let watchedProjectPath: string | null = null; // resolved path for directory watcher (v1.2)
let isPaused: boolean = false; // pause/resume state (v1.2)
// Queue for new-session notifications (emit one at a time with 1s gap)
const newSessionQueue: ClaudeCodeSessionPreview[] = [];
let newSessionEmitTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 500;
const FALLBACK_POLL_MS = 30_000;
const SESSION_BUFFER_MS = 120_000; // 2-minute buffer
const MAX_PARTIAL_LINE_BYTES = 1_048_576; // 1MB cap
const FIRST_USER_MSG_SCAN_LINES = 100;
const FIRST_USER_MSG_MAX_CHARS = 60;
const NEW_SESSION_EMIT_GAP_MS = 1_000;

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

// --- First User Message Extractor (v1.2) ---

/**
 * Reads up to FIRST_USER_MSG_SCAN_LINES lines from the start of a JSONL file,
 * finds the first type:"user" message, extracts text content truncated to 60 chars.
 * Returns null if not found or on parse errors.
 */
export function extractFirstUserMessage(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    if (fileSize === 0) {
      fs.closeSync(fd);
      return null;
    }

    // Read up to 16KB from start (should cover 100 lines for typical JSONL)
    const readSize = Math.min(16384, fileSize);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, 0);
    fs.closeSync(fd);
    fd = null;

    const chunk = buffer.toString("utf8");
    const rawLines = chunk.split("\n");

    let lineCount = 0;
    for (const raw of rawLines) {
      if (lineCount >= FIRST_USER_MSG_SCAN_LINES) break;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      lineCount++;

      const parsed = parseJsonlLine(trimmed);
      if (!parsed || parsed.type !== "user") continue;

      // Extract text content from the message
      const content = parsed.message?.content;
      let text: string | null = null;

      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        // Content blocks array — find first text block
        for (const block of content) {
          if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
            const textVal = (block as { type: string; text?: unknown }).text;
            if (typeof textVal === "string") {
              text = textVal;
              break;
            }
          }
        }
      }

      if (text && text.trim().length > 0) {
        const trimmedText = text.trim();
        // Skip system-injected messages (plugin caveats, slash commands, command output)
        if (trimmedText.startsWith("<")) continue;
        if (trimmedText.length <= FIRST_USER_MSG_MAX_CHARS) {
          return trimmedText;
        }
        return trimmedText.substring(0, FIRST_USER_MSG_MAX_CHARS - 1) + "…";
      }
    }
    return null;
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    return null;
  }
}

// --- Session State Processing ---

/**
 * Extract all tool names from an assistant message's content blocks.
 */
export function extractToolNamesFromLine(line: JsonlLine): string[] {
  if (line.type !== "assistant") return [];
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];

  const names: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as ToolUseBlock).type === "tool_use" &&
      typeof (block as ToolUseBlock).name === "string"
    ) {
      names.push((block as ToolUseBlock).name);
    }
  }
  return names;
}

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

    // Track last line type and tool names for activity inference
    state.lastLineType = line.type;
    if (line.type === "assistant") {
      const toolNames = extractToolNamesFromLine(line);
      state.lastToolNames = toolNames;
    } else if (line.type === "user") {
      state.lastToolNames = [];
    }

    // Extract file edits from Write/Edit tool_use blocks
    const edited = extractFileEditsFromLine(line);
    for (const fp of edited) {
      state.filesEdited.add(fp);
    }
  }
}

// --- Aggregation ---

/**
 * Derive session activity from the most recently active tracked session.
 * Uses the last JSONL line type to infer what Claude is doing.
 */
function deriveSessionActivity(states: SessionState[]): ClaudeSessionActivity | undefined {
  if (states.length === 0) return undefined;

  // Find the session with the most recent activity
  let mostRecent: SessionState | null = null;
  for (const s of states) {
    if (!s.lastActivityAt) continue;
    if (!mostRecent || s.lastActivityAt > mostRecent.lastActivityAt!) {
      mostRecent = s;
    }
  }

  if (!mostRecent || !mostRecent.lastLineType) return undefined;

  // Infer activity from last line type:
  // - "user" line → Claude received input, is thinking/reasoning
  // - "assistant" with tool_use → Claude just used tools
  // - "assistant" without tool_use → Claude finished responding, idle
  if (mostRecent.lastLineType === "user") {
    return { type: "thinking" };
  }

  if (mostRecent.lastLineType === "assistant") {
    if (mostRecent.lastToolNames.length > 0) {
      return { type: "tool_use", toolNames: mostRecent.lastToolNames };
    }
    return { type: "idle" };
  }

  // Other line types (file-history-snapshot, system, etc.) — don't change activity
  return undefined;
}

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
    sessionActivity: deriveSessionActivity(states),
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
  if (isPaused) return; // ignore events while paused

  const existing = debounceTimers.get(ccSessionUuid);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(ccSessionUuid);
    if (!isPaused) {
      processFile(ccSessionUuid);
      pushUpdate();
    }
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

// --- New Session Notification Queue ---

function emitNextNewSession(): void {
  if (newSessionQueue.length === 0) {
    newSessionEmitTimer = null;
    return;
  }
  const session = newSessionQueue.shift()!;
  if (targetWebContents && !targetWebContents.isDestroyed()) {
    targetWebContents.send("claude-tracker:new-session", { session });
  }
  // Schedule next emission after gap
  newSessionEmitTimer = setTimeout(emitNextNewSession, NEW_SESSION_EMIT_GAP_MS);
}

function queueNewSessionNotification(session: ClaudeCodeSessionPreview): void {
  newSessionQueue.push(session);
  if (!newSessionEmitTimer) {
    emitNextNewSession();
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

      // Skip if already tracking or already discovered (already in picker)
      if (trackedUuids.has(ccSessionUuid)) return;
      if (discoveredSessions.some((s) => s.ccSessionUuid === ccSessionUuid)) return;
      if (frozenSessions.has(ccSessionUuid)) return;

      const filePath = path.join(projectPath, filename);

      // Check if the file exists (may be a delete event)
      try {
        fs.statSync(filePath);
      } catch {
        return;
      }

      // Extract preview info for notification
      const lastActivityAt = readLastLineTimestamp(filePath);
      if (!lastActivityAt) return;

      const firstUserMessage = extractFirstUserMessage(filePath);

      const preview: ClaudeCodeSessionPreview = {
        ccSessionUuid,
        lastActivityAt,
        firstUserMessage,
        filePath,
      };

      // Add to discovered sessions so we don't emit again
      discoveredSessions.push(preview);

      // Emit notification to renderer
      queueNewSessionNotification(preview);
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
    if (isPaused) return; // skip poll while paused

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

/**
 * Phase 1 (v1.2): Scan project directory for active Claude Code sessions.
 * Returns session previews for display in the picker. Does NOT start tracking.
 * Also starts the directory watcher for detecting new files during the run.
 */
export function scanSessions(
  projectDirName: string,
  webContents: WebContents,
  idleThresholdMinutes?: number,
): { success: boolean; error?: string; sessions: ClaudeCodeSessionPreview[] } {
  // If already scanning/tracking, stop first
  if (
    watchedProjectPath !== null ||
    sessionState.size > 0 ||
    frozenSessions.size > 0 ||
    directoryWatcher !== null ||
    fileWatchers.size > 0 ||
    debounceTimers.size > 0 ||
    fallbackPollInterval !== null
  ) {
    console.warn("[claude-tracker] Tracker already active — stopping previous session");
    destroyTracker();
  }

  let resolvedPath: string;
  try {
    resolvedPath = validateProjectDirName(projectDirName);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Invalid project directory name",
      sessions: [],
    };
  }

  // Check if directory exists
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return { success: false, error: "Project not found", sessions: [] };
    }
  } catch {
    return { success: false, error: "Project not found", sessions: [] };
  }

  targetWebContents = webContents;
  idleThresholdMs = (idleThresholdMinutes ?? 5) * 60 * 1000;
  watchedProjectPath = resolvedPath;

  // Scan JSONL files for preview info
  const sessions = scanAndBuildPreviews(resolvedPath);

  // Store scan results
  discoveredSessions = sessions;

  // Start directory watcher for new-session notifications (FR-033)
  watchDirectory(resolvedPath);

  // Return sorted by lastActivityAt descending (most recent first per FR-035)
  const sorted = sessions.slice().sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return { success: true, sessions: sorted };
}

function scanAndBuildPreviews(projectPath: string): ClaudeCodeSessionPreview[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    console.warn(`[claude-tracker] Cannot read project directory: ${projectPath}`);
    return [];
  }

  const now = Date.now();
  // No timerStartTime yet at scan time — use now as reference
  const bufferStart = now - SESSION_BUFFER_MS;
  const previews: ClaudeCodeSessionPreview[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

    const filePath = path.join(projectPath, entry.name);
    const ccSessionUuid = entry.name.replace(/\.jsonl$/, "");

    // Check if session was active within 2-minute buffer
    const lastTs = readLastLineTimestamp(filePath);
    if (!lastTs) continue;

    const tsMs = new Date(lastTs).getTime();
    if (tsMs < bufferStart || tsMs > now) continue;

    // Extract first user message for picker preview
    const firstUserMessage = extractFirstUserMessage(filePath);

    previews.push({
      ccSessionUuid,
      lastActivityAt: lastTs,
      firstUserMessage,
      filePath,
    });
  }

  return previews;
}

/**
 * Phase 2 (v1.2): Begin tracking only user-selected Claude Code sessions.
 * Can be called multiple times mid-run to update the tracked set.
 * Sessions removed from the set are frozen (data preserved, watcher closed).
 */
export function trackSelectedSessions(
  sessionUuids: string[],
): { tracked: number } {
  const newUuidSet = new Set(sessionUuids);

  // Remove sessions no longer in the selected set -> freeze them
  for (const uuid of Array.from(trackedUuids)) {
    if (!newUuidSet.has(uuid)) {
      // Move to frozen: close watcher, preserve state
      const state = sessionState.get(uuid);
      if (state) {
        frozenSessions.set(uuid, state);
        sessionState.delete(uuid);
      }
      // Close file watcher for this session
      const watcher = fileWatchers.get(uuid);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        fileWatchers.delete(uuid);
      }
      // Cancel any pending debounce for this session
      const timer = debounceTimers.get(uuid);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(uuid);
      }
      trackedUuids.delete(uuid);
    }
  }

  // Add newly selected sessions
  for (const uuid of sessionUuids) {
    if (trackedUuids.has(uuid)) continue; // already tracking, no change

    // Find preview info from discovered sessions
    const preview = discoveredSessions.find((s) => s.ccSessionUuid === uuid);
    if (!preview) {
      console.warn(`[claude-tracker] UUID not in discovered sessions: ${uuid}`);
      continue;
    }

    // Get file size to start incremental reading from current position
    let fileSize: number;
    try {
      const stat = fs.statSync(preview.filePath);
      fileSize = stat.size;
    } catch {
      console.warn(`[claude-tracker] Cannot stat file for tracking: ${preview.filePath}`);
      continue;
    }

    const state: SessionState = {
      ccSessionUuid: uuid,
      filesEdited: new Set(),
      lastMessageTimestamp: null,
      firstActivityAt: null,
      lastActivityAt: null,
      idlePeriods: [],
      bytesRead: fileSize, // start at current end (only track new activity)
      filePath: preview.filePath,
      partialLine: "",
      lastLineType: null,
      lastToolNames: [],
    };

    sessionState.set(uuid, state);
    trackedUuids.add(uuid);
    watchFile(state);
  }

  // Start fallback poll if not already running (only when at least 1 session tracked)
  if (sessionUuids.length > 0 && !fallbackPollInterval) {
    startFallbackPoll();
  }

  // Push initial stats update
  pushUpdate();

  return { tracked: trackedUuids.size };
}

/**
 * v1.2: Pause data collection. Watcher events are ignored while paused.
 * The directory watcher continues to detect new files.
 */
export function pauseTracking(): void {
  isPaused = true;
}

/**
 * v1.2: Resume data collection. Next event or poll will process accumulated changes.
 */
export function resumeTracking(): void {
  isPaused = false;
}

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

  // Clear new-session emit timer
  if (newSessionEmitTimer) {
    clearTimeout(newSessionEmitTimer);
    newSessionEmitTimer = null;
  }
  newSessionQueue.length = 0;

  // Do final read of all active tracked files
  for (const uuid of sessionState.keys()) {
    processFile(uuid);
  }

  // Merge active sessions + frozen sessions into result
  const allStates = [
    ...Array.from(sessionState.values()),
    ...Array.from(frozenSessions.values()),
  ];

  const result: ClaudeCodeSessionData[] = allStates.map((s) => ({
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
  frozenSessions.clear();
  trackedUuids.clear();
  discoveredSessions = [];
  watchedProjectPath = null;
  isPaused = false;

  return result;
}

export function stopTrackingAndGetData(): { sessions: ClaudeCodeSessionData[] } {
  const sessions = stopTracking();
  return { sessions };
}

/**
 * Scan ALL projects for active Claude Code sessions.
 * Lightweight: no watchers, no state mutation. Just reads JSONL previews.
 * Used by the stopwatch dropdown to let users pick a session to link.
 */
export function scanAllProjects(): { sessions: Array<ClaudeCodeSessionPreview & { projectDirName: string; projectDisplayPath: string }> } {
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");

  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return { sessions: [] };
  }

  const allSessions: Array<ClaudeCodeSessionPreview & { projectDirName: string; projectDisplayPath: string }> = [];

  for (const projEntry of projectEntries) {
    if (!projEntry.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, projEntry.name);
    const displayPath = decodeProjectPath(projEntry.name);

    let fileEntries: fs.Dirent[];
    try {
      fileEntries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const now = Date.now();
    const bufferStart = now - SESSION_BUFFER_MS;

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;

      const filePath = path.join(projectPath, fileEntry.name);
      const ccSessionUuid = fileEntry.name.replace(/\.jsonl$/, "");

      const lastTs = readLastLineTimestamp(filePath);
      if (!lastTs) continue;

      const tsMs = new Date(lastTs).getTime();
      if (tsMs < bufferStart || tsMs > now) continue;

      const firstUserMessage = extractFirstUserMessage(filePath);

      allSessions.push({
        ccSessionUuid,
        lastActivityAt: lastTs,
        firstUserMessage,
        filePath,
        projectDirName: projEntry.name,
        projectDisplayPath: displayPath,
      });
    }
  }

  // Sort by most recent activity first
  allSessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  return { sessions: allSessions };
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

  // Clear new-session emit timer
  if (newSessionEmitTimer) {
    clearTimeout(newSessionEmitTimer);
    newSessionEmitTimer = null;
  }
  newSessionQueue.length = 0;

  // Clear in-memory state
  sessionState.clear();
  frozenSessions.clear();
  discoveredSessions = [];
  trackedUuids.clear();
  targetWebContents = null;
  watchedProjectPath = null;
  isPaused = false;
}
