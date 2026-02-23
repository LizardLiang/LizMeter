# File Structure

## Full Source Tree (excluding node_modules, dist, dist-electron)

```
D:/Programing/React/LizMeter/
├── .husky/
│   ├── pre-commit                          # Runs: bun run fmt:check && bun run lint
│   └── pre-push                            # Runs: bun run test (only on master/main)
│
├── electron/
│   ├── main/
│   │   ├── __tests__/
│   │   │   └── database.test.ts            # 16 test cases for all database functions
│   │   ├── database.ts                     # SQLite module: initDatabase, saveSession, listSessions, deleteSession, getSettings, saveSettings
│   │   ├── index.ts                        # Electron main entry: app lifecycle, createWindow, database init
│   │   └── ipc-handlers.ts                 # Registers all ipcMain.handle channels
│   └── preload/
│       └── index.ts                        # contextBridge: exposes window.electronAPI
│
├── src/
│   ├── renderer/
│   │   └── src/
│   │       ├── components/
│   │       │   ├── __tests__/
│   │       │   │   ├── SessionHistory.test.tsx
│   │       │   │   ├── SessionHistoryItem.test.tsx
│   │       │   │   ├── SessionTitleInput.test.tsx
│   │       │   │   ├── TimerControls.test.tsx
│   │       │   │   └── TimerDisplay.test.tsx
│   │       │   ├── SessionHistory.tsx       # Session history list with empty/error/loading states
│   │       │   ├── SessionHistoryItem.tsx   # Single session row (title, type badge, duration, timestamp, delete)
│   │       │   ├── SessionTitleInput.tsx    # Text input for session title
│   │       │   ├── TimerControls.tsx        # Start/Pause/Resume/Reset/Dismiss buttons
│   │       │   ├── TimerDisplay.tsx         # MM:SS countdown display, editable when idle
│   │       │   ├── TimerTypeSelector.tsx    # Work/Short Break/Long Break toggle buttons
│   │       │   ├── TimerView.tsx            # Composed timer panel (type selector + display + title + controls)
│   │       │   └── TomatoClock.tsx          # Root feature container, composes all hooks + renders TimerView + SessionHistory
│   │       ├── hooks/
│   │       │   ├── __tests__/
│   │       │   │   ├── timerReducer.test.ts
│   │       │   │   ├── useSessionHistory.test.ts
│   │       │   │   ├── useSettings.test.ts
│   │       │   │   └── useTimer.test.ts
│   │       │   ├── useSessionHistory.ts     # Paginated session list fetching, delete, refresh
│   │       │   ├── useSettings.ts           # Load/save timer settings via IPC
│   │       │   └── useTimer.ts              # Timer FSM via useReducer, wall-clock tick, auto-save
│   │       ├── utils/
│   │       │   ├── __tests__/
│   │       │   │   └── format.test.ts
│   │       │   └── format.ts                # formatTime, formatCompletedAt, formatTimerType
│   │       ├── App.tsx                      # Root component, renders <TomatoClock />
│   │       ├── App.test.tsx                 # Smoke test for App
│   │       ├── electron-api.d.ts            # Augments Window with electronAPI typing
│   │       └── main.tsx                     # React entry point (createRoot + StrictMode)
│   ├── shared/
│   │   └── types.ts                         # All shared types: Session, TimerSettings, ElectronAPI, etc.
│   └── test/
│       ├── better-sqlite3-shim.ts           # sql.js-based shim replacing better-sqlite3 in Vitest
│       └── setup.ts                         # Vitest setup: imports @testing-library/jest-dom/vitest
│
├── CLAUDE.md                                # Project instructions for Claude Code
├── dprint.json                              # dprint formatter config
├── index.html                               # Vite entry point + Tokyo Night CSS variables + custom title bar
├── package.json                             # bun scripts, dependencies
├── tsconfig.json                            # Solution-style root (references main + renderer)
├── tsconfig.main.json                       # Electron main + preload + shared (node types only)
├── tsconfig.renderer.json                   # Renderer + shared + test (DOM types, JSX)
├── vite.config.ts                           # Vite + electron plugin config
└── vitest.config.ts                         # Vitest config (jsdom, node env for electron/main, shim alias)
```

## Where to Add New Code for Session Tagging + Sidebar

### New database tables/queries
- `electron/main/database.ts` -- Add `tags` and `session_tags` tables in `initDatabase()`, add CRUD functions

### New IPC channels
- `electron/main/ipc-handlers.ts` -- Register new handlers (e.g., `tag:create`, `tag:list`, `tag:delete`, `session:addTag`, `session:removeTag`, `session:listByTag`)

### New preload methods
- `electron/preload/index.ts` -- Expose new tag methods on `window.electronAPI.tag`

### New types
- `src/shared/types.ts` -- Add `Tag`, `CreateTagInput`, etc. and extend `ElectronAPI`

### New hooks
- `src/renderer/src/hooks/useTags.ts` -- CRUD for tags
- Extend `useSessionHistory.ts` -- Add tag filtering

### New components
- `src/renderer/src/components/Sidebar.tsx` -- Sidebar container
- `src/renderer/src/components/TagList.tsx` -- List of tags with management
- `src/renderer/src/components/TagBadge.tsx` -- Tag display chip
- `src/renderer/src/components/TagInput.tsx` -- Tag add/remove interface on sessions

### Layout restructure
- `src/renderer/src/App.tsx` or `TomatoClock.tsx` -- Change from single-column to sidebar + main panel layout

### New tests
- `electron/main/__tests__/database-tags.test.ts` -- Database tag operations
- `src/renderer/src/components/__tests__/` -- New component tests
- `src/renderer/src/hooks/__tests__/useTags.test.ts` -- Hook tests