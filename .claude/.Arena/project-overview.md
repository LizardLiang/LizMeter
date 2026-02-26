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

# Project Overview

**Confidence**: High
**Last Verified**: 2026-02-26
**Coverage**: 95% of project files examined

## What is LizMeter?

LizMeter is a full-featured personal productivity Electron desktop application for time tracking. It combines:
- A **Pomodoro timer** (Work / Short Break / Long Break modes) requiring a session title before start
- A **Stopwatch** (free-running elapsed timer, optionally linked to an issue tracker ticket)
- **Session history** (paginated, filterable by tag, with Jira worklog export)
- **Issue tracker integrations** (GitHub, Linear, Jira) - link sessions to tickets
- **Tag management** - create color-coded tags, assign them to sessions, filter by tag
- **Claude Code session tracker** - overlay on Pomodoro or Stopwatch that monitors Claude Code AI activity files
- **Statistics page** for aggregated productivity metrics
- **Settings page** for timer durations, stopwatch config, Claude Code project/idle threshold

The UI uses the Tokyo Night dark theme. Layout is sidebar nav + main content area. All data is stored locally in SQLite via better-sqlite3.

## Application Modes

| Mode | Timer Type | Key Behavior |
|------|-----------|-------------|
| Pomodoro | work / short_break / long_break | Fixed countdown; title required; auto-saves on completion |
| Time-tracking | stopwatch | Elapsed counter; optional issue prompt at start; saved on Stop |

Mode is toggled by `ModeToggle` component. Toggle is disabled while any timer is active.

## Navigation Pages (NavSidebar)

| Page | Key | Components |
|------|-----|-----------|
| Timer | `timer` | TimerView (Pomodoro) or StopwatchView, Claude Code picker/stats, TagPicker |
| History | `history` | HistoryPage (paginated sessions, tag filter, worklog export) |
| Issues | `issues` | IssuesPage (GitHub/Linear/Jira issue browser with provider tabs) |
| Claude | `claude` | ClaudePage (Claude Code project/session tracking config) |
| Stats | `stats` | StatsPage (aggregated metrics) |
| Tags | `tags` | TagsPage / TagManager (CRUD for tags) |
| Settings | `settings` | SettingsPage (timer durations, stopwatch, Claude settings) |

## Repository Coordinates

- **Repo root**: `C:\Users\lizard_liang\personal\PersonalTool\LizMeter`
- **Package manager**: bun (never npm/npx)
- **Entry points**:
  - Electron main: `electron/main/index.ts`
  - Preload: `electron/preload/index.ts`
  - Renderer: `src/renderer/src/main.tsx` (loaded from `index.html`)
- **Root component**: `src/renderer/src/components/TomatoClock.tsx`
- **Database**: `electron/main/database.ts` (better-sqlite3, synchronous API)
- **Shared types**: `src/shared/types.ts` (single source of truth for all cross-process types)
- **IPC handlers**: `electron/main/ipc-handlers.ts`

## E2E Test Status (Key Finding for This Research)

- **Framework**: Playwright `^1.58.2` with `electron-playwright-helpers ^2.1.0` installed
- **Config**: `playwright.config.ts` exists (testDir: `./e2e`, timeout: 30s)
- **Existing tests**: `e2e/app.spec.ts` - 2 stub tests, BROKEN (wrong main process path: `dist/main/index.js` should be `dist-electron/main/index.js`)
- **Script**: `bun run test:e2e` runs `playwright test`
- **Prerequisite**: `bun run build` must complete before E2E tests

## Key Constraints

- Styling: SCSS Modules (`.module.scss` per component) - NOT inline styles (the old architecture.md is outdated on this)
- Named exports only (no default exports from React components)
- All imports use explicit `.ts`/`.tsx` extensions
- dprint for formatting (double quotes, semicolons, 2-space indent, 120-char)
- ESLint for linting
- Husky git hooks: pre-commit runs `fmt:check` + `lint`; pre-push runs tests on master/main
- Session title is required (Start button disabled when title is empty)

## Update History

- **2026-02-26 03:44** (Metis): Major update - codebase has grown significantly since original Arena docs. Added stopwatch, tags, issues, Claude tracker, rich text editor, SCSS modules.