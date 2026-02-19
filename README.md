# LizMeter

A desktop Pomodoro timer app built with Electron, React, and TypeScript. Features a Tokyo Night dark theme, local SQLite session history, and configurable timer durations.

Electron + React 19 桌面番茄鐘應用程式。採用 Tokyo Night 深色主題，本機 SQLite 記錄工作階段，支援自訂計時時長。

---

## Features / 功能

- **Pomodoro Timer** — Work, Short Break, Long Break modes with start/pause/resume/reset controls
- **Session History** — Automatically saves completed sessions to a local SQLite database with pagination and delete
- **Configurable Durations** — Customize work and break durations (1–120 minutes)
- **Session Titles** — Optionally label each work session
- **Tokyo Night Theme** — Dark UI with the Tokyo Night color palette

---

- **番茄計時器** — 工作、短休息、長休息模式，支援開始／暫停／繼續／重設
- **工作階段歷史** — 完成的工作階段自動儲存至本機 SQLite 資料庫，支援分頁與刪除
- **自訂時長** — 可調整工作與休息時間（1–120 分鐘）
- **工作階段標題** — 可為每次工作加上標題
- **Tokyo Night 主題** — 深色 UI，使用 Tokyo Night 配色

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
| `bun run test:coverage` | Run tests with coverage / 測試覆蓋率 |
| `bun run test:e2e` | Run Playwright E2E tests / 端對端測試 |
| `bun run lint` | Run ESLint / 執行 ESLint |
| `bun run fmt` | Auto-format with dprint / dprint 自動格式化 |
| `bun run fmt:check` | Check formatting / 檢查格式 |

---

## Project Structure / 專案結構

```
LizMeter/
├── electron/
│   ├── main/           # Electron main process / 主程序
│   │   ├── index.ts        # App entry, window creation / 應用程式進入點
│   │   ├── database.ts     # SQLite operations / SQLite 資料庫操作
│   │   └── ipc-handlers.ts # IPC channel handlers / IPC 通道處理
│   └── preload/        # Preload script (contextBridge) / 預載入腳本
├── src/
│   ├── renderer/       # React UI / React 使用者介面
│   │   └── src/
│   │       ├── components/  # React components / React 元件
│   │       ├── hooks/       # Custom hooks (useTimer, useSettings, useSessionHistory)
│   │       └── utils/       # Utility functions / 工具函式
│   ├── shared/         # Types shared between processes / 程序間共用型別
│   └── test/           # Test setup and shims / 測試設定與墊片
├── e2e/                # Playwright E2E tests / 端對端測試
├── index.html          # Vite entry HTML
├── vite.config.ts      # Vite + vite-plugin-electron config
└── vitest.config.ts    # Vitest config
```

---

## Architecture / 架構

The app follows Electron's security best practices with `contextIsolation: true` and `nodeIntegration: false`:

本應用遵循 Electron 安全最佳實踐，啟用 `contextIsolation: true` 並停用 `nodeIntegration: false`：

```
Renderer (React)
  ↓ window.electronAPI.*()
Preload (contextBridge)
  ↓ ipcRenderer.invoke()
Main Process (ipcMain.handle)
  ↓
SQLite Database (better-sqlite3)
```

Timer state is managed by a finite state machine (`useReducer`) with wall-clock arithmetic to prevent drift. No external state management library is used.

計時器狀態由有限狀態機（`useReducer`）搭配實際時鐘運算管理，以避免時間漂移。未使用外部狀態管理套件。

---

## License / 授權

Private project.

私人專案。
