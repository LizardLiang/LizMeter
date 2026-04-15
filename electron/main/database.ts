// electron/main/database.ts
// SQLite database module for the main process
// All operations are synchronous (better-sqlite3 API)

import { app } from "electron";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  AssignTagInput,
  ClaudeCodeIdlePeriod,
  ClaudeCodeSessionSummary,
  CreateTagInput,
  ListSessionsInput,
  ListSessionsResult,
  MusicLibraryListInput,
  MusicLibraryListResult,
  MusicPlaylist,
  MusicSortDir,
  MusicSortField,
  NvimActivity,
  PlaylistTrack,
  SaveSessionInput,
  SaveSessionWithTrackingInput,
  Session,
  Tag,
  TimerSettings,
  TimerType,
  UpdateTagInput,
  WorklogStatus,
} from "../../src/shared/types.ts";
import type { InternalTrackRecord } from "./music/internal-types.ts";
import { toRendererTrack } from "./music/internal-types.ts";

let db: Database.Database | null = null;

const VALID_TIMER_TYPES: readonly TimerType[] = ["work", "short_break", "long_break", "stopwatch"];
const VALID_ISSUE_PROVIDERS = new Set(["github", "linear", "jira"]);

const DEFAULT_SETTINGS: TimerSettings = {
  workDuration: 1500,
  shortBreakDuration: 300,
  longBreakDuration: 900,
};

const MIN_DURATION = 60;
const MAX_DURATION = 7200;
const MAX_TITLE_LENGTH = 5000;
const MAX_NVIM_FIELD_LENGTH = 1000;

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

    CREATE TABLE IF NOT EXISTS claude_code_sessions (
      id                  TEXT PRIMARY KEY,
      session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      cc_session_uuid     TEXT NOT NULL,
      file_edit_count     INTEGER NOT NULL DEFAULT 0,
      total_idle_seconds  INTEGER NOT NULL DEFAULT 0,
      idle_period_count   INTEGER NOT NULL DEFAULT 0,
      first_activity_at   TEXT,
      last_activity_at    TEXT,
      files_edited        TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_cc_sessions_session_id ON claude_code_sessions(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_sessions_unique ON claude_code_sessions(session_id, cc_session_uuid);

    CREATE TABLE IF NOT EXISTS claude_code_idle_periods (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      cc_session_id       TEXT NOT NULL REFERENCES claude_code_sessions(id) ON DELETE CASCADE,
      start_at            TEXT NOT NULL,
      end_at              TEXT NOT NULL,
      duration_seconds    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cc_idle_cc_session_id ON claude_code_idle_periods(cc_session_id);

    CREATE TABLE IF NOT EXISTS nvim_activity (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      file        TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nvim_activity_recorded_at ON nvim_activity(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nvim_activity_project ON nvim_activity(project);

    CREATE TABLE IF NOT EXISTS tracks (
      id                TEXT PRIMARY KEY,
      source_url        TEXT NOT NULL UNIQUE,
      source_id         TEXT NOT NULL,
      source_site       TEXT NOT NULL,
      title             TEXT NOT NULL,
      artist            TEXT,
      duration_seconds  INTEGER,
      thumbnail_url     TEXT,
      cached_file_path  TEXT,
      cache_size_bytes  INTEGER,
      play_count        INTEGER NOT NULL DEFAULT 0,
      last_played_at    TEXT,
      added_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_source_url ON tracks(source_url);
    CREATE INDEX IF NOT EXISTS idx_tracks_last_played_at ON tracks(last_played_at);
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_tracks_cached ON tracks(cached_file_path) WHERE cached_file_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at DESC);

    CREATE TABLE IF NOT EXISTS playlists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'user_created',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_position ON playlist_tracks(playlist_id, position);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
  `);

  // Idempotent migration: add issue columns if they don't exist yet
  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("issue_number")) {
    db.exec("ALTER TABLE sessions ADD COLUMN issue_number INTEGER");
    db.exec("ALTER TABLE sessions ADD COLUMN issue_title TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN issue_url TEXT");
  }
  // Idempotent migration: add generic provider columns for multi-provider support
  if (!cols.includes("issue_provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN issue_provider TEXT");
    db.exec("ALTER TABLE sessions ADD COLUMN issue_id TEXT");
  }
  // Idempotent migration: add worklog tracking columns
  if (!cols.includes("worklog_status")) {
    db.exec("ALTER TABLE sessions ADD COLUMN worklog_status TEXT NOT NULL DEFAULT 'not_logged'");
    db.exec("ALTER TABLE sessions ADD COLUMN worklog_id TEXT");
  }
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

function validateIssueProvider(provider: unknown): void {
  if (provider === undefined || provider === null) return;
  if (!VALID_ISSUE_PROVIDERS.has(provider as string)) {
    throw new Error(
      `Invalid issueProvider: "${String(provider)}". Must be one of: ${[...VALID_ISSUE_PROVIDERS].join(", ")}`,
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

function validateSessionInput(input: SaveSessionInput): string {
  validateTimerType(input.timerType);
  validateIssueProvider(input.issueProvider);
  const title = sanitizeTitle(input.title);

  if (input.timerType === "stopwatch") {
    if (typeof input.plannedDurationSeconds !== "number" || input.plannedDurationSeconds < 0) {
      throw new Error(`Invalid plannedDurationSeconds: ${String(input.plannedDurationSeconds)}`);
    }
  } else {
    if (typeof input.plannedDurationSeconds !== "number" || input.plannedDurationSeconds <= 0) {
      throw new Error(`Invalid plannedDurationSeconds: ${String(input.plannedDurationSeconds)}`);
    }
  }
  if (typeof input.actualDurationSeconds !== "number" || input.actualDurationSeconds < 0) {
    throw new Error(`Invalid actualDurationSeconds: ${String(input.actualDurationSeconds)}`);
  }
  return title;
}

function buildSessionResult(id: string, title: string, input: SaveSessionInput, completedAt: string): Session {
  return {
    id,
    title,
    timerType: input.timerType,
    plannedDurationSeconds: input.plannedDurationSeconds,
    actualDurationSeconds: input.actualDurationSeconds,
    completedAt,
    tags: [],
    issueNumber: input.issueNumber ?? null,
    issueTitle: input.issueTitle ?? null,
    issueUrl: input.issueUrl ?? null,
    issueProvider: input.issueProvider ?? null,
    issueId: input.issueId ?? null,
    worklogStatus: "not_logged" as WorklogStatus,
    worklogId: null,
  };
}

export function saveSession(input: SaveSessionInput): Session {
  const database = getDb();
  const title = validateSessionInput(input);

  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();

  const issueProvider = input.issueProvider ?? null;
  const issueId = input.issueId ?? null;

  const stmt = database.prepare(`
    INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at, issue_number, issue_title, issue_url, issue_provider, issue_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    title,
    input.timerType,
    input.plannedDurationSeconds,
    input.actualDurationSeconds,
    completedAt,
    input.issueNumber ?? null,
    input.issueTitle ?? null,
    input.issueUrl ?? null,
    issueProvider,
    issueId,
  );

  return buildSessionResult(id, title, input, completedAt);
}

interface SessionRow {
  id: string;
  title: string;
  timerType: string;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  completedAt: string;
  issueNumber: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
  issueProvider: string | null;
  issueId: string | null;
  worklogStatus: string;
  worklogId: string | null;
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
                s.completed_at as completedAt,
                s.issue_number as issueNumber,
                s.issue_title as issueTitle,
                s.issue_url as issueUrl,
                s.issue_provider as issueProvider,
                s.issue_id as issueId,
                s.worklog_status as worklogStatus,
                s.worklog_id as worklogId
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
                completed_at as completedAt,
                issue_number as issueNumber,
                issue_title as issueTitle,
                issue_url as issueUrl,
                issue_provider as issueProvider,
                issue_id as issueId,
                worklog_status as worklogStatus,
                worklog_id as worklogId
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
    issueNumber: row.issueNumber ?? null,
    issueTitle: row.issueTitle ?? null,
    issueUrl: row.issueUrl ?? null,
    issueProvider: (row.issueProvider as "github" | "linear" | "jira" | null) ?? null,
    issueId: row.issueId ?? null,
    worklogStatus: (row.worklogStatus ?? "not_logged") as WorklogStatus,
    worklogId: row.worklogId ?? null,
  }));

  return { sessions, total };
}

export function saveSessionWithTracking(input: SaveSessionWithTrackingInput): Session {
  const database = getDb();
  const title = validateSessionInput(input);

  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();
  const issueProvider = input.issueProvider ?? null;
  const issueId = input.issueId ?? null;

  const insertSession = database.prepare(`
    INSERT INTO sessions (id, title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at, issue_number, issue_title, issue_url, issue_provider, issue_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertCcSession = database.prepare(`
    INSERT OR IGNORE INTO claude_code_sessions
      (id, session_id, cc_session_uuid, file_edit_count, total_idle_seconds, idle_period_count, first_activity_at, last_activity_at, files_edited)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertIdlePeriod = database.prepare(`
    INSERT INTO claude_code_idle_periods (cc_session_id, start_at, end_at, duration_seconds)
    VALUES (?, ?, ?, ?)
  `);

  const runTransaction = database.transaction(() => {
    insertSession.run(
      id,
      title,
      input.timerType,
      input.plannedDurationSeconds,
      input.actualDurationSeconds,
      completedAt,
      input.issueNumber ?? null,
      input.issueTitle ?? null,
      input.issueUrl ?? null,
      issueProvider,
      issueId,
    );

    if (input.claudeCodeSessions && input.claudeCodeSessions.length > 0) {
      for (const ccSession of input.claudeCodeSessions) {
        const ccId = crypto.randomUUID();
        const filesEditedJson = JSON.stringify(ccSession.filesEdited ?? []);

        // SELECT-before-INSERT: used instead of relying on INSERT OR IGNORE's `changes` count
        // because the Vitest sql.js shim does not return `changes` from Statement.run().
        // Within a single transaction this SELECT will always return null for a fresh UUID,
        // but the pattern provides idempotency safety and test compatibility.
        const existingRow = database
          .prepare(
            "SELECT id FROM claude_code_sessions WHERE session_id = ? AND cc_session_uuid = ?",
          )
          .get(id, ccSession.ccSessionUuid);

        if (!existingRow) {
          insertCcSession.run(
            ccId,
            id,
            ccSession.ccSessionUuid,
            ccSession.fileEditCount,
            ccSession.totalIdleSeconds,
            ccSession.idlePeriodCount,
            ccSession.firstActivityAt ?? null,
            ccSession.lastActivityAt ?? null,
            filesEditedJson,
          );

          // Insert idle periods for this CC session
          if (ccSession.idlePeriods && ccSession.idlePeriods.length > 0) {
            for (const period of ccSession.idlePeriods) {
              insertIdlePeriod.run(ccId, period.startAt, period.endAt, period.durationSeconds);
            }
          }
        }
      }
    }
  });

  runTransaction();

  return buildSessionResult(id, title, input, completedAt);
}

export function getClaudeCodeDataForSession(
  sessionId: string,
): { sessions: ClaudeCodeSessionSummary[] } | null {
  const database = getDb();

  const ccRows = database
    .prepare(
      `SELECT id, cc_session_uuid, file_edit_count, total_idle_seconds, idle_period_count,
              first_activity_at, last_activity_at, files_edited
       FROM claude_code_sessions
       WHERE session_id = ?
       ORDER BY first_activity_at ASC`,
    )
    .all(sessionId) as Array<{
      id: string;
      cc_session_uuid: string;
      file_edit_count: number;
      total_idle_seconds: number;
      idle_period_count: number;
      first_activity_at: string | null;
      last_activity_at: string | null;
      files_edited: string;
    }>;

  if (ccRows.length === 0) return null;

  const getIdlePeriodsStmt = database.prepare(
    `SELECT start_at, end_at, duration_seconds
     FROM claude_code_idle_periods
     WHERE cc_session_id = ?
     ORDER BY start_at ASC`,
  );

  const sessions: ClaudeCodeSessionSummary[] = ccRows.map((row) => {
    const idlePeriods = (
      getIdlePeriodsStmt.all(row.id) as Array<{
        start_at: string;
        end_at: string;
        duration_seconds: number;
      }>
    ).map(
      (p): ClaudeCodeIdlePeriod => ({
        startAt: p.start_at,
        endAt: p.end_at,
        durationSeconds: p.duration_seconds,
      }),
    );

    let filesEdited: string[];
    try {
      filesEdited = JSON.parse(row.files_edited) as string[];
    } catch {
      filesEdited = [];
    }

    return {
      id: row.id,
      ccSessionUuid: row.cc_session_uuid,
      fileEditCount: row.file_edit_count,
      totalIdleSeconds: row.total_idle_seconds,
      idlePeriodCount: row.idle_period_count,
      firstActivityAt: row.first_activity_at,
      lastActivityAt: row.last_activity_at,
      filesEdited,
      idlePeriods,
    };
  });

  return { sessions };
}

export function deleteSession(id: string): void {
  const database = getDb();
  // No-op if ID doesn't exist — delete is safe to call with any ID
  database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function getSessionById(id: string): Session | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT id, title, timer_type as timerType,
              planned_duration_seconds as plannedDurationSeconds,
              actual_duration_seconds as actualDurationSeconds,
              completed_at as completedAt,
              issue_number as issueNumber,
              issue_title as issueTitle,
              issue_url as issueUrl,
              issue_provider as issueProvider,
              issue_id as issueId,
              worklog_status as worklogStatus,
              worklog_id as worklogId
       FROM sessions WHERE id = ?`,
    )
    .get(id) as SessionRow | undefined;
  if (!row) return null;
  const tags = listTagsForSession(id);
  return {
    id: row.id,
    title: row.title,
    timerType: row.timerType as TimerType,
    plannedDurationSeconds: row.plannedDurationSeconds,
    actualDurationSeconds: row.actualDurationSeconds,
    completedAt: row.completedAt,
    tags,
    issueNumber: row.issueNumber ?? null,
    issueTitle: row.issueTitle ?? null,
    issueUrl: row.issueUrl ?? null,
    issueProvider: (row.issueProvider as "github" | "linear" | "jira" | null) ?? null,
    issueId: row.issueId ?? null,
    worklogStatus: (row.worklogStatus ?? "not_logged") as WorklogStatus,
    worklogId: row.worklogId ?? null,
  };
}

export function updateSessionDuration(id: string, actualDurationSeconds: number): Session {
  const database = getDb();
  database
    .prepare("UPDATE sessions SET actual_duration_seconds = ? WHERE id = ?")
    .run(actualDurationSeconds, id);
  const updated = getSessionById(id);
  if (!updated) throw new Error(`Session not found after update: ${id}`);
  return updated;
}

export function updateWorklogStatus(
  sessionId: string,
  status: WorklogStatus,
  worklogId?: string,
): void {
  const database = getDb();
  if (worklogId !== undefined) {
    database
      .prepare("UPDATE sessions SET worklog_status = ?, worklog_id = ? WHERE id = ?")
      .run(status, worklogId, sessionId);
  } else {
    database
      .prepare("UPDATE sessions SET worklog_status = ? WHERE id = ?")
      .run(status, sessionId);
  }
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

// --- Generic Key-Value Settings Helpers ---
// Used for arbitrary configuration (e.g., Linear team selection)

export function getSettingValue(key: string): string | null {
  const database = getDb();
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSettingValue(key: string, value: string): void {
  const database = getDb();
  database
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, value);
}

export function deleteSettingValue(key: string): void {
  const database = getDb();
  database.prepare("DELETE FROM settings WHERE key = ?").run(key);
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

// --- Neovim Activity Functions ---

interface NvimActivityRow {
  id: number;
  project: string;
  file: string;
  recorded_at: string;
}

export function isDuplicateNvimActivity(project: string, file: string): boolean {
  const database = getDb();
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const row = database
    .prepare(
      `SELECT id FROM nvim_activity
       WHERE project = ? AND file = ? AND recorded_at >= ?
       LIMIT 1`,
    )
    .get(project, file, cutoff) as { id: number } | undefined;
  return row !== undefined;
}

export function insertNvimActivity(project: string, file: string): void {
  if (
    typeof project !== "string" ||
    typeof file !== "string" ||
    project.trim().length === 0 ||
    file.trim().length === 0 ||
    project.trim().length > MAX_NVIM_FIELD_LENGTH ||
    file.trim().length > MAX_NVIM_FIELD_LENGTH
  ) {
    throw new Error("Invalid project or file value for nvim_activity insert");
  }
  const database = getDb();
  const recordedAt = new Date().toISOString();
  database
    .prepare("INSERT INTO nvim_activity (project, file, recorded_at) VALUES (?, ?, ?)")
    .run(project.trim(), file.trim(), recordedAt);
}

export function listNvimActivityByDate(date: string): { records: NvimActivity[] } {
  const database = getDb();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date format: "${date}". Expected YYYY-MM-DD.`);
  }

  // Compute local day boundaries as ISO strings
  const startOfDay = new Date(`${date}T00:00:00`).toISOString();
  const nextDay = new Date(new Date(`${date}T00:00:00`).getTime() + 86400000).toISOString();

  const rows = database
    .prepare(
      `SELECT id, project, file, recorded_at
       FROM nvim_activity
       WHERE recorded_at >= ? AND recorded_at < ?
       ORDER BY recorded_at DESC`,
    )
    .all(startOfDay, nextDay) as NvimActivityRow[];

  const records: NvimActivity[] = rows.map((row) => ({
    id: row.id,
    project: row.project,
    file: row.file,
    recordedAt: row.recorded_at,
  }));

  return { records };
}

// --- Music Track Functions ---

export function upsertTrack(record: Omit<InternalTrackRecord, "play_count" | "last_played_at">): InternalTrackRecord {
  const database = getDb();
  const now = new Date().toISOString();

  // Try INSERT first, fall back to UPDATE on conflict (source_url UNIQUE)
  database.prepare(`
    INSERT INTO tracks (id, source_url, source_id, source_site, title, artist, duration_seconds, thumbnail_url, cached_file_path, cache_size_bytes, play_count, last_played_at, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      duration_seconds = excluded.duration_seconds,
      thumbnail_url = excluded.thumbnail_url
  `).run(
    record.id,
    record.source_url,
    record.source_id,
    record.source_site,
    record.title,
    record.artist ?? null,
    record.duration_seconds ?? null,
    record.thumbnail_url ?? null,
    record.cached_file_path ?? null,
    record.cache_size_bytes ?? null,
    record.added_at ?? now,
  );

  const row = database.prepare("SELECT * FROM tracks WHERE source_url = ?").get(record.source_url) as InternalTrackRecord;
  return row;
}

export function incrementTrackPlayCount(trackId: string): void {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare("UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?").run(now, trackId);
}

export function getTrackBySourceUrl(sourceUrl: string): InternalTrackRecord | null {
  const database = getDb();
  const row = database.prepare("SELECT * FROM tracks WHERE source_url = ?").get(sourceUrl) as InternalTrackRecord | undefined;
  return row ?? null;
}

export function getTrackById(trackId: string): InternalTrackRecord | null {
  const database = getDb();
  const row = database.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as InternalTrackRecord | undefined;
  return row ?? null;
}

export function updateTrackCache(trackId: string, cachedFilePath: string | null, cacheSizeBytes: number | null): void {
  const database = getDb();
  database.prepare("UPDATE tracks SET cached_file_path = ?, cache_size_bytes = ? WHERE id = ?").run(
    cachedFilePath,
    cacheSizeBytes,
    trackId,
  );
}

export function deleteTrack(trackId: string): void {
  const database = getDb();
  database.prepare("DELETE FROM tracks WHERE id = ?").run(trackId);
}

const VALID_MUSIC_SORT_FIELDS: readonly MusicSortField[] = ["last_played_at", "title", "duration_seconds", "added_at"];
const VALID_MUSIC_SORT_DIRS: readonly MusicSortDir[] = ["asc", "desc"];

export function listMusicTracks(input: MusicLibraryListInput = {}): MusicLibraryListResult {
  const database = getDb();

  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const sortField: MusicSortField = VALID_MUSIC_SORT_FIELDS.includes(input.sortField as MusicSortField)
    ? (input.sortField as MusicSortField)
    : "last_played_at";
  const sortDir: MusicSortDir = VALID_MUSIC_SORT_DIRS.includes(input.sortDir as MusicSortDir)
    ? (input.sortDir as MusicSortDir)
    : "desc";

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.search && input.search.trim().length > 0) {
    const term = `%${input.search.trim()}%`;
    conditions.push("(title LIKE ? OR artist LIKE ?)");
    params.push(term, term);
  }

  if (input.cachedOnly) {
    conditions.push("cached_file_path IS NOT NULL");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderClause = `ORDER BY ${sortField} ${sortDir.toUpperCase()}, id ASC`;

  const rows = database
    .prepare(`SELECT * FROM tracks ${whereClause} ${orderClause} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as InternalTrackRecord[];

  const countRow = database
    .prepare(`SELECT COUNT(*) as count FROM tracks ${whereClause}`)
    .get(...params) as { count: number };

  return {
    tracks: rows.map(toRendererTrack),
    total: countRow.count,
  };
}

export function getCacheUsage(): { currentBytes: number; trackCount: number } {
  const database = getDb();
  const row = database
    .prepare("SELECT COALESCE(SUM(cache_size_bytes), 0) as total, COUNT(*) as count FROM tracks WHERE cached_file_path IS NOT NULL")
    .get() as { total: number; count: number };
  return { currentBytes: row.total, trackCount: row.count };
}

export function clearAllCachedTracks(): void {
  const database = getDb();
  database.prepare("UPDATE tracks SET cached_file_path = NULL, cache_size_bytes = NULL").run();
}

export function getEvictionCandidates(excludeTrackIds: string[]): InternalTrackRecord[] {
  const database = getDb();
  if (excludeTrackIds.length === 0) {
    return database
      .prepare("SELECT * FROM tracks WHERE cached_file_path IS NOT NULL ORDER BY last_played_at ASC")
      .all() as InternalTrackRecord[];
  }
  const placeholders = excludeTrackIds.map(() => "?").join(", ");
  return database
    .prepare(`SELECT * FROM tracks WHERE cached_file_path IS NOT NULL AND id NOT IN (${placeholders}) ORDER BY last_played_at ASC`)
    .all(...excludeTrackIds) as InternalTrackRecord[];
}

export function getAllCachedTracks(): InternalTrackRecord[] {
  const database = getDb();
  return database
    .prepare("SELECT * FROM tracks WHERE cached_file_path IS NOT NULL")
    .all() as InternalTrackRecord[];
}

export function getAllPlaylistTrackIds(): string[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT DISTINCT track_id FROM playlist_tracks")
    .all() as Array<{ track_id: string }>;
  return rows.map((r) => r.track_id);
}

// --- Music Playlist Functions ---

export function createPlaylist(name: string, source: "user_created" | "saved_queue" = "user_created"): MusicPlaylist {
  const database = getDb();
  const now = new Date().toISOString();

  if (!name || name.trim().length === 0) {
    throw new Error("Playlist name cannot be empty");
  }
  const trimmedName = name.trim().slice(0, 200);

  const result = database
    .prepare("INSERT INTO playlists (name, source, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(trimmedName, source, now, now);

  const id = result.lastInsertRowid as number;
  return {
    id,
    name: trimmedName,
    source,
    trackCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function renamePlaylist(id: number, name: string): void {
  const database = getDb();
  if (!name || name.trim().length === 0) {
    throw new Error("Playlist name cannot be empty");
  }
  const trimmedName = name.trim().slice(0, 200);
  const now = new Date().toISOString();
  const result = database
    .prepare("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?")
    .run(trimmedName, now, id);
  if (result.changes === 0) {
    throw new Error(`Playlist with id ${id} not found`);
  }
}

export function deletePlaylist(id: number): void {
  const database = getDb();
  const result = database.prepare("DELETE FROM playlists WHERE id = ?").run(id);
  if (result.changes === 0) {
    throw new Error(`Playlist with id ${id} not found`);
  }
}

interface PlaylistRow {
  id: number;
  name: string;
  source: string;
  track_count: number;
  created_at: string;
  updated_at: string;
}

function rowToPlaylist(row: PlaylistRow): MusicPlaylist {
  return {
    id: row.id,
    name: row.name,
    source: row.source as "user_created" | "saved_queue",
    trackCount: row.track_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPlaylists(): MusicPlaylist[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT p.id, p.name, p.source, p.created_at, p.updated_at,
             COUNT(pt.id) as track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `)
    .all() as PlaylistRow[];
  return rows.map(rowToPlaylist);
}

export function getPlaylistById(id: number): MusicPlaylist | null {
  const database = getDb();
  const row = database
    .prepare(`
      SELECT p.id, p.name, p.source, p.created_at, p.updated_at,
             COUNT(pt.id) as track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      WHERE p.id = ?
      GROUP BY p.id
    `)
    .get(id) as PlaylistRow | undefined;
  return row ? rowToPlaylist(row) : null;
}

export function getPlaylistTracks(playlistId: number): PlaylistTrack[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT pt.id, pt.playlist_id, pt.track_id, pt.position,
             t.source_url, t.source_id, t.source_site, t.title, t.artist,
             t.duration_seconds, t.thumbnail_url, t.cached_file_path,
             t.cache_size_bytes, t.play_count, t.last_played_at, t.added_at
      FROM playlist_tracks pt
      INNER JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `)
    .all(playlistId) as Array<{
      id: number;
      playlist_id: number;
      track_id: string;
      position: number;
      source_url: string;
      source_id: string;
      source_site: string;
      title: string;
      artist: string | null;
      duration_seconds: number | null;
      thumbnail_url: string | null;
      cached_file_path: string | null;
      cache_size_bytes: number | null;
      play_count: number;
      last_played_at: string | null;
      added_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    playlistId: row.playlist_id,
    trackId: row.track_id,
    position: row.position,
    track: toRendererTrack({
      id: row.track_id,
      source_url: row.source_url,
      source_id: row.source_id,
      source_site: row.source_site,
      title: row.title,
      artist: row.artist,
      duration_seconds: row.duration_seconds,
      thumbnail_url: row.thumbnail_url,
      cached_file_path: row.cached_file_path,
      cache_size_bytes: row.cache_size_bytes,
      play_count: row.play_count,
      last_played_at: row.last_played_at,
      added_at: row.added_at,
    }),
  }));
}

export function addTrackToPlaylist(playlistId: number, trackId: string): PlaylistTrack {
  const database = getDb();
  const now = new Date().toISOString();

  // Get next position
  const maxPos = database
    .prepare("SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_tracks WHERE playlist_id = ?")
    .get(playlistId) as { max_pos: number };

  const position = maxPos.max_pos + 1;
  const result = database
    .prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)")
    .run(playlistId, trackId, position);

  const entryId = result.lastInsertRowid as number;

  // Update playlist updated_at
  database.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);

  // Return the entry with track data
  const track = getTrackById(trackId);
  if (!track) {
    throw new Error(`Track not found after insert: ${trackId}`);
  }

  return {
    id: entryId,
    playlistId,
    trackId,
    position,
    track: toRendererTrack(track),
  };
}

export function removeTrackFromPlaylist(playlistTrackId: number): void {
  const database = getDb();
  const result = database.prepare("DELETE FROM playlist_tracks WHERE id = ?").run(playlistTrackId);
  if (result.changes === 0) {
    throw new Error(`Playlist track entry with id ${playlistTrackId} not found`);
  }
}

export function reorderPlaylistTrack(playlistId: number, trackEntryId: number, toPosition: number): void {
  const database = getDb();

  // Fetch the entry being moved
  const entry = database
    .prepare("SELECT id, position FROM playlist_tracks WHERE id = ? AND playlist_id = ?")
    .get(trackEntryId, playlistId) as { id: number; position: number } | undefined;

  if (!entry) {
    throw new Error(`Track entry ${trackEntryId} not found in playlist ${playlistId}`);
  }

  const fromPosition = entry.position;
  if (fromPosition === toPosition) return;

  const reorder = database.transaction(() => {
    if (fromPosition < toPosition) {
      // Moving down: shift intervening tracks up
      database
        .prepare(
          "UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?",
        )
        .run(playlistId, fromPosition, toPosition);
    } else {
      // Moving up: shift intervening tracks down
      database
        .prepare(
          "UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?",
        )
        .run(playlistId, toPosition, fromPosition);
    }
    database
      .prepare("UPDATE playlist_tracks SET position = ? WHERE id = ?")
      .run(toPosition, trackEntryId);

    const now = new Date().toISOString();
    database.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(now, playlistId);
  });

  reorder();
}
