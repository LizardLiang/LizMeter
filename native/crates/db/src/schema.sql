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

    -- --- Multi-writer sync (electron/main/sync/) ---
    -- All machine-local: never written to the shared folder themselves, they are this device's
    -- own bookkeeping about the shared folder's contents.

    -- Every device this one has ever seen, its permanent block number, and how far this device
    -- has read into that peer's oplog file. The read cursor is an efficiency optimization only;
    -- correctness never depends on it because oplog apply is idempotent (sync_applied_ops below).
    CREATE TABLE IF NOT EXISTS sync_devices (
      device_id         TEXT PRIMARY KEY,
      device_number     INTEGER NOT NULL UNIQUE,
      first_seen_at     TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL,
      last_applied_seq  INTEGER NOT NULL DEFAULT 0
    );

    -- Every oplog entry's opId, once applied. A re-read of the same file segment (a watcher
    -- double-fire, or a restart) is a guaranteed no-op, not a correctness hazard.
    CREATE TABLE IF NOT EXISTS sync_applied_ops (
      op_id       TEXT PRIMARY KEY,
      device_id   TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );

    -- Name-unique convergence (FR-010): the losing row's uuid redirects to the winner's. Every
    -- reference to a uuid is resolved through this table first.
    CREATE TABLE IF NOT EXISTS sync_id_aliases (
      table_name  TEXT NOT NULL,
      old_uuid    TEXT NOT NULL,
      new_uuid    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (table_name, old_uuid)
    );

    -- User-visible automatic-resolution log (FR-009, FR-031, FR-041): a discard, a clock-drift
    -- clamp, a placeholder block, a stray file, or a stale-machine rebuild.
    CREATE TABLE IF NOT EXISTS sync_notices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      message     TEXT NOT NULL,
      detail      TEXT,
      created_at  TEXT NOT NULL,
      dismissed   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sync_notices_created_at ON sync_notices(created_at DESC);

    -- Per-(row, field) high-water HLC mark. Field-level LWW (FR-008) needs this across merge
    -- passes, not just within one: without it, a late-arriving older edit from a device that
    -- was offline could overwrite a newer value applied in an earlier pass, since that earlier
    -- winning entry is no longer part of the current batch being compared.
    CREATE TABLE IF NOT EXISTS sync_field_clocks (
      table_name        TEXT NOT NULL,
      row_uuid          TEXT NOT NULL,
      field_name        TEXT NOT NULL,
      hlc_physical_ms   INTEGER NOT NULL,
      hlc_counter       INTEGER NOT NULL,
      hlc_device_number INTEGER NOT NULL,
      PRIMARY KEY (table_name, row_uuid, field_name)
    );

    -- Delete-always-wins (FR-007), tracked independently of the oplog file itself: this is what
    -- actually stops a late-arriving edit from resurrecting a deleted row once the oplog file
    -- has been compacted past the delete entry. Trimmed at the same 90-day boundary (Milestone 7).
    CREATE TABLE IF NOT EXISTS sync_tombstones (
      table_name        TEXT NOT NULL,
      row_uuid          TEXT NOT NULL,
      deleted_at        TEXT NOT NULL,
      hlc_physical_ms   INTEGER NOT NULL,
      hlc_counter       INTEGER NOT NULL,
      hlc_device_number INTEGER NOT NULL,
      PRIMARY KEY (table_name, row_uuid)
    );

    -- Oplog lines waiting to be appended to this device's file in the shared folder. A line is
    -- inserted in the same transaction as the row change it describes and removed only after the
    -- append succeeded (sync-writer.ts flushOutbox). Local only: never snapshotted or synced.
    CREATE TABLE IF NOT EXISTS sync_outbox (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      line        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
