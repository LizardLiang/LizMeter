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

# File Structure

**Confidence**: High
**Last Verified**: 2026-02-26
**Source**: Direct directory listing via ls
**Coverage**: 100% of directories mapped

**NOTE**: Previous version was stale. Current tree reflects all new components, hooks, and E2E setup.

## Full Source Tree (excluding node_modules, dist, dist-electron)

```
LizMeter/   (C:\Users\lizard_liang\personal\PersonalTool\LizMeter)
├── .claude/
│   └── .Arena/                              # Metis research documents
│
├── .husky/
│   ├── pre-commit                           # bun run fmt:check && bun run lint
│   └── pre-push                             # bun run test (only on master/main)
│
├── e2e/
│   └── app.spec.ts                          # Playwright E2E - 2 stub tests (BROKEN - wrong main path)
│
├── electron/
│   ├── main/
│   │   ├── __tests__/
│   │   │   └── database.test.ts             # SQLite unit tests (node environment)
│   │   ├── issue-providers/
│   │   │   ├── github-provider.ts           # GitHub REST API (Octokit)
│   │   │   ├── linear-provider.ts           # Linear GraphQL API (native fetch)
│   │   │   ├── jira-provider.ts             # Jira REST API (native fetch)
│   │   │   ├── token-storage.ts             # Token persistence (per-provider keystore)
│   │   │   ├── types.ts                     # IssueProviderError class
│   │   │   └── index.ts                     # Provider singletons (get/set/setLinear/setJira)
│   │   ├── claude-code-tracker.ts           # Claude Code JSONL file watcher + idle detection
│   │   ├── database.ts                      # All SQLite operations (better-sqlite3, synchronous)
│   │   ├── index.ts                         # Electron main: app lifecycle, createWindow, db init
│   │   └── ipc-handlers.ts                  # Registers ALL ipcMain.handle channels (~40 handlers)
│   └── preload/
│       └── index.ts                         # contextBridge: exposes window.electronAPI
│
├── scripts/
│   └── generate-icons.mjs                   # Icon generation (jimp + png-to-ico)
│
├── src/
│   ├── renderer/
│   │   └── src/
│   │       ├── components/
│   │       │   ├── __tests__/
│   │       │   │   └── SessionTitleInput.test.tsx
│   │       │   ├── ClaudeCodeStats.tsx      # Live Claude Code activity display
│   │       │   ├── ClaudePage.tsx           # Claude Code project/session config page
│   │       │   ├── ClaudeSessionSelect.tsx  # Dropdown to link stopwatch to a Claude session
│   │       │   ├── DateSubGroupHeader.tsx   # Date grouping header in history
│   │       │   ├── HistoryPage.tsx          # Full session history with filters and worklog
│   │       │   ├── IssueBadge.tsx           # Issue link badge (GitHub/Linear/Jira)
│   │       │   ├── IssueGroupHeader.tsx     # Issue grouping header in history
│   │       │   ├── IssuePickerDropdown.tsx  # Issue selector dropdown (multi-provider)
│   │       │   ├── IssuePromptDialog.tsx    # Modal: link issue at stopwatch start
│   │       │   ├── IssuesPage.tsx           # Issues browser (GitHub/Linear/Jira tabs)
│   │       │   ├── ModeToggle.tsx           # Pomodoro / Time-tracking mode switch
│   │       │   ├── NavSidebar.tsx           # 7-button vertical nav sidebar
│   │       │   ├── NewSessionNotification.tsx # Toast when new Claude session detected
│   │       │   ├── ProviderTabs.tsx         # GitHub/Linear/Jira tab switcher
│   │       │   ├── RichTextInput.tsx        # Tiptap-based rich text editor (session title)
│   │       │   ├── SessionHistory.tsx       # Session list container (now inside HistoryPage)
│   │       │   ├── SessionHistoryItem.tsx   # Single session row
│   │       │   ├── SessionPicker.tsx        # Claude Code session multi-select picker
│   │       │   ├── SessionTitleInput.tsx    # Plain text title input (Pomodoro)
│   │       │   ├── SettingsPage.tsx         # All settings (timer, stopwatch, Claude Code)
│   │       │   ├── Sidebar.tsx              # Right sidebar (session history inline)
│   │       │   ├── SidebarToggle.tsx        # Toggle button for sidebar collapse
│   │       │   ├── StatsPage.tsx            # Productivity statistics
│   │       │   ├── StopwatchView.tsx        # Stopwatch UI (RichText title + controls)
│   │       │   ├── TagBadge.tsx             # Color-coded tag chip
│   │       │   ├── TagColorPicker.tsx       # Color swatch picker for tags
│   │       │   ├── TagManager.tsx           # Tag CRUD management UI
│   │       │   ├── TagPicker.tsx            # Multi-tag assign/remove on session
│   │       │   ├── TagsPage.tsx             # Tags page wrapper
│   │       │   ├── TimerControls.tsx        # Start/Pause/Resume/Reset/Dismiss buttons
│   │       │   ├── TimerDisplay.tsx         # MM:SS countdown, editable when idle
│   │       │   ├── TimerTypeSelector.tsx    # Work/Short Break/Long Break toggle
│   │       │   ├── TimerView.tsx            # Full Pomodoro panel
│   │       │   ├── TomatoClock.tsx          # ROOT - all hooks + page routing (~550 lines)
│   │       │   ├── WorklogConfirmDialog.tsx # Jira worklog export confirmation dialog
│   │       │   └── tagColors.ts             # Predefined tag color palette
│   │       ├── hooks/
│   │       │   ├── __tests__/
│   │       │   │   └── timerReducer.test.ts
│   │       │   ├── useClaudeTracker.ts      # Claude Code scan/track/stop/stats lifecycle
│   │       │   ├── useSessionHistory.ts     # Paginated sessions, tag filter, delete, worklog
│   │       │   ├── useSettings.ts           # Timer + stopwatch settings via IPC
│   │       │   ├── useStopwatch.ts          # Stopwatch FSM, elapsed, auto-save
│   │       │   ├── useTagManager.ts         # Tag CRUD via IPC
│   │       │   └── useTimer.ts              # Pomodoro FSM via useReducer, 250ms tick
│   │       ├── utils/
│   │       │   ├── format.ts                # formatTime, formatElapsed, formatTimerType
│   │       │   └── html.ts                  # stripHtml() - extract plain text from Tiptap HTML
│   │       ├── electron-api.d.ts            # Augments Window with electronAPI typing
│   │       └── main.tsx                     # React entry (createRoot + StrictMode)
│   ├── shared/
│   │   └── types.ts                         # SINGLE SOURCE OF TRUTH - all types + ElectronAPI
│   └── test/
│       ├── better-sqlite3-shim.ts           # sql.js WASM shim for Vitest
│       └── setup.ts                         # Vitest setup (@testing-library/jest-dom)
│
├── assets/
│   └── icon.png                             # App icon
│
├── CLAUDE.md                                # Claude Code project instructions
├── dprint.json                              # Formatter config
├── eslint.config.ts                         # ESLint config
├── index.html                               # Vite entry + Tokyo Night CSS vars
├── package.json                             # bun scripts + all dependencies
├── playwright.config.ts                     # Playwright E2E config (testDir: ./e2e)
├── tsconfig.json                            # Solution-style root
├── tsconfig.main.json                       # Electron main + preload + shared
├── tsconfig.renderer.json                   # Renderer + shared + test
├── vite.config.ts                           # Vite + electron plugin config
└── vitest.config.ts                         # Vitest (jsdom + node env + shim alias)
```

## Key File Sizes (for complexity reference)

| File | Lines | Notes |
|------|-------|-------|
| `TomatoClock.tsx` | ~550 | Root orchestrator, most complex |
| `SettingsPage.tsx` | ~800 | Largest settings form |
| `IssuesPage.tsx` | ~500 | Multi-provider issue browser |
| `HistoryPage.tsx` | ~430 | Paginated history |
| `ipc-handlers.ts` | ~475 | All IPC registrations |
| `database.ts` | ~400+ | All SQLite operations |
| `src/shared/types.ts` | ~389 | All shared types |

## Update History

- **2026-02-26 03:44** (Metis): Major rewrite - corrected repo path, added all new components (25+), all new hooks (4 new), E2E directory, issue-providers/ directory, scripts/. Previous version predated tags, issues, stopwatch, Claude tracker features.