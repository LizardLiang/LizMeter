# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Issue Tracker Integration |
| **Author** | Athena (PM Agent) |
| **Status** | Draft |
| **Date** | 2026-02-22 |
| **Version** | 1.0 |

---

## 1. Executive Summary

LizMeter is a Pomodoro timer app that tracks focused work sessions. Currently, sessions have a free-text title and optional tags but no link to external work items. Users who manage tasks in GitHub Issues must manually copy issue titles and cannot later correlate sessions to specific issues.

This feature adds a **GitHub Issues integration**: users can browse assigned issues in a new Issues page, select an issue from the Timer page before starting a session, and see the linked issue in session history. The integration is read-only — no data is posted back to GitHub. A **provider abstraction layer** is designed from the start so Linear can be added in a future iteration without rearchitecting.

API credentials are managed via a Settings page text input, encrypted with Electron's `safeStorage` API, and stored in SQLite. The raw token never reaches the renderer process.

---

## 2. Problem Statement

### Current Situation
Sessions are recorded with a manual title. There is no connection to actual tracked issues. Users cannot answer "how much time did I spend on issue #42?" or quickly start a session for a specific issue without leaving the app to look it up.

### Target Users
| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Solo developer | Individual using GitHub Issues for personal/OSS project work | Link sessions to issues for personal time awareness |
| Team developer | Developer on a small team using GitHub Issues for sprint work | Quick-select an issue before starting a focus session |

### Pain Points
1. **Manual data entry** — Copying issue titles is tedious and error-prone
2. **No traceability** — Cannot query "sessions for issue #42" without manual review
3. **Context switching** — Must open the browser to find an issue, then return to the app

---

## 3. Goals & Success Metrics

### Business Goals
- Connect Pomodoro sessions to real tracked work items
- Establish an extensible provider architecture for future integrations (Linear)
- Keep users in LizMeter during the focus workflow

### Success Metrics
| Metric | Current | Target |
|--------|---------|--------|
| Sessions linked to an issue | 0% | 40%+ of sessions (users with configured token) |
| Time to start a linked session | Manual copy-paste | Under 15 seconds from opening picker to starting timer |
| Token setup completion rate | N/A | 90%+ of users who open the settings field |

### Out of Scope (MVP)
- Linear integration (architected for, not implemented)
- OAuth / GitHub App authentication (PAT only in MVP)
- Posting back to GitHub (no comments, time logs, or status changes)
- Issue creation or editing from LizMeter
- Multi-account support (one token per installation)
- Webhooks or real-time sync

---

## 4. Requirements

### P0 — Must Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-001 | GitHub PAT entry in Settings | As a user, I want to paste my GitHub Personal Access Token in Settings so LizMeter can access my issues | Given the Settings page, when the user pastes a token and clicks Save, the token is encrypted via `safeStorage` and stored in SQLite; the raw token never reaches the renderer |
| FR-002 | Token validation | As a user, I want to know if my token is valid when I save it | Given a saved token, when the user saves or clicks Verify, LizMeter calls `GET /user` and shows a success indicator (username) or clear error |
| FR-003 | Issues page — list assigned issues | As a user, I want a dedicated Issues page to browse my GitHub issues | Given a valid token, when the user navigates to the Issues page, a list shows: issue number, title, repository name, labels, open/closed state |
| FR-004 | Issues page navigation | As a user, I want to reach the Issues page from the navigation sidebar | Given the app is running, a new "Issues" nav item is visible in NavSidebar and navigates to the Issues page |
| FR-005 | Timer page — issue picker | As a user, I want to select a GitHub issue on the Timer page before starting a session | Given a valid token, when the user clicks the issue picker on the Timer page, a searchable list of assigned issues appears; selecting one shows the issue reference next to the session title |
| FR-006 | Session–issue linking | As a user, I want the linked issue saved with my session | Given an issue is selected when a session completes, the session record stores: `issue_provider`, `issue_id`, `issue_number`, `issue_title`, `issue_url` |
| FR-007 | History page — display linked issue | As a user, I want to see which issue a past session was linked to | Given the History page, sessions with a linked issue show the issue number and title; clicking it opens the issue URL in the default browser |
| FR-008 | No-token graceful state | As a user without a configured token, I want clear setup guidance | Given no token is configured, the Issues page shows an empty state with instructions and a link to Settings; the Timer page issue picker is hidden |

### P1 — Should Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-010 | Issue search / filter | As a user, I want to search the issue list by title or number | Given the issue list, typing in the search field filters results client-side |
| FR-011 | Repository filter | As a user, I want to filter by repository | Given the issue list, selecting a repo from a dropdown shows only that repo's issues |
| FR-012 | Unlink issue from Timer | As a user, I want to remove a selected issue before starting | Given a selected issue on the Timer page, a clear button removes the selection; the session will be saved without an issue link |
| FR-013 | Token removal | As a user, I want to delete my stored token | Given the Settings page, clicking "Remove token" deletes the encrypted record and disables all issue UI |

### P2 — Nice to Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-020 | Time-per-issue summary | On the Issues page, show total session count and duration for issues that have linked sessions |
| FR-021 | Recent issues shortlist | Timer page issue picker shows the 5 most recently linked issues at the top before the full list |
| FR-022 | Issue list refresh | A manual refresh button re-fetches issues from the GitHub API |

### Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| **Security** | Token encrypted via `electron.safeStorage.encryptString()` before persistence; token MUST NOT transit to the renderer process; all GitHub API calls happen in the main process only |
| **Security** | Required PAT scope: `repo` (private repos) or `public_repo` (public only) |
| **Performance** | Issue list fetch completes in under 3 seconds on a typical connection; UI shows loading spinner during fetch |
| **Performance** | Issue picker on Timer page opens in under 200ms |
| **Graceful degradation** | No configured token → friendly setup prompt, never an error state; timer workflow is fully unaffected |
| **Graceful degradation** | GitHub API failure → clear error message, user can still start an unlinked session |
| **Graceful degradation** | If a linked issue is later deleted on GitHub, the stored snapshot (title + URL) is preserved in session history |
| **Extensibility** | All GitHub-specific logic sits behind an `IssueProvider` TypeScript interface; adding Linear requires only a new provider implementation |

---

## 5. User Flows

### Flow 1: Configure GitHub Token
```
1. User opens Settings page via NavSidebar
2. User sees "Issue Tracker" section with a GitHub PAT text input
3. User pastes token and clicks Save
4. Main process encrypts via safeStorage, stores in SQLite
5. Main process calls GET /user to validate
6. UI shows GitHub username on success, or error message on failure
7. Issue features are now enabled
```

### Flow 2: Browse Issues (Issues Page)
```
1. User clicks "Issues" in NavSidebar
2. If no token → show setup prompt with link to Settings
3. If token configured → fetch assigned issues from GitHub (main process)
4. Loading spinner shown during fetch
5. Issue list renders: #number, title, repo name, labels, state
6. User can filter by repo or search by text (P1)
7. Clicking an issue opens GitHub URL in default browser
```

### Flow 3: Link Issue Before Starting Timer
```
1. User is on the Timer page
2. User clicks the issue picker button (near the session title)
3. Searchable dropdown/popover shows assigned issues
4. User selects an issue → issue #number and title appear on Timer page
5. User starts the timer normally
6. On session save: issue_provider, issue_id, issue_number, issue_title, issue_url stored with session
```

### Flow 4: View Linked Issues in History
```
1. User opens History page
2. Sessions with linked issues show: "#42 Fix login bug" (clickable)
3. Clicking opens issue_url in default browser
4. Sessions without linked issues display unchanged
```

### Error Flows
- **Invalid token**: Settings shows "Invalid token — check that it has the `repo` scope"
- **Network error**: Issues page shows "Unable to reach GitHub. Check your connection." with Retry
- **Rate limit**: Shows "GitHub API rate limit reached. Try again in X minutes."
- **Token revoked** (on next API call): Issue UI shows error, prompts user to update token in Settings

---

## 6. Dependencies & Risks

### Dependencies
| Dependency | Impact |
|------------|--------|
| GitHub REST API v3 | Core data source; requires network and valid PAT |
| Electron `safeStorage` API | Token encryption; available since Electron 15 |
| `better-sqlite3` | Sessions table needs new nullable columns |
| `NavSidebar.tsx` | Needs a new "Issues" nav entry |
| `App.tsx` page routing | Needs a new `"issues"` page state value |

### Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Token leakage to renderer | Low | High | Enforce in IPC design: all API calls in main; preload exposes results only, never the token |
| DB schema migration breaks existing sessions | Medium | High | ALTER TABLE ADD COLUMN (SQLite-safe); new columns nullable; existing sessions unaffected |
| safeStorage unavailable on some Linux DEs | Low | Medium | Detect availability; warn user if falling back to unencrypted storage |
| Provider abstraction over-engineered | Medium | Medium | Keep interface minimal: 4–5 methods; no plugin registry needed |

---

## 7. Open Questions

| Question | Status |
|----------|--------|
| Should issue picker show issues from repos the user is not assigned to (collaborator repos)? | Open |
| Manual refresh only or auto-refresh when Issues page is focused? | Open — recommend manual for MVP |
| Should selecting an issue auto-fill the session title with the issue title? | Open — recommend yes as opt-in |

---

## 8. GitHub API Reference

| Aspect | Details |
|--------|---------|
| Base URL | `https://api.github.com` |
| Auth header | `Authorization: Bearer <token>` |
| Key endpoints | `GET /user`, `GET /issues` (assigned across repos), `GET /repos/{owner}/{repo}/issues` |
| Required scopes | `repo` (private) or `public_repo` (public only) |
| Rate limits | 5,000 req/hr authenticated |
| Pagination | `per_page` (max 100), `page` params; `Link` response header |
| Issue object fields | `id`, `number`, `title`, `state`, `labels[]`, `html_url`, `repository_url`, `assignee` |
| Note | `/issues` endpoint returns PRs too; filter by absence of `pull_request` key |

---

## 9. Architecture Notes (for Tech Spec)

### IssueProvider Interface
Define a TypeScript interface with methods:
- `validateToken()` → `{ valid: boolean; username?: string }`
- `listIssues(filters)` → `Issue[]`
- `listRepositories()` → `Repository[]`

`GitHubProvider` implements this for MVP. `LinearProvider` will implement it later without touching UI or session code.

### New IPC Channels Needed
| Channel | Purpose |
|---------|---------|
| `issues:fetch` | Fetch assigned issues from configured provider |
| `issues:validate-token` | Validate a token and return username |
| `issues:save-token` | Encrypt and persist token |
| `issues:remove-token` | Delete stored token |
| `issues:get-status` | Return `{ configured: boolean; provider: string }` — never the token |

### Session Table Changes
Add nullable columns to `sessions`:
- `issue_provider TEXT` (e.g. `"github"`)
- `issue_id TEXT`
- `issue_number INTEGER`
- `issue_title TEXT`
- `issue_url TEXT`

These are snapshots — not updated if the issue changes on GitHub after linking.

### Navigation
`App.tsx` `page` state adds `"issues"`. `NavSidebar.tsx` adds a new nav item.