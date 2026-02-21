// electron/main/database.ts
// SQLite database module for the main process
// All operations are synchronous (better-sqlite3 API)

import { app } from "electron";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AssignTagInput,
  CreateTagInput,
  ListSessionsInput,
  ListSessionsResult,
  SaveSessionInput,
  Session,
  Tag,
  TimerSettings,
  TimerType,
  UpdateTagInput,
} from "../../src/shared/types.ts";

let db: Database.Database | null = null;

const VALID_TIMER_TYPES: readonly TimerType[] = ["work", "short_break", "long_break"];

const DEFAULT_SETTINGS: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
};

const MIN_DURATION = 60;
const MAX_DURATION = 7200;
const MAX_TITLE_LENGTH = 500;

export function initDatabase(dbPath?: string): void {
  // Close existing connection if any (supports re-initialization in tests)
  if (db) {
    db.close();
    db = null;
  }

  const resolvedPath = dbPath ?? getDefaultDbPath();
  db = new Database(resolvedPath);

  // Enable foreign key constraint enforcement (must be per-connection, before WAL)
  db.pragma("foreign_keys = ON");

  // Enable WAL mode for better performance
  db.pragma("journal_mode = WAL");

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL DEFAULT '',
      timer_type    TEXT NOT NULL,
      planned_duration_seconds  INTEGER NOT NULL,
      actual_duration_seconds   INTEGER NOT NULL,
      completed_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_completed_at ON sessions(completed_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#7aa2f7',
      created_at TEXT NOT NULL,
      UNIQUE(name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tag_id     INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
      PRIMARY KEY (session_id, tag_id)
    );
  `);
}

function getDefaultDbPath(): string {
  return path.join(app.getPath("userData"), "lizmeter.db");
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database is not initialized. Call initDatabase() first.");
  }
  return db;
}

function validateTimerType(timerType: unknown): asserts timerType is TimerType {
  if (!VALID_TIMER_TYPES.includes(timerType as TimerType)) {
    throw new Error(
      `Invalid timerType: "${String(timerType)}". Must be one of: ${VALID_TIMER_TYPES.join(", ")}`,
    );
  }
}

function validateDuration(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Invalid ${fieldName}: must be an integer, got ${String(value)}`);
  }
  if (value < MIN_DURATION || value > MAX_DURATION) {
    throw new Error(
      `Invalid ${fieldName}: ${value} is out of range [${MIN_DURATION}, ${MAX_DURATION}]`,
    );
  }
}

function sanitizeTitle(title: unknown): string {
  if (typeof title !== "string") {
    throw new Error(`Invalid title: must be a string`);
  }
  const trimmed = title.trim();
  return trimmed.slice(0, MAX_TITLE_LENGTH);
}

export function saveSession(input: SaveSessionInput): Session {
  const database = getDb();

  // Input validation (trust boundary — main process validates all inputs)
  validateTimerType(input.timerType);
  const title = sanitizeTitle(input.title);

  if (typeof input.plannedDurationSeconds !== "number" || input.plannedDurationSeconds <= 0) {
    throw new Error(`Invalid plannedDurationSeconds: ${String(input.plannedDurationSeconds)}`);
  }
  if (typeof input.actualDurationSeconds !== "number" || input.actualDurationSeconds < 0) {
    throw new Error(`Invalid actualDurationSeconds: ${String(input.actualDurationSeconds)}`);
  }

  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();

  const stmt = database.prepare(`
    INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, title, input.timerType, input.plannedDurationSeconds, input.actualDurationSeconds, completedAt);

  return {
    id,
    title,
    timerType: input.timerType,
    plannedDurationSeconds: input.plannedDurationSeconds,
    actualDurationSeconds: input.actualDurationSeconds,
    completedAt,
    tags: [],
  };
}

interface SessionRow {
  id: string;
  title: string;
  timerType: string;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  completedAt: string;
}

interface TagRow {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

function rowToTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, color: row.color, createdAt: row.created_at };
}

export function listSessions(input: ListSessionsInput = {}): ListSessionsResult {
  const database = getDb();

  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const tagId = input.tagId;

  let rows: SessionRow[];
  let total: number;

  if (tagId !== undefined) {
    rows = database
      .prepare(
        `SELECT s.id, s.title, s.timer_type as timerType,
                s.planned_duration_seconds as plannedDurationSeconds,
                s.actual_duration_seconds as actualDurationSeconds,
                s.completed_at as completedAt
         FROM sessions s
         INNER JOIN session_tags st ON st.session_id = s.id AND st.tag_id = ?
         ORDER BY s.completed_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(tagId, limit, offset) as SessionRow[];
    const countRow = database
      .prepare(
        `SELECT COUNT(*) as count FROM sessions s
         INNER JOIN session_tags st ON st.session_id = s.id AND st.tag_id = ?`,
      )
      .get(tagId) as { count: number };
    total = countRow.count;
  } else {
    rows = database
      .prepare(
        `SELECT id, title, timer_type as timerType,
                planned_duration_seconds as plannedDurationSeconds,
                actual_duration_seconds as actualDurationSeconds,
                completed_at as completedAt
         FROM sessions
         ORDER BY completed_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as SessionRow[];
    const countRow = database.prepare("SELECT COUNT(*) as count FROM sessions").get() as {
      count: number;
    };
    total = countRow.count;
  }

  const getTagsStmt = database.prepare(
    `SELECT t.id, t.name, t.color, t.created_at
     FROM tags t
     INNER JOIN session_tags st ON st.tag_id = t.id
     WHERE st.session_id = ?
     ORDER BY t.name ASC`,
  );

  const sessions: Session[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    timerType: row.timerType as TimerType,
    plannedDurationSeconds: row.plannedDurationSeconds,
    actualDurationSeconds: row.actualDurationSeconds,
    completedAt: row.completedAt,
    tags: (getTagsStmt.all(row.id) as TagRow[]).map(rowToTag),
  }));

  return { sessions, total };
}

export function deleteSession(id: string): void {
  const database = getDb();
  // No-op if ID doesn't exist — delete is safe to call with any ID
  database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function getSettings(): TimerSettings {
  const database = getDb();

  const rows = database
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)")
    .all("timer.work_duration", "timer.short_break_duration", "timer.long_break_duration") as Array<{
      key: string;
      value: string;
    }>;

  const settingsMap = new Map(rows.map((r) => [r.key, r.value]));

  return {
    workDuration: settingsMap.has("timer.work_duration")
      ? parseInt(settingsMap.get("timer.work_duration")!, 10)
      : DEFAULT_SETTINGS.workDuration,
    shortBreakDuration: settingsMap.has("timer.short_break_duration")
      ? parseInt(settingsMap.get("timer.short_break_duration")!, 10)
      : DEFAULT_SETTINGS.shortBreakDuration,
    longBreakDuration: settingsMap.has("timer.long_break_duration")
      ? parseInt(settingsMap.get("timer.long_break_duration")!, 10)
      : DEFAULT_SETTINGS.longBreakDuration,
  };
}

// --- Tag Functions ---

const MAX_TAG_NAME_LENGTH = 32;
const VALID_TAG_COLORS = new Set([
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#9ece6a",
  "#f7768e",
  "#ff9e64",
  "#e0af68",
  "#c678dd",
]);

function validateTagName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Tag name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_TAG_NAME_LENGTH) {
    throw new Error(`Tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

function validateTagColor(color: unknown): string {
  if (typeof color !== "string" || !VALID_TAG_COLORS.has(color)) {
    throw new Error(
      `Invalid tag color. Must be one of: ${[...VALID_TAG_COLORS].join(", ")}`,
    );
  }
  return color;
}

export function createTag(input: CreateTagInput): Tag {
  const database = getDb();
  const name = validateTagName(input.name);
  const color = validateTagColor(input.color);
  const createdAt = new Date().toISOString();
  database
    .prepare("INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)")
    .run(name, color, createdAt);
  const row = database
    .prepare("SELECT id, name, color, created_at FROM tags WHERE name = ? COLLATE NOCASE")
    .get(name) as TagRow;
  return rowToTag(row);
}

export function listTags(): Tag[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT id, name, color, created_at FROM tags ORDER BY name ASC")
    .all() as TagRow[];
  return rows.map(rowToTag);
}

export function updateTag(input: UpdateTagInput): Tag {
  const database = getDb();
  const name = validateTagName(input.name);
  const color = validateTagColor(input.color);
  const result = database
    .prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?")
    .run(name, color, input.id);
  if (result.changes === 0) {
    throw new Error(`Tag with id ${input.id} not found`);
  }
  const row = database
    .prepare("SELECT id, name, color, created_at FROM tags WHERE id = ?")
    .get(input.id) as TagRow;
  return rowToTag(row);
}

export function deleteTag(id: number): void {
  const database = getDb();
  database.prepare("DELETE FROM tags WHERE id = ?").run(id);
}

export function assignTag(input: AssignTagInput): void {
  const database = getDb();
  database
    .prepare("INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)")
    .run(input.sessionId, input.tagId);
}

export function unassignTag(input: AssignTagInput): void {
  const database = getDb();
  database
    .prepare("DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?")
    .run(input.sessionId, input.tagId);
}

export function listTagsForSession(sessionId: string): Tag[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT t.id, t.name, t.color, t.created_at
       FROM tags t
       INNER JOIN session_tags st ON st.tag_id = t.id
       WHERE st.session_id = ?
       ORDER BY t.name ASC`,
    )
    .all(sessionId) as TagRow[];
  return rows.map(rowToTag);
}

export function saveSettings(settings: TimerSettings): void {
  // Input validation
  validateDuration(settings.workDuration, "workDuration");
  validateDuration(settings.shortBreakDuration, "shortBreakDuration");
  validateDuration(settings.longBreakDuration, "longBreakDuration");

  const database = getDb();
  const upsert = database.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  );

  const upsertMany = database.transaction(() => {
    upsert.run("timer.work_duration", String(settings.workDuration));
    upsert.run("timer.short_break_duration", String(settings.shortBreakDuration));
    upsert.run("timer.long_break_duration", String(settings.longBreakDuration));
  });

  upsertMany();
}
