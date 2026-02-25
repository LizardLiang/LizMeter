# Technical Specification

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Linear Integration |
| **Author** | Hephaestus (Tech Spec Agent) |
| **Status** | Draft |
| **Date** | 2026-02-23 |
| **PRD Version** | 1.0 |

---

## 1. Overview

### Summary
Add Linear as a second issue-tracking provider alongside the existing GitHub integration. Users will configure a Linear API key and team in Settings, browse Linear issues in the Issues page, and link Linear issues to pomodoro sessions. The architecture evolves from a single-provider model to a multi-provider model where GitHub and Linear can be configured and used simultaneously.

### Goals
- Implement a `LinearProvider` class following the existing `IssueProvider` interface pattern
- Extend the database schema to store Linear issue references alongside existing GitHub references
- Add provider-aware IPC channels for Linear token management, team selection, and issue fetching
- Update the renderer UI (IssuesPage, IssuePickerDropdown, SettingsPage, SessionHistoryItem) to support switching between providers
- Maintain full backward compatibility with existing GitHub-linked sessions

### Non-Goals
- Creating or updating Linear issues from LizMeter (read-only)
- Linear OAuth2 flow (API key only for v1)
- Syncing time data back to Linear
- Supporting multiple Linear teams simultaneously (one team at a time)
- Abstracting a generic "provider plugin" system (premature for 2 providers)

---

## 2. Architecture

### System Context
```
Renderer (React 19)
  |
  |-- useIssues(provider)  -- fetches from active provider
  |-- IssuesPage           -- tabs: GitHub | Linear
  |-- IssuePickerDropdown  -- tabs: GitHub | Linear
  |-- SettingsPage         -- separate sections for GitHub and Linear config
  |
  v (IPC via contextBridge)
Preload
  |
  v
Main Process
  |-- issue-providers/
  |     |-- index.ts           -- multi-provider registry (github + linear)
  |     |-- github-provider.ts -- existing, unchanged
  |     |-- linear-provider.ts -- NEW: Linear GraphQL client
  |     |-- token-storage.ts   -- parameterized by provider name
  |     |-- types.ts           -- extended IssueProvider interface
  |
  |-- database.ts              -- new columns: issue_provider, issue_id (TEXT)
  |-- ipc-handlers.ts          -- new linear:* channels + refactored issues:* channels
```

### Component Diagram
```
+------------------+     IPC      +-------------------+     GraphQL    +------------------+
|   IssuesPage     | -----------> | ipc-handlers.ts   | ------------> | api.linear.app   |
|   (tabs: GH/LN)  |             |                   |               |                  |
+------------------+             |  LinearProvider    |               +------------------+
                                  |  GitHubProvider    |
+------------------+             |                   |     REST       +------------------+
| IssuePickerDD    | -----------> |  token-storage    | ------------> | api.github.com   |
| (tabs: GH/LN)    |             |  (per-provider)   |               |                  |
+------------------+             +-------------------+               +------------------+
                                        |
+------------------+                    |
|  SettingsPage    | ------------------>|
|  (GH + LN)       |                    v
+------------------+             +-------------------+
                                  |  database.ts      |
                                  |  sessions table   |
                                  +-------------------+
```

### Key Design Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| **Raw `fetch` with GraphQL** instead of `@linear/sdk` | The SDK is 2.5 MB, pulls in many transitive dependencies, and risks CJS/ESM compatibility issues in Electron's main process. We only need 4 queries (viewer, teams, issues, search). Raw fetch with typed response interfaces is lighter and more controllable. | `@linear/sdk` -- heavier, potential Electron bundling issues |
| **Add `issue_provider TEXT` + `issue_id TEXT` columns** instead of separate `linear_issue_id` | Generic provider+id columns scale to future providers (Jira, Asana) without schema changes. The existing `issue_number INTEGER` column is preserved for backward compatibility -- old sessions keep working. New sessions use the new columns. | Separate `linear_issue_id TEXT` column -- does not scale, creates column sprawl |
| **Tabs** for multi-provider browsing | Tabs provide instant switching without dropdown interaction overhead. With only 2 providers, tabs are cleaner than a dropdown. Tabs are visible at a glance showing what is available. | Dropdown -- adds a click, hides available providers |
| **Union type `IssueRef`** for issue references | A discriminated union (`{ provider: "github"; number: number }` vs `{ provider: "linear"; identifier: string }`) preserves type safety while handling GitHub's numeric IDs and Linear's string identifiers. | Single `issueId: string` -- loses type safety for GitHub's numeric IDs |
| **Per-provider token files** (`.github-token`, `.linear-token`) | Follows the existing pattern, minimal change to token-storage.ts. Each provider has its own encrypted file. | Single token store with key prefixes -- more complex, no benefit for 2 providers |
| **Provider registry object** instead of singleton | Replace single `currentProvider` with a `Map<string, IssueProvider>` so both providers can be active simultaneously, as required by the multi-provider UI. | Keep singleton, switch on demand -- breaks requirement for simultaneous browsing |

---

## 3. Data Model

### Database Schema Changes

```sql
-- Migration: Add generic issue provider columns to sessions table
-- Existing issue_number, issue_title, issue_url columns are PRESERVED for backward compat

ALTER TABLE sessions ADD COLUMN issue_provider TEXT;
-- Values: "github" | "linear" | NULL (legacy sessions without provider tag)

ALTER TABLE sessions ADD COLUMN issue_id TEXT;
-- GitHub: stores the issue number as string (e.g., "42")
-- Linear: stores the identifier (e.g., "LIN-42")
-- NULL for sessions without linked issues
```

The migration is idempotent (same pattern as existing `issue_number` migration in `database.ts`). Existing sessions with `issue_number` set but `issue_provider` NULL are treated as GitHub issues for backward compatibility.

### Settings Keys (in `settings` table)

| Key | Value | Description |
|-----|-------|-------------|
| `linear_team_id` | UUID string | Selected Linear team ID |
| `linear_team_name` | string | Selected Linear team name (for display) |

Note: Linear API key is stored in encrypted file (`.linear-token`), not in the settings table. This matches the GitHub pattern.

### Entity Relationships
```
sessions
  |-- issue_number INTEGER (legacy GitHub, preserved)
  |-- issue_title TEXT
  |-- issue_url TEXT
  |-- issue_provider TEXT (NEW: "github" | "linear" | NULL)
  |-- issue_id TEXT (NEW: "42" for GitHub, "LIN-42" for Linear)

settings (key-value)
  |-- linear_team_id
  |-- linear_team_name

Encrypted files (userData directory):
  |-- .github-token
  |-- .linear-token (NEW)
```

### Data Migration Strategy

1. Add `issue_provider` and `issue_id` columns via `ALTER TABLE` (idempotent, checks `PRAGMA table_info` first)
2. **No backfill** of existing rows -- legacy GitHub sessions continue working via the existing `issue_number` column
3. New sessions saved with a linked issue will populate BOTH the legacy columns (`issue_number`, `issue_title`, `issue_url`) AND the new columns (`issue_provider`, `issue_id`)
4. The renderer reads `issue_provider` + `issue_id` when available, falls back to `issue_number` for legacy display

---

## 4. API Design

### Linear GraphQL Queries

All queries use `POST https://api.linear.app/graphql` with header `Authorization: <API_KEY>`.

#### Query: Viewer (Test Connection)
```graphql
query Viewer {
  viewer {
    id
    name
    email
  }
}
```

#### Query: Teams
```graphql
query Teams {
  teams {
    nodes {
      id
      name
      key
    }
  }
}
```

#### Query: Team Issues
```graphql
query TeamIssues($teamId: String!, $first: Int!) {
  team(id: $teamId) {
    issues(
      first: $first
      orderBy: updatedAt
      filter: { state: { type: { nin: ["completed", "cancelled"] } } }
    ) {
      nodes {
        id
        identifier
        title
        url
        priority
        state {
          name
          type
        }
        updatedAt
      }
    }
  }
}
```

#### Query: Search Issues
```graphql
query SearchIssues($teamId: String!, $query: String!, $first: Int!) {
  issueSearch(
    query: $query
    first: $first
    filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["completed", "cancelled"] } } }
  ) {
    nodes {
      id
      identifier
      title
      url
      priority
      state {
        name
        type
      }
      updatedAt
    }
  }
}
```

### IPC Channel Definitions

#### New Channels

| Channel | Direction | Input | Output | Purpose |
|---------|-----------|-------|--------|---------|
| `linear:set-token` | invoke | `{ token: string }` | `void` | Save Linear API key |
| `linear:delete-token` | invoke | none | `void` | Remove Linear API key and provider |
| `linear:test-connection` | invoke | none | `{ displayName: string }` | Validate API key, return user name |
| `linear:list-teams` | invoke | none | `LinearTeam[]` | Fetch teams for team selector |
| `linear:set-team` | invoke | `{ teamId: string; teamName: string }` | `void` | Save selected team to settings |
| `linear:get-team` | invoke | none | `{ teamId: string; teamName: string } \| null` | Get currently selected team |
| `linear:fetch-issues` | invoke | `{ forceRefresh?: boolean }` | `LinearIssue[]` | Fetch issues for selected team |
| `linear:provider-status` | invoke | none | `LinearProviderStatus` | Check if Linear is configured |

#### Modified Channels

| Channel | Change |
|---------|--------|
| `issues:provider-status` | Returns status for ALL providers (both GitHub and Linear) |

### Preload Bridge Additions

```typescript
// Added to window.electronAPI
linear: {
  setToken: (input: { token: string }) => Promise<void>;
  deleteToken: () => Promise<void>;
  testConnection: () => Promise<{ displayName: string }>;
  listTeams: () => Promise<LinearTeam[]>;
  setTeam: (input: { teamId: string; teamName: string }) => Promise<void>;
  getTeam: () => Promise<{ teamId: string; teamName: string } | null>;
  fetchIssues: (input: { forceRefresh?: boolean }) => Promise<LinearIssue[]>;
  providerStatus: () => Promise<LinearProviderStatus>;
}
```

---

## 5. Type Definitions

### New Types (added to `src/shared/types.ts`)

```typescript
// --- Linear Issue Types ---

export interface LinearIssue {
  id: string;           // Linear UUID
  identifier: string;   // e.g., "LIN-42"
  title: string;
  url: string;
  priority: number;     // 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
  state: LinearIssueState;
  updatedAt: string;    // ISO 8601
}

export interface LinearIssueState {
  name: string;         // e.g., "In Progress"
  type: string;         // "backlog" | "unstarted" | "started" | "completed" | "cancelled"
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;          // e.g., "LIN" (prefix for issue identifiers)
}

export interface LinearProviderStatus {
  configured: boolean;       // API key exists
  teamSelected: boolean;     // Team has been chosen
  teamName: string | null;   // Display name of selected team
}

// --- Issue Reference (discriminated union for session linking) ---

export type IssueRef =
  | { provider: "github"; number: number; title: string; url: string }
  | { provider: "linear"; identifier: string; title: string; url: string };
```

### Modified Types

```typescript
// Session: add optional issue_provider and issue_id
export interface Session {
  id: string;
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  completedAt: string;
  tags: Tag[];
  // Legacy GitHub fields (preserved for backward compat)
  issueNumber: number | null;
  issueTitle: string | null;
  issueUrl: string | null;
  // New generic fields
  issueProvider: "github" | "linear" | null;
  issueId: string | null;
}

// SaveSessionInput: add optional provider fields
export interface SaveSessionInput {
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
  // Legacy (still used for GitHub backward compat)
  issueNumber?: number;
  issueTitle?: string;
  issueUrl?: string;
  // New generic fields
  issueProvider?: "github" | "linear";
  issueId?: string;
}

// IssueProviderStatus: expanded to cover multiple providers
export interface IssueProviderStatus {
  configured: boolean;
  provider: "github" | null;
  // New:
  linearConfigured: boolean;
  linearTeamSelected: boolean;
}

// ElectronAPI: add linear namespace
export interface ElectronAPI {
  // ... existing ...
  linear: {
    setToken: (input: { token: string }) => Promise<void>;
    deleteToken: () => Promise<void>;
    testConnection: () => Promise<{ displayName: string }>;
    listTeams: () => Promise<LinearTeam[]>;
    setTeam: (input: { teamId: string; teamName: string }) => Promise<void>;
    getTeam: () => Promise<{ teamId: string; teamName: string } | null>;
    fetchIssues: (input: { forceRefresh?: boolean }) => Promise<LinearIssue[]>;
    providerStatus: () => Promise<LinearProviderStatus>;
  };
}
```

---

## 6. Security Considerations

### Authentication
- Linear API key is a personal API key (not OAuth)
- Stored encrypted on disk using Electron `safeStorage` (OS keychain-backed), same as GitHub token
- File location: `{userData}/.linear-token`
- Key is sent as `Authorization: <key>` header (no "Bearer" prefix, per Linear API spec)

### Authorization
- Read-only access: only fetches viewer info, teams, and issues
- No scopes to configure (Linear personal API keys have full access to the user's workspace)

### Data Protection
- API key never leaves the main process (not sent to renderer)
- API key is encrypted at rest via OS keychain
- No sensitive data cached in renderer state beyond issue titles/identifiers

---

## 7. Performance Considerations

### Expected Load
- Typical user fetches issues 2-5 times per session (page mount + manual refreshes)
- Each fetch returns up to 100 issues (paginated at API level)
- Linear rate limit: 1,500 requests/hour (ample for single-user desktop app)

### Optimization Strategies
- In-memory issue cache in `LinearProvider` (same pattern as `GitHubProvider.cache`)
- Cache keyed by team ID, invalidated on force refresh
- Cache cleared on provider destroy (token removal)

### Caching
- Issues cached per team after first fetch
- `forceRefresh: true` clears cache before fetching
- No persistent disk cache (issues are fetched fresh each app session)

---

## 8. Implementation Plan

### Actual File Inventory (Verified 2026-02-23)

The following is the verified current state of every file relevant to this feature:

| File | Exists | Purpose |
|------|--------|---------|
| `src/shared/types.ts` | Yes | All shared types (Session, Issue, ElectronAPI, etc.) |
| `electron/main/database.ts` | Yes | SQLite schema, session CRUD, settings CRUD |
| `electron/main/ipc-handlers.ts` | Yes | All IPC handler registration |
| `electron/main/index.ts` | Yes | App lifecycle, calls initProviderFromDisk() |
| `electron/main/issue-providers/index.ts` | Yes | Single-provider singleton (currentProvider) |
| `electron/main/issue-providers/types.ts` | Yes | IssueProvider interface, IssueProviderError class |
| `electron/main/issue-providers/github-provider.ts` | Yes | GitHub REST client via @octokit/rest |
| `electron/main/issue-providers/token-storage.ts` | Yes | Encrypted token save/load/delete/has (hardcoded to `.github-token`) |
| `electron/preload/index.ts` | Yes | contextBridge exposing electronAPI |
| `src/renderer/src/components/IssuesPage.tsx` | Yes | Issues browse page (GitHub only, SCSS modules) |
| `src/renderer/src/components/IssuePickerDropdown.tsx` | Yes | Issue selector in timer view (GitHub only, SCSS modules) |
| `src/renderer/src/components/SettingsPage.tsx` | Yes | Settings with GitHub token section (SCSS modules) |
| `src/renderer/src/components/SessionHistoryItem.tsx` | Yes | Session row in history list (no issue display currently) |
| `src/renderer/src/components/TomatoClock.tsx` | Yes | Root orchestrator, manages pendingIssue state |
| `src/renderer/src/components/TimerView.tsx` | Yes | Timer section, renders IssuePickerDropdown |
| `src/renderer/src/hooks/useIssues.ts` | Yes | Hook for fetching issues + provider status |
| `src/renderer/src/hooks/useTimer.ts` | Yes | Timer FSM, saves session with issue data on completion |

**Styling approach**: All components use **SCSS modules** (`.module.scss` files), NOT inline styles. The CLAUDE.md claim of inline styles is outdated.

### Files to Create

| File | Purpose |
|------|---------|
| `electron/main/issue-providers/linear-provider.ts` | Linear GraphQL client implementing IssueProvider |
| `src/renderer/src/hooks/useLinearIssues.ts` | Hook for fetching Linear issues + provider status |
| `src/renderer/src/components/ProviderTabs.tsx` | Reusable provider tab switcher component |
| `src/renderer/src/components/ProviderTabs.module.scss` | Styles for provider tabs |

### Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add LinearIssue, LinearTeam, LinearProviderStatus, LinearIssueState, IssueRef types. Extend Session, SaveSessionInput, IssueProviderStatus, ElectronAPI. |
| `electron/main/database.ts` | Add migration for `issue_provider TEXT` and `issue_id TEXT` columns. Update `saveSession()` and `listSessions()` to read/write new columns. |
| `electron/main/ipc-handlers.ts` | Add `linear:*` IPC handlers. Update `issues:provider-status` to include Linear status. |
| `electron/main/issue-providers/index.ts` | Replace singleton with provider registry Map. Add `initLinearProviderFromDisk()`. Export `getGitHubProvider()`, `getLinearProvider()`, `setLinearProvider()`. |
| `electron/main/issue-providers/types.ts` | Extend `IssueProvider` interface if needed (may remain unchanged if LinearProvider returns `LinearIssue[]` via its own typed method). Add `LinearIssueProvider` sub-interface. |
| `electron/main/issue-providers/token-storage.ts` | Parameterize functions to accept a provider name (e.g., `saveToken(token, "linear")` stores to `.linear-token`). Maintain backward-compatible overloads for GitHub. |
| `electron/main/index.ts` | Call `initLinearProviderFromDisk()` alongside `initProviderFromDisk()` at startup. |
| `electron/preload/index.ts` | Add `linear` namespace to contextBridge with all Linear IPC invoke calls. |
| `src/renderer/src/components/IssuesPage.tsx` | Add provider tabs (GitHub / Linear). Render GitHub issues or Linear issues based on active tab. Show per-provider empty states. |
| `src/renderer/src/components/IssuesPage.module.scss` | Add styles for provider tabs and Linear issue cards (priority badges, state labels). |
| `src/renderer/src/components/IssuePickerDropdown.tsx` | Add provider tabs within dropdown. Support selecting both GitHub `Issue` and `LinearIssue`. Update `onSelect` to emit `IssueRef`. |
| `src/renderer/src/components/IssuePickerDropdown.module.scss` | Add styles for provider tabs in dropdown. |
| `src/renderer/src/components/SettingsPage.tsx` | Add Linear configuration section (API key input, test connection, team selector, disconnect). |
| `src/renderer/src/components/SettingsPage.module.scss` | Add styles for Linear settings section and team dropdown. |
| `src/renderer/src/components/SessionHistoryItem.tsx` | Display linked issue info (identifier + title) when `issueProvider` / `issueId` or legacy `issueNumber` is present. |
| `src/renderer/src/components/SessionHistoryItem.module.scss` | Add styles for issue badge in history item. |
| `src/renderer/src/components/TomatoClock.tsx` | Change `pendingIssue` type from `Issue \| null` to `IssueRef \| null`. Update `handleIssueSelect` and `handleSessionSaved`. |
| `src/renderer/src/hooks/useTimer.ts` | Update session save to include `issueProvider` and `issueId` fields from `IssueRef`. |
| `src/renderer/src/hooks/useIssues.ts` | Minor: expose method to check Linear status alongside GitHub status (or keep separate hooks). |

### Sequence of Changes

**Phase 1: Backend Foundation**
1. Extend `token-storage.ts` to support parameterized provider names
2. Add `LinearIssue`, `LinearTeam`, `LinearProviderStatus` types to `types.ts`
3. Create `linear-provider.ts` with GraphQL client
4. Refactor `issue-providers/index.ts` to multi-provider registry
5. Add database migration for `issue_provider` + `issue_id` columns
6. Update `saveSession()` and `listSessions()` in `database.ts`

**Phase 2: IPC Layer**
7. Register `linear:*` IPC handlers in `ipc-handlers.ts`
8. Update `issues:provider-status` handler
9. Add `linear` namespace to preload bridge
10. Update `ElectronAPI` type and preload imports

**Phase 3: Type System**
11. Add `IssueRef` union type
12. Extend `Session` and `SaveSessionInput` with new fields
13. Extend `IssueProviderStatus` with Linear fields

**Phase 4: Renderer UI**
14. Create `ProviderTabs` component
15. Create `useLinearIssues` hook
16. Update `SettingsPage` with Linear configuration section
17. Update `IssuesPage` with provider tabs
18. Update `IssuePickerDropdown` with provider tabs
19. Update `TomatoClock` to use `IssueRef` for `pendingIssue`
20. Update `useTimer` session save logic
21. Update `SessionHistoryItem` to display issue info

**Phase 5: Startup + Polish**
22. Update `electron/main/index.ts` to initialize Linear provider from disk
23. Handle edge cases (only one provider configured, no team selected, etc.)

---

## 9. Linear Provider Implementation Detail

### `linear-provider.ts` Design

```typescript
export class LinearProvider {
  private apiKey: string;
  private cache = new Map<string, LinearIssue[]>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async testConnection(): Promise<{ displayName: string }> {
    const data = await this.graphql<{ viewer: { name: string } }>(VIEWER_QUERY);
    return { displayName: data.viewer.name };
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(TEAMS_QUERY);
    return data.teams.nodes;
  }

  async fetchIssues(teamId: string, forceRefresh = false): Promise<LinearIssue[]> {
    if (forceRefresh) this.cache.delete(teamId);
    const cached = this.cache.get(teamId);
    if (cached) return cached;

    const data = await this.graphql<{ team: { issues: { nodes: RawLinearIssue[] } } }>(
      TEAM_ISSUES_QUERY,
      { teamId, first: 100 }
    );
    const issues = data.team.issues.nodes.map(mapToLinearIssue);
    this.cache.set(teamId, issues);
    return issues;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      if (response.status === 401) throw new IssueProviderError("Linear API key is invalid or revoked", "AUTH_FAILED");
      if (response.status === 429) throw new IssueProviderError("Linear API rate limit reached", "RATE_LIMITED");
      throw new IssueProviderError("Could not reach Linear", "NETWORK_ERROR");
    }

    const json = await response.json();
    if (json.errors?.length) {
      throw new IssueProviderError(json.errors[0].message, "NETWORK_ERROR");
    }
    return json.data as T;
  }

  clearCache(): void { this.cache.clear(); }
  destroy(): void { this.cache.clear(); }
}
```

### Error Handling Strategy

| Error | HTTP Status | User-Facing Message | Error Code |
|-------|-------------|---------------------|------------|
| Invalid/revoked API key | 401 | "Linear API key is invalid or has been revoked. Check Settings > Account > API in Linear." | `AUTH_FAILED` |
| Rate limited | 429 | "Linear API rate limit reached. Try again in a few minutes." | `RATE_LIMITED` |
| Network failure | 0 / timeout | "Could not reach Linear. Check your internet connection." | `NETWORK_ERROR` |
| GraphQL error | 200 with errors | First error message from response | `NETWORK_ERROR` |
| No token configured | N/A | "No Linear API key configured" | `NO_TOKEN` |
| No team selected | N/A | "Please select a team in Settings" | (UI-level, not thrown) |

---

## 10. UI Component Changes

### SettingsPage: Linear Section

Below the existing "Issue Tracker" / GitHub section, add a new "Linear" sub-section:

**Unconfigured state:**
- Heading: "Linear"
- Input: "Linear API Key" (password field)
- Help text: "Generate at Settings > Account > API in Linear."
- Button: "Save Key"

**Configured, no team:**
- Status: "Linear -- Connected" with display name
- Team dropdown (fetched from `linear:list-teams`)
- "Select a team to browse issues"
- Button: "Test Connection" | "Remove Key"

**Configured, team selected:**
- Status: "Linear -- Connected" with display name
- Team: "{teamName}" with "Change" button
- Buttons: "Test Connection" | "Disconnect"

### IssuesPage: Provider Tabs

```
+--------+---------+
| GitHub | Linear  |    <-- ProviderTabs component
+--------+---------+
| Issue list for    |
| active tab        |
+-------------------+
```

- If only one provider is configured, show that tab only (no tab bar)
- If neither is configured, show generic "Configure an issue tracker in Settings" message
- Each tab has independent loading/error state
- Tab selection persisted in `useState` (reset on unmount, per PRD P2 FR-021 -- nice-to-have)

### IssuePickerDropdown: Provider Tabs

- Same tab mechanism inside the dropdown panel
- Tabs only shown when both providers are configured
- Single provider: show issues directly without tabs
- Selected issue display shows provider-specific identifier (e.g., "#42" for GitHub, "LIN-42" for Linear)

### SessionHistoryItem: Issue Display

- When `issueProvider === "linear"`: show `issueId` (e.g., "LIN-42") as a badge
- When `issueProvider === "github"` or legacy `issueNumber`: show "#42" as a badge
- Both: show title text next to the badge
- Badge is clickable (opens `issueUrl` in browser via `shell:open-external`)

### Linear Issue Card (in IssuesPage)

```
+-----------------------------------------------+
| LIN-42            In Progress                  |
| Fix authentication timeout on mobile           |
| [!!] High                                      |
+-----------------------------------------------+
```

- Identifier (bold, left)
- State label (right, colored by type: started=blue, unstarted=gray, backlog=dim)
- Title (second line)
- Priority indicator (icon + text: Urgent, High, Medium, Low, No priority)

---

## 11. Testing Strategy

### Unit Tests

**Main process:**
- `linear-provider.ts`: Mock `fetch`, test all 4 queries, test error handling for 401/429/network
- `token-storage.ts`: Test parameterized save/load/delete for both "github" and "linear"
- `database.ts`: Test migration adds columns, test `saveSession` with new fields, test `listSessions` returns new fields, test backward compat (old sessions without `issue_provider` still work)

**Renderer:**
- `useLinearIssues.ts`: Mock `window.electronAPI.linear.*`, test loading/error/success states
- `IssuePickerDropdown.tsx`: Test tab switching, test issue selection emits correct `IssueRef`
- `SessionHistoryItem.tsx`: Test display of GitHub issue, Linear issue, and no-issue sessions

### Integration Tests
- Full IPC round-trip: save token -> test connection -> fetch teams -> set team -> fetch issues -> save session with Linear issue -> list sessions shows Linear issue
- Backward compatibility: existing sessions with `issue_number` display correctly after migration

### E2E Tests
- Configure Linear in Settings (API key + team selection)
- Browse Linear issues in Issues page
- Link a Linear issue to a session via the picker
- Verify history shows the linked Linear issue

---

## 12. Backward Compatibility Plan

### Database
- New columns are `ALTER TABLE ADD COLUMN` (nullable, no default required)
- Existing `issue_number`, `issue_title`, `issue_url` columns are NOT removed
- Legacy sessions (before Linear feature) have `issue_provider = NULL`, `issue_id = NULL`
- When saving a new GitHub-linked session, BOTH old columns (`issue_number`) and new columns (`issue_provider = "github"`, `issue_id = "42"`) are populated
- Renderer display logic: check `issue_provider` first; if NULL, fall back to `issue_number`

### Types
- `Session` type adds new optional fields (`issueProvider`, `issueId`) -- no breaking change
- `SaveSessionInput` adds new optional fields -- no breaking change
- `IssueProviderStatus` adds new fields -- existing code only reads `configured` and `provider`, unaffected

### IPC
- All existing channels remain unchanged
- New `linear:*` channels are additive
- `issues:provider-status` response is extended (additive, non-breaking)

### Token Storage
- `.github-token` file path is unchanged
- New `.linear-token` file is stored alongside it
- `loadToken()` / `saveToken()` / `deleteToken()` / `hasToken()` gain an optional `provider` parameter, defaulting to `"github"` for backward compat

---

## 13. Rollout Plan

### Feature Flags
Not applicable for a desktop Electron app. The feature ships as part of the next release. Linear UI sections only appear after the user configures a Linear API key.

### Rollback Plan
- The database migration adds columns but never removes them -- safe to roll back to a prior app version
- Old versions of the app ignore unknown columns (SQLite does not enforce schema on read)
- Token file (`.linear-token`) is ignored by old versions
- No data loss on rollback

---

## 14. Open Questions

| Question | Status | Resolution |
|----------|--------|------------|
| `@linear/sdk` vs raw `fetch`? | Resolved | Raw `fetch` with typed GraphQL queries. SDK is too heavy and risks Electron CJS/ESM issues. |
| Generic provider columns vs separate `linear_issue_id`? | Resolved | Generic `issue_provider` + `issue_id` columns. Scales to future providers. |
| Tabs vs dropdown for multi-provider? | Resolved | Tabs. Faster switching, immediately visible, appropriate for 2 providers. |
| Default provider when both configured? | Resolved | Default to last-used tab (local component state). On fresh mount, default to GitHub (existing behavior). |
| How to handle GitHub numeric IDs vs Linear string IDs? | Resolved | `IssueRef` discriminated union type. `issue_id TEXT` column stores both (GitHub number as string). |
| Should `IssueProvider` interface be modified for Linear? | Resolved | No. `LinearProvider` is a standalone class with its own typed methods. The `IssueProvider` interface remains GitHub-oriented. Linear uses its own IPC channels. This avoids forcing Linear's team-scoped model into GitHub's repo-scoped interface. |
| Multiple Linear teams? | Resolved (per PRD) | v1 supports one team at a time, changeable in Settings. |