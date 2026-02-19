// src/main/database.ts
// SQLite database module for the main process
// All operations are synchronous (better-sqlite3 API)

import Database from "better-sqlite3";
import type {
  ListSessionsInput,
  ListSessionsResult,
  SaveSessionInput,
  Session,
  TimerSettings,
  TimerType,
} from "../shared/types.ts";

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

  const path = dbPath ?? getDefaultDbPath();
  db = new Database(path);

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
  `);
}

function getDefaultDbPath(): string {
  // Dynamic import of electron and path is necessary here:
  // - database.ts is a main-process-only module loaded by Electron
  // - Tests call initDatabase(":memory:") and bypass this code path entirely
  // - ESLint rule suppressed intentionally: no alternative to require() for
  //   runtime-conditional Electron API access in a bundled ESM context
  /* eslint-disable @typescript-eslint/no-require-imports */
  const electronModule = require("electron") as { app: { getPath: (name: string) => string; }; };
  const pathModule = require("node:path") as { join: (...args: string[]) => string; };
  /* eslint-enable @typescript-eslint/no-require-imports */
  return pathModule.join(electronModule.app.getPath("userData"), "lizmeter.db");
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
  };
}

export function listSessions(input: ListSessionsInput): ListSessionsResult {
  const database = getDb();

  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  const sessions = database
    .prepare(`
      SELECT id, title, timer_type as timerType, planned_duration_seconds as plannedDurationSeconds,
             actual_duration_seconds as actualDurationSeconds, completed_at as completedAt
      FROM sessions
      ORDER BY completed_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(limit, offset) as Session[];

  const totalRow = database
    .prepare("SELECT COUNT(*) as count FROM sessions")
    .get() as { count: number; };

  return {
    sessions,
    total: totalRow.count,
  };
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
