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

# Coding Conventions

**Confidence**: High
**Last Verified**: 2026-02-26
**Source**: CLAUDE.md, dprint.json, vitest.config.ts, source code inspection
**Coverage**: 80% of codebase examined

**IMPORTANT CORRECTION**: The previous version stated "ALL styling is done via inline React.CSSProperties". This is WRONG for the current codebase. The project has migrated to **SCSS Modules** (`.module.scss` files per component). Every component now has a corresponding `.module.scss` file and uses `className={styles.foo}`.

## Code Style & Formatting

### dprint (Formatter)

Config in `dprint.json`:

- **Quote style**: Always double quotes (`"alwaysDouble"`)
- **Semicolons**: Always required
- **Indent**: 2 spaces
- **Line width**: 120 characters
- **Trailing commas**: Only on multi-line expressions (`"onlyMultiLine"`)
- **Scope**: `src/**/*.{ts,tsx}` and `*.json` (electron/ files are NOT covered)

Run `bun run fmt` to auto-format, `bun run fmt:check` for read-only check (used in pre-commit).

### ESLint

Run `bun run lint`. Covers `src/` and `electron/`.
Plugins: `react-hooks`, `react-refresh`, `typescript-eslint`.

### Git Hooks (Husky)

- **Pre-commit**: `bun run fmt:check` + `bun run lint`
- **Pre-push**: `bun run test` (only on master/main branch)

---

## TypeScript Conventions

### Import Style
- All imports use **explicit `.ts` / `.tsx` extensions** (enforced by `allowImportingTsExtensions` + `verbatimModuleSyntax`)
- Use `import type` for type-only imports (enforced by `verbatimModuleSyntax`)

```typescript
// CORRECT
import { useTimer } from "../hooks/useTimer.ts";
import type { TimerSettings } from "../../../shared/types.ts";

// WRONG
import { useTimer } from "../hooks/useTimer";
import { TimerSettings } from "../../../shared/types";
```

### Export Style
- **Named exports only** -- no default exports from React components
- Exception: the better-sqlite3 shim uses `export default` (it mimics a CJS module)

```typescript
// CORRECT
export function SessionHistory() { ... }

// WRONG
export default function SessionHistory() { ... }
```

### Type Location
- All types shared between processes live in `src/shared/types.ts`
- Component-local interfaces (props) are defined in the same file as the component
- Hook return types are defined in the same file as the hook

---

## React Conventions

### Component Structure
- Functional components with hooks only
- Props interface defined above the component function in the same file
- No `React.FC` -- plain function declarations

```typescript
interface MyComponentProps {
  value: string;
  onChange: (value: string) => void;
}

export function MyComponent({ value, onChange }: MyComponentProps) {
  // ...
}
```

### Styling -- SCSS Modules (CURRENT)

All styling uses **SCSS Modules** (`.module.scss` file per component). Components import the module and use `className={styles.foo}`.

```typescript
import styles from "./MyComponent.module.scss";

export function MyComponent() {
  return (
    <div className={styles.container}>
      <span className={styles.text}>Hello</span>
    </div>
  );
}
```

Each component has a paired `.module.scss` file (e.g., `TimerView.tsx` + `TimerView.module.scss`). The Tokyo Night color variables are available via CSS custom properties defined in `index.html` (e.g., `var(--tn-bg)`, `var(--tn-blue)`).

### State Management
- `useState` for simple local state
- `useReducer` for complex state machines (see `useTimer.ts`)
- No external state libraries (no Redux, Zustand, Jotai, etc.)
- Cross-component communication via prop drilling from `TomatoClock.tsx`
- Data fetching via custom hooks that call `window.electronAPI`

### Hook Patterns
- Refresh-by-token pattern: increment a counter to trigger `useEffect` re-fetch (see `useSessionHistory.ts`)
- Custom hooks return a typed interface (e.g., `UseTimerReturn`)
- Side effects (IPC calls) happen inside `useEffect` with appropriate deps

---

## Tokyo Night Dark Theme

CSS variables defined in `index.html`:

| Variable | Value | Usage |
|----------|-------|-------|
| `--tn-bg` | `#1a1b2e` | App background |
| `--tn-panel` | `#16213e` | Panel/card backgrounds, session list bg |
| `--tn-surface` | `#1f2335` | Surface/card backgrounds, timer panel bg |
| `--tn-border` | `#292e42` | Borders, dividers |
| `--tn-text` | `#c0caf5` | Primary text |
| `--tn-text-dim` | `#a9b1d6` | Secondary text, labels |
| `--tn-muted` | `#565f89` | Muted text, placeholders, empty states |
| `--tn-blue` | `#7aa2f7` | Primary accent, "Work" type color |
| `--tn-purple` | `#bb9af7` | "Long Break" type color |
| `--tn-green` | `#9ece6a` | "Short Break" type color, success state |
| `--tn-yellow` | `#e0af68` | Warning/paused state |
| `--tn-red` | `#f7768e` | Danger/error/delete actions |

### Color Usage in Components (use raw hex values, not CSS vars, since inline styles cannot access CSS vars)

- **Timer type accent colors**:
  - Work: `#7aa2f7` (blue)
  - Short Break: `#9ece6a` (green)
  - Long Break: `#bb9af7` (purple)
- **Timer type badge**: Background `{accent}22` (accent with 13% opacity), border `{accent}66`, text color = accent
- **Timer panel**: Container border uses `{accent}33`, box-shadow uses `{accent}18`
- **Buttons**: Styled per semantic role:
  - Primary (Start/Resume): blue `#7aa2f7` border + `#7aa2f722` bg
  - Warning (Pause): yellow `#e0af68`
  - Danger (Reset/Delete): red `#f7768e`
  - Success (New Session): green `#9ece6a`
- **Session history list**: `#16213e` bg, `#292e42` borders, `#c0caf5` text
- **Disabled state**: `opacity: 0.3`, `cursor: "not-allowed"` or `opacity: 0.4`
- **Error messages**: `#f7768e` text, `#f7768e11` bg, `#f7768e44` border

### UI Dimensions & Spacing
- App max-width: 640px, centered
- Container padding: 24px 16px
- Card border-radius: 8-12px
- Button border-radius: 8px (actions) or 20px (pill-shaped selectors)
- Font sizes: headings 1.5rem, body 0.9375rem, small/meta 0.8125rem, tiny 0.75rem
- Section gaps: 20-24px
- Session list max-height: 300px (scrollable)

---

## Testing Conventions

### Database Tests (`electron/main/__tests__/`)
- Use `// @vitest-environment node` directive at top
- `beforeEach(() => initDatabase(":memory:"))` and `afterEach(() => closeDatabase())`
- Test IDs follow pattern: `TC-3xx` for database, `TC-4xx` for performance
- Import directly from `../database.ts` (no IPC layer)

### Renderer Component Tests (`src/renderer/src/components/__tests__/`)
- Use jsdom environment (default)
- Mock `window.electronAPI` via `vi.stubGlobal` before each test
- Use `@testing-library/react` for rendering and queries
- Use `@testing-library/jest-dom` matchers

### Hook Tests (`src/renderer/src/hooks/__tests__/`)
- Mock `window.electronAPI` via `vi.stubGlobal`
- Test reducer logic directly by importing `timerReducer` and `getInitialTimerState`
- Test hooks via `renderHook` from `@testing-library/react`

### Test File Naming
- Tests live alongside source in `__tests__/` directories
- Name: `{SourceFileName}.test.{ts,tsx}`

### Running Tests
```bash
bun run test              # All tests, single run
bun run test:watch        # Watch mode
bun vitest run path/to/file.test.ts  # Single file
```

---

## Naming Conventions

- **Files**: camelCase for hooks/utils (`useTimer.ts`, `format.ts`), PascalCase for components (`TimerView.tsx`)
- **Components**: PascalCase function names, named exports
- **Hooks**: `use` prefix, camelCase (`useTimer`, `useSettings`)
- **Types/Interfaces**: PascalCase (`TimerState`, `SessionHistoryProps`)
- **Constants**: UPPER_SNAKE_CASE for true constants (`MIN_DURATION`, `MAX_TITLE_LENGTH`, `VALID_TIMER_TYPES`), camelCase for computed style objects (`containerStyle`, `primaryButton`)
- **IPC channels**: `domain:action` format (`session:save`, `settings:get`)
- **Database columns**: `snake_case` (`timer_type`, `completed_at`)
- **TypeScript fields**: `camelCase` (`timerType`, `completedAt`)
- **SQL column aliases**: `SELECT timer_type as timerType` -- map snake_case to camelCase in SELECT statements

---

## Package Manager

**Always use `bun`**, never `npm` or `npx`. Scripts:

```bash
bun run dev              # Dev server + Electron
bun run build            # Production build
bun run test             # Vitest single run
bun run test:watch       # Vitest watch
bun run test:e2e         # Playwright E2E (requires bun run build first)
bun run lint             # ESLint
bun run fmt              # dprint format
bun run fmt:check        # dprint check
bun run rebuild          # Recompile better-sqlite3 for Electron ABI
```

## Session Title Input Conventions

- **Pomodoro mode**: Uses `SessionTitleInput` (plain text input) - stores as plain string
- **Stopwatch mode**: Uses `RichTextInput` (Tiptap rich text editor) - stores HTML
- `stripHtml()` utility in `src/renderer/src/utils/html.ts` extracts plain text from Tiptap HTML
- Start button is disabled when `stripHtml(title).trim() === ""` (both modes require non-empty title)

## E2E Testing Conventions (NEW)

- Framework: Playwright with `electron-playwright-helpers`
- Tests live in `e2e/` at project root
- Must `bun run build` before running `bun run test:e2e`
- Launch Electron app via `electron.launch({ args: ["dist-electron/main/index.js"] })`
- Use `app.firstWindow()` to get the renderer window
- Config: `playwright.config.ts` (testDir: `./e2e`, timeout: 30s, retries: 0)

## Update History

- **2026-02-26 03:44** (Metis): Added frontmatter, corrected styling section (SCSS Modules not inline styles), added SessionTitleInput conventions, added E2E testing conventions, added test:e2e to package manager scripts.