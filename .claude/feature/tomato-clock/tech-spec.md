# Technical Specification

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Tomato Clock (Pomodoro Timer) |
| **Author** | Hephaestus (Tech Spec Agent) |
| **Status** | Draft |
| **Date** | 2026-02-19 |
| **PRD Version** | 1.0 |

---

## 1. Overview

### Summary
Tomato Clock is a Pomodoro Timer feature for the LizMeter Electron desktop app. It adds a countdown timer with work/break modes, session title input, start/pause/reset controls, automatic session persistence to a local SQLite database, and a session history view. This is the first interactive feature in LizMeter and establishes the IPC communication pattern, database layer, and React component architecture that future features will follow.

### Goals
- Implement a complete timer lifecycle (idle -> running -> paused -> completed) in the React renderer
- Establish a SQLite database layer in the Electron main process with IPC bridge to renderer
- Persist all completed sessions and user settings locally with zero cloud dependency
- Achieve timer accuracy within 1 second drift over a 25-minute session using wall-clock correction

### Non-Goals
- System tray integration or background timer
- Desktop OS notifications (toast/notification center)
- Auto-cycling between work and break sessions
- Statistics, charts, or analytics dashboards
- Cloud sync, export, or multi-device support
- Keyboard shortcuts for timer controls

---

## 2. Architecture

### System Context

The app follows the standard Electron three-process architecture:

```
+------------------------------------------------------------------+
|  Electron App                                                     |
|                                                                   |
|  +------------------+    IPC     +----------------------------+   |
|  |  Main Process    |<---------->|  Preload Script            |   |
|  |                  |  (invoke/  |  (contextBridge)           |   |
|  |  - DB module     |   handle)  +----------------------------+   |
|  |  - IPC handlers  |                      |                      |
|  |  - App lifecycle  |                     | window.electronAPI   |
|  +------------------+                      |                      |
|         |                          +----------------------------+ |
|         |                          |  Renderer Process          | |
|    +----------+                    |  (React App)               | |
|    | SQLite   |                    |                            | |
|    | Database |                    |  - Timer logic (hooks)     | |
|    | (file)   |                    |  - UI components           | |
|    +----------+                    |  - State management        | |
|                                    +----------------------------+ |
+------------------------------------------------------------------+
```

All database operations happen exclusively in the main process. The renderer communicates through `ipcRenderer.invoke()` calls exposed via `contextBridge` in the preload script. `contextIsolation: true` and `nodeIntegration: false` are already configured, enforcing the security boundary.

### Key Design Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| `better-sqlite3` for SQLite | Synchronous API simplifies IPC handlers (invoke/handle pattern returns values directly). Mature, battle-tested in Electron apps. Needs native rebuild for Electron but `@electron/rebuild` is already a dev dependency. | `bun:sqlite` -- only works in Bun runtime, not inside Electron's main process which runs on Node/Chromium. `sql.js` -- WASM-based, no native compilation needed, but slower for writes and less mature. |
| `useReducer` for timer state | Timer has multiple interdependent state fields (status, remaining time, timer type, title). A reducer ensures atomic state transitions and makes the state machine explicit. | `useState` per field -- leads to inconsistent intermediate states. Zustand/Redux -- overkill for a single-feature app with no cross-component shared state beyond what props can handle. |
| Wall-clock delta for timer accuracy | `setInterval` drifts because it guarantees minimum delay, not exact delay. Computing `remaining = endTime - Date.now()` on each tick ensures the display is always correct relative to the system clock. | Pure interval counting (`remaining -= 1` each tick) -- accumulates drift, fails the 1-second-over-25-minutes NFR. `requestAnimationFrame` -- pauses when tab is hidden (not relevant in Electron but bad practice). |
| Single-page layout (timer above, history below) | Simplest architecture for v1. No routing library needed. The 800x600 window comfortably fits both sections with the timer taking ~40% and history scrolling below. | Tab-based navigation -- adds complexity (react-router or tab state) without clear UX benefit for two views. Separate windows -- overkill. |
| Settings stored in same SQLite DB | Keeps all persistence in one place. Settings are a simple key-value table. No need for a separate config file. | `electron-store` / JSON file -- adds a dependency for something a single SQL table handles. `localStorage` -- violates the "all persistence through IPC" security model. |

---

## 3. Data Model

### Database Location

The database file is stored at:
```
{app.getPath('userData')}/lizmeter.db
```

On Windows this resolves to `%APPDATA%/lizmeter/lizmeter.db`. The `userData` directory is created automatically by Electron.

### Database Schema

```sql
-- sessions table: stores all completed timer sessions
CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,       -- UUID v4, generated in main process
    title         TEXT NOT NULL DEFAULT '',  -- user-entered session title (empty string if not provided)
    timer_type    TEXT NOT NULL,          -- 'work' | 'short_break' | 'long_break'
    planned_duration_seconds  INTEGER NOT NULL,  -- the configured duration in seconds (e.g., 1500 for 25 min)
    actual_duration_seconds   INTEGER NOT NULL,  -- wall-clock elapsed time in seconds (accounts for pause gaps)
    completed_at  TEXT NOT NULL           -- ISO 8601 timestamp (e.g., '2026-02-19T14:30:00.000Z')
);

-- Index for history queries ordered by completion time
CREATE INDEX IF NOT EXISTS idx_sessions_completed_at ON sessions(completed_at DESC);

-- settings table: key-value store for user preferences
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,  -- setting identifier
    value TEXT NOT NULL       -- JSON-encoded value
);
```

**Note on `actual_duration_seconds`**: This field addresses the PRD review note about planned vs. actual duration. For a session that runs straight through without pauses, `actual_duration_seconds` equals `planned_duration_seconds`. If the user pauses and resumes, `actual_duration_seconds` reflects only the time the timer was actively counting down (total wall-clock time minus pause time). This future-proofs the schema for analytics without changing the v1 completion logic (the timer still counts down to zero based on the planned duration).

### Entity Relationships

```
+------------------+        +------------------+
|    sessions      |        |    settings      |
+------------------+        +------------------+
| id (PK, TEXT)    |        | key (PK, TEXT)   |
| title            |        | value (TEXT/JSON) |
| timer_type       |        +------------------+
| planned_duration |
| actual_duration  |        No FK relationship.
| completed_at     |        Tables are independent.
+------------------+
```

### Migration Strategy

For v1, schema initialization uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, which are idempotent. This runs every time the app starts. No migration framework is needed yet.

If future versions require schema changes, the `settings` table will store a `schema_version` key. The database module will check this version on startup and run sequential migration scripts as needed. This decision is deferred until a schema change is actually required.

### Default Settings

On first launch, if no settings exist, the app uses these hardcoded defaults:

| Key | Default Value | Description |
|-----|---------------|-------------|
| `timer.work_duration` | `1500` | Work session duration in seconds (25 min) |
| `timer.short_break_duration` | `300` | Short break duration in seconds (5 min) |
| `timer.long_break_duration` | `900` | Long break duration in seconds (15 min) |

Settings are only written to the database when the user explicitly changes them. The `settings:get` IPC handler returns defaults for any key not found in the database.

---

## 4. IPC Layer Design

### Shared Type Definitions

These types are defined in a shared file importable by both main process and renderer (via the preload type declaration).

```typescript
// src/shared/types.ts

// --- Timer Types ---

export type TimerType = 'work' | 'short_break' | 'long_break';

export type TimerStatus = 'idle' | 'running' | 'paused' | 'completed';

// --- Session Types ---

export interface Session {
  id: string;                      // UUID v4
  title: string;                   // user-entered title, may be empty string
  timerType: TimerType;            // which timer mode was used
  plannedDurationSeconds: number;  // configured duration
  actualDurationSeconds: number;   // elapsed active time (excludes pauses)
  completedAt: string;             // ISO 8601 timestamp
}

export interface SaveSessionInput {
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
}

export interface ListSessionsInput {
  limit?: number;   // default 50
  offset?: number;  // default 0
}

export interface ListSessionsResult {
  sessions: Session[];
  total: number;  // total count for pagination
}

// --- Settings Types ---

export interface TimerSettings {
  workDuration: number;        // seconds
  shortBreakDuration: number;  // seconds
  longBreakDuration: number;   // seconds
}

// --- Electron API (exposed via contextBridge) ---

export interface ElectronAPI {
  platform: string;
  session: {
    save: (input: SaveSessionInput) => Promise<Session>;
    list: (input: ListSessionsInput) => Promise<ListSessionsResult>;
    delete: (id: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<TimerSettings>;
    save: (settings: TimerSettings) => Promise<void>;
  };
}
```

### IPC Channel Definitions

| Channel Name | Direction | Input Type | Return Type | Description |
|-------------|-----------|------------|-------------|-------------|
| `session:save` | Renderer -> Main | `SaveSessionInput` | `Session` | Saves a completed session. Main process generates the `id` and `completedAt` timestamp, inserts the row, and returns the full `Session` object. |
| `session:list` | Renderer -> Main | `ListSessionsInput` | `ListSessionsResult` | Retrieves sessions ordered by `completed_at DESC` with pagination. Returns the page of sessions plus the total count. |
| `session:delete` | Renderer -> Main | `string` (id) | `void` | Deletes a session by its UUID. No-op if the ID does not exist (no error thrown). |
| `settings:get` | Renderer -> Main | (none) | `TimerSettings` | Returns the current timer settings. Falls back to hardcoded defaults for any missing keys. |
| `settings:save` | Renderer -> Main | `TimerSettings` | `void` | Upserts all three duration settings into the `settings` table. |

### IPC Handler Pattern

All IPC communication uses Electron's `ipcMain.handle` / `ipcRenderer.invoke` pattern, which returns Promises. This is the recommended pattern for request-response communication and naturally integrates with async/await in the renderer.

```typescript
// Main process (registration)
ipcMain.handle('session:save', async (_event, input: SaveSessionInput) => {
  return db.saveSession(input);
});

// Preload (bridge)
contextBridge.exposeInMainWorld('electronAPI', {
  session: {
    save: (input: SaveSessionInput) => ipcRenderer.invoke('session:save', input),
  },
  // ...
});

// Renderer (usage)
const session = await window.electronAPI.session.save({ ... });
```

---

## 5. Main Process Changes

### New File: `src/main/database.ts`

This module encapsulates all SQLite operations. It exports a singleton database instance and query functions.

**Responsibilities:**
- Open/create the SQLite database file at the `userData` path
- Run schema initialization (CREATE TABLE IF NOT EXISTS)
- Provide typed query functions for all IPC operations
- Handle UUID generation (using `crypto.randomUUID()`)
- Handle ISO timestamp generation

**Key functions:**
```typescript
export function initDatabase(): void;
export function closeDatabase(): void;
export function saveSession(input: SaveSessionInput): Session;
export function listSessions(input: ListSessionsInput): ListSessionsResult;
export function deleteSession(id: string): void;
export function getSettings(): TimerSettings;
export function saveSettings(settings: TimerSettings): void;
```

`better-sqlite3` is synchronous, so these functions are plain functions (not async). The `ipcMain.handle` callbacks can call them directly and return the result -- Electron serializes the return value back to the renderer.

### New File: `src/main/ipc-handlers.ts`

Registers all IPC handlers. Called once during app initialization.

```typescript
export function registerIpcHandlers(): void {
  ipcMain.handle('session:save', (_event, input: SaveSessionInput) => {
    return saveSession(input);
  });

  ipcMain.handle('session:list', (_event, input: ListSessionsInput) => {
    return listSessions(input);
  });

  ipcMain.handle('session:delete', (_event, id: string) => {
    return deleteSession(id);
  });

  ipcMain.handle('settings:get', () => {
    return getSettings();
  });

  ipcMain.handle('settings:save', (_event, settings: TimerSettings) => {
    return saveSettings(settings);
  });
}
```

### Modified File: `src/main/index.ts`

Add database initialization and IPC handler registration to the app startup sequence.

```typescript
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { initDatabase, closeDatabase } from "./database";
import { registerIpcHandlers } from "./ipc-handlers";

app.whenReady().then(() => {
  initDatabase();
  registerIpcHandlers();
  createWindow();
  // ... existing activate handler
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  closeDatabase();
});
```

The `will-quit` handler ensures the database connection is closed cleanly.

---

## 6. Preload Script Changes

### Modified File: `src/preload/index.ts`

Expand the existing `contextBridge.exposeInMainWorld` call to expose the session and settings IPC channels.

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  session: {
    save: (input) => ipcRenderer.invoke("session:save", input),
    list: (input) => ipcRenderer.invoke("session:list", input),
    delete: (id) => ipcRenderer.invoke("session:delete", id),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings) => ipcRenderer.invoke("settings:save", settings),
  },
});
```

### New File: `src/preload/electron-api.d.ts`

TypeScript declaration so the renderer can use `window.electronAPI` with full type safety.

```typescript
import type { ElectronAPI } from "../shared/types";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
```

---

## 7. Renderer Architecture

### Component Tree

```
App
+-- TomatoClock
    +-- TimerView
    |   +-- TimerTypeSelector        (work / short break / long break tabs/buttons)
    |   +-- TimerDisplay              (MM:SS countdown, large centered text)
    |   +-- SessionTitleInput         (text input for session title)
    |   +-- TimerControls             (Start, Pause/Resume, Reset buttons)
    |   +-- TodaySessionCount         (P2: "4 work sessions today")
    |   +-- CompletionOverlay         (visual indication when timer hits 00:00)
    |
    +-- SessionHistory
        +-- SessionHistoryHeader      ("Session History" heading)
        +-- SessionHistoryEmpty       (empty state message, shown when no sessions)
        +-- SessionHistoryList        (scrollable list of session entries)
            +-- SessionHistoryItem    (single session row: title, duration, type, time, delete button)
```

### State Management

The timer is a finite state machine managed by `useReducer` in the `TomatoClock` component. The reducer handles these actions:

```typescript
type TimerAction =
  | { type: 'SET_TIMER_TYPE'; payload: TimerType }
  | { type: 'SET_TITLE'; payload: string }
  | { type: 'START' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'RESET' }
  | { type: 'TICK'; payload: number }  // payload = remaining seconds
  | { type: 'COMPLETE' }
  | { type: 'UPDATE_SETTINGS'; payload: TimerSettings }
  | { type: 'CLEAR_COMPLETION' };  // dismiss completion state to return to idle

interface TimerState {
  status: TimerStatus;            // 'idle' | 'running' | 'paused' | 'completed'
  timerType: TimerType;           // 'work' | 'short_break' | 'long_break'
  title: string;                  // session title text
  remainingSeconds: number;       // current countdown value
  settings: TimerSettings;        // configured durations
  // Internal tracking (not displayed):
  startedAtWallClock: number | null;     // Date.now() when timer was started/resumed
  accumulatedActiveMs: number;           // total active (non-paused) milliseconds
}
```

**State transitions:**

```
          SET_TIMER_TYPE / SET_TITLE
                    |
                    v
    +--------> [IDLE] <---------+
    |              |             |
    |           START            |
    |              |           RESET
    |              v             |
    |        [RUNNING] ------>--+
    |           |    |
    |        PAUSE  TICK->COMPLETE
    |           |         |
    |           v         v
    |       [PAUSED]  [COMPLETED]
    |           |         |
    |        RESUME    CLEAR_COMPLETION
    |           |         |
    |           v         v
    |       [RUNNING]   [IDLE]
    +----<------+---------+
```

**Key rules:**
- `SET_TIMER_TYPE` while idle resets `remainingSeconds` to the new type's configured duration.
- `RESET` returns to idle with the current type's configured duration. The `title` is **preserved** (addressing PRD review note).
- `COMPLETE` triggers session save via the IPC bridge (handled in the custom hook, not the reducer).
- `TICK` is dispatched by the timer interval; the payload is the computed remaining seconds from wall-clock delta.

### Custom Hooks

#### `useTimer(settings: TimerSettings)`

The primary timer hook. Contains the `useReducer`, the `setInterval` tick logic, and the session-save side effect.

**Returns:**
```typescript
{
  state: TimerState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  setTimerType: (type: TimerType) => void;
  setTitle: (title: string) => void;
  dismissCompletion: () => void;
}
```

**Timer tick implementation (wall-clock correction):**

```typescript
// Inside useTimer, when status === 'running':
useEffect(() => {
  if (state.status !== 'running') return;

  const endTime = Date.now() + state.remainingSeconds * 1000;

  const intervalId = setInterval(() => {
    const now = Date.now();
    const remaining = Math.max(0, Math.round((endTime - now) / 1000));

    if (remaining <= 0) {
      dispatch({ type: 'COMPLETE' });
      clearInterval(intervalId);
    } else {
      dispatch({ type: 'TICK', payload: remaining });
    }
  }, 250); // tick every 250ms for responsive display, but compute from wall clock

  return () => clearInterval(intervalId);
}, [state.status, state.startedAtWallClock]);
```

**Why 250ms interval instead of 1000ms:** A 1-second interval could visually skip a second if it fires slightly late (e.g., 1010ms). A 250ms interval ensures the display updates within 250ms of each second boundary while the actual remaining time is always computed from the wall clock. The `Math.round` ensures we display clean second values.

#### `useSessionHistory()`

Manages session history data fetching and delete operations.

**Returns:**
```typescript
{
  sessions: Session[];
  total: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  deleteSession: (id: string) => void;
  loadMore: () => void;
}
```

Calls `window.electronAPI.session.list()` on mount and after mutations. Manages pagination state internally (starts with limit=50, `loadMore` fetches the next page).

#### `useSettings()`

Loads settings on mount and provides a save function.

**Returns:**
```typescript
{
  settings: TimerSettings | null;
  isLoading: boolean;
  saveSettings: (settings: TimerSettings) => Promise<void>;
}
```

---

## 8. Key Implementation Details

### Timer Accuracy Strategy

The timer MUST NOT rely on counting `setInterval` callbacks. Instead:

1. When the user clicks **Start**, record `endTime = Date.now() + remainingSeconds * 1000` and `startedAtWallClock = Date.now()`.
2. On each tick (every 250ms), compute `remaining = Math.round((endTime - Date.now()) / 1000)`.
3. When the user clicks **Pause**, record the current `remainingSeconds` from the wall-clock computation. Add the elapsed active time (`Date.now() - startedAtWallClock`) to `accumulatedActiveMs`.
4. When the user clicks **Resume**, compute a new `endTime = Date.now() + remainingSeconds * 1000` and update `startedAtWallClock = Date.now()`.
5. When `remaining <= 0`, the timer is complete. Add the final active segment to `accumulatedActiveMs`.

This approach is immune to `setInterval` drift, JavaScript event loop delays, and the system sleep/wake cycle.

### Actual Duration Tracking

When a session completes, the `actualDurationSeconds` is calculated as:

```typescript
const actualDurationSeconds = Math.round(accumulatedActiveMs / 1000);
```

Where `accumulatedActiveMs` is the sum of all active (non-paused) time segments. For a session with no pauses, this equals `plannedDurationSeconds` (within 1 second). For a session with pauses, it reflects only the time the timer was actively running.

### Audio Notification on Completion

The PRD lists audio notifications as out of scope. However, a minimal completion indication is required (FR-008). For v1, the completion is purely visual (the UI enters "completed" state with a distinct visual treatment). No audio file or system beep is included.

If audio is added later, the approach would be: include a short `.mp3` or `.wav` file in `src/renderer/public/`, play it via `new Audio('completion.mp3')` in the renderer when the `COMPLETE` action fires. The CSP in `index.html` already allows `'self'` for default-src, so local audio files would work without CSP changes.

### Settings Persistence

1. On app startup, the `useSettings` hook calls `window.electronAPI.settings.get()`.
2. The main process reads from the `settings` table. If no rows exist, it returns hardcoded defaults.
3. When the user modifies durations, the renderer calls `window.electronAPI.settings.save(newSettings)`.
4. The main process uses `INSERT OR REPLACE` (SQLite UPSERT) for each setting key.
5. The timer hook receives updated settings and adjusts the idle duration display if the user is not mid-session.

### Title Preservation on Reset

Per the PRD review note: when the user clicks Reset, the timer returns to idle with the configured duration, but the title text input retains its current value. This avoids the frustration of retyping a title when the user wants to restart the same task. The `RESET` action in the reducer does not clear the `title` field.

### Error Handling

- **Database write failure on session save**: The `useTimer` hook wraps the save call in a try/catch. On failure, the UI still shows the completion state but displays an inline error message ("Session could not be saved"). The user is not blocked from starting a new session.
- **Database read failure on history load**: The `useSessionHistory` hook sets an `error` state string. The history view shows the error message instead of the list.
- **IPC timeout**: Not expected in practice (local SQLite is fast), but `ipcRenderer.invoke` returns a Promise that can reject. All IPC calls are wrapped in try/catch at the hook level.

---

## 9. File Structure

### Files to Create

| File | Purpose |
|------|---------|
| `src/shared/types.ts` | Shared TypeScript type definitions (Session, TimerSettings, ElectronAPI, etc.) |
| `src/main/database.ts` | SQLite database initialization, schema, and query functions |
| `src/main/ipc-handlers.ts` | IPC handler registration for all channels |
| `src/preload/electron-api.d.ts` | TypeScript global declaration for `window.electronAPI` |
| `src/renderer/src/components/TomatoClock.tsx` | Root component for the feature, composes timer and history |
| `src/renderer/src/components/TimerView.tsx` | Timer display, controls, type selector, title input |
| `src/renderer/src/components/TimerTypeSelector.tsx` | Work / Short Break / Long Break selector |
| `src/renderer/src/components/TimerDisplay.tsx` | Large MM:SS countdown display |
| `src/renderer/src/components/SessionTitleInput.tsx` | Text input for session title |
| `src/renderer/src/components/TimerControls.tsx` | Start, Pause/Resume, Reset buttons |
| `src/renderer/src/components/SessionHistory.tsx` | Session history section (header + list or empty state) |
| `src/renderer/src/components/SessionHistoryItem.tsx` | Single session entry with delete button |
| `src/renderer/src/hooks/useTimer.ts` | Timer state machine, tick logic, session save side effect |
| `src/renderer/src/hooks/useSessionHistory.ts` | Session list fetching, delete, pagination |
| `src/renderer/src/hooks/useSettings.ts` | Settings load and save |
| `src/renderer/src/utils/format.ts` | Utility functions (formatTime MM:SS, formatDate, etc.) |

### Files to Modify

| File | Changes |
|------|---------|
| `src/main/index.ts` | Import and call `initDatabase()`, `registerIpcHandlers()` in `app.whenReady()`. Add `closeDatabase()` in `will-quit` handler. |
| `src/preload/index.ts` | Add `session` and `settings` IPC invoke methods to the `electronAPI` object exposed via `contextBridge`. Add `ipcRenderer` import. |
| `src/renderer/src/App.tsx` | Replace placeholder content with `<TomatoClock />` component. |
| `src/renderer/index.html` | No changes expected. CSP already allows `'self'` which covers local assets. |
| `package.json` | Add `better-sqlite3` to `dependencies`. Add `@types/better-sqlite3` to `devDependencies`. Add `postinstall` script for `@electron/rebuild`. |
| `tsconfig.json` | No changes needed. The `include: ["src"]` already covers `src/shared/`. |

### Sequence of Changes (Implementation Order)

1. **Install dependencies** -- Add `better-sqlite3` and `@types/better-sqlite3`. Run `@electron/rebuild` to compile native module for Electron.
2. **Create shared types** -- `src/shared/types.ts` (no dependencies, used by everything else).
3. **Create database module** -- `src/main/database.ts` (depends on shared types and `better-sqlite3`).
4. **Create IPC handlers** -- `src/main/ipc-handlers.ts` (depends on database module).
5. **Modify main process** -- `src/main/index.ts` (wire up database init + IPC handlers).
6. **Modify preload script** -- `src/preload/index.ts` + create `electron-api.d.ts` (expose IPC channels).
7. **Create utility functions** -- `src/renderer/src/utils/format.ts`.
8. **Create custom hooks** -- `useSettings.ts`, `useTimer.ts`, `useSessionHistory.ts` (depends on preload bridge + shared types).
9. **Create UI components** -- Bottom-up: `TimerDisplay`, `TimerTypeSelector`, `SessionTitleInput`, `TimerControls`, `TimerView`, `SessionHistoryItem`, `SessionHistory`, `TomatoClock`.
10. **Modify App.tsx** -- Render `<TomatoClock />`.
11. **Test end-to-end** -- Verify full flow: start timer, complete, check history, restart app, verify persistence.

---

## 10. Dependencies to Add

| Package | Type | Version | Purpose |
|---------|------|---------|---------|
| `better-sqlite3` | `dependencies` | `^11.0.0` | Synchronous SQLite3 binding for Node.js / Electron main process |
| `@types/better-sqlite3` | `devDependencies` | `^7.6.0` | TypeScript type definitions for better-sqlite3 |

**Native module rebuild:**

`better-sqlite3` includes a native C++ addon that must be compiled against Electron's version of Node.js. The project already has `@electron/rebuild` as a dev dependency. Add a `postinstall` script to `package.json`:

```json
"scripts": {
  "postinstall": "electron-rebuild -f -w better-sqlite3"
}
```

Alternatively, the implementer can run `npx @electron/rebuild` manually after install. The `postinstall` script automates this for CI and fresh clones.

**No other new dependencies are needed.** The project already has React 19, TypeScript, Vitest, Testing Library, and Playwright.

---

## 11. Security Considerations

### Authentication
Not applicable. This is a local-only desktop app with no user accounts.

### Authorization
Not applicable. Single-user, local data only.

### Data Protection
- All data stays on the local filesystem. No network requests are made.
- The SQLite database is stored in the OS-standard user data directory (`app.getPath('userData')`), which is protected by OS-level file permissions.
- The renderer process has no direct access to Node.js APIs, the filesystem, or the database file. All data flows through the preload IPC bridge.
- `contextIsolation: true` prevents the renderer from accessing Electron internals.
- `nodeIntegration: false` prevents `require()` or Node.js module access in the renderer.
- The CSP header in `index.html` restricts script and resource loading to `'self'`.

### Input Validation
- Session title: Trim whitespace. No length limit in v1, but the database module should enforce a reasonable maximum (e.g., 500 characters) to prevent abuse.
- Timer type: Validate against the `TimerType` union in the IPC handler. Reject unknown values.
- Duration values in settings: Validate as positive integers within a sane range (e.g., 60 to 7200 seconds = 1 min to 2 hours).

---

## 12. Performance Considerations

### Expected Load
- Single user, single window. Concurrency is not a concern.
- Maximum realistic session history: a few thousand records over months of use (4 sessions/hour * 8 hours * 250 work days = 8,000 sessions/year).
- SQLite easily handles this volume with sub-millisecond query times.

### Optimization Strategies
- Use a `DESC` index on `completed_at` for history queries (defined in schema).
- Paginate history queries (default limit 50) to avoid loading thousands of rows at once.
- Timer tick interval at 250ms is lightweight (4 dispatches/second, each doing one `Date.now()` call and one subtraction).

### Caching
- No caching layer needed. SQLite reads from the local filesystem are fast enough for all use cases.
- Settings are loaded once on mount and cached in React state. They are only re-fetched if the user explicitly changes them.

---

## 13. Testing Strategy

### Unit Tests (Vitest)

- **Timer reducer**: Test all state transitions (idle->running, running->paused, paused->running, running->completed, reset from any state). Verify title is preserved on reset. Verify timer type change updates remaining seconds when idle.
- **Format utilities**: Test `formatTime(seconds)` returns correct MM:SS strings (e.g., 1500 -> "25:00", 0 -> "00:00", 61 -> "01:01").
- **Database module**: Test `saveSession`, `listSessions`, `deleteSession`, `getSettings`, `saveSettings` against an in-memory SQLite database (`:memory:`). Verify schema creation, UUID generation, pagination, default settings fallback.

### Integration Tests (Vitest + Testing Library)

- **Timer component**: Render `TimerView`, simulate start/pause/reset via button clicks using `@testing-library/react`. Use `vi.useFakeTimers()` to advance time and verify display updates. Mock `window.electronAPI` to verify IPC calls on completion.
- **Session history component**: Mock `window.electronAPI.session.list` to return test data. Verify items render. Simulate delete and verify the IPC call.
- **Settings flow**: Mock `window.electronAPI.settings.get/save`. Verify settings load on mount and save on user change.

### E2E Tests (Playwright)

- **Full session flow**: Launch the Electron app, start a work timer (use a short duration like 3 seconds for testing), wait for completion, verify the session appears in history. Restart the app, verify the session persists.
- **Delete flow**: Complete a session, delete it from history, verify it disappears.
- **Settings persistence**: Change work duration, restart app, verify the new duration is displayed.

---

## 14. Rollout Plan

### Feature Flags
Not applicable. This is the first feature in the app. It ships as the default (and only) content.

### Rollback Plan
Since this is a fresh feature in a new app with no existing users or data:
- Rollback = revert the commit(s) and ship the empty shell.
- No data migration reversal needed (the database file can simply be deleted or ignored).

---

## 15. Open Questions

| Question | Status | Resolution |
|----------|--------|------------|
| Which SQLite library to use? | Resolved | `better-sqlite3` -- synchronous API, mature Electron support, works with `@electron/rebuild`. `bun:sqlite` is not usable inside Electron's main process. |
| Should we store actual elapsed time or planned duration? | Resolved | Both. `planned_duration_seconds` stores the configured duration. `actual_duration_seconds` stores wall-clock active time (excluding pauses). See Section 3. |
| What happens to the title on reset? | Resolved | Title is preserved. The reducer's `RESET` action does not clear the `title` field. See Section 8. |
| Layout: single page or tabs? | Resolved | Single scrollable page. Timer view on top (~40% of viewport), session history below. No routing library needed for v1. |
| How to handle `better-sqlite3` native rebuild in CI? | Open | The `postinstall` script with `electron-rebuild` should handle this. If Bun's package manager has issues with native module rebuilds, the implementer may need to use npm/yarn for the install step or run rebuild separately. To be validated during implementation. |

---

## 16. Addressing PRD Review Notes

The PRD review (prd-review.md) identified three minor notes. Here is how each is addressed in this spec:

### Note 1: "Feature completeness" metric is tautological
**Resolution**: This is a product-level observation, not a technical concern. No action needed in the tech spec. The success metrics in the PRD are sufficient for v1.

### Note 2: Planned duration vs. actual elapsed time
**Resolution**: The `sessions` table includes both `planned_duration_seconds` and `actual_duration_seconds` columns. The timer hook tracks accumulated active milliseconds across start/pause/resume cycles. When the session completes, both values are persisted. For sessions without pauses, the two values are equal. This future-proofs the schema for analytics without adding complexity to the v1 UI (which only displays `planned_duration_seconds` in the history list). See Sections 3 and 8.

### Note 3: Title preservation on reset
**Resolution**: The `RESET` action in the timer reducer explicitly preserves the `title` field. Only `status` and `remainingSeconds` are reset. The user's typed title remains in the input field so they can restart the same task without retyping. See Section 8.
