// electron/main/database.ts
// SQLite database module for the main process
// All operations are synchronous (better-sqlite3 API)

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
  CreateTodoInput,
  CreateTodoLabelInput,
  CreateTodoProjectInput,
  CreateTodoStateInput,
  ListTodosInput,
  Tag,
  TimerSettings,
  TimerType,
  Todo,
  TodoAttachment,
  TodoAttachmentKind,
  TodoLabel,
  TodoProject,
  TodoSource,
  TodoState,
  UpdateTagInput,
  UpdateTodoInput,
  UpdateTodoLabelInput,
  UpdateTodoProjectInput,
  UpdateTodoStateInput,
  WorklogStatus,
} from "../../src/shared/types.ts";
import {
  DEFAULT_TODO_COLOR,
  MAX_TODO_PRIORITY,
  NOTES_MAX_LENGTH,
  TODO_COLORS,
  TODO_PRIORITY_LABELS,
} from "../../src/shared/types.ts";
import { attachmentKindForExt, attachmentUrl, extFromFileName } from "./attachment-url.ts";
import { DB_FILE_NAME, getDataDir } from "./data-location.ts";
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

const MIN_DURATION = 1;
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

    -- Declared before todos: the todos.state_id foreign key points at it.
    CREATE TABLE IF NOT EXISTS todo_states (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      label        TEXT NOT NULL,
      color        TEXT NOT NULL DEFAULT '#7aa2f7',
      position     INTEGER NOT NULL,
      is_completed INTEGER NOT NULL DEFAULT 0,
      is_default   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      UNIQUE(label COLLATE NOCASE)
    );

    CREATE INDEX IF NOT EXISTS idx_todo_states_position ON todo_states(position);

    -- Declared before todos for the same reason as todo_states: todos.project_id points at it.
    -- No default and no completed flag -- a project groups work, it does not sequence it.
    CREATE TABLE IF NOT EXISTS todo_projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#7aa2f7',
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(name COLLATE NOCASE)
    );

    CREATE INDEX IF NOT EXISTS idx_todo_projects_position ON todo_projects(position);

    -- Labels are many-to-many with todos, the same shape as tags/session_tags above.
    CREATE TABLE IF NOT EXISTS todo_labels (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#7aa2f7',
      created_at TEXT NOT NULL,
      UNIQUE(name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS todo_label_links (
      todo_id  INTEGER NOT NULL REFERENCES todos(id)       ON DELETE CASCADE,
      label_id INTEGER NOT NULL REFERENCES todo_labels(id) ON DELETE CASCADE,
      PRIMARY KEY (todo_id, label_id)
    );

    -- The composite primary key already indexes (todo_id, label_id); this covers the other
    -- direction, which is what "list todos carrying label X" and label deletion both scan.
    CREATE INDEX IF NOT EXISTS idx_todo_label_links_label ON todo_label_links(label_id);

    CREATE TABLE IF NOT EXISTS todos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      notes        TEXT,
      state_id     INTEGER REFERENCES todo_states(id),
      -- Deleting a project clears it from its todos rather than deleting the work items.
      project_id   INTEGER REFERENCES todo_projects(id) ON DELETE SET NULL,
      milestone    TEXT,
      -- 0-4 on the Linear scale, where 0 is "not set". See TODO_PRIORITY_LABELS.
      priority     INTEGER NOT NULL DEFAULT 0,
      start_date   TEXT,
      due_date     TEXT,
      source       TEXT NOT NULL DEFAULT 'user',
      source_label TEXT,
      -- Self-referencing: a todo nests under another todo, to any depth. Deleting a parent
      -- lifts its children to the top level rather than taking them with it.
      parent_id    INTEGER REFERENCES todos(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_todos_source ON todos(source);
    -- Indexes on state_id / project_id / due_date / parent_id are created by migrateTodosToStates.
    -- On an existing database those columns do not exist yet at this point.

    -- Files attached to a todo. The blob on disk is content-addressed (<sha256>.<ext>), so
    -- UNIQUE(todo_id, sha256) makes attaching the same file twice to one todo a no-op while
    -- two different todos can still reference a single shared blob.
    CREATE TABLE IF NOT EXISTS todo_attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id     INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
      sha256      TEXT NOT NULL,
      file_name   TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'file',
      created_at  TEXT NOT NULL,
      UNIQUE(todo_id, sha256)
    );

    -- Unlike the todos indexes above, both of these are safe here: the table is new, so every
    -- column they name is created by the statement immediately preceding them.
    CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo ON todo_attachments(todo_id);
    CREATE INDEX IF NOT EXISTS idx_todo_attachments_sha ON todo_attachments(sha256);
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

  seedTodoStates(db);
  migrateTodosToStates(db);
}

type DbHandle = ReturnType<typeof getDb>;

/** The states a fresh install starts with. Users may rename, recolor, reorder, add, and delete these. */
const SEED_TODO_STATES: Array<{ label: string; color: string; isCompleted: boolean; isDefault: boolean }> = [
  { label: "Backlog", color: "#565f89", isCompleted: false, isDefault: false },
  { label: "Todo", color: "#7aa2f7", isCompleted: false, isDefault: true },
  { label: "Processing", color: "#e0af68", isCompleted: false, isDefault: false },
  { label: "Testing", color: "#bb9af7", isCompleted: false, isDefault: false },
  { label: "Done", color: "#9ece6a", isCompleted: true, isDefault: false },
  { label: "Deprecated", color: "#f7768e", isCompleted: false, isDefault: false },
];

/**
 * Seeds the default states into an empty table, then makes sure the table is usable.
 *
 * Seeding only-when-empty matters: doing it on every boot would resurrect states the
 * user deleted. Doing it in a transaction matters just as much -- a crash midway
 * through would otherwise leave rows behind with no completed state, and every later
 * boot would throw before the app could start.
 */
function seedTodoStates(database: DbHandle): void {
  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todo_states")
    .get() as { count: number };

  if (count === 0) {
    const createdAt = new Date().toISOString();
    const insert = database.prepare(
      "INSERT INTO todo_states (label, color, position, is_completed, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const seed = database.transaction(() => {
      SEED_TODO_STATES.forEach((state, index) => {
        insert.run(state.label, state.color, index, state.isCompleted ? 1 : 0, state.isDefault ? 1 : 0, createdAt);
      });
    });
    seed();
  }

  repairTodoStateFlags(database);
}

/**
 * Guarantees the table has exactly the flags the rest of the app relies on.
 *
 * Without this, a database left inconsistent by hand-editing or an interrupted write
 * makes startup fail permanently: the app shows a modal error before it can open, so
 * the user has no way in to fix it. Repairing is always better than refusing to boot.
 */
function repairTodoStateFlags(database: DbHandle): void {
  const states = database
    .prepare("SELECT id, is_completed, is_default FROM todo_states ORDER BY position ASC")
    .all() as Array<{ id: number; is_completed: number; is_default: number }>;
  if (states.length === 0) return;

  const repair = database.transaction(() => {
    // Exactly one completed state. Prefer the last one, which is where a finished
    // item naturally sits in a left-to-right workflow.
    const completed = states.filter((s) => s.is_completed === 1);
    if (completed.length === 0) {
      database.prepare("UPDATE todo_states SET is_completed = 1 WHERE id = ?").run(states[states.length - 1]!.id);
    } else if (completed.length > 1) {
      database
        .prepare("UPDATE todo_states SET is_completed = 0 WHERE id != ?")
        .run(completed[0]!.id);
    }

    // Exactly one default state. Prefer the first.
    const defaults = states.filter((s) => s.is_default === 1);
    if (defaults.length === 0) {
      database.prepare("UPDATE todo_states SET is_default = 1 WHERE id = ?").run(states[0]!.id);
    } else if (defaults.length > 1) {
      database.prepare("UPDATE todo_states SET is_default = 0 WHERE id != ?").run(defaults[0]!.id);
    }
  });
  repair();
}

/**
 * Brings an older todos table up to date: adds every column the current schema declares,
 * moves each row onto a state, then removes the old `done` column.
 *
 * Runs at most once -- each step is guarded by what the table actually looks like.
 */
function migrateTodosToStates(database: DbHandle): void {
  const columns = (database.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>)
    .map((c) => c.name);

  if (!columns.includes("state_id")) {
    database.exec("ALTER TABLE todos ADD COLUMN state_id INTEGER REFERENCES todo_states(id)");
  }
  if (!columns.includes("project_id")) {
    database.exec("ALTER TABLE todos ADD COLUMN project_id INTEGER REFERENCES todo_projects(id) ON DELETE SET NULL");
  }
  if (!columns.includes("milestone")) database.exec("ALTER TABLE todos ADD COLUMN milestone TEXT");
  if (!columns.includes("priority")) {
    // NOT NULL DEFAULT 0 is legal on ADD COLUMN because the default is a constant, so every
    // existing row backfills to "no priority" without a second UPDATE pass.
    database.exec("ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("start_date")) database.exec("ALTER TABLE todos ADD COLUMN start_date TEXT");
  if (!columns.includes("due_date")) {
    database.exec("ALTER TABLE todos ADD COLUMN due_date TEXT");
  }
  if (!columns.includes("parent_id")) {
    // SQLite allows a REFERENCES clause on ADD COLUMN as long as the default is NULL,
    // which it is. ON DELETE SET NULL backs up the explicit orphaning in deleteTodo.
    database.exec("ALTER TABLE todos ADD COLUMN parent_id INTEGER REFERENCES todos(id) ON DELETE SET NULL");
  }

  // Safe now that every column above exists, on both a fresh and an upgraded database.
  database.exec("CREATE INDEX IF NOT EXISTS idx_todos_state_id ON todos(state_id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id)");

  migrateProjectTextToRows(database, columns);

  const completedId = getCompletedStateId(database);
  const defaultId = getDefaultStateId(database);

  // Backfill from the old boolean while it is still there.
  if (columns.includes("done")) {
    database
      .prepare("UPDATE todos SET state_id = ? WHERE state_id IS NULL AND done = 1")
      .run(completedId);
    database
      .prepare("UPDATE todos SET state_id = ? WHERE state_id IS NULL AND done = 0")
      .run(defaultId);
  }

  // Any row still without a state (e.g. written between migration steps) lands on the default.
  database.prepare("UPDATE todos SET state_id = ? WHERE state_id IS NULL").run(defaultId);

  // SQLite refuses DROP COLUMN on an indexed column, so the index goes first.
  // Requires SQLite >= 3.35; better-sqlite3 ships 3.51 and the sql.js test shim 3.49.
  if (columns.includes("done")) {
    database.exec("DROP INDEX IF EXISTS idx_todos_done");
    database.exec("ALTER TABLE todos DROP COLUMN done");
  }
}

/**
 * Promotes the old free-text `todos.project` column to rows in `todo_projects`.
 *
 * Each distinct spelling becomes one project, matched case-insensitively so "lizmeter" and
 * "LizMeter" collapse into a single row rather than two. The text column is dropped once every
 * row has been repointed, the same way the old `done` boolean was retired.
 *
 * `columns` is the pre-migration column list, so this is a no-op on a database that never had
 * the text column -- which is every database created after this change.
 */
function migrateProjectTextToRows(database: DbHandle, columns: string[]): void {
  if (!columns.includes("project")) return;

  const names = database
    .prepare("SELECT DISTINCT TRIM(project) AS name FROM todos WHERE project IS NOT NULL AND TRIM(project) != ''")
    .all() as Array<{ name: string }>;

  const move = database.transaction(() => {
    const { next } = database
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects")
      .get() as { next: number };
    let position = next;

    const findProject = database.prepare("SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE");
    const insertProject = database.prepare(
      "INSERT INTO todo_projects (name, color, position, created_at) VALUES (?, ?, ?, ?)",
    );
    const repoint = database.prepare(
      "UPDATE todos SET project_id = ? WHERE project_id IS NULL AND project = ? COLLATE NOCASE",
    );

    for (const { name } of names) {
      let row = findProject.get(name) as { id: number } | undefined;
      if (!row) {
        insertProject.run(name, DEFAULT_TODO_COLOR, position, new Date().toISOString());
        position += 1;
        row = findProject.get(name) as { id: number };
      }
      repoint.run(row.id, name);
    }

    // Same ordering rule as the `done` column below: SQLite refuses DROP COLUMN while an
    // index still names the column, so the index goes first.
    database.exec("DROP INDEX IF EXISTS idx_todos_project");
    database.exec("ALTER TABLE todos DROP COLUMN project");
  });
  move();
}

/**
 * Re-runs the todos-to-states migration against the open database.
 *
 * Exported so tests can build a pre-states `todos` table and prove real rows land on
 * the right state. This is the riskiest path in the feature -- a wrong backfill loses
 * the user's work items -- so it is worth the extra export.
 */
export function migrateTodosToStatesNow(): void {
  migrateTodosToStates(getDb());
}

function getDefaultDbPath(): string {
  return path.join(getDataDir(), DB_FILE_NAME);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Exported so migration tests can rebuild an older table shape and prove real rows survive
 * the upgrade. The same reasoning as {@link migrateTodosToStatesNow}: a wrong backfill loses
 * the user's work items, and that is only provable against the actual schema.
 */
export function getDb(): Database.Database {
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

// Deletes every track row. playlist_tracks rows cascade (foreign_keys = ON,
// ON DELETE CASCADE — see schema above), so playlists survive as empty shells.
export function deleteAllTracks(): void {
  const database = getDb();
  database.prepare("DELETE FROM tracks").run();
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

// --- Todo State Functions ---

const MAX_TODO_STATE_LABEL_LENGTH = 32;

/** Tag colors plus the muted grey used for de-emphasised UI, which suits a Backlog state. */
const VALID_TODO_STATE_COLORS = new Set<string>(TODO_COLORS);

interface TodoStateRow {
  id: number;
  label: string;
  color: string;
  position: number;
  is_completed: number;
  is_default: number;
  created_at: string;
}

const TODO_STATE_COLUMNS = "id, label, color, position, is_completed, is_default, created_at";

function rowToTodoState(row: TodoStateRow): TodoState {
  return {
    id: row.id,
    label: row.label,
    color: row.color,
    position: row.position,
    isCompleted: row.is_completed === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  };
}

function validateStateLabel(label: unknown): string {
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error("State label must be a non-empty string");
  }
  const trimmed = label.trim();
  if (trimmed.length > MAX_TODO_STATE_LABEL_LENGTH) {
    throw new Error(`State label must be ${MAX_TODO_STATE_LABEL_LENGTH} characters or fewer`);
  }
  return trimmed;
}

function validateStateColor(color: unknown): string {
  if (typeof color !== "string" || !VALID_TODO_STATE_COLORS.has(color)) {
    throw new Error(`Invalid state color. Must be one of: ${[...VALID_TODO_STATE_COLORS].join(", ")}`);
  }
  return color;
}

/** The state new todos land in. Stable across label renames. */
function getDefaultStateId(database: DbHandle): number {
  const row = database
    .prepare("SELECT id FROM todo_states WHERE is_default = 1 ORDER BY position ASC LIMIT 1")
    .get() as { id: number } | undefined;
  if (row) return row.id;
  // Fall back to the first state so a hand-edited database cannot wedge the app.
  const first = database.prepare("SELECT id FROM todo_states ORDER BY position ASC LIMIT 1").get() as
    | { id: number }
    | undefined;
  if (!first) throw new Error("No todo states exist");
  return first.id;
}

/** The state that means "finished". Everything completion-related resolves through this, never a label. */
function getCompletedStateId(database: DbHandle): number {
  const row = database
    .prepare("SELECT id FROM todo_states WHERE is_completed = 1 ORDER BY position ASC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!row) throw new Error("No state is marked as completed");
  return row.id;
}

export function listTodoStates(): TodoState[] {
  const database = getDb();
  const rows = database
    .prepare(`SELECT ${TODO_STATE_COLUMNS} FROM todo_states ORDER BY position ASC`)
    .all() as TodoStateRow[];
  return rows.map(rowToTodoState);
}

/** Resolves a state by label, case-insensitively. Returns null when there is no match. */
export function findTodoStateByLabel(label: string): TodoState | null {
  const database = getDb();
  const row = database
    .prepare(`SELECT ${TODO_STATE_COLUMNS} FROM todo_states WHERE label = ? COLLATE NOCASE`)
    .get(label.trim()) as TodoStateRow | undefined;
  return row ? rowToTodoState(row) : null;
}

export function createTodoState(input: CreateTodoStateInput): TodoState {
  const database = getDb();
  const label = validateStateLabel(input.label);
  const color = input.color === undefined ? "#7aa2f7" : validateStateColor(input.color);

  const existing = database
    .prepare("SELECT id FROM todo_states WHERE label = ? COLLATE NOCASE")
    .get(label) as { id: number } | undefined;
  if (existing) throw new Error(`A state named "${label}" already exists`);

  const { next } = database
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_states")
    .get() as { next: number };

  database
    .prepare(
      "INSERT INTO todo_states (label, color, position, is_completed, is_default, created_at) VALUES (?, ?, ?, 0, 0, ?)",
    )
    .run(label, color, next, new Date().toISOString());

  const row = database
    .prepare(`SELECT ${TODO_STATE_COLUMNS} FROM todo_states WHERE id = last_insert_rowid()`)
    .get() as TodoStateRow;
  return rowToTodoState(row);
}

export function updateTodoState(input: UpdateTodoStateInput): TodoState {
  const database = getDb();

  const existing = database
    .prepare(`SELECT ${TODO_STATE_COLUMNS} FROM todo_states WHERE id = ?`)
    .get(input.id) as TodoStateRow | undefined;
  if (!existing) throw new Error(`State with id ${input.id} not found`);

  const label = input.label === undefined ? existing.label : validateStateLabel(input.label);
  const color = input.color === undefined ? existing.color : validateStateColor(input.color);

  if (label.toLowerCase() !== existing.label.toLowerCase()) {
    const clash = database
      .prepare("SELECT id FROM todo_states WHERE label = ? COLLATE NOCASE AND id != ?")
      .get(label, input.id) as { id: number } | undefined;
    if (clash) throw new Error(`A state named "${label}" already exists`);
  }

  const isCompleted = input.isCompleted === undefined ? existing.is_completed === 1 : input.isCompleted;
  const isDefault = input.isDefault === undefined ? existing.is_default === 1 : input.isDefault;

  // At least one state must mean "completed", or todo_complete has nowhere to go.
  if (!isCompleted && existing.is_completed === 1) {
    const { count } = database
      .prepare("SELECT COUNT(*) AS count FROM todo_states WHERE is_completed = 1")
      .get() as { count: number };
    if (count <= 1) throw new Error("At least one state must be marked as completed");
  }
  if (!isDefault && existing.is_default === 1) {
    throw new Error("Pick another state as the default rather than clearing this one");
  }

  const apply = database.transaction(() => {
    // Default and completed are single-winner flags.
    if (isDefault) database.prepare("UPDATE todo_states SET is_default = 0 WHERE id != ?").run(input.id);
    if (isCompleted) database.prepare("UPDATE todo_states SET is_completed = 0 WHERE id != ?").run(input.id);

    database
      .prepare("UPDATE todo_states SET label = ?, color = ?, is_completed = ?, is_default = ? WHERE id = ?")
      .run(label, color, isCompleted ? 1 : 0, isDefault ? 1 : 0, input.id);
  });
  apply();

  const row = database
    .prepare(`SELECT ${TODO_STATE_COLUMNS} FROM todo_states WHERE id = ?`)
    .get(input.id) as TodoStateRow;
  return rowToTodoState(row);
}

/**
 * Deletes a state and moves every todo using it onto `reassignToId`.
 * Todos are work items -- they are never deleted as a side effect of tidying states.
 * Returns how many todos moved.
 */
export function deleteTodoState(id: number, reassignToId: number): number {
  const database = getDb();

  const target = database.prepare("SELECT id, is_default, is_completed FROM todo_states WHERE id = ?").get(id) as
    | { id: number; is_default: number; is_completed: number }
    | undefined;
  if (!target) throw new Error(`State with id ${id} not found`);
  if (id === reassignToId) throw new Error("Cannot reassign todos to the state being deleted");

  const replacement = database.prepare("SELECT id FROM todo_states WHERE id = ?").get(reassignToId) as
    | { id: number }
    | undefined;
  if (!replacement) throw new Error(`State with id ${reassignToId} not found`);

  if (target.is_default === 1) throw new Error("Pick another default state before deleting this one");
  if (target.is_completed === 1) throw new Error("Pick another completed state before deleting this one");

  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todos WHERE state_id = ?")
    .get(id) as { count: number };

  const apply = database.transaction(() => {
    database.prepare("UPDATE todos SET state_id = ? WHERE state_id = ?").run(reassignToId, id);
    database.prepare("DELETE FROM todo_states WHERE id = ?").run(id);

    // Keep positions contiguous so reordering stays predictable.
    const remaining = database
      .prepare("SELECT id FROM todo_states ORDER BY position ASC")
      .all() as Array<{ id: number }>;
    const setPosition = database.prepare("UPDATE todo_states SET position = ? WHERE id = ?");
    remaining.forEach((row, index) => setPosition.run(index, row.id));
  });
  apply();

  return count;
}

/** Rewrites positions to match the given order. Ids not listed keep their relative order at the end. */
export function reorderTodoStates(orderedIds: number[]): TodoState[] {
  const database = getDb();
  const all = database.prepare("SELECT id FROM todo_states ORDER BY position ASC").all() as Array<{ id: number }>;
  const known = new Set(all.map((r) => r.id));

  for (const id of orderedIds) {
    if (!known.has(id)) throw new Error(`State with id ${id} not found`);
  }

  const seen = new Set(orderedIds);
  const finalOrder = [...orderedIds, ...all.map((r) => r.id).filter((id) => !seen.has(id))];

  const apply = database.transaction(() => {
    const setPosition = database.prepare("UPDATE todo_states SET position = ? WHERE id = ?");
    finalOrder.forEach((id, index) => setPosition.run(index, id));
  });
  apply();

  return listTodoStates();
}

// --- Todo Project Functions ---

const MAX_TODO_PROJECT_NAME_LENGTH = 60;

interface TodoProjectRow {
  id: number;
  name: string;
  color: string;
  position: number;
  created_at: string;
}

const TODO_PROJECT_COLUMNS = "id, name, color, position, created_at";

function rowToTodoProject(row: TodoProjectRow): TodoProject {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
  };
}

function validateProjectName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Project name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_TODO_PROJECT_NAME_LENGTH) {
    throw new Error(`Project name must be ${MAX_TODO_PROJECT_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/** Projects, labels and states all draw from one palette, so one check serves all three. */
function validatePaletteColor(color: unknown, kind: string): string {
  if (typeof color !== "string" || !VALID_TODO_STATE_COLORS.has(color)) {
    throw new Error(`Invalid ${kind} color. Must be one of: ${[...VALID_TODO_STATE_COLORS].join(", ")}`);
  }
  return color;
}

export function listTodoProjects(): TodoProject[] {
  const database = getDb();
  const rows = database
    .prepare(`SELECT ${TODO_PROJECT_COLUMNS} FROM todo_projects ORDER BY position ASC`)
    .all() as TodoProjectRow[];
  return rows.map(rowToTodoProject);
}

/** Resolves a project by name, case-insensitively. Returns null when there is no match. */
export function findTodoProjectByName(name: string): TodoProject | null {
  const database = getDb();
  const row = database
    .prepare(`SELECT ${TODO_PROJECT_COLUMNS} FROM todo_projects WHERE name = ? COLLATE NOCASE`)
    .get(name.trim()) as TodoProjectRow | undefined;
  return row ? rowToTodoProject(row) : null;
}

export function createTodoProject(input: CreateTodoProjectInput): TodoProject {
  const database = getDb();
  const name = validateProjectName(input.name);
  const color = input.color === undefined ? DEFAULT_TODO_COLOR : validatePaletteColor(input.color, "project");

  const existing = database
    .prepare("SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE")
    .get(name) as { id: number } | undefined;
  if (existing) throw new Error(`A project named "${name}" already exists`);

  const { next } = database
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM todo_projects")
    .get() as { next: number };

  database
    .prepare("INSERT INTO todo_projects (name, color, position, created_at) VALUES (?, ?, ?, ?)")
    .run(name, color, next, new Date().toISOString());

  const row = database
    .prepare(`SELECT ${TODO_PROJECT_COLUMNS} FROM todo_projects WHERE id = last_insert_rowid()`)
    .get() as TodoProjectRow;
  return rowToTodoProject(row);
}

export function updateTodoProject(input: UpdateTodoProjectInput): TodoProject {
  const database = getDb();

  const existing = database
    .prepare(`SELECT ${TODO_PROJECT_COLUMNS} FROM todo_projects WHERE id = ?`)
    .get(input.id) as TodoProjectRow | undefined;
  if (!existing) throw new Error(`Project with id ${input.id} not found`);

  const name = input.name === undefined ? existing.name : validateProjectName(input.name);
  const color = input.color === undefined ? existing.color : validatePaletteColor(input.color, "project");

  if (name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = database
      .prepare("SELECT id FROM todo_projects WHERE name = ? COLLATE NOCASE AND id != ?")
      .get(name, input.id) as { id: number } | undefined;
    if (clash) throw new Error(`A project named "${name}" already exists`);
  }

  database.prepare("UPDATE todo_projects SET name = ?, color = ? WHERE id = ?").run(name, color, input.id);

  const row = database
    .prepare(`SELECT ${TODO_PROJECT_COLUMNS} FROM todo_projects WHERE id = ?`)
    .get(input.id) as TodoProjectRow;
  return rowToTodoProject(row);
}

/**
 * Deletes a project and clears it from every todo that held it. Returns how many todos changed.
 *
 * There is no reassignment target the way there is for states: "no project" is a valid resting
 * place for a todo, so the work items simply lose the grouping rather than being moved or deleted.
 */
export function deleteTodoProject(id: number): number {
  const database = getDb();

  const target = database.prepare("SELECT id FROM todo_projects WHERE id = ?").get(id) as { id: number } | undefined;
  if (!target) throw new Error(`Project with id ${id} not found`);

  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todos WHERE project_id = ?")
    .get(id) as { count: number };

  const apply = database.transaction(() => {
    // Explicit rather than relying on ON DELETE SET NULL: an upgraded database added the column
    // by ALTER TABLE, and the pragma is not guaranteed to have been on when those rows were written.
    database.prepare("UPDATE todos SET project_id = NULL WHERE project_id = ?").run(id);
    database.prepare("DELETE FROM todo_projects WHERE id = ?").run(id);

    // Keep positions contiguous so reordering stays predictable.
    const remaining = database
      .prepare("SELECT id FROM todo_projects ORDER BY position ASC")
      .all() as Array<{ id: number }>;
    const setPosition = database.prepare("UPDATE todo_projects SET position = ? WHERE id = ?");
    remaining.forEach((row, index) => setPosition.run(index, row.id));
  });
  apply();

  return count;
}

/** Rewrites positions to match the given order. Ids not listed keep their relative order at the end. */
export function reorderTodoProjects(orderedIds: number[]): TodoProject[] {
  const database = getDb();
  const all = database.prepare("SELECT id FROM todo_projects ORDER BY position ASC").all() as Array<{ id: number }>;
  const known = new Set(all.map((r) => r.id));

  for (const id of orderedIds) {
    if (!known.has(id)) throw new Error(`Project with id ${id} not found`);
  }

  const seen = new Set(orderedIds);
  const finalOrder = [...orderedIds, ...all.map((r) => r.id).filter((id) => !seen.has(id))];

  const apply = database.transaction(() => {
    const setPosition = database.prepare("UPDATE todo_projects SET position = ? WHERE id = ?");
    finalOrder.forEach((id, index) => setPosition.run(index, id));
  });
  apply();

  return listTodoProjects();
}

// --- Todo Label Functions ---

const MAX_TODO_LABEL_NAME_LENGTH = 40;

interface TodoLabelRow {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

const TODO_LABEL_COLUMNS = "id, name, color, created_at";

function rowToTodoLabel(row: TodoLabelRow): TodoLabel {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

function validateLabelName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("Label name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_TODO_LABEL_NAME_LENGTH) {
    throw new Error(`Label name must be ${MAX_TODO_LABEL_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/** Name-ordered rather than position-ordered: labels are a set, not a sequence. */
export function listTodoLabels(): TodoLabel[] {
  const database = getDb();
  const rows = database
    .prepare(`SELECT ${TODO_LABEL_COLUMNS} FROM todo_labels ORDER BY name COLLATE NOCASE ASC`)
    .all() as TodoLabelRow[];
  return rows.map(rowToTodoLabel);
}

export function findTodoLabelByName(name: string): TodoLabel | null {
  const database = getDb();
  const row = database
    .prepare(`SELECT ${TODO_LABEL_COLUMNS} FROM todo_labels WHERE name = ? COLLATE NOCASE`)
    .get(name.trim()) as TodoLabelRow | undefined;
  return row ? rowToTodoLabel(row) : null;
}

/**
 * Get-or-create, unlike `createTodoProject` which rejects a duplicate.
 *
 * The label picker creates by typing a name, and typing one that already exists means
 * "use that one" -- an error there would be a dead end rather than a correction.
 */
export function createTodoLabel(input: CreateTodoLabelInput): TodoLabel {
  const database = getDb();
  const name = validateLabelName(input.name);
  const color = input.color === undefined ? DEFAULT_TODO_COLOR : validatePaletteColor(input.color, "label");

  const existing = database
    .prepare(`SELECT ${TODO_LABEL_COLUMNS} FROM todo_labels WHERE name = ? COLLATE NOCASE`)
    .get(name) as TodoLabelRow | undefined;
  if (existing) return rowToTodoLabel(existing);

  database
    .prepare("INSERT INTO todo_labels (name, color, created_at) VALUES (?, ?, ?)")
    .run(name, color, new Date().toISOString());

  const row = database
    .prepare(`SELECT ${TODO_LABEL_COLUMNS} FROM todo_labels WHERE id = last_insert_rowid()`)
    .get() as TodoLabelRow;
  return rowToTodoLabel(row);
}

export function updateTodoLabel(input: UpdateTodoLabelInput): TodoLabel {
  const database = getDb();

  const existing = database
    .prepare(`SELECT ${TODO_LABEL_COLUMNS} FROM todo_labels WHERE id = ?`)
    .get(input.id) as TodoLabelRow | undefined;
  if (!existing) throw new Error(`Label with id ${input.id} not found`);

  const name = input.name === undefined ? existing.name : validateLabelName(input.name);
  const color = input.color === undefined ? existing.color : validatePaletteColor(input.color, "label");

  if (name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = database
      .prepare("SELECT id FROM todo_labels WHERE name = ? COLLATE NOCASE AND id != ?")
      .get(name, input.id) as { id: number } | undefined;
    if (clash) throw new Error(`A label named "${name}" already exists`);
  }

  database.prepare("UPDATE todo_labels SET name = ?, color = ? WHERE id = ?").run(name, color, input.id);

  const row = database
    .prepare(`SELECT ${TODO_LABEL_COLUMNS} FROM todo_labels WHERE id = ?`)
    .get(input.id) as TodoLabelRow;
  return rowToTodoLabel(row);
}

/** Detaches the label from every todo, then deletes it. Returns how many todos lost it. */
export function deleteTodoLabel(id: number): number {
  const database = getDb();

  const target = database.prepare("SELECT id FROM todo_labels WHERE id = ?").get(id) as { id: number } | undefined;
  if (!target) throw new Error(`Label with id ${id} not found`);

  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todo_label_links WHERE label_id = ?")
    .get(id) as { count: number };

  const apply = database.transaction(() => {
    database.prepare("DELETE FROM todo_label_links WHERE label_id = ?").run(id);
    database.prepare("DELETE FROM todo_labels WHERE id = ?").run(id);
  });
  apply();

  return count;
}

/**
 * Reads every label for the given todos in one query, keyed by todo id.
 *
 * Labels are one-to-many, so they cannot ride along in TODO_SELECT without multiplying the
 * todo rows. One extra query per list call beats one query per todo.
 */
function labelsByTodoId(database: DbHandle, todoIds: number[]): Map<number, TodoLabel[]> {
  const byTodo = new Map<number, TodoLabel[]>();
  if (todoIds.length === 0) return byTodo;

  const placeholders = todoIds.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT k.todo_id, l.id, l.name, l.color, l.created_at
       FROM todo_label_links k
       INNER JOIN todo_labels l ON l.id = k.label_id
       WHERE k.todo_id IN (${placeholders})
       ORDER BY l.name COLLATE NOCASE ASC`,
    )
    .all(...todoIds) as Array<TodoLabelRow & { todo_id: number; }>;

  for (const row of rows) {
    const list = byTodo.get(row.todo_id);
    if (list) list.push(rowToTodoLabel(row));
    else byTodo.set(row.todo_id, [rowToTodoLabel(row)]);
  }
  return byTodo;
}

/** Replaces a todo's whole label set. Unknown ids are rejected before anything is written. */
function replaceTodoLabels(database: DbHandle, todoId: number, labelIds: number[]): void {
  const unique = [...new Set(labelIds)];
  for (const id of unique) {
    if (!Number.isInteger(id)) throw new Error("labelIds must be integers");
    const found = database.prepare("SELECT id FROM todo_labels WHERE id = ?").get(id) as { id: number } | undefined;
    if (!found) throw new Error(`Label with id ${id} not found`);
  }

  database.prepare("DELETE FROM todo_label_links WHERE todo_id = ?").run(todoId);
  const link = database.prepare("INSERT INTO todo_label_links (todo_id, label_id) VALUES (?, ?)");
  for (const id of unique) link.run(todoId, id);
}

/** Rejects an unknown project id up front, so a bad write never reaches the todos table. */
function resolveProjectId(database: DbHandle, projectId: number | null | undefined): number | null {
  if (projectId === undefined || projectId === null) return null;
  if (!Number.isInteger(projectId)) throw new Error("projectId must be an integer");
  const found = database.prepare("SELECT id FROM todo_projects WHERE id = ?").get(projectId) as
    | { id: number }
    | undefined;
  if (!found) throw new Error(`Project with id ${projectId} not found`);
  return projectId;
}

// --- Todo Functions ---

const MAX_TODO_TITLE_LENGTH = 500;
// Shared with the renderer's markdown editor so the pipe/MCP writer, which never passes
// through the dialog, is held to the same cap as a person typing into it.
const MAX_TODO_NOTES_LENGTH = NOTES_MAX_LENGTH;
const MAX_TODO_SOURCE_LABEL_LENGTH = 64;
const MAX_TODO_TEXT_FIELD_LENGTH = 120;
const VALID_TODO_SOURCES = new Set<TodoSource>(["user", "ai"]);

interface TodoRow {
  id: number;
  title: string;
  notes: string | null;
  project_id: number | null;
  /** Null on every column when the todo has no project, since the join is a LEFT JOIN. */
  project_name: string | null;
  project_color: string | null;
  project_position: number | null;
  project_created_at: string | null;
  milestone: string | null;
  priority: number;
  start_date: string | null;
  due_date: string | null;
  source: string;
  source_label: string | null;
  parent_id: number | null;
  parent_title: string | null;
  child_count: number;
  completed_child_count: number;
  created_at: string;
  completed_at: string | null;
  state_id: number;
  state_label: string;
  state_color: string;
  state_position: number;
  state_is_completed: number;
  state_is_default: number;
  state_created_at: string;
}

const TODO_SELECT = `
  SELECT t.id, t.title, t.notes, t.project_id, t.milestone, t.priority, t.start_date, t.due_date,
         t.source, t.source_label, t.created_at, t.completed_at, t.parent_id,
         p.title AS parent_title,
         (SELECT COUNT(*) FROM todos c WHERE c.parent_id = t.id) AS child_count,
         (SELECT COUNT(*) FROM todos c
            INNER JOIN todo_states cs ON cs.id = c.state_id
            WHERE c.parent_id = t.id AND cs.is_completed = 1) AS completed_child_count,
         s.id AS state_id, s.label AS state_label, s.color AS state_color,
         s.position AS state_position, s.is_completed AS state_is_completed,
         s.is_default AS state_is_default, s.created_at AS state_created_at,
         j.name AS project_name, j.color AS project_color,
         j.position AS project_position, j.created_at AS project_created_at
  FROM todos t
  INNER JOIN todo_states s ON s.id = t.state_id
  LEFT JOIN todos p ON p.id = t.parent_id
  LEFT JOIN todo_projects j ON j.id = t.project_id`;

/**
 * `labels` defaults to empty. Every caller that returns a todo to the renderer fills it in
 * afterwards via {@link labelsByTodoId} -- see `withLabels` and `withLabelsForOne`.
 */
function rowToTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    state: {
      id: row.state_id,
      label: row.state_label,
      color: row.state_color,
      position: row.state_position,
      isCompleted: row.state_is_completed === 1,
      isDefault: row.state_is_default === 1,
      createdAt: row.state_created_at,
    },
    // project_name is the discriminator rather than project_id: a row whose project was
    // deleted out from under it reads back as no project rather than a half-built object.
    project: row.project_id !== null && row.project_name !== null
      ? {
        id: row.project_id,
        name: row.project_name,
        color: row.project_color ?? DEFAULT_TODO_COLOR,
        position: row.project_position ?? 0,
        createdAt: row.project_created_at ?? "",
      }
      : null,
    labels: [],
    milestone: row.milestone,
    // Coalesced because a row written before the column existed reads back as null under the shim.
    priority: row.priority ?? 0,
    startDate: row.start_date,
    dueDate: row.due_date,
    source: VALID_TODO_SOURCES.has(row.source as TodoSource) ? (row.source as TodoSource) : "user",
    sourceLabel: row.source_label,
    parentId: row.parent_id,
    parentTitle: row.parent_title,
    childCount: row.child_count,
    // Coalesced like `priority`: the sql.js shim hands back null rather than 0 for a
    // correlated subquery that matches no rows.
    completedChildCount: row.completed_child_count ?? 0,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Maps rows to todos and fills every `labels` array from a single follow-up query. */
function withLabels(database: DbHandle, rows: TodoRow[]): Todo[] {
  const todos = rows.map(rowToTodo);
  const byTodo = labelsByTodoId(database, todos.map((t) => t.id));
  for (const todo of todos) todo.labels = byTodo.get(todo.id) ?? [];
  return todos;
}

function withLabelsForOne(database: DbHandle, row: TodoRow): Todo {
  return withLabels(database, [row])[0]!;
}

function validateTodoTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("Todo title must be a non-empty string");
  }
  const trimmed = title.trim();
  if (trimmed.length > MAX_TODO_TITLE_LENGTH) {
    throw new Error(`Todo title must be ${MAX_TODO_TITLE_LENGTH} characters or fewer`);
  }
  return trimmed;
}

function validateTodoNotes(notes: unknown): string | null {
  if (notes === undefined || notes === null) return null;
  if (typeof notes !== "string") throw new Error("Todo notes must be a string or null");
  const trimmed = notes.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TODO_NOTES_LENGTH) {
    throw new Error(`Todo notes must be ${MAX_TODO_NOTES_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/** Shared by project and milestone: optional short free text, blank normalised to null. */
function validateTodoTextField(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Todo ${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_TODO_TEXT_FIELD_LENGTH) {
    throw new Error(`Todo ${field} must be ${MAX_TODO_TEXT_FIELD_LENGTH} characters or fewer`);
  }
  return trimmed;
}

function validateTodoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Todo ${field} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Todo ${field} must be in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Todo ${field} is not a real date`);
  return trimmed;
}

/** Rejects anything outside 0-4 rather than clamping, so a typo from an agent is visible. */
function validateTodoPriority(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Todo priority must be an integer");
  }
  if (value < 0 || value > MAX_TODO_PRIORITY) {
    throw new Error(
      `Todo priority must be between 0 and ${MAX_TODO_PRIORITY} (${TODO_PRIORITY_LABELS.join(", ")})`,
    );
  }
  return value;
}

function assertDateOrder(startDate: string | null, dueDate: string | null): void {
  if (startDate && dueDate && startDate > dueDate) {
    throw new Error("Todo startDate must not be after dueDate");
  }
}

function validateTodoSourceLabel(label: unknown): string | null {
  if (label === undefined || label === null) return null;
  if (typeof label !== "string") throw new Error("Todo source label must be a string or null");
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_TODO_SOURCE_LABEL_LENGTH);
}

function resolveStateId(database: DbHandle, stateId: number | undefined): number {
  if (stateId === undefined) return getDefaultStateId(database);
  const row = database.prepare("SELECT id FROM todo_states WHERE id = ?").get(stateId) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`State with id ${stateId} not found`);
  return row.id;
}

/**
 * Validates `parentId` as the new parent of `childId` and returns it unchanged.
 *
 * Nesting is unbounded, so the one structural rule is that a todo must never end up inside its
 * own subtree. Walking up from the proposed parent catches the direct case and every deeper one.
 * The `seen` set bounds the walk, so a cycle already sitting in the data cannot hang the app.
 *
 * `childId` is null when creating, where no cycle is possible yet -- existence is the only check.
 */
function resolveParentId(database: DbHandle, childId: number | null, parentId: number): number {
  if (!Number.isInteger(parentId)) throw new Error("Todo parentId must be an integer or null");

  const parent = database.prepare("SELECT id FROM todos WHERE id = ?").get(parentId) as
    | { id: number }
    | undefined;
  if (!parent) throw new Error(`Parent todo with id ${parentId} not found`);

  if (childId === null) return parentId;
  if (parentId === childId) throw new Error("A todo cannot be its own parent");

  const readParent = database.prepare("SELECT parent_id FROM todos WHERE id = ?");
  const seen = new Set<number>();
  let cursor: number | null = parentId;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === childId) {
      throw new Error("That would nest the todo inside its own subtree");
    }
    seen.add(cursor);
    const row = readParent.get(cursor) as { parent_id: number | null } | undefined;
    cursor = row?.parent_id ?? null;
  }
  return parentId;
}

function isCompletedState(database: DbHandle, stateId: number): boolean {
  const row = database.prepare("SELECT is_completed FROM todo_states WHERE id = ?").get(stateId) as
    | { is_completed: number }
    | undefined;
  return row?.is_completed === 1;
}

export function createTodo(input: CreateTodoInput): Todo {
  const database = getDb();
  const title = validateTodoTitle(input.title);
  const notes = validateTodoNotes(input.notes);
  const projectId = resolveProjectId(database, input.projectId);
  const milestone = validateTodoTextField(input.milestone, "milestone");
  const priority = validateTodoPriority(input.priority);
  const startDate = validateTodoDate(input.startDate, "startDate");
  const dueDate = validateTodoDate(input.dueDate, "dueDate");
  assertDateOrder(startDate, dueDate);

  const source: TodoSource = VALID_TODO_SOURCES.has(input.source as TodoSource)
    ? (input.source as TodoSource)
    : "user";
  // A source label only makes sense for AI-written todos.
  const sourceLabel = source === "ai" ? validateTodoSourceLabel(input.sourceLabel) : null;

  const stateId = resolveStateId(database, input.stateId);
  const completedAt = isCompletedState(database, stateId) ? new Date().toISOString() : null;
  const parentId = input.parentId === undefined || input.parentId === null
    ? null
    : resolveParentId(database, null, input.parentId);

  // The insert and the label links go in together: a todo that briefly exists without the
  // labels it was created with would be visible to a concurrent read on the same connection.
  const write = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO todos (title, notes, state_id, project_id, milestone, priority, start_date, due_date, source, source_label, parent_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        notes,
        stateId,
        projectId,
        milestone,
        priority,
        startDate,
        dueDate,
        source,
        sourceLabel,
        parentId,
        new Date().toISOString(),
        completedAt,
      );

    // last_insert_rowid() rather than result.lastInsertRowid: the same statement works
    // under better-sqlite3 and the sql.js test shim, which does not return that field.
    const { id } = database.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    if (input.labelIds !== undefined) replaceTodoLabels(database, id, input.labelIds);
    return id;
  });
  const id = write();

  const row = database.prepare(`${TODO_SELECT} WHERE t.id = ?`).get(id) as TodoRow;
  return withLabelsForOne(database, row);
}

export function listTodos(input: ListTodosInput = {}): Todo[] {
  const database = getDb();
  const filter = input.filter ?? "all";

  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filter === "active") clauses.push("s.is_completed = 0");
  else if (filter === "done") clauses.push("s.is_completed = 1");
  else if (filter === "ai") clauses.push("t.source = 'ai'");

  if (input.stateId !== undefined) {
    clauses.push("t.state_id = ?");
    params.push(input.stateId);
  }
  if (input.projectId !== undefined) {
    clauses.push("t.project_id = ?");
    params.push(input.projectId);
  }
  if (input.labelId !== undefined) {
    // EXISTS rather than a join, so a todo carrying the label once is returned once.
    clauses.push("EXISTS (SELECT 1 FROM todo_label_links k WHERE k.todo_id = t.id AND k.label_id = ?)");
    params.push(input.labelId);
  }
  if (input.parentId !== undefined) {
    clauses.push("t.parent_id = ?");
    params.push(input.parentId);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";

  // Completed sink to the bottom; among the rest, dated before undated and soonest first.
  // Once todos carry due dates, "what is due next" beats "what did I add last".
  const order = ` ORDER BY s.is_completed ASC, (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at DESC`;

  const rows = database.prepare(`${TODO_SELECT}${where}${order}`).all(...params) as TodoRow[];
  return withLabels(database, rows);
}

export function updateTodo(input: UpdateTodoInput): Todo {
  const database = getDb();

  const existing = database.prepare(`${TODO_SELECT} WHERE t.id = ?`).get(input.id) as TodoRow | undefined;
  if (!existing) throw new Error(`Todo with id ${input.id} not found`);

  const title = input.title === undefined ? existing.title : validateTodoTitle(input.title);
  const notes = input.notes === undefined ? existing.notes : validateTodoNotes(input.notes);
  // Three-way: absent keeps the current project, null clears it, an id moves the todo.
  const projectId = input.projectId === undefined ? existing.project_id : resolveProjectId(database, input.projectId);
  const milestone = input.milestone === undefined
    ? existing.milestone
    : validateTodoTextField(input.milestone, "milestone");
  const priority = input.priority === undefined ? (existing.priority ?? 0) : validateTodoPriority(input.priority);
  const startDate = input.startDate === undefined
    ? existing.start_date
    : validateTodoDate(input.startDate, "startDate");
  const dueDate = input.dueDate === undefined ? existing.due_date : validateTodoDate(input.dueDate, "dueDate");
  assertDateOrder(startDate, dueDate);

  const stateId = input.stateId === undefined ? existing.state_id : resolveStateId(database, input.stateId);

  // Three-way: absent leaves the link alone, null lifts the todo to the top level.
  let parentId: number | null;
  if (input.parentId === undefined) parentId = existing.parent_id;
  else if (input.parentId === null) parentId = null;
  else parentId = resolveParentId(database, input.id, input.parentId);

  const wasCompleted = existing.state_is_completed === 1;
  const nowCompleted = isCompletedState(database, stateId);

  let completedAt = existing.completed_at;
  if (nowCompleted && !wasCompleted) completedAt = new Date().toISOString();
  else if (!nowCompleted) completedAt = null;
  // Editing a todo that is already completed keeps its original completion time.

  const write = database.transaction(() => {
    database
      .prepare(
        `UPDATE todos SET title = ?, notes = ?, state_id = ?, project_id = ?, milestone = ?, priority = ?,
                        start_date = ?, due_date = ?, parent_id = ?, completed_at = ?
       WHERE id = ?`,
      )
      .run(title, notes, stateId, projectId, milestone, priority, startDate, dueDate, parentId, completedAt, input.id);

    // Absent leaves the label set alone; an empty array is a deliberate "remove them all".
    if (input.labelIds !== undefined) replaceTodoLabels(database, input.id, input.labelIds);
  });
  write();

  const row = database.prepare(`${TODO_SELECT} WHERE t.id = ?`).get(input.id) as TodoRow;
  return withLabelsForOne(database, row);
}

/**
 * Deletes one todo and lifts its children to the top level.
 *
 * Parent and child states are independent, so removing a parent must never take its children
 * with it. Both statements run in one transaction: with `foreign_keys = ON` the delete would
 * otherwise be rejected while a child still points at the row.
 */
export function deleteTodo(id: number): string[] {
  const database = getDb();
  let shas: string[] = [];
  const remove = database.transaction(() => {
    // Read before the delete rather than trusting ON DELETE CASCADE to have fired: the
    // caller needs these to garbage-collect blobs, and a cascade leaves nothing to read.
    shas = database
      .prepare("SELECT sha256 FROM todo_attachments WHERE todo_id = ?")
      .all(id)
      .map((r) => (r as { sha256: string }).sha256);
    database.prepare("DELETE FROM todo_attachments WHERE todo_id = ?").run(id);
    database.prepare("UPDATE todos SET parent_id = NULL WHERE parent_id = ?").run(id);
    database.prepare("DELETE FROM todos WHERE id = ?").run(id);
  });
  remove();
  return shas;
}

/** What `clearCompletedTodos` swept: the row count, and the blobs those rows referenced. */
export interface ClearCompletedTodosResult {
  count: number;
  /**
   * Every sha256 whose attachment row was deleted. Duplicates are collapsed, and a sha listed
   * here may still be referenced by a surviving todo — `countAttachmentsBySha` decides that.
   */
  deletedShas: string[];
}

/** Removes every todo sitting in a completed state. Returns the count and the swept shas. */
export function clearCompletedTodos(): ClearCompletedTodosResult {
  const database = getDb();
  // Counted before the delete rather than read from result.changes: the sql.js
  // test shim does not populate that field, and the app is a single writer.
  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todos t INNER JOIN todo_states s ON s.id = t.state_id WHERE s.is_completed = 1")
    .get() as { count: number };
  let deletedShas: string[] = [];
  const clear = database.transaction(() => {
    // Same reasoning as deleteTodo: read the shas before the rows go, not after a cascade.
    deletedShas = database
      .prepare(
        `SELECT DISTINCT a.sha256 AS sha256
         FROM todo_attachments a
         INNER JOIN todos t ON t.id = a.todo_id
         INNER JOIN todo_states s ON s.id = t.state_id
         WHERE s.is_completed = 1`,
      )
      .all()
      .map((r) => (r as { sha256: string }).sha256);
    database.exec(`
      DELETE FROM todo_attachments
      WHERE todo_id IN (
        SELECT t.id FROM todos t
        INNER JOIN todo_states s ON s.id = t.state_id
        WHERE s.is_completed = 1
      )`);
    // Children of a cleared todo survive at the top level, the same as a single delete.
    database.exec(`
      UPDATE todos SET parent_id = NULL
      WHERE parent_id IN (
        SELECT t.id FROM todos t
        INNER JOIN todo_states s ON s.id = t.state_id
        WHERE s.is_completed = 1
      )`);
    database.exec(
      "DELETE FROM todos WHERE state_id IN (SELECT id FROM todo_states WHERE is_completed = 1)",
    );
  });
  clear();
  return { count, deletedShas };
}

// --- Todo attachments -------------------------------------------------------

interface TodoAttachmentRow {
  id: number;
  todo_id: number;
  sha256: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  created_at: string;
}

const ATTACHMENT_SELECT = `
  SELECT id, todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at
  FROM todo_attachments
`;

/**
 * The on-disk extension is derived from `file_name` rather than stored in its own column,
 * because `attachment-store.ts` derives the blob's name the same way. One helper, one answer.
 */
function rowToTodoAttachment(row: TodoAttachmentRow): TodoAttachment {
  const ext = extFromFileName(row.file_name);
  return {
    id: row.id,
    todoId: row.todo_id,
    sha256: row.sha256,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.kind === "image" ? "image" : "file",
    url: attachmentUrl(row.sha256, ext),
    createdAt: row.created_at,
  };
}

export interface CreateTodoAttachmentInput {
  todoId: number;
  /** Lower-case hex sha256 of the file contents, as returned by `storeBuffer`. */
  sha256: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Defaults to the classification of the file name's extension. */
  kind?: TodoAttachmentKind;
}

/**
 * Attaches a stored blob to a todo.
 *
 * Attaching the same sha to the same todo again is a no-op that returns the existing row —
 * the caller pastes the same screenshot twice and gets one entry, not a duplicate or an error.
 */
export function createTodoAttachment(input: CreateTodoAttachmentInput): TodoAttachment {
  const database = getDb();

  const todoExists = database.prepare("SELECT id FROM todos WHERE id = ?").get(input.todoId) as
    | { id: number }
    | undefined;
  if (!todoExists) {
    throw new Error(`Todo ${input.todoId} not found`);
  }

  const existing = database
    .prepare(`${ATTACHMENT_SELECT} WHERE todo_id = ? AND sha256 = ?`)
    .get(input.todoId, input.sha256) as TodoAttachmentRow | undefined;
  if (existing) return rowToTodoAttachment(existing);

  const kind = input.kind ?? attachmentKindForExt(extFromFileName(input.fileName));
  database
    .prepare(
      `INSERT INTO todo_attachments (todo_id, sha256, file_name, mime_type, size_bytes, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.todoId,
      input.sha256,
      input.fileName,
      input.mimeType,
      input.sizeBytes,
      kind,
      new Date().toISOString(),
    );

  // last_insert_rowid() rather than result.lastInsertRowid: the sql.js test shim does
  // not populate that field. Same reasoning as createTodo.
  const row = database
    .prepare(`${ATTACHMENT_SELECT} WHERE id = last_insert_rowid()`)
    .get() as TodoAttachmentRow;
  return rowToTodoAttachment(row);
}

/** Every attachment on one todo, oldest first. */
export function listTodoAttachments(todoId: number): TodoAttachment[] {
  const database = getDb();
  const rows = database
    .prepare(`${ATTACHMENT_SELECT} WHERE todo_id = ? ORDER BY id ASC`)
    .all(todoId) as TodoAttachmentRow[];
  return rows.map(rowToTodoAttachment);
}

export function getTodoAttachment(id: number): TodoAttachment | null {
  const database = getDb();
  const row = database.prepare(`${ATTACHMENT_SELECT} WHERE id = ?`).get(id) as
    | TodoAttachmentRow
    | undefined;
  return row ? rowToTodoAttachment(row) : null;
}

/** Deletes one attachment row and hands back what it deleted, so the caller can collect the blob. */
export function deleteTodoAttachment(id: number): TodoAttachment | null {
  const database = getDb();
  const existing = getTodoAttachment(id);
  if (!existing) return null;
  database.prepare("DELETE FROM todo_attachments WHERE id = ?").run(id);
  return existing;
}

/**
 * How many rows still reference a blob. This is the refcount that keeps a shared image
 * alive when one of the two todos embedding it is deleted.
 */
export function countAttachmentsBySha(sha256: string): number {
  const database = getDb();
  const { count } = database
    .prepare("SELECT COUNT(*) AS count FROM todo_attachments WHERE sha256 = ?")
    .get(sha256) as { count: number };
  return count;
}

/** Every distinct sha still referenced. `sweepOrphanBlobs` diffs the attachments folder against this. */
export function listAllAttachmentShas(): string[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT DISTINCT sha256 FROM todo_attachments")
    .all() as Array<{ sha256: string }>;
  return rows.map((r) => r.sha256);
}

/** Distinct project names already in use, for the autocomplete datalist. */
/** Distinct milestone names already in use, for the autocomplete datalist. */
export function listTodoMilestones(): string[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT DISTINCT milestone FROM todos WHERE milestone IS NOT NULL ORDER BY milestone COLLATE NOCASE ASC")
    .all() as Array<{ milestone: string }>;
  return rows.map((r) => r.milestone);
}
