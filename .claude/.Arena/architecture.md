# Architecture

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

## IPC Channel Contracts

All IPC uses Electron's invoke/handle pattern (request-response, async from renderer side, synchronous on main side).

### Session Channels

| Channel | Direction | Input Type | Return Type | Handler |
|---------|-----------|-----------|-------------|---------|
| `session:save` | renderer -> main | `SaveSessionInput` | `Session` | `saveSession()` |
| `session:list` | renderer -> main | `ListSessionsInput` | `ListSessionsResult` | `listSessions()` |
| `session:delete` | renderer -> main | `string` (id) | `void` | `deleteSession()` |

### Settings Channels

| Channel | Direction | Input Type | Return Type | Handler |
|---------|-----------|-----------|-------------|---------|
| `settings:get` | renderer -> main | (none) | `TimerSettings` | `getSettings()` |
| `settings:save` | renderer -> main | `TimerSettings` | `void` | `saveSettings()` |

### Window Channels (fire-and-forget via `ipcRenderer.send`)

| Channel | Purpose |
|---------|---------|
| `window:minimize` | Minimize the window |
| `window:maximize` | Toggle maximize/unmaximize |
| `window:close` | Close the window |

### Full Type Definitions (from `src/shared/types.ts`)

```typescript
type TimerType = "work" | "short_break" | "long_break";
type TimerStatus = "idle" | "running" | "paused" | "completed";

interface Session {
  id: string;              // UUID v4
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  completedAt: string;     // ISO 8601
}

interface SaveSessionInput {
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
}

interface ListSessionsInput {
  limit?: number;   // default 50
  offset?: number;  // default 0
}

interface ListSessionsResult {
  sessions: Session[];
  total: number;
}

interface TimerSettings {
  workDuration: number;       // seconds
  shortBreakDuration: number; // seconds
  longBreakDuration: number;  // seconds
}

interface ElectronAPI {
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
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
}
```

---

## Preload Bridge (`electron/preload/index.ts`)

Exposes `window.electronAPI` via `contextBridge.exposeInMainWorld`. Each method maps 1:1 to an IPC channel:

- Session methods use `ipcRenderer.invoke` (async request-response)
- Window methods use `ipcRenderer.send` (fire-and-forget)

The renderer accesses the API via `window.electronAPI`. TypeScript typing is provided by `src/renderer/src/electron-api.d.ts` which augments the global `Window` interface.

---

## React Component Tree

```
App
 └── TomatoClock              (root container, composes hooks)
      ├── TimerView            (timer panel with accent border)
      │    ├── TimerTypeSelector  (Work / Short Break / Long Break buttons)
      │    ├── TimerDisplay       (MM:SS countdown, editable when idle)
      │    ├── SessionTitleInput  (text input for session title)
      │    └── TimerControls      (Start/Pause/Resume/Reset/Dismiss buttons)
      └── SessionHistory        (history section)
           └── SessionHistoryItem[]  (individual session rows)
```

---

## State Management (Hooks)

No external state library. Three custom hooks composed in `TomatoClock.tsx`:

### `useTimer(settings: TimerSettings)` -> `UseTimerReturn`

- Implements a finite state machine via `useReducer`:
  - States: `idle` -> `running` -> `paused` -> `completed`
  - Actions: `START`, `PAUSE`, `RESUME`, `RESET`, `TICK`, `COMPLETE`, `SET_TIMER_TYPE`, `SET_TITLE`, `SET_REMAINING`, `UPDATE_SETTINGS`, `CLEAR_COMPLETION`
- Wall-clock tick: 250ms interval using `Date.now()` endpoint math to avoid drift
- Auto-saves session to SQLite via IPC when status transitions to `completed`
- Exposes: `state`, `start`, `pause`, `resume`, `reset`, `setTimerType`, `setTitle`, `setRemaining`, `dismissCompletion`, `saveError`

### `useSettings()` -> `UseSettingsReturn`

- Loads timer settings from SQLite on mount via `window.electronAPI.settings.get()`
- Falls back to hardcoded defaults on failure
- `saveSettings()` persists via IPC and updates local state
- Exposes: `settings` (nullable until loaded), `isLoading`, `saveSettings`

### `useSessionHistory()` -> `UseSessionHistoryReturn`

- Fetches paginated session list via `window.electronAPI.session.list()`
- Refresh via token counter pattern (`refreshToken` state triggers re-fetch)
- `deleteSession()` calls IPC then triggers refresh
- `loadMore()` increments offset and appends results
- Exposes: `sessions`, `total`, `isLoading`, `error`, `refresh`, `deleteSession`, `loadMore`

---

## App Startup Sequence

1. `app.whenReady()` fires
2. `initDatabase()` creates/opens SQLite database
3. `registerIpcHandlers()` registers all `ipcMain.handle` listeners
4. `createWindow()` creates a frameless `BrowserWindow` with preload script
5. Window loads Vite dev server URL (dev) or `dist/index.html` (prod)
6. `index.html` renders the custom title bar and mounts React at `#root`
7. `main.tsx` creates root and renders `<App />` inside `<StrictMode>`
8. `TomatoClock` mounts, `useSettings` loads settings, `useSessionHistory` fetches initial sessions

---

## Adding New Features: The IPC Pattern

To add a new feature that touches the database (e.g., session tagging):

1. **Types** (`src/shared/types.ts`): Define input/output interfaces and extend `ElectronAPI`
2. **Database** (`electron/main/database.ts`): Add tables in `initDatabase()`, add query/mutation functions
3. **IPC Handlers** (`electron/main/ipc-handlers.ts`): Register new `ipcMain.handle` channels
4. **Preload** (`electron/preload/index.ts`): Expose new methods via `contextBridge`
5. **Renderer hook** (`src/renderer/src/hooks/`): Create a custom hook that calls `window.electronAPI`
6. **Components** (`src/renderer/src/components/`): Build UI components, compose with hook in parent
7. **Tests**: Database tests in `electron/main/__tests__/`, component tests in `src/renderer/src/components/__tests__/`, hook tests in `src/renderer/src/hooks/__tests__/`