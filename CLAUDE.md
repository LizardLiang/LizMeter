# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Always use **bun**, never npm/npx.

```
bun run dev              # Vite dev server + Electron (hot reload)
bun run build            # Production build (renderer + main + preload)
bun run test             # Vitest unit tests (single run)
bun run test:watch       # Vitest watch mode
bun vitest run path/to/file.test.ts  # Run a single test file
bun run test:e2e         # Playwright E2E (requires bun run build first)
bun run lint             # ESLint
bun run fmt              # dprint auto-format
bun run fmt:check        # dprint check (read-only, used in pre-commit)
bun run rebuild          # Recompile better-sqlite3 for Electron ABI
```

## Architecture

Electron app with three isolated processes communicating via IPC:

```
Renderer (React 19)  →  Preload (contextBridge)  →  Main (ipcMain.handle)  →  SQLite
```

- **`electron/main/`** — Main process: app lifecycle, database (better-sqlite3, synchronous), IPC handlers
- **`electron/preload/`** — Exposes `window.electronAPI` via contextBridge (contextIsolation: true, nodeIntegration: false)
- **`src/renderer/`** — React UI with inline styles (no CSS files), Tokyo Night dark theme
- **`src/shared/types.ts`** — Single source of truth for all types shared between processes
- **`index.html`** — At project root (Vite entry point), defines CSS variables for Tokyo Night palette

Build output: `dist/` (renderer), `dist-electron/main/` and `dist-electron/preload/` (electron). Unified via `vite-plugin-electron/simple` in `vite.config.ts`.

### IPC Channels

`session:save`, `session:list`, `session:delete`, `settings:get`, `settings:save` — all registered in `electron/main/ipc-handlers.ts`, typed in `src/shared/types.ts`, exposed in `electron/preload/index.ts`.

### State Management

No external state library. Three hooks composed in `TomatoClock.tsx`:
- **`useTimer`** — FSM via `useReducer` (idle→running→paused→completed). 250ms tick interval with wall-clock arithmetic to avoid drift.
- **`useSettings`** — Loads/saves timer durations via IPC
- **`useSessionHistory`** — Paginated session list via IPC, refresh via token counter pattern

## Testing

- **Vitest** with jsdom (renderer) and node environment (electron/main via `environmentMatchGlobs`)
- **better-sqlite3 shim**: Vitest can't load the native module (ABI mismatch). `vitest.config.ts` aliases it to `src/test/better-sqlite3-shim.ts` which uses sql.js (WASM). Database tests call `initDatabase(":memory:")`.
- **Renderer tests** mock `window.electronAPI` via `vi.stubGlobal`
- Tests live in `__tests__/` directories alongside source files

## Code Style

- **dprint**: double quotes, semicolons, 2-space indent, 120-char line width, trailing commas onlyMultiLine
- **dprint includes**: `src/**/*.{ts,tsx}` and `*.json` — electron/ files are not currently covered
- All imports use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions` + `verbatimModuleSyntax`)
- Components use named exports (no default exports)
- All styling is inline `React.CSSProperties` — no CSS files or CSS-in-JS libraries
- Git hooks: pre-commit runs `fmt:check` + `lint`; pre-push runs tests on master/main

## Gotchas

- After installing native deps, run `bun run rebuild` or Electron crashes with ABI mismatch
- Database tests must pass `":memory:"` to `initDatabase()` — the default path requires Electron's `app.getPath()` which is unavailable in Vitest
- Two tsconfigs: `tsconfig.main.json` (electron + shared, node types only) and `tsconfig.renderer.json` (renderer + shared + test, includes DOM)
