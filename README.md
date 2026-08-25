# LizMeter

A desktop time-tracking app built with Electron, React, and TypeScript. Combines Pomodoro timer and stopwatch modes with issue tracker integration (GitHub, Linear, Jira), session tagging, and Jira worklog logging. Tokyo Night dark theme, local SQLite storage.

Electron + React 19 桌面時間追蹤應用程式。整合番茄鐘與碼錶模式，支援 GitHub、Linear、Jira 議題追蹤、工作階段標籤，以及 Jira worklog 記錄功能。採用 Tokyo Night 深色主題，本機 SQLite 儲存。

---

## Features / 功能

### Time Tracking / 計時模式
- **Pomodoro Timer** — Work / Short Break / Long Break modes with start/pause/resume/reset controls
- **Stopwatch Mode** — Open-ended time tracking with configurable max duration and optional issue prompt on start
- **Session Titles** — Label each session before or after completing it

### Issue Integration / 議題整合
- **GitHub Issues** — Browse and link assigned issues; view inline comments
- **Linear Issues** — Browse team-scoped issues with priority; view inline comments
- **Jira Cloud & Server** — Browse issues by project or custom JQL; view inline comments

### Work Logging / 工時記錄
- **Jira Worklog** — Log completed session duration back to linked Jira issues with a comment; tracks logged/failed status
- **Bulk Log** — Log all sessions for a single issue at once from the History page

### Todos / 待辦事項
- **Todo List** — A standalone list with project, milestone, start/due dates, and a workflow state
- **Editable States** — Ships with Backlog / Todo / Processing / Testing / Done / Deprecated, all of which you can
  rename, recolor, reorder, add to, and delete. Deleting one asks where to move its todos
- **AI-Written Todos** — An AI agent can add and update todos through an MCP server; they land live and carry a
  source badge
- **Grouped List** — Linear-style dense rows grouped under collapsible state bands, with multi-select,
  per-row actions, and `c` to create a todo
- **Filters** — All / Active / Done / From AI, plus a per-project filter

### Session Management / 工作階段管理
- **Session History** — Paginated list of completed sessions with delete support
- **Session Tags** — Create color-coded tags and assign them to sessions; filter history by tag
- **Grouping** — History grouped by linked issue, with date sub-groups; collapsible headers

### Settings / 設定
- **Configurable Durations** — Work (1–120 min), Short Break (1–60 min), Long Break (1–120 min)
- **Stopwatch Settings** — Max duration (0 = unlimited) and prompt-for-issue toggle
- **Secure Credential Storage** — API tokens and passwords stored in OS keychain

---

## Tech Stack / 技術堆疊

| Layer | Technology |
|---|---|
| Desktop Shell | Electron 40 |
| UI | React 19 + TypeScript 5 |
| Build | Vite 7 + vite-plugin-electron |
| Database | better-sqlite3 (local SQLite) |
| Package Manager | Bun |
| Testing | Vitest + Testing Library + Playwright |
| Formatter / Linter | dprint + ESLint |

---

## Prerequisites / 前置需求

- [Bun](https://bun.sh/) >= 1.0
- [Node.js](https://nodejs.org/) >= 20 (required by Electron tooling)

---

## Getting Started / 開始使用

```bash
# Install dependencies / 安裝依賴
bun install

# Rebuild native modules for Electron / 為 Electron 重新編譯原生模組
bun run rebuild

# Start development / 啟動開發模式
bun run dev
```

The app window will open automatically with hot reload enabled.

應用程式視窗將自動開啟，並啟用熱重載。

---

## Scripts / 指令

| Command | Description |
|---|---|
| `bun run dev` | Start Vite dev server + Electron / 啟動開發伺服器 |
| `bun run build` | Production build / 正式版建置 |
| `bun run rebuild` | Recompile native deps for Electron ABI / 重新編譯原生模組 |
| `bun run test` | Run unit tests / 執行單元測試 |
| `bun run test:watch` | Run tests in watch mode / 監聽模式測試 |
| `bun run test:e2e` | Run Playwright E2E tests (requires build first) / 端對端測試 |
| `bun run lint` | Run ESLint / 執行 ESLint |
| `bun run fmt` | Auto-format with dprint / dprint 自動格式化 |
| `bun run fmt:check` | Check formatting (read-only) / 檢查格式 |

---

## Project Structure / 專案結構

```
LizMeter/
├── electron/
│   ├── main/
│   │   ├── index.ts                  # App entry, window creation
│   │   ├── database.ts               # SQLite schema and migrations
│   │   ├── ipc-handlers.ts           # All IPC channel handlers
│   │   └── issue-providers/          # GitHub / Linear / Jira API clients
│   └── preload/
│       └── index.ts                  # contextBridge → window.electronAPI
├── src/
│   ├── renderer/src/
│   │   ├── components/               # React components (+ SCSS modules)
│   │   │   └── __tests__/
│   │   ├── hooks/                    # useTimer, useStopwatch, useSessionHistory,
│   │   │                             #   useIssues, useGroupExpand, ...
│   │   │   └── __tests__/
│   │   ├── utils/                    # format, groupSessions, ...
│   │   │   └── __tests__/
│   │   └── styles/                   # Global SCSS vars and mixins (Tokyo Night)
│   ├── shared/
│   │   └── types.ts                  # Single source of truth for all shared types
│   └── test/
│       └── better-sqlite3-shim.ts    # sql.js WASM shim for Vitest
├── e2e/                              # Playwright E2E tests
├── index.html                        # Vite entry point
├── vite.config.ts
└── vitest.config.ts
```

---

## Architecture / 架構

The app follows Electron security best practices (`contextIsolation: true`, `nodeIntegration: false`):

```
Renderer (React 19)
  ↓ window.electronAPI.*()
Preload (contextBridge)
  ↓ ipcRenderer.invoke()
Main Process (ipcMain.handle)
  ↓
SQLite (better-sqlite3, synchronous)
```

**State management** — No external library. Three core hooks composed in `TomatoClock.tsx`:
- `useTimer` — FSM via `useReducer` (idle → running → paused → completed); 250ms tick with wall-clock arithmetic to prevent drift
- `useStopwatch` — FSM via `useReducer` for open-ended count-up
- `useSettings` / `useSessionHistory` / `useIssues` — IPC-backed hooks with local caching

**Styling** — SCSS modules (one per component), Tokyo Night palette via CSS variables in `index.html`. No inline styles, no CSS-in-JS.

---

## Issue Tracker Setup / 議題追蹤設定

Open **Settings** in the sidebar and configure one or more providers:

| Provider | Required Fields |
|---|---|
| **GitHub** | Personal Access Token (repo scope) |
| **Linear** | API key + select team |
| **Jira Cloud** | Atlassian domain, email, API token |
| **Jira Server** | Server URL, username, password |

Optional per-provider: project key filter, custom JQL query.

---

## AI Todo Setup / AI 待辦設定

LizMeter ships an MCP server that lets an AI agent add todos to the running app.
It has no dependencies and forwards over the app's existing named pipe, so the UI
updates live and the database keeps a single writer.

Register it with Claude Code:

```bash
claude mcp add lizmeter-todo -- node /absolute/path/to/LizMeter/mcp/lizmeter-todo-mcp.mjs
```

Or add it to `.mcp.json` by hand:

```json
{
  "mcpServers": {
    "lizmeter-todo": {
      "command": "node",
      "args": ["/absolute/path/to/LizMeter/mcp/lizmeter-todo-mcp.mjs"]
    }
  }
}
```

The agent then gets three tools:

| Tool | Purpose |
|---|---|
| `todo_add` | Add a todo. Accepts `title`, plus optional `notes`, `agent`, `project`, `milestone`, `startDate`, `dueDate`, `state` |
| `todo_list` | List todos, optionally filtered by `all` / `active` / `done` / `ai`, and by `project` or `state` |
| `todo_update` | Change an existing todo: move it between states, set a due date, assign a project. Only the fields you pass change |
| `todo_complete` | Mark one todo done by its numeric id |

Notes:

- **LizMeter must be running.** The MCP server talks to the live app, not the database
  file. If the app is closed, the tools return a message saying so.
- Every todo added this way is tagged `ai` and shown with a badge, so it can be told
  apart from one you typed and filtered out in bulk.
- `LIZMETER_PIPE_PATH` overrides the pipe on both sides, for tests or a second instance.
- **State labels are yours to change.** The agent passes a state by label, case-insensitively. Because you can
  rename them, there is no fixed list — pass an unknown one and the error names every valid label, so the agent
  learns them in a single round trip. `todo_complete` resolves whichever state you marked as the completed one,
  so renaming "Done" to "Shipped" breaks nothing.
- Dates are `YYYY-MM-DD`, and a start date may not be later than the due date.

---

## Testing / 測試

```bash
bun run test           # All unit tests (single run)
bun run test:watch     # Watch mode
bun vitest run src/renderer/src/components/__tests__/Sidebar.test.tsx  # Single file
```

- Renderer tests run in **jsdom** and mock `window.electronAPI` via `vi.stubGlobal`
- Main-process tests run in **node** environment
- `better-sqlite3` is aliased to a `sql.js` WASM shim in Vitest to avoid ABI mismatch

---

## License / 授權

Private project. / 私人專案。
