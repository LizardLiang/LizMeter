# Implementation Notes — Issue Tracker Integration

## Summary

Feature implemented per tech-spec.md with all SA review corrections applied.

- **Date**: 2026-02-22
- **Tests**: 92/92 passing
- **TypeScript**: 0 new errors introduced
- **Lint**: 0 new errors (2 pre-existing in StatsPage + TagPicker not touched)
- **Format**: dprint clean

---

## New Files Created (10)

| File | Purpose |
|------|---------|
| `electron/main/issue-providers/types.ts` | `IssueProvider` interface + `IssueProviderError` |
| `electron/main/issue-providers/token-storage.ts` | safeStorage encrypt/decrypt/delete/check |
| `electron/main/issue-providers/github-provider.ts` | `GitHubProvider` using @octokit/rest v20 |
| `electron/main/issue-providers/index.ts` | Provider singleton manager |
| `src/renderer/src/hooks/useIssues.ts` | Issues list + provider status hook |
| `src/renderer/src/components/IssuesPage.tsx` | Issues browser page (5 states) |
| `src/renderer/src/components/IssuesPage.module.scss` | Styles |
| `src/renderer/src/components/IssuePickerDropdown.tsx` | Timer-area issue picker dropdown |
| `src/renderer/src/components/IssuePickerDropdown.module.scss` | Styles |

---

## Modified Files (14)

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Added `Issue`, `IssueLabel`, `IssueProviderStatus`, input/result types; extended `Session`, `SaveSessionInput`, `ElectronAPI` |
| `electron/main/database.ts` | Idempotent migration via `prepare("PRAGMA table_info").all()`; extended INSERT + SELECT + SessionRow |
| `electron/main/ipc-handlers.ts` | 5 new handlers: `issues:list/provider-status/set-token/delete-token`, `shell:open-external` |
| `electron/preload/index.ts` | Exposed `issues` + `shell` namespaces via contextBridge |
| `electron/main/index.ts` | Added `initProviderFromDisk()` after `registerIpcHandlers()` in app.whenReady() |
| `src/renderer/src/components/NavSidebar.tsx` | Added `"issues"` to `NavPage` union; added nav item with IssuesIcon |
| `src/renderer/src/components/TimerView.tsx` | Added `selectedIssue`/`onIssueSelect` props; renders `IssuePickerDropdown` |
| `src/renderer/src/components/TimerView.module.scss` | Added `.issuePickerRow` |
| `src/renderer/src/components/TomatoClock.tsx` | Added `pendingIssue` state; `handleReset`; `handleIssueSelect`; wired to useTimer; renders IssuesPage |
| `src/renderer/src/components/HistoryPage.tsx` | Issue badge (button) on session cards; calls `shell.openExternal` |
| `src/renderer/src/components/HistoryPage.module.scss` | Added `.issueLink` style |
| `src/renderer/src/components/SettingsPage.tsx` | GitHub token section (configured/unconfigured states) |
| `src/renderer/src/components/SettingsPage.module.scss` | Added token section styles |
| `src/renderer/src/hooks/useTimer.ts` | Added `pendingIssue` param (ref pattern); included in session:save payload |

---

## SA Review Corrections Applied

| # | Finding | Fix |
|---|---------|-----|
| 1 | `initProviderFromDisk()` never called at startup | Added call after `registerIpcHandlers()` in `electron/main/index.ts` |
| 2 | `@octokit/rest` ESM/CJS incompatibility | Pinned to `@octokit/rest@^20` (v20.1.2, last CJS-compatible) |
| 3 | `loadToken()` missing try/catch | Wrapped `safeStorage.decryptString()` in try/catch, returns `null` on failure |
| 4 | `useIssues` infinite re-render | Used `JSON.stringify(input)` as stable `useEffect` dependency |
| 5 | `@me` assignee for repo-scoped queries | `getUsername()` caches `authenticatedUsername` in `GitHubProvider` |

---

## Key Implementation Decisions

- **Migration approach**: Used `prepare("PRAGMA table_info(sessions)").all()` instead of `db.pragma()` because the sql.js Vitest shim returns `null` from `pragma()`. The `prepare().all()` path works in both production and tests.
- **`pendingIssue` state**: Lives in `TomatoClock`, passed to `useTimer` via 3rd param (ref pattern, same as `onSaved`). Cleared on reset (via `handleReset` wrapper) and after save (in `handleSessionSaved` callback).
- **Title auto-fill**: `handleIssueSelect` in TomatoClock sets title to issue title only when title is currently empty. User can override before starting.
- **Token never crosses IPC back**: Raw PAT sent once via `issues:set-token`, encrypted immediately; no handler ever returns the token to renderer.
- **`shell.openExternal` validation**: Only `http://` and `https://` URLs pass; prevents `file://` injection.