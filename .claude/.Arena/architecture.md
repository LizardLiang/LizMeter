---
created: 2026-02-26T03:44:47Z
updated: 2026-02-26T03:44:47Z
author: metis
git_hash: 1f6ae2e1eb51e2ec75295ceb47c6782ecd4e9a28
analysis_scope: full
confidence: high
stale_after: 2026-03-28T03:44:47Z
verification_status: unverified
---

# Architecture

**Confidence**: High
**Last Verified**: 2026-02-26
**Source**: Full examination of electron/main/, src/renderer/src/, src/shared/types.ts
**Coverage**: 90% of codebase examined

**NOTE**: This file was previously stale. Major features have been added: Stopwatch mode, tags, issue tracker integrations (GitHub/Linear/Jira), Claude Code tracker, Tiptap rich text editor, SCSS Modules styling, paginated history with worklog export. The IPC channel list and component tree below reflect the CURRENT state.

## Process Model

LizMeter follows Electron's recommended security architecture with three isolated processes:

```
Renderer (React 19)  -->  Preload (contextBridge)  -->  Main (ipcMain.handle)  -->  SQLite
```

- **Main process** (`electron/main/`): Node.js environment. Manages app lifecycle, database operations, and IPC handlers.
- **Preload** (`electron/preload/index.ts`): Bridge between renderer and main. Exposes `window.electronAPI` via `contextBridge.exposeInMainWorld`.
- **Renderer** (`src/renderer/`): Browser environment (React). No direct Node.js access. Communicates via `window.electronAPI`.

Security settings: `contextIsolation: true`, `nodeIntegration: false`.

---

## Database Schema

File: `electron/main/database.ts`

### Table: `sessions`

| Column | Type | Constraints | Maps to |
|--------|------|-------------|---------|
| `id` | TEXT | PRIMARY KEY | `Session.id` (UUID v4, generated server-side via `crypto.randomUUID()`) |
| `title` | TEXT | NOT NULL DEFAULT '' | `Session.title` |
| `timer_type` | TEXT | NOT NULL | `Session.timerType` ("work" / "short_break" / "long_break") |
| `planned_duration_seconds` | INTEGER | NOT NULL | `Session.plannedDurationSeconds` |
| `actual_duration_seconds` | INTEGER | NOT NULL | `Session.actualDurationSeconds` |
| `completed_at` | TEXT | NOT NULL | `Session.completedAt` (ISO 8601) |

Index: `idx_sessions_completed_at` on `completed_at DESC`

### Table: `settings`

| Column | Type | Constraints |
|--------|------|-------------|
| `key` | TEXT | PRIMARY KEY |
| `value` | TEXT | NOT NULL |

Settings keys used:
- `timer.work_duration`
- `timer.short_break_duration`
- `timer.long_break_duration`

Values are stored as strings, parsed as integers on read. Defaults: 1500 / 300 / 900.

### Database Init

- `initDatabase(dbPath?)` -- Opens database, enables WAL mode, creates tables + index via `CREATE TABLE IF NOT EXISTS`
- Default path: `app.getPath("userData")/lizmeter.db`
- Tests pass `":memory:"` for in-memory databases

### Validation Constants

- `MIN_DURATION = 60`, `MAX_DURATION = 7200` (for settings)
- `MAX_TITLE_LENGTH = 500`
- `VALID_TIMER_TYPES = ["work", "short_break", "long_break"]`

---

## Complete IPC Channel Contracts (Current)

All IPC uses Electron's invoke/handle pattern. Registered in `electron/main/ipc-handlers.ts`, typed in `src/shared/types.ts`, exposed in `electron/preload/index.ts`.

### Session Channels

| Channel | Input | Return |
|---------|-------|--------|
| `session:save` | `SaveSessionInput` | `Session` |
| `session:save-with-tracking` | `SaveSessionWithTrackingInput` | `Session` |
| `session:list` | `ListSessionsInput` | `ListSessionsResult` |
| `session:delete` | `string` (id) | `void` |

### Settings Channels

| Channel | Input | Return |
|---------|-------|--------|
| `settings:get` | none | `TimerSettings` |
| `settings:save` | `TimerSettings` | `void` |
| `settings:get-value` | `string` (key) | `string \| null` |
| `settings:set-value` | `string` key, `string \| null` value | `void` |

### Tag Channels

| Channel | Input | Return |
|---------|-------|--------|
| `tag:create` | `CreateTagInput` | `Tag` |
| `tag:list` | none | `Tag[]` |
| `tag:update` | `UpdateTagInput` | `Tag` |
| `tag:delete` | `number` (id) | `void` |
| `tag:assign` | `AssignTagInput` | `void` |
| `tag:unassign` | `AssignTagInput` | `void` |
| `tag:list-for-session` | `string` (sessionId) | `Tag[]` |

### Issue Tracker Channels (GitHub)

| Channel | Input | Return |
|---------|-------|--------|
| `issues:list` | `IssuesListInput` | `IssuesListResult` |
| `issues:provider-status` | none | `IssueProviderStatus` |
| `issues:set-token` | `IssuesSetTokenInput` | `void` |
| `issues:delete-token` | none | `void` |
| `issues:test-token` | none | `{ username: string }` |
| `issues:fetch-comments` | `{ repo, issueNumber }` | `IssueComment[]` |

### Linear Channels

| Channel | Input | Return |
|---------|-------|--------|
| `linear:set-token` | `{ token }` | `void` |
| `linear:delete-token` | none | `void` |
| `linear:test-connection` | none | `{ displayName }` |
| `linear:list-teams` | none | `LinearTeam[]` |
| `linear:set-team` | `{ teamId, teamName }` | `void` |
| `linear:get-team` | none | `{ teamId, teamName } \| null` |
| `linear:fetch-issues` | `{ forceRefresh? }` | `LinearIssue[]` |
| `linear:fetch-comments` | `{ issueId }` | `IssueComment[]` |
| `linear:provider-status` | none | `LinearProviderStatus` |

### Jira Channels

| Channel | Input | Return |
|---------|-------|--------|
| `jira:set-token` | `{ token }` | `void` |
| `jira:delete-token` | none | `void` |
| `jira:test-connection` | none | `{ displayName }` |
| `jira:fetch-issues` | `{ forceRefresh? }` | `JiraIssue[]` |
| `jira:provider-status` | none | `JiraProviderStatus` |
| `jira:fetch-comments` | `{ issueKey }` | `IssueComment[]` |
| `jira:set-auth-type` | `{ authType }` | `void` |
| `jira:set-domain` | `{ domain }` | `void` |
| `jira:set-email` | `{ email }` | `void` |
| `jira:set-project-key` | `{ projectKey }` | `void` |
| `jira:set-jql-filter` | `{ jql }` | `void` |

### Worklog Channels

| Channel | Input | Return |
|---------|-------|--------|
| `worklog:log` | `WorklogLogInput` | `WorklogLogResult` |
| `worklog:mark-logged` | `{ sessionIds, worklogId }` | `void` |

### Claude Code Tracker Channels

| Channel | Input | Return |
|---------|-------|--------|
| `claude-tracker:scan` | `{ projectDirName }` | `{ success, sessions: ClaudeCodeSessionPreview[] }` |
| `claude-tracker:track-selected` | `{ sessionUuids }` | `{ tracked: number }` |
| `claude-tracker:stop` | none | `{ sessions: ClaudeCodeSessionData[] }` |
| `claude-tracker:pause` | none | `void` |
| `claude-tracker:resume` | none | `void` |
| `claude-tracker:get-projects` | none | `{ projects: ClaudeCodeProject[] }` |
| `claude-tracker:scan-all` | none | `{ sessions: ClaudeCodeSessionPreviewWithProject[] }` |
| `claude-tracker:get-for-session` | `{ sessionId }` | `{ sessions: ClaudeCodeSessionSummary[] } \| null` |

Claude tracker also uses `ipcMain.emit` for push events:
- `claude-tracker:update` -> `ClaudeCodeLiveStats`
- `claude-tracker:new-session` -> `{ session: ClaudeCodeSessionPreview }`

### Window / Shell Channels

| Channel | Input | Return |
|---------|-------|--------|
| `window:minimize` | none | void (send) |
| `window:maximize` | none | void (send) |
| `window:close` | none | void (send) |
| `shell:open-external` | `string` (url) | `void` |

---

## React Component Tree (Current)

```
TomatoClock (root orchestrator - all hooks, all page routing)
  NavSidebar (7 nav buttons: timer/history/issues/claude/stats/tags/settings)
  [activePage === "timer"]
    ModeToggle (pomodoro / time-tracking)
    [pomodoro mode]
      TimerView
        TimerTypeSelector (work/short_break/long_break)
        TimerDisplay (MM:SS countdown, editable when idle)
        SessionTitleInput (RichTextInput wrapper, required)
        IssuePickerDropdown (optional issue link - GitHub/Linear/Jira)
        TimerControls (Start/Pause/Resume/Reset/Dismiss)
      [timer running/paused]
        SessionPicker (Claude Code session selection)
        ClaudeCodeStats (live file edit stats)
        TagPicker (assign tags to pending session)
    [time-tracking mode]
      StopwatchView
        RichTextInput (session title/description - required)
        ClaudeSessionSelect (link to Claude Code session)
        elapsed display
        IssuePromptDialog (on start if promptForIssue=true)
        controls (Start/Pause/Resume/Stop)
  [activePage === "history"]
    HistoryPage
      tag filter bar
      DateSubGroupHeader[]
      IssueGroupHeader[]
      SessionHistoryItem[] (with IssueBadge, TagBadge[], delete, worklog)
      WorklogConfirmDialog
  [activePage === "issues"]
    IssuesPage
      ProviderTabs (GitHub/Linear/Jira)
  [activePage === "claude"]
    ClaudePage
  [activePage === "stats"]
    StatsPage
  [activePage === "tags"]
    TagsPage -> TagManager -> TagBadge[], TagColorPicker
  [activePage === "settings"]
    SettingsPage
```

---

## State Management (Hooks - Current)

All hooks composed in `TomatoClock.tsx`. No external state library.

| Hook | Purpose |
|------|---------|
| `useTimer` | Pomodoro FSM (idle/running/paused/completed), 250ms wall-clock tick, auto-save |
| `useStopwatch` | Stopwatch FSM (idle/running/paused), elapsed counting, stop-and-save |
| `useSettings` | Load/save `TimerSettings` + `StopwatchSettings` via IPC |
| `useSessionHistory` | Paginated sessions, tag filter, delete, load-more, worklog |
| `useTagManager` | Tag CRUD (create/update/delete/assign/unassign) |
| `useClaudeTracker` | Claude Code session scanning/tracking/stats lifecycle |

---

## Database Schema (Current)

Tables in `electron/main/database.ts` (created via `CREATE TABLE IF NOT EXISTS`):

- `sessions` - id (UUID), title, timer_type, planned_duration_seconds, actual_duration_seconds, completed_at, issue_number, issue_title, issue_url, issue_provider, issue_id, worklog_status, worklog_id
- `settings` - key, value (generic KV store for timer durations and any string setting)
- `tags` - id (AUTOINCREMENT), name (UNIQUE NOCASE), color, created_at
- `session_tags` - session_id FK, tag_id FK (many-to-many join table)
- `claude_code_sessions` - tracks Claude Code AI session data linked to timer sessions

Validation: `MIN_DURATION=60`, `MAX_DURATION=7200`, `MAX_TITLE_LENGTH=5000` (updated from 500)

---

## App Startup Sequence

1. `app.whenReady()` fires in `electron/main/index.ts`
2. `initDatabase()` creates/opens `~/.local/share/lizmeter/lizmeter.db` (or platform equivalent)
3. `registerIpcHandlers()` registers all `ipcMain.handle` channels
4. `createWindow()` creates a BrowserWindow with preload script
5. Window loads Vite dev server (dev) or `dist/index.html` (prod)
6. React mounts `TomatoClock` which loads settings and sessions

## Update History

- **2026-02-26 03:44** (Metis): Major rewrite - added frontmatter, complete current IPC channel table (all 40+ channels), updated component tree with all new components, updated hooks table, updated DB schema. Previous version was from initial project creation and was significantly outdated.