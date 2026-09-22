# Constraints

Hard limits enforced in code. Changing one means changing every place it is validated.

[2026-09-22 | ares | todo-923] music-binary-integrity: yt-dlp and ffmpeg downloads must not be installed unless a valid, filename-matched SHA-256 checksum is fetched and matches. Missing, unreachable, malformed, or non-matching checksum entries fail with `CHECKSUM_UNAVAILABLE`; confirmed digest mismatches fail with `HASH_MISMATCH`. SHA-256 is streamed from disk. HTTP redirects are limited to 5 HTTPS hops and only `api.github.com`, `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`, or `github-releases.githubusercontent.com`.
[2026-09-22 | ares | todo-968] timer-duration: 1 to 7200 seconds. Canonical `MIN_DURATION` / `MAX_DURATION` values live in `src/shared/types.ts` and are consumed by main-process validation and the renderer timer reducer. README states the user-facing ranges as work 1-120 min, short break 1-60 min, long break 1-120 min.
[2026-09-22 | ares | todo-968] default-durations: work 1500 s, short break 300 s, long break 900 s. Canonical `DEFAULT_SETTINGS` lives in `src/shared/types.ts` and is consumed by database fallback settings and the renderer root.
[2026-08-28 | metis | project-setup] stopwatch-max: default 28800 s (8 hours), user-configurable, 0 means unlimited.
[2026-09-22 | ares | todo-968] session-title-max: 5000 characters. Canonical `MAX_TITLE_LENGTH` lives in `src/shared/types.ts` and is consumed by database sanitization and the renderer timer reducer.
[2026-08-28 | metis | project-setup] todo-notes-max: 32000 characters (`NOTES_MAX_LENGTH`, `src/shared/types.ts:134`).
[2026-08-28 | metis | project-setup] attachment-max: 25 MiB per file (`ATTACHMENT_MAX_BYTES`, `src/shared/types.ts:363`).
[2026-08-28 | metis | project-setup] attachment-blocked-types: `svg` and `svgz` are refused outright. An SVG served from a privileged scheme is a needless attack surface. (`attachment-store.ts` `BLOCKED_EXTENSIONS`)
[2026-08-28 | metis | project-setup] attachment-url-shape: `app-media:` accepts only a `<64 hex>.<ext>` basename that still resolves inside the attachments folder. `resolveAttachmentPath()` in `attachment-url.ts` is the entire security boundary.
[2026-08-28 | metis | project-setup] pipe-message-max: 256 KB (`MAX_BUFFER_SIZE = 262_144`, `pipe-server.ts`). Sized so a 32000-character note survives JSON escaping.
[2026-08-28 | metis | project-setup] mcp-request-timeout: 5000 ms per command (`REQUEST_TIMEOUT_MS`, `mcp/lizmeter-todo-mcp.mjs`).
[2026-08-28 | metis | project-setup] todo-priority: integer 0-4, where 0 means unset. `TODO_PRIORITY_LABELS` = No priority, Urgent, High, Medium, Low (`src/shared/types.ts:121`).
[2026-08-28 | metis | project-setup] nvim-field-max: 1000 characters per field (`MAX_NVIM_FIELD_LENGTH`, database.ts).
[2026-08-28 | metis | project-setup] renderer-privileges: `contextIsolation: true`, `nodeIntegration: false`. Not negotiable.
[2026-08-28 | metis | project-setup] csp: `default-src 'self'`; `img-src` adds `file: data: https: app-media:`; `media-src` and `connect-src` add `http://127.0.0.1:*` for the local music stream server. Declared in `index.html`.
[2026-08-28 | metis | project-setup] credential-storage: provider tokens go through Electron `safeStorage` into `<userData>/.<provider>-token`. Never plaintext, never in SQLite, never carried to a moved data folder.
[2026-08-28 | metis | project-setup] package-manager: Bun only. Never npm or npx.
[2026-08-28 | metis | project-setup] test-timeouts: Vitest `testTimeout` (15000 ms) must stay strictly above Testing Library `asyncUtilTimeout` (5000 ms).
[2026-08-28 | athena | multi-writer-sqlite-sync] no-live-db-on-cloud-drive: never let a cloud-drive client sync a live `lizmeter.db` (with or without WAL) that a second machine also opens. The client copies `.db`, `-wal`, and `-shm` independently and ignores SQLite's locks, so a synced snapshot can be mutually inconsistent. External origin: sqlite.org/howtocorrupt.html. Sync per-machine change files instead.
[2026-08-28 | athena | multi-writer-sqlite-sync] no-partial-read-writeback: never write back content read from a cloud-drive file that was not fully downloaded. A OneDrive Files-On-Demand placeholder reports its real size but reads as truncated, and writing that back destroys the full cloud copy with no error. External origin: anthropics/claude-code#62140 (2026, a 258 KB file read as 24 KB). Detect the unhydrated state and halt.
[2026-08-28 | athena | multi-writer-sqlite-sync] todo-number-permanence: a todo's visible number is `todos.id` and is fixed for the life of the todo. Never recompute, renumber, or reuse it. `mcp/lizmeter-todo-mcp.mjs` passes that integer back as the addressing key for update, complete, and sub-issue parent, so a shifting number breaks an agent mid-conversation.
