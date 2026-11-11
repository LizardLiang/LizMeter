# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Native app (current)

LizMeter is moving from Electron to a native Rust app drawn with DirectX 11 (gpui, vendored with a backdrop-blur patch). The native app lives in `native/` and is the app to extend. The Electron app described under "Legacy: Electron app" stays in the repo until both machines run native.

Versions: the native app is LizMeter v2 (2.x). The Electron line ends at 1.x. The version lives in `native/Cargo.toml` (`[workspace.package]`) and `native/Packager.toml`; `crates/app/tests/installer_config.rs` fails when they differ.

Commands, run from `native/` (GNU toolchain, see `rust-toolchain.toml`; needs MinGW-w64 gcc on PATH, e.g. `scoop install mingw`, and the Windows SDK for `fxc.exe`; no Visual Studio):

```
cargo build --release                 # build native/target/release/lizmeter.exe
cargo test --workspace                # all native tests
cargo test -p lizmeter-db             # one crate
cargo run --release -p lizmeter-app   # start the app
Remove-Item env:NSISDIR -ErrorAction SilentlyContinue   # PowerShell; scoop's NSIS sets it, see below
cargo packager --release -c Packager.toml   # per-user NSIS installer (needs: cargo install cargo-packager --locked)
```

Clear `NSISDIR` in the shell before `cargo packager`. scoop's NSIS sets it as a user variable, and then cargo-packager's own `makensis` looks for plugins in scoop's folder and stops with `Plugin not found, cannot call nsis_tauri_utils::SemverCompare`. Clear it in the shell only, not in the user environment, which scoop's NSIS needs.

Soak and cutover (details: `.claude/.Arena/runbooks/native-cutover.md`):

```
lizmeter.exe --soak-setup [--soak-sync <dir>]   # copy %APPDATA%\lizmeter to %APPDATA%\lizmeter-soak, sync to a test folder
lizmeter.exe --soak                             # run on the soak copy; refuses a OneDrive sync folder
lizmeter.exe --soak-check                       # clean-run report, exit code 3 when not clean
```

Crates in `native/crates/`:

- `core`: shared types (the Rust twin of `src/shared/types.ts`)
- `db`: SQLite (rusqlite), same schema and idempotent migrations as Electron, data-folder location
- `sync`: multi-writer oplog sync engine, held row-equal to the TS engine by `native/tools/sync-equivalence/`
- `services`: the Rust twin of the Electron main process: IPC-equivalent services, named pipe server, issue providers, tokens (DPAPI), OS integrations, single-writer guard, soak mode
- `music`: yt-dlp / ffmpeg playback, in-process decoder for cached tracks
- `ui`: gpui widgets: text input with IME, markdown live-preview editor, rich-text input
- `app`: windows, pages and the `lizmeter` binary

Rules:

- Same data as Electron: no schema change unless it also lands in `electron/main/database.ts` until cutover.
- Native tests that touch data use a temp folder (`tempfile`). Never point a test at `%APPDATA%\lizmeter`.
- A live native window for testing sets `LIZMETER_PIPE_PATH` to its own pipe and `--data-dir` to a scratch folder: the default pipe and `%APPDATA%\lizmeter` belong to the installed app.
- Visual changes: compare against the Electron page; `native/docs/effects-coverage.md` maps every blur and animation.
- One app writes a data folder at a time (`native/crates/services/src/os/guard.rs`).

## Legacy: Electron app

Everything below describes the Electron build. It is the shipped app until the cutover and is not extended with new features.

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
- **`src/renderer/`** — React UI with SCSS, Tokyo Night dark theme
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
