# GitHub Issues Integration — Full Pattern Analysis

**Author**: Metis | **Date**: 2026-02-23

---

## 1. Complete File Inventory

| File | Role |
|------|------|
| `src/shared/types.ts` | Type definitions: `GitHubIssue`, `ElectronAPI` issue methods |
| `electron/main/github.ts` | GitHub API client (fetch issues, test connection) |
| `electron/main/database.ts` | SQLite schema: `issue_number` column on `sessions` table |
| `electron/main/ipc-handlers.ts` | IPC channel registration for `github:*` channels |
| `electron/preload/index.ts` | Exposes `github*` methods on `window.electronAPI` |
| `src/renderer/components/IssuesSidebar.tsx` | Full-page issues browser panel |
| `src/renderer/components/IssueSelector.tsx` | Dropdown for linking an issue to a session |
| `src/renderer/components/CompletionActions.tsx` | Session save form (uses IssueSelector) |
| `src/renderer/components/SettingsPanel.tsx` | GitHub token + repo configuration UI |
| `src/renderer/components/Sidebar.tsx` | Navigation sidebar (has Issues tab) |
| `src/renderer/components/TomatoClock.tsx` | Main orchestrator (passes selectedIssue state) |
| `src/renderer/components/HistoryPage.tsx` | Displays `issue_number` in session history |
| `src/renderer/App.tsx` | Top-level routing between views |

---

## 2. Core Pattern

- **No local issue cache** — Issues fetched live from GitHub API each time a component mounts
- **Only store the reference** — Session stores just `issue_number` (integer), not the full issue object
- **Settings loaded per-component** — No shared context/provider; each component reads settings via IPC
- **State ownership in TomatoClock** — `selectedIssue` state lives in TomatoClock, passed to both browse and save components
- **Inline styles only** — All UI uses `React.CSSProperties` objects, no CSS files
- **Tokyo Night theme** — Colors reference CSS variables defined in `index.html`

---

## 3. IPC Channel Convention

- Channel naming: `namespace:action` kebab-case (e.g., `github:fetch-issues`)
- Preload method naming: camelCase prefixed with service name (`githubFetchIssues`)
- Two channels: `github:fetch-issues`, `github:test-connection`

---

## 4. Database Schema

`sessions` table has `issue_number INTEGER DEFAULT NULL` with migration for existing DBs.
`settings` table stores `github_token`, `github_owner`, `github_repo` as key-value pairs.

---

## 5. Linear Integration Mapping

| Aspect | GitHub Pattern | Linear Equivalent |
|--------|---------------|-------------------|
| API client | `electron/main/github.ts` (REST) | `electron/main/linear.ts` (GraphQL) |
| Types | `GitHubIssue` | `LinearIssue` |
| IPC channels | `github:fetch-issues`, `github:test-connection` | `linear:fetch-issues`, `linear:test-connection` |
| Preload | `githubFetchIssues`, `githubTestConnection` | `linearFetchIssues`, `linearTestConnection` |
| Settings keys | `github_token`, `github_owner`, `github_repo` | `linear_token`, `linear_team_id` |
| DB schema | `issue_number INTEGER` | `linear_issue_id TEXT` (Linear IDs are strings) |
| Browse UI | `IssuesSidebar.tsx` | Update to support both providers |
| Link UI | `IssueSelector.tsx` | Update to support both providers |
| Settings UI | SettingsPanel GitHub section | Add Linear section |

### Linear API Differences
- **GraphQL API** (not REST)
- **Single API key** authentication (no owner/repo split)
- Issues scoped to **teams** (not repos)
- Issue identifiers are strings like `LIN-42` (not integers)
- Has priority, status, assignee, project fields
- No PR contamination issue