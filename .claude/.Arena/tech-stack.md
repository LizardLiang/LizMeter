# Tech Stack

## Runtime & Framework

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Desktop shell | Electron | ^40.6.0 | Frameless window, contextIsolation: true, nodeIntegration: false |
| UI framework | React | ^19.2.4 | StrictMode enabled |
| UI renderer | ReactDOM | ^19.2.4 | `createRoot` API |
| Language | TypeScript | ^5.9.3 | Strict mode, two tsconfigs |
| Bundler | Vite | ^7.3.1 | With `vite-plugin-electron/simple` for main + preload |
| Database | better-sqlite3 | ^12.6.2 | Synchronous API, WAL mode |

## Build & Dev Tooling

| Tool | Version | Purpose |
|------|---------|---------|
| bun | (system) | Package manager and script runner (NEVER npm/npx) |
| vite-plugin-electron | ^0.29.0 | Builds electron main + preload alongside Vite renderer |
| @electron/rebuild | ^4.0.3 | Recompiles better-sqlite3 for Electron ABI |
| electron-builder | ^26.8.1 | Packaging for distribution |
| @vitejs/plugin-react | ^5.1.4 | React Fast Refresh in dev |

## Code Quality

| Tool | Version | Config File | Purpose |
|------|---------|-------------|---------|
| dprint | ^0.51.1 | `dprint.json` | Formatter (double quotes, semicolons, 2-space indent, 120 line width, trailing commas onlyMultiLine) |
| ESLint | ^10.0.0 | (inline config) | Linter with react-hooks + react-refresh plugins |
| typescript-eslint | ^8.56.0 | (inline config) | TS-aware ESLint rules |
| husky | ^9.1.7 | `.husky/` | Git hooks: pre-commit (fmt:check + lint), pre-push (tests on master/main) |

## Testing

| Tool | Version | Config File | Purpose |
|------|---------|-------------|---------|
| Vitest | ^4.0.18 | `vitest.config.ts` | Unit test runner |
| @testing-library/react | ^16.3.2 | -- | React component testing |
| @testing-library/jest-dom | ^6.9.1 | `src/test/setup.ts` | DOM matchers (toBeInTheDocument, etc.) |
| jsdom | ^28.1.0 | vitest env | Browser simulation for renderer tests |
| sql.js | ^1.14.0 | `src/test/better-sqlite3-shim.ts` | WASM SQLite shim for database tests in Vitest |
| Playwright | ^1.58.2 | -- | E2E tests (requires `bun run build` first) |
| @vitest/coverage-v8 | ^4.0.18 | -- | Code coverage |

## TypeScript Configuration

### Root `tsconfig.json` (solution-style)
- References `tsconfig.main.json` and `tsconfig.renderer.json`
- Common: `strict: true`, `allowImportingTsExtensions: true`, `verbatimModuleSyntax: true`, `noEmit: true`

### `tsconfig.main.json` (Electron + shared)
- `types: ["node"]` (no DOM types)
- Includes: `electron/main`, `electron/preload`, `src/shared`

### `tsconfig.renderer.json` (React + shared + test)
- `lib: ["ESNext", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`
- Includes: `src/renderer`, `src/shared`, `src/test`

## Vite Configuration (`vite.config.ts`)

- Path alias: `@` maps to `src/`
- `vite-plugin-electron/simple` builds:
  - Main: `electron/main/index.ts` -> `dist-electron/main/`
  - Preload: `electron/preload/index.ts` -> `dist-electron/preload/`
- External: all `dependencies` from `package.json` (i.e., `better-sqlite3`, `react`, `react-dom`)
- Dev server port: 5173

## Vitest Configuration (`vitest.config.ts`)

- Default environment: `jsdom` (for renderer tests)
- `environmentMatchGlobs`: `electron/main/**` uses `node` environment
- Alias: `better-sqlite3` -> `src/test/better-sqlite3-shim.ts` (avoids native ABI mismatch)
- Setup file: `src/test/setup.ts` (imports `@testing-library/jest-dom/vitest`)
- Test file pattern: `src/**/*.test.{ts,tsx}` and `electron/**/*.test.{ts,tsx}`

## dprint Configuration (`dprint.json`)

```json
{
  "typescript": {
    "quoteStyle": "alwaysDouble",
    "semiColons": "always",
    "indentWidth": 2,
    "lineWidth": 120,
    "trailingCommas": "onlyMultiLine"
  },
  "includes": ["src/**/*.{ts,tsx}", "*.json"],
  "excludes": ["node_modules", "dist"]
}
```

Note: `electron/` files are NOT covered by dprint currently.