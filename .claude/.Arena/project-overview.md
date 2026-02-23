# Project Overview

## What is LizMeter?

LizMeter is a desktop Pomodoro/Tomato Clock application built with Electron + React 19 + TypeScript. It provides a timer with three modes (Work, Short Break, Long Break), session tracking with persistence to a local SQLite database, and a session history view. The UI uses a Tokyo Night dark color theme with a custom frameless window and title bar.

## Current Feature Set

1. **Tomato Clock Timer** -- A countdown timer with three modes:
   - Work (default 25 min / 1500s)
   - Short Break (default 5 min / 300s)
   - Long Break (default 15 min / 900s)
   - Editable duration (click the MM:SS display when idle to type a custom time)

2. **Session Tracking** -- When a timer completes, the session is automatically saved to SQLite with:
   - A user-entered title (optional, max 500 chars)
   - Timer type (work/short_break/long_break)
   - Planned vs. actual duration in seconds
   - Completion timestamp (ISO 8601)

3. **Session History** -- A scrollable list below the timer showing past sessions with:
   - Title, timer type badge, planned duration, completion timestamp
   - Delete button per session
   - Paginated loading (50 per page)

4. **Persistent Settings** -- Timer durations are stored in SQLite and loaded on app start. Settings are editable (durations must be 60--7200 seconds).

5. **Custom Title Bar** -- Frameless Electron window with a custom HTML/CSS title bar providing minimize, maximize, and close buttons.

## Upcoming Features (Context for This Research)

The team is about to build:
- **Session tagging** -- Add/remove tags on sessions (new database tables, new IPC channels, new UI components)
- **Sidebar layout** -- A sidebar showing the current session, session history, and tag management (restructuring the current single-column layout)

## Repository Coordinates

- **Repo root**: `D:/Programing/React/LizMeter`
- **Package manager**: bun (never npm/npx)
- **Entry points**:
  - Electron main: `electron/main/index.ts`
  - Preload: `electron/preload/index.ts`
  - Renderer: `src/renderer/src/main.tsx` (loaded from `index.html`)
- **Database**: `electron/main/database.ts` (better-sqlite3, synchronous API)
- **Shared types**: `src/shared/types.ts` (single source of truth for all cross-process types)

## Key Constraints

- All styling is inline `React.CSSProperties` -- no CSS files or CSS-in-JS libraries (except global styles in `index.html`)
- Named exports only (no default exports from React components)
- All imports use explicit `.ts`/`.tsx` extensions
- dprint for formatting (double quotes, semicolons, 2-space indent, 120-char line width)
- ESLint for linting
- Husky git hooks: pre-commit runs `fmt:check` + `lint`; pre-push runs tests on master/main