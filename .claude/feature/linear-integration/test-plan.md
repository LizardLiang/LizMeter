# Test Plan

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Linear Integration |
| **Author** | Artemis (QA Agent) |
| **Date** | 2026-02-23 |
| **PRD Version** | 1.0 |
| **Tech Spec Version** | 1.0 |

---

## 1. Test Overview

### Scope
This test plan covers all new and modified behavior introduced by the Linear integration feature:
- `LinearProvider` class (GraphQL client, caching, error handling)
- `token-storage.ts` parameterization (provider-aware save/load/delete/has)
- `database.ts` migration (new `issue_provider` and `issue_id` columns) and updated `saveSession` / `listSessions`
- IPC handlers for all `linear:*` channels
- `useLinearIssues` hook (loading, error, success states)
- `ProviderTabs` component (tab switching, single-provider mode)
- `IssuesPage` updates (provider tabs, per-tab empty states, search/filter)
- `IssuePickerDropdown` updates (provider tabs, `IssueRef` emission)
- `SettingsPage` Linear section (all three configuration states)
- `SessionHistoryItem` updates (Linear issue badge, legacy GitHub badge)
- `TomatoClock` / `useTimer` updates (IssueRef type for pendingIssue)
- Backward compatibility for existing sessions with `issue_number` only

### Out of Scope
- GitHub provider behavior that is not changed by this feature (covered by existing tests)
- Playwright E2E tests requiring a running Electron process (infrastructure not yet set up for CI)
- Linear OAuth2 flow (not in scope per PRD)
- Writing to Linear (read-only integration)
- Multi-team simultaneous browsing (v1 is one team at a time)

### Test Approach
Tests follow the patterns established in the existing codebase:
- **Main process tests** (`// @vitest-environment node`) live in `electron/main/__tests__/` and use `initDatabase(":memory:")` with the better-sqlite3 shim.
- **Renderer tests** (jsdom environment, default) live in `src/renderer/src/*/` `__tests__/` directories and mock `window.electronAPI` via `vi.stubGlobal("electronAPI", ...)`.
- **Network calls** are mocked via `vi.spyOn(global, "fetch")` or by injecting mock providers.
- **IPC handlers** are tested in node environment by calling the handler functions directly after stubbing their dependencies.
- All tests use Vitest + `@testing-library/react` for component tests.

---

## 2. Requirements Coverage Matrix

| Req ID | Requirement | Test Cases | Priority |
|--------|-------------|------------|----------|
| FR-001 | Linear API key configuration | TC-101, TC-102, TC-201 | P0 |
| FR-002 | Test connection button | TC-103, TC-104, TC-105, TC-201, TC-202 | P0 |
| FR-003 | Team selection | TC-106, TC-107, TC-203, TC-204, TC-401 | P0 |
| FR-004 | Browse Linear issues | TC-108, TC-109, TC-110, TC-111, TC-301, TC-302 | P0 |
| FR-005 | Link Linear issue to session | TC-151, TC-152, TC-153, TC-601, TC-602 | P0 |
| FR-006 | Display linked Linear issues in history | TC-321, TC-322, TC-323, TC-324 | P0 |
| FR-007 | Multi-provider sidebar (tabs) | TC-301, TC-302, TC-303, TC-304 | P0 |
| FR-008 | Multi-provider issue selector | TC-601, TC-602, TC-603 | P0 |
| FR-010 | Search/filter Linear issues | TC-305, TC-306 | P1 |
| FR-011 | Display Linear issue metadata | TC-307, TC-308 | P1 |
| FR-012 | Delete Linear configuration | TC-113, TC-205 | P1 |
| FR-020 | Open Linear issue in browser | TC-325 | P2 |
| FR-021 | Remember last active provider tab | TC-309 | P2 |
| FR-022 | Force refresh Linear issues | TC-310 | P2 |
| NFR-COMPAT | Backward compatibility | TC-154, TC-155, TC-156, TC-701, TC-702 | P0 |
| NFR-SEC | API key never crosses IPC boundary | TC-114 | P0 |
| NFR-CACHE | In-memory issue cache | TC-112 | P1 |
| NFR-PERF | API response time threshold | TC-801 | P1 |

---

## 3. Test Cases

---

### Unit Tests — LinearProvider

**File**: `electron/main/issue-providers/__tests__/linear-provider.test.ts`
**Environment**: `// @vitest-environment node`
**Setup**: Mock `global.fetch` using `vi.spyOn(global, "fetch")`

---

#### TC-101: LinearProvider constructor stores API key

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Verify that `new LinearProvider(apiKey)` stores the key internally and uses it in subsequent GraphQL requests.

**Preconditions**:
- `fetch` is mocked to return a valid viewer response

**Test Steps**:
1. Create `new LinearProvider("lin_api_test_key")`
2. Call `provider.testConnection()`
3. Assert that `fetch` was called with `Authorization: lin_api_test_key` header (no "Bearer" prefix)

**Expected Result**:
- `fetch` is called with `"Content-Type": "application/json"` and `"Authorization": "lin_api_test_key"` headers
- The `Authorization` header does NOT include a "Bearer " prefix

---

#### TC-102: LinearProvider.testConnection returns displayName on success

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Successful viewer query returns the user's display name.

**Preconditions**:
- `fetch` mocked to return `{ data: { viewer: { id: "u1", name: "Jane Dev", email: "jane@example.com" } } }`

**Test Steps**:
1. Create `new LinearProvider("valid_key")`
2. Call `await provider.testConnection()`
3. Assert the returned object

**Expected Result**:
- Returns `{ displayName: "Jane Dev" }`

---

#### TC-103: LinearProvider.testConnection throws AUTH_FAILED on 401

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: HTTP 401 from Linear API results in `IssueProviderError` with code `AUTH_FAILED`.

**Preconditions**:
- `fetch` mocked to return `{ ok: false, status: 401 }`

**Test Steps**:
1. Create `new LinearProvider("bad_key")`
2. Call `await provider.testConnection()`
3. Expect it to throw

**Expected Result**:
- Throws `IssueProviderError` with `code === "AUTH_FAILED"`
- Error message matches "Linear API key is invalid or revoked" (case-insensitive substring match)

---

#### TC-104: LinearProvider.testConnection throws RATE_LIMITED on 429

| Field | Value |
|-------|-------|
| **Requirement** | FR-002, NFR-RATE |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: HTTP 429 results in `IssueProviderError` with code `RATE_LIMITED`.

**Preconditions**:
- `fetch` mocked to return `{ ok: false, status: 429 }`

**Test Steps**:
1. Create `new LinearProvider("valid_key")`
2. Call `await provider.testConnection()`
3. Expect it to throw

**Expected Result**:
- Throws `IssueProviderError` with `code === "RATE_LIMITED"`
- Error message includes "rate limit"

---

#### TC-105: LinearProvider.testConnection throws NETWORK_ERROR on GraphQL error array

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: HTTP 200 response that contains a GraphQL `errors` array is treated as an error (not silently returned).

**Preconditions**:
- `fetch` mocked to return `{ ok: true, status: 200, json: () => ({ errors: [{ message: "Unauthorized" }] }) }`

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.testConnection()`
3. Expect it to throw

**Expected Result**:
- Throws `IssueProviderError`
- Error message is `"Unauthorized"` (taken from first error in the array)

**Edge Cases**:
- Empty `errors: []` array: should NOT throw (treated as success if `data` is present)

---

#### TC-106: LinearProvider.listTeams returns team array

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: `listTeams()` maps GraphQL response nodes to `LinearTeam[]`.

**Preconditions**:
- `fetch` mocked to return `{ data: { teams: { nodes: [{ id: "t1", name: "Engineering", key: "ENG" }, { id: "t2", name: "Design", key: "DES" }] } } }`

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.listTeams()`
3. Assert the returned array

**Expected Result**:
- Returns `[{ id: "t1", name: "Engineering", key: "ENG" }, { id: "t2", name: "Design", key: "DES" }]`
- Each object has `id`, `name`, and `key` properties

---

#### TC-107: LinearProvider.listTeams returns empty array when workspace has no teams

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, edge case |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Zero-teams edge case (user has no teams in their workspace).

**Preconditions**:
- `fetch` mocked to return `{ data: { teams: { nodes: [] } } }`

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.listTeams()`

**Expected Result**:
- Returns `[]` (empty array, does not throw)

---

#### TC-108: LinearProvider.fetchIssues returns mapped issues for a team

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: `fetchIssues(teamId)` sends a GraphQL query with the team ID and maps the response to `LinearIssue[]`.

**Preconditions**:
- `fetch` mocked to return a valid team issues response with 3 issues containing `id`, `identifier`, `title`, `url`, `priority`, `state.name`, `state.type`, `updatedAt`

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.fetchIssues("team-id-1")`
3. Assert the returned array

**Expected Result**:
- Returns 3 `LinearIssue` objects
- Each issue has: `id` (UUID), `identifier` (e.g., "ENG-42"), `title`, `url`, `priority` (number 0-4), `state.name`, `state.type`, `updatedAt`
- The GraphQL request body includes `teamId: "team-id-1"` in the variables

---

#### TC-109: LinearProvider.fetchIssues uses cache on second call

| Field | Value |
|-------|-------|
| **Requirement** | FR-004, NFR-CACHE |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: The second call to `fetchIssues` with the same team ID returns cached data without making a second network request.

**Preconditions**:
- `fetch` mocked to succeed once

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.fetchIssues("team-id-1")` (first call)
3. Call `await provider.fetchIssues("team-id-1")` (second call)
4. Assert `fetch` call count

**Expected Result**:
- `fetch` was called exactly once (not twice)
- Both calls return the same issue array

---

#### TC-110: LinearProvider.fetchIssues bypasses cache on forceRefresh

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: `fetchIssues(teamId, true)` clears the cache for that team before fetching.

**Preconditions**:
- `fetch` mocked to succeed twice (returning different data on second call to verify re-fetch)

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.fetchIssues("team-id-1")` (populates cache)
3. Call `await provider.fetchIssues("team-id-1", true)` (force refresh)
4. Assert `fetch` call count

**Expected Result**:
- `fetch` was called exactly twice
- Second call result is from the second fetch (fresh data)

---

#### TC-111: LinearProvider.fetchIssues throws NETWORK_ERROR on network failure

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Network failure (fetch throws) results in `IssueProviderError` with `NETWORK_ERROR` code.

**Preconditions**:
- `fetch` mocked to throw `new TypeError("Failed to fetch")`

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `await provider.fetchIssues("team-id-1")`
3. Expect it to throw

**Expected Result**:
- Throws `IssueProviderError` with `code === "NETWORK_ERROR"`

---

#### TC-112: LinearProvider.clearCache removes all cached data

| Field | Value |
|-------|-------|
| **Requirement** | NFR-CACHE |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: After `clearCache()`, the next `fetchIssues` call makes a new network request.

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Call `fetchIssues("team-id-1")` (populates cache)
3. Call `provider.clearCache()`
4. Call `fetchIssues("team-id-1")` again
5. Assert `fetch` call count

**Expected Result**:
- `fetch` was called twice (once before, once after `clearCache`)

---

#### TC-113: LinearProvider.destroy clears cache

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: `destroy()` clears all cached issues (cleanup on disconnect).

**Test Steps**:
1. Create `new LinearProvider("key")`
2. Populate cache via `fetchIssues("team-id-1")`
3. Call `provider.destroy()`
4. Call `fetchIssues("team-id-1")` again (requires a new `fetch` call)
5. Assert `fetch` call count equals 2

**Expected Result**:
- `fetch` was called twice (cache was cleared by `destroy`)

---

#### TC-114: LinearProvider never exposes API key via return value

| Field | Value |
|-------|-------|
| **Requirement** | NFR-SEC |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: No method on `LinearProvider` returns the raw API key string.

**Test Steps**:
1. Create `new LinearProvider("secret_key_do_not_expose")`
2. Call `testConnection()`, `listTeams()`, `fetchIssues("t1")`
3. Stringify each return value and search for the key string

**Expected Result**:
- None of the return values contain `"secret_key_do_not_expose"`

---

### Unit Tests — token-storage (parameterized)

**File**: `electron/main/issue-providers/__tests__/token-storage.test.ts`
**Environment**: `// @vitest-environment node`
**Setup**: Mock `electron` (safeStorage + app), mock `node:fs`

---

#### TC-121: saveToken("github") writes to .github-token file

| Field | Value |
|-------|-------|
| **Requirement** | Backward compat |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: After parameterization, calling `saveToken(token, "github")` (or the backward-compatible `saveToken(token)`) still writes to `.github-token`.

**Preconditions**:
- `safeStorage.encryptString` mocked to return a buffer
- `fs.writeFileSync` spied on

**Test Steps**:
1. Call `saveToken("gh_token_123")` (no provider argument)
2. Assert `fs.writeFileSync` was called with a path ending in `.github-token`

**Expected Result**:
- File path ends with `.github-token`

---

#### TC-122: saveToken("linear") writes to .linear-token file

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: `saveToken(token, "linear")` writes to `.linear-token`, a separate encrypted file.

**Preconditions**:
- `safeStorage.encryptString` mocked
- `fs.writeFileSync` spied on

**Test Steps**:
1. Call `saveToken("lin_api_key", "linear")`
2. Assert `fs.writeFileSync` was called with a path ending in `.linear-token`

**Expected Result**:
- File path ends with `.linear-token`
- `.github-token` is NOT written

---

#### TC-123: loadToken("linear") returns decrypted token when file exists

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: `loadToken("linear")` reads `.linear-token` and decrypts it.

**Preconditions**:
- `fs.readFileSync` mocked to return an encrypted buffer for `.linear-token`
- `safeStorage.decryptString` mocked to return `"lin_api_key_decrypted"`

**Test Steps**:
1. Call `loadToken("linear")`

**Expected Result**:
- Returns `"lin_api_key_decrypted"`

---

#### TC-124: loadToken("linear") returns null when .linear-token does not exist

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Missing token file for Linear returns `null` without throwing.

**Preconditions**:
- `fs.readFileSync` mocked to throw `ENOENT` for `.linear-token`

**Test Steps**:
1. Call `loadToken("linear")`

**Expected Result**:
- Returns `null`
- Does not throw

---

#### TC-125: deleteToken("linear") removes .linear-token file

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: `deleteToken("linear")` unlinks the `.linear-token` file.

**Preconditions**:
- `fs.unlinkSync` spied on

**Test Steps**:
1. Call `deleteToken("linear")`
2. Assert `fs.unlinkSync` was called with a path ending in `.linear-token`

**Expected Result**:
- `.linear-token` is unlinked
- `.github-token` is NOT unlinked

---

#### TC-126: deleteToken("linear") is a no-op if .linear-token does not exist

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: `deleteToken` does not throw if the file is already gone.

**Preconditions**:
- `fs.unlinkSync` mocked to throw `ENOENT`

**Test Steps**:
1. Call `deleteToken("linear")`

**Expected Result**:
- Does not throw

---

#### TC-127: hasToken("linear") returns true when .linear-token exists

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: `hasToken("linear")` correctly checks for the `.linear-token` file.

**Preconditions**:
- `fs.existsSync` mocked to return `true` for paths ending in `.linear-token`

**Test Steps**:
1. Call `hasToken("linear")`

**Expected Result**:
- Returns `true`

---

#### TC-128: hasToken with no argument (legacy) still checks .github-token

| Field | Value |
|-------|-------|
| **Requirement** | Backward compat |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Calling `hasToken()` without arguments defaults to `"github"` provider.

**Preconditions**:
- `fs.existsSync` spied on

**Test Steps**:
1. Call `hasToken()`
2. Assert `fs.existsSync` was called with a path ending in `.github-token`

**Expected Result**:
- Path checked ends with `.github-token`

---

### Unit Tests — database.ts (migration + new fields)

**File**: `electron/main/__tests__/database.test.ts` (extend existing file)
**Environment**: `// @vitest-environment node`
**Setup**: `initDatabase(":memory:")` in `beforeEach`, `closeDatabase()` in `afterEach`

---

#### TC-141: Migration adds issue_provider and issue_id columns

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: After `initDatabase(":memory:")`, the sessions table contains `issue_provider` and `issue_id` columns in addition to the pre-existing `issue_number`, `issue_title`, `issue_url` columns.

**Test Steps**:
1. Call `initDatabase(":memory:")`
2. Query `PRAGMA table_info(sessions)` and collect column names

**Expected Result**:
- Column names include `issue_provider`, `issue_id`, `issue_number`, `issue_title`, `issue_url`

---

#### TC-142: Migration is idempotent (calling initDatabase twice does not fail)

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Running the migration twice does not throw a "duplicate column" error.

**Test Steps**:
1. Call `initDatabase(":memory:")`
2. Call `closeDatabase()`
3. Call `initDatabase(":memory:")` again

**Expected Result**:
- No error thrown on either call

---

#### TC-151: saveSession with Linear issue stores issue_provider and issue_id

| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: When `saveSession` receives `issueProvider: "linear"` and `issueId: "LIN-42"`, these values are stored in the new columns.

**Test Steps**:
1. Call `initDatabase(":memory:")`
2. Call `saveSession({ title: "Linear work", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1498, issueProvider: "linear", issueId: "LIN-42", issueTitle: "Fix auth timeout", issueUrl: "https://linear.app/..." })`
3. Call `listSessions({})`
4. Assert the returned session

**Expected Result**:
- `session.issueProvider === "linear"`
- `session.issueId === "LIN-42"`
- `session.issueTitle === "Fix auth timeout"`
- `session.issueUrl === "https://linear.app/..."`

---

#### TC-152: saveSession with GitHub issue stores both legacy and new columns

| Field | Value |
|-------|-------|
| **Requirement** | FR-005, NFR-COMPAT |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: GitHub sessions should dual-write: populate `issue_number` (legacy) AND `issue_provider: "github"` + `issue_id: "42"` (new).

**Test Steps**:
1. Call `saveSession({ title: "GitHub work", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1498, issueNumber: 42, issueTitle: "Fix bug", issueUrl: "https://github.com/...", issueProvider: "github", issueId: "42" })`
2. Call `listSessions({})`

**Expected Result**:
- `session.issueNumber === 42`
- `session.issueProvider === "github"`
- `session.issueId === "42"`
- `session.issueTitle === "Fix bug"`

---

#### TC-153: saveSession rejects invalid issueProvider values

| Field | Value |
|-------|-------|
| **Requirement** | SA Review Minor #4 |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: `saveSession` should validate `issueProvider` and reject values other than `"github"`, `"linear"`, or `null`/`undefined`.

**Test Steps**:
1. Call `saveSession({ title: "test", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500, issueProvider: "jira" as unknown as "github" })`

**Expected Result**:
- Throws an error indicating invalid `issueProvider` value
- Does NOT silently insert invalid data into the database

---

#### TC-154: listSessions returns issueProvider and issueId for new sessions

| Field | Value |
|-------|-------|
| **Requirement** | FR-006, NFR-COMPAT |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: `listSessions` reads `issue_provider` and `issue_id` columns and maps them to camelCase fields.

**Test Steps**:
1. Save a Linear session with `saveSession(..., issueProvider: "linear", issueId: "LIN-99")`
2. Call `listSessions({})`

**Expected Result**:
- `sessions[0].issueProvider === "linear"`
- `sessions[0].issueId === "LIN-99"`

---

#### TC-155: listSessions returns null for issueProvider on legacy sessions (backward compat)

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Sessions saved without `issueProvider` (simulating legacy data before Linear feature) return `issueProvider: null` and `issueId: null`, while still returning the existing `issueNumber`.

**Test Steps**:
1. Call `initDatabase(":memory:")`
2. Save a session with only `issueNumber: 5` and no `issueProvider` or `issueId`
3. Call `listSessions({})`

**Expected Result**:
- `sessions[0].issueNumber === 5`
- `sessions[0].issueProvider === null`
- `sessions[0].issueId === null`

---

#### TC-156: Simulated legacy database migration (issue_provider columns added to pre-existing table)

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: Simulate a pre-existing database that has the old columns but not `issue_provider`/`issue_id`. After calling `initDatabase`, the new columns exist and old sessions are still queryable.

**Test Steps**:
1. Create a raw in-memory SQLite database without `issue_provider` and `issue_id` columns (mimicking an old schema)
2. Insert a legacy session directly with `issue_number = 10`
3. Call `initDatabase` (which runs the migration)
4. Call `listSessions({})`

**Expected Result**:
- The legacy session is returned with `issueNumber: 10`
- `issueProvider` and `issueId` are `null`
- No error thrown during migration

---

### Unit Tests — useLinearIssues hook

**File**: `src/renderer/src/hooks/__tests__/useLinearIssues.test.ts`
**Environment**: jsdom (default)
**Setup**: `vi.stubGlobal("electronAPI", mockElectronAPI)` in `beforeEach`

---

#### TC-201: useLinearIssues shows loading state initially

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: The hook starts in a loading state before the IPC call resolves.

**Test Steps**:
1. Mock `window.electronAPI.linear.fetchIssues` to return a never-resolving promise
2. Call `renderHook(() => useLinearIssues())`
3. Assert the initial state

**Expected Result**:
- `result.current.isLoading === true`
- `result.current.issues` is an empty array
- `result.current.error === null`

---

#### TC-202: useLinearIssues populates issues on success

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: After `fetchIssues` resolves, the hook updates with the returned issues.

**Preconditions**:
- `window.electronAPI.linear.fetchIssues` mocked to return 3 `LinearIssue` objects

**Test Steps**:
1. `renderHook(() => useLinearIssues())`
2. `await waitFor(() => expect(result.current.isLoading).toBe(false))`

**Expected Result**:
- `result.current.issues.length === 3`
- `result.current.error === null`

---

#### TC-203: useLinearIssues sets error on IPC failure

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Description**: When `fetchIssues` rejects, the hook exposes the error and does not crash.

**Preconditions**:
- `window.electronAPI.linear.fetchIssues` mocked to reject with `new Error("AUTH_FAILED")`

**Test Steps**:
1. `renderHook(() => useLinearIssues())`
2. `await waitFor(() => expect(result.current.isLoading).toBe(false))`

**Expected Result**:
- `result.current.error` is truthy
- `result.current.issues` is empty array
- Component does not throw an unhandled promise rejection

---

#### TC-204: useLinearIssues calls fetchIssues with forceRefresh when refresh is triggered

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | Unit |
| **Priority** | P1 |

**Description**: Calling the hook's `refresh()` function re-invokes `fetchIssues` with `{ forceRefresh: true }`.

**Preconditions**:
- `window.electronAPI.linear.fetchIssues` mocked to succeed

**Test Steps**:
1. `renderHook(() => useLinearIssues())`
2. `await waitFor(() => expect(result.current.isLoading).toBe(false))`
3. `act(() => result.current.refresh())`
4. Assert the second call to `fetchIssues`

**Expected Result**:
- `fetchIssues` was called twice
- Second call was invoked with `{ forceRefresh: true }`

---

### Component Tests — SettingsPage (Linear section)

**File**: `src/renderer/src/components/__tests__/SettingsPage.test.tsx` (extend existing or create new)
**Environment**: jsdom

---

#### TC-211: SettingsPage shows unconfigured Linear section when no token exists

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When `providerStatus()` reports Linear not configured, the Settings page shows the API key input field.

**Preconditions**:
- `window.electronAPI.linear.providerStatus` returns `{ configured: false, teamSelected: false, teamName: null }`

**Test Steps**:
1. Render `<SettingsPage />`
2. `await waitFor(() => ...)` until loading complete
3. Query for the Linear API key input

**Expected Result**:
- A password input for "Linear API Key" is visible
- A "Save Key" or equivalent button is visible
- "Connected" status is NOT shown

---

#### TC-212: SettingsPage calls linear.setToken when API key is saved

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Typing a key in the Linear API Key input and clicking Save calls the IPC handler.

**Test Steps**:
1. Render `<SettingsPage />` (unconfigured state)
2. `fireEvent.change` the Linear API key input with `"lin_api_testkey"`
3. `fireEvent.click` the Save Key button

**Expected Result**:
- `window.electronAPI.linear.setToken` was called with `{ token: "lin_api_testkey" }`

---

#### TC-213: SettingsPage test connection button calls linear.testConnection

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Clicking "Test Connection" calls the IPC and shows the display name on success.

**Preconditions**:
- Linear is configured (token exists)
- `window.electronAPI.linear.testConnection` resolves with `{ displayName: "Jane Dev" }`

**Test Steps**:
1. Render `<SettingsPage />` in configured state
2. Click "Test Connection" button
3. `await waitFor` for display name to appear

**Expected Result**:
- `testConnection` was called once
- Text "Jane Dev" appears in the component

---

#### TC-214: SettingsPage shows error when test connection fails

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When `testConnection` rejects, an error message is displayed.

**Preconditions**:
- `window.electronAPI.linear.testConnection` rejects with `Error("API key is invalid or has been revoked")`

**Test Steps**:
1. Render `<SettingsPage />` in configured state
2. Click "Test Connection"
3. `await waitFor` for error message

**Expected Result**:
- An error message containing "invalid" or "revoked" is visible
- The component does not crash

---

#### TC-215: SettingsPage shows team dropdown after connection test succeeds

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: After a successful test connection, the team list is fetched and shown in a dropdown.

**Preconditions**:
- `testConnection` resolves with `{ displayName: "Jane" }`
- `listTeams` returns 2 teams

**Test Steps**:
1. Click "Test Connection"
2. `await waitFor` for team dropdown to appear
3. Assert team names visible in dropdown

**Expected Result**:
- Team dropdown is visible
- Both team names appear as options

---

#### TC-216: SettingsPage auto-selects single team

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, edge case (SA Review Minor #5) |
| **Type** | Component |
| **Priority** | P1 |

**Description**: When `listTeams` returns only one team, it is automatically selected without user interaction.

**Preconditions**:
- `listTeams` returns exactly 1 team `[{ id: "t1", name: "Engineering", key: "ENG" }]`
- `setTeam` is mocked

**Test Steps**:
1. Render `<SettingsPage />` after test connection succeeds with one team
2. `await waitFor` for auto-selection

**Expected Result**:
- `window.electronAPI.linear.setTeam` was called with `{ teamId: "t1", teamName: "Engineering" }`
- No team picker interaction required

---

#### TC-217: SettingsPage shows "no teams" message for empty workspace

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, PM Review Issue #2 |
| **Type** | Component |
| **Priority** | P1 |

**Description**: When `listTeams` returns an empty array, a helpful message is shown instead of an empty dropdown.

**Preconditions**:
- `listTeams` returns `[]`

**Test Steps**:
1. Trigger test connection success
2. `await waitFor` for team section to render

**Expected Result**:
- A message like "No teams found in your workspace" is visible
- No empty dropdown is shown

---

#### TC-218: SettingsPage disconnect button calls linear.deleteToken

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Component |
| **Priority** | P1 |

**Description**: Clicking "Disconnect" (or "Remove Key") invokes `linear.deleteToken` and resets the UI to unconfigured state.

**Preconditions**:
- Linear is fully configured (token + team)
- `window.electronAPI.linear.deleteToken` is mocked

**Test Steps**:
1. Render `<SettingsPage />` in fully configured state
2. Click "Disconnect" button
3. `await waitFor` for UI reset

**Expected Result**:
- `window.electronAPI.linear.deleteToken` was called
- The API key input is visible again (unconfigured state)
- "Connected" status is no longer shown

---

### Component Tests — IssuesPage (provider tabs)

**File**: `src/renderer/src/components/__tests__/IssuesPage.test.tsx` (extend existing or create new)
**Environment**: jsdom

---

#### TC-301: IssuesPage shows provider tabs when both providers are configured

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When both GitHub and Linear are configured, tabs for both providers are visible.

**Preconditions**:
- `issues.providerStatus` returns `{ configured: true, provider: "github", linearConfigured: true, linearTeamSelected: true }`

**Test Steps**:
1. Render `<IssuesPage />`
2. `await waitFor` until tabs render

**Expected Result**:
- A "GitHub" tab is visible
- A "Linear" tab is visible

---

#### TC-302: IssuesPage hides tab bar when only one provider is configured

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When only Linear is configured (no GitHub token), no tab bar is shown — Linear issues are displayed directly.

**Preconditions**:
- `issues.providerStatus` returns `{ configured: false, provider: null, linearConfigured: true, linearTeamSelected: true }`
- `linear.fetchIssues` returns 2 issues

**Test Steps**:
1. Render `<IssuesPage />`
2. `await waitFor` for issues to load

**Expected Result**:
- No tab buttons are rendered
- Linear issues are shown directly

---

#### TC-303: IssuesPage shows "Configure an issue tracker" when neither provider is configured

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When neither GitHub nor Linear is configured, a prompt to configure an issue tracker is shown.

**Preconditions**:
- `issues.providerStatus` returns `{ configured: false, provider: null, linearConfigured: false, linearTeamSelected: false }`

**Test Steps**:
1. Render `<IssuesPage />`
2. `await waitFor` for status to load

**Expected Result**:
- A message containing "Configure" and "Settings" is visible
- No issue list is shown
- No tab bar is shown

---

#### TC-304: IssuesPage switches to Linear tab and fetches Linear issues

| Field | Value |
|-------|-------|
| **Requirement** | FR-007, FR-004 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Clicking the "Linear" tab triggers `linear.fetchIssues` and shows Linear-specific issue cards.

**Preconditions**:
- Both providers configured
- `linear.fetchIssues` returns 2 issues with `identifier: "LIN-1"` and `identifier: "LIN-2"`

**Test Steps**:
1. Render `<IssuesPage />` (defaults to GitHub tab)
2. Click "Linear" tab
3. `await waitFor` for Linear issues to appear

**Expected Result**:
- "LIN-1" and "LIN-2" identifiers are visible
- `linear.fetchIssues` was called

---

#### TC-305: IssuesPage search field filters issues by title client-side

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Component |
| **Priority** | P1 |

**Description**: Typing in the search field on the Linear tab filters the displayed issues to those matching the query (client-side filter of cached results).

**Preconditions**:
- Linear tab is active with 3 issues: "Fix auth bug", "Update onboarding flow", "Fix payment gateway"
- `linear.fetchIssues` already returned all 3

**Test Steps**:
1. Switch to Linear tab
2. `await waitFor` for issues to load
3. `fireEvent.change` the search input with `"Fix"`
4. Assert visible issues

**Expected Result**:
- Only "Fix auth bug" and "Fix payment gateway" are visible
- "Update onboarding flow" is not rendered
- No additional IPC call is made (client-side filter)

---

#### TC-306: IssuesPage search field filters by identifier

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Component |
| **Priority** | P1 |

**Description**: Searching by identifier (e.g., "LIN-42") filters to matching issues.

**Preconditions**:
- Linear tab active with issues including identifier "LIN-42" and "LIN-100"

**Test Steps**:
1. Type `"LIN-42"` in the search field

**Expected Result**:
- Only "LIN-42" issue is visible
- "LIN-100" is not visible

---

#### TC-307: IssuesPage Linear issue card shows identifier, title, state, and priority

| Field | Value |
|-------|-------|
| **Requirement** | FR-004, FR-011 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Each Linear issue card renders all required fields.

**Preconditions**:
- Linear issue: `{ identifier: "ENG-5", title: "Fix auth timeout", state: { name: "In Progress", type: "started" }, priority: 2 }`

**Test Steps**:
1. Render `<IssuesPage />` on Linear tab with the above issue
2. `await waitFor` for card to render

**Expected Result**:
- "ENG-5" is visible (identifier)
- "Fix auth timeout" is visible (title)
- "In Progress" is visible (state name)
- A "High" priority indicator is visible (priority 2 = High)

---

#### TC-308: IssuesPage priority badge labels map correctly

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Component |
| **Priority** | P1 |

**Description**: Priority numbers 0-4 map to the correct display labels.

**Test Steps**:
1. Render issues with priority 0, 1, 2, 3, 4

**Expected Result**:
- Priority 0: "No priority"
- Priority 1: "Urgent"
- Priority 2: "High"
- Priority 3: "Medium"
- Priority 4: "Low"

---

#### TC-309: IssuesPage remembers selected tab during the component session

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 (P2) |
| **Type** | Component |
| **Priority** | P2 |

**Description**: After switching to the Linear tab, navigating within the component and returning keeps the Linear tab selected.

**Test Steps**:
1. Render `<IssuesPage />` (defaults to GitHub tab)
2. Click "Linear" tab
3. Trigger a re-render (simulating navigation back)
4. Assert active tab

**Expected Result**:
- Linear tab remains selected after re-render (component state is preserved)

---

#### TC-310: IssuesPage refresh button calls fetchIssues with forceRefresh

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 (P2) |
| **Type** | Component |
| **Priority** | P2 |

**Description**: A visible refresh button on the Linear tab calls `fetchIssues({ forceRefresh: true })`.

**Test Steps**:
1. Switch to Linear tab
2. `await waitFor` for issues to load
3. Click the refresh button
4. Assert second IPC call

**Expected Result**:
- `linear.fetchIssues` is called a second time
- Second call includes `{ forceRefresh: true }`

---

#### TC-311: IssuesPage shows network error state with retry button

| Field | Value |
|-------|-------|
| **Requirement** | PM Review Issue #4 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When `fetchIssues` fails, an error message and a retry button are shown.

**Preconditions**:
- `linear.fetchIssues` rejects with `Error("Could not reach Linear")`

**Test Steps**:
1. Render `<IssuesPage />` on Linear tab
2. `await waitFor` for error state

**Expected Result**:
- Error message containing "Could not reach Linear" is visible
- A "Retry" or equivalent button is visible
- Clicking retry re-calls `fetchIssues`

---

### Component Tests — IssuePickerDropdown (multi-provider)

**File**: `src/renderer/src/components/__tests__/IssuePickerDropdown.test.tsx` (extend existing or create)
**Environment**: jsdom

---

#### TC-601: IssuePickerDropdown shows GitHub tab and Linear tab when both configured

| Field | Value |
|-------|-------|
| **Requirement** | FR-008 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: When both providers are configured, the dropdown shows provider tabs inside.

**Preconditions**:
- Provider status: both GitHub and Linear configured

**Test Steps**:
1. Render `<IssuePickerDropdown />` (open state)

**Expected Result**:
- "GitHub" and "Linear" tabs are visible inside the dropdown

---

#### TC-602: IssuePickerDropdown emits IssueRef with provider "linear" on Linear issue selection

| Field | Value |
|-------|-------|
| **Requirement** | FR-008, FR-005 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Selecting a Linear issue from the dropdown calls `onSelect` with `{ provider: "linear", identifier: "LIN-42", title: "...", url: "..." }`.

**Preconditions**:
- Linear tab active with issue `{ identifier: "LIN-42", title: "Fix login", url: "https://linear.app/..." }`

**Test Steps**:
1. Open dropdown
2. Click Linear tab
3. Click the "LIN-42" issue
4. Assert `onSelect` call

**Expected Result**:
- `onSelect` called with `{ provider: "linear", identifier: "LIN-42", title: "Fix login", url: "https://linear.app/..." }`
- NOT a GitHub `IssueRef` shape

---

#### TC-603: IssuePickerDropdown emits IssueRef with provider "github" on GitHub issue selection

| Field | Value |
|-------|-------|
| **Requirement** | FR-008, NFR-COMPAT |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Selecting a GitHub issue calls `onSelect` with `{ provider: "github", number: 42, title: "...", url: "..." }`.

**Preconditions**:
- GitHub tab active with issue `{ number: 42, title: "Fix bug", url: "https://github.com/..." }`

**Test Steps**:
1. Open dropdown (GitHub tab is default)
2. Click GitHub issue #42
3. Assert `onSelect` call

**Expected Result**:
- `onSelect` called with `{ provider: "github", number: 42, title: "Fix bug", url: "https://github.com/..." }`

---

#### TC-604: IssuePickerDropdown shows issues directly (no tabs) when only one provider configured

| Field | Value |
|-------|-------|
| **Requirement** | FR-008 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Single-provider mode does not render tab buttons — issues are shown directly.

**Preconditions**:
- Only Linear is configured (no GitHub token)

**Test Steps**:
1. Open dropdown

**Expected Result**:
- No "GitHub" tab button is rendered
- No "Linear" tab button is rendered
- Linear issues are displayed directly

---

#### TC-605: IssuePickerDropdown displays selected Linear issue identifier in trigger

| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: After selecting a Linear issue, the trigger/button area shows the Linear identifier (e.g., "LIN-42"), not a GitHub-style "#42".

**Test Steps**:
1. Select Linear issue with `identifier: "LIN-42"` from the picker
2. Assert trigger display text

**Expected Result**:
- Trigger shows "LIN-42" (not "#42")

---

### Component Tests — SessionHistoryItem (issue display)

**File**: `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` (extend existing)
**Environment**: jsdom

---

#### TC-321: SessionHistoryItem shows Linear issue badge for sessions with issueProvider "linear"

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: A session with `issueProvider: "linear"` and `issueId: "LIN-42"` renders the Linear identifier as a clickable badge.

**Preconditions**:
```typescript
const session = {
  ...baseSession,
  issueProvider: "linear",
  issueId: "LIN-42",
  issueTitle: "Fix auth timeout",
  issueUrl: "https://linear.app/team/LIN-42",
  issueNumber: null
};
```

**Test Steps**:
1. Render `<SessionHistoryItem session={session} onDelete={vi.fn()} />`
2. Assert badge presence

**Expected Result**:
- Text "LIN-42" is visible
- Text "Fix auth timeout" is visible next to the badge
- "#42" is NOT shown (not a GitHub-style badge)

---

#### TC-322: SessionHistoryItem shows GitHub issue badge for sessions with issueProvider "github"

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: A new-style GitHub session (with both `issueProvider: "github"` and `issueNumber: 42`) renders the GitHub badge.

**Preconditions**:
```typescript
const session = {
  ...baseSession,
  issueProvider: "github",
  issueId: "42",
  issueNumber: 42,
  issueTitle: "Fix bug",
  issueUrl: "https://github.com/owner/repo/issues/42"
};
```

**Test Steps**:
1. Render `<SessionHistoryItem session={session} onDelete={vi.fn()} />`

**Expected Result**:
- Text "#42" is visible
- Text "Fix bug" is visible

---

#### TC-323: SessionHistoryItem shows legacy GitHub issue badge (issueProvider null, issueNumber set)

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT, FR-006 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Legacy sessions (pre-migration) with `issueProvider: null` but `issueNumber: 7` fall back to the legacy display.

**Preconditions**:
```typescript
const session = {
  ...baseSession,
  issueProvider: null,
  issueId: null,
  issueNumber: 7,
  issueTitle: "Old GitHub issue",
  issueUrl: "https://github.com/owner/repo/issues/7"
};
```

**Test Steps**:
1. Render `<SessionHistoryItem session={session} onDelete={vi.fn()} />`

**Expected Result**:
- Text "#7" is visible (fallback to `issueNumber`)
- Text "Old GitHub issue" is visible

---

#### TC-324: SessionHistoryItem shows no issue badge for sessions without linked issues

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Sessions with no issue linked show no badge at all.

**Preconditions**:
```typescript
const session = {
  ...baseSession,
  issueProvider: null,
  issueId: null,
  issueNumber: null,
  issueTitle: null,
  issueUrl: null
};
```

**Test Steps**:
1. Render `<SessionHistoryItem session={session} onDelete={vi.fn()} />`

**Expected Result**:
- No issue badge, identifier, or issue title is visible
- Session title still renders correctly

---

#### TC-325: SessionHistoryItem issue badge opens URL in browser on click

| Field | Value |
|-------|-------|
| **Requirement** | FR-020 (P2) |
| **Type** | Component |
| **Priority** | P2 |

**Description**: Clicking the issue badge calls `shell.openExternal` with the issue URL.

**Preconditions**:
- Session has `issueProvider: "linear"`, `issueUrl: "https://linear.app/team/LIN-42"`
- `window.electronAPI.shell.openExternal` is mocked

**Test Steps**:
1. Render `<SessionHistoryItem session={linearSession} onDelete={vi.fn()} />`
2. Click the "LIN-42" badge

**Expected Result**:
- `window.electronAPI.shell.openExternal` was called with `"https://linear.app/team/LIN-42"`

---

### Component Tests — ProviderTabs

**File**: `src/renderer/src/components/__tests__/ProviderTabs.test.tsx` (new file)
**Environment**: jsdom

---

#### TC-351: ProviderTabs renders correct tab labels

| Field | Value |
|-------|-------|
| **Requirement** | FR-007, FR-008 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: `<ProviderTabs>` renders tab buttons for the specified providers.

**Test Steps**:
1. Render `<ProviderTabs providers={["github", "linear"]} activeProvider="github" onSwitch={vi.fn()} />`

**Expected Result**:
- "GitHub" tab button is rendered
- "Linear" tab button is rendered
- "GitHub" tab has active styling

---

#### TC-352: ProviderTabs calls onSwitch with the clicked provider

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P0 |

**Description**: Clicking the "Linear" tab calls `onSwitch("linear")`.

**Test Steps**:
1. Render `<ProviderTabs providers={["github", "linear"]} activeProvider="github" onSwitch={onSwitch} />`
2. Click "Linear" tab
3. Assert `onSwitch` call

**Expected Result**:
- `onSwitch` was called with `"linear"`

---

---

## 4. Integration Tests

**File**: `electron/main/__tests__/linear-integration.test.ts` (new file)
**Environment**: `// @vitest-environment node`
**Note**: These tests exercise the IPC handler functions directly with mocked dependencies, without a full Electron process.

---

#### TC-701: IPC round-trip: save Linear token, fetch issues, save session, list sessions

| Field | Value |
|-------|-------|
| **Requirements** | FR-001, FR-004, FR-005, FR-006 |
| **Type** | Integration |
| **Priority** | P0 |

**Description**: Full happy-path flow: save token -> provider initialized -> fetch issues -> save session with Linear issue -> list sessions shows Linear issue.

**Preconditions**:
- In-memory database initialized
- `LinearProvider.fetchIssues` mocked (or injected mock provider) to return issues
- Token storage mocked

**Test Steps**:
1. Call `handleLinearSetToken({ token: "lin_key" })`
2. Call `handleLinearFetchIssues({ teamId: "team-1", forceRefresh: false })`
3. Call `handleSessionSave({ title: "Work", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500, issueProvider: "linear", issueId: "LIN-42", issueTitle: "Fix auth", issueUrl: "https://linear.app/..." })`
4. Call `handleSessionList({ limit: 10, offset: 0 })`

**Expected Result**:
- Sessions list contains 1 session
- `sessions[0].issueProvider === "linear"`
- `sessions[0].issueId === "LIN-42"`

---

#### TC-702: Backward compat: existing GitHub sessions still display correctly after migration

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT |
| **Type** | Integration |
| **Priority** | P0 |

**Description**: Sessions saved with the old schema (only `issue_number`) continue to be listed correctly after the database migration runs.

**Test Steps**:
1. Initialize database in-memory
2. Insert a session row directly with `issue_number = 10, issue_title = "Old issue", issue_provider = NULL, issue_id = NULL`
3. Call `listSessions({})` via the exported function

**Expected Result**:
- `sessions[0].issueNumber === 10`
- `sessions[0].issueTitle === "Old issue"`
- `sessions[0].issueProvider === null`
- `sessions[0].issueId === null`
- No error thrown

---

#### TC-703: Linear provider registry: both GitHub and Linear providers can be active simultaneously

| Field | Value |
|-------|-------|
| **Requirement** | FR-007, FR-008 |
| **Type** | Integration |
| **Priority** | P0 |

**Description**: The provider registry allows both `getGitHubProvider()` and `getLinearProvider()` to return active providers at the same time.

**Preconditions**:
- Both providers initialized with mock tokens

**Test Steps**:
1. Initialize GitHub provider with token "gh_token"
2. Initialize Linear provider with token "lin_token"
3. Call `getGitHubProvider()`
4. Call `getLinearProvider()`

**Expected Result**:
- Both return non-null provider instances
- `getGitHubProvider().providerName === "github"`
- `getLinearProvider()` is an instance of `LinearProvider`

---

#### TC-704: Deleting Linear token destroys the Linear provider

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Integration |
| **Priority** | P1 |

**Description**: After `handleLinearDeleteToken()` is called, `getLinearProvider()` returns null and the token file is removed.

**Test Steps**:
1. Initialize Linear provider
2. Call `handleLinearDeleteToken()`
3. Call `getLinearProvider()`
4. Assert token file removed

**Expected Result**:
- `getLinearProvider()` returns `null`
- `deleteToken("linear")` was called

---

#### TC-705: Settings persistence: linear_team_id and linear_team_name saved and retrieved

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Integration |
| **Priority** | P0 |

**Description**: Setting a Linear team via IPC persists to the settings table and can be retrieved.

**Test Steps**:
1. `initDatabase(":memory:")`
2. Call `handleLinearSetTeam({ teamId: "t1", teamName: "Engineering" })`
3. Call `handleLinearGetTeam()`

**Expected Result**:
- Returns `{ teamId: "t1", teamName: "Engineering" }`

---

---

## 5. Edge Cases and Boundaries

| Category | Test Case | Input | Expected |
|----------|-----------|-------|----------|
| Empty state | Zero teams in workspace | `listTeams()` returns `[]` | Settings shows "No teams found" message, no crash (TC-107, TC-217) |
| Empty state | Single team in workspace | `listTeams()` returns 1 team | Team is auto-selected, no picker shown (TC-216) |
| Empty state | Linear configured, no issues in team | `fetchIssues()` returns `[]` | Empty state message shown, no crash (TC-202) |
| Provider state | Neither provider configured | Both status checks return unconfigured | Generic "Configure issue tracker in Settings" shown (TC-303) |
| Provider state | Only Linear configured | GitHub status returns unconfigured | No tab bar, Linear issues shown directly (TC-302) |
| Provider state | Only GitHub configured | Linear status returns unconfigured | No tab bar, GitHub issues shown directly (TC-302) |
| Search | Empty search query | `""` | All issues shown (no filter applied) |
| Search | Query matches no issues | `"XXXXXXX"` | Empty list shown within the search results, not an error state |
| Search | Case-insensitive search | `"fix"` | Matches "Fix auth" and "FIX login" |
| Boundary | Issue identifier format | `"LIN-1"` (low number) | Displays correctly |
| Boundary | Issue identifier format | `"ENG-99999"` (high number) | Displays correctly |
| Boundary | Priority range | Priority 0, 1, 2, 3, 4 | All map to correct labels (TC-308) |
| Security | API key in IPC response | Any IPC call returns data | Key string never appears in response (TC-114) |
| Error | Network timeout | `fetch` takes > timeout | Throws `NETWORK_ERROR`, shows retry button (TC-311) |
| Error | GraphQL partial errors | Response has `data` and `errors` | Uses `data` if available, or throws on errors (TC-105) |
| Backward compat | Legacy session with `issueNumber` | Session has `issueProvider: null` | Displays `#N` badge correctly (TC-323) |
| Backward compat | Session with no issues | `issueNumber: null`, `issueProvider: null` | No badge shown (TC-324) |
| Validation | Invalid `issueProvider` value | `issueProvider: "jira"` | Rejected by `saveSession` validation (TC-153) |
| Validation | Empty Linear API key | `setToken({ token: "" })` | IPC handler rejects, settings page shows error |

---

## 6. Security Tests

| Test | Description | Expected | Test Case |
|------|-------------|----------|-----------|
| API key storage | Linear API key is encrypted at rest | Key stored via `safeStorage.encryptString`, not plaintext | TC-122 |
| API key isolation | API key never returned from IPC | None of the `linear:*` IPC handler return values include the API key | TC-114 |
| API key header format | Authorization header has no "Bearer" prefix | `Authorization: <key>` not `Authorization: Bearer <key>` | TC-101 |
| External URL | `shell.openExternal` only called for Linear URLs | URL must start with `https://linear.app/` (or validated scheme) | TC-325 |
| Input validation | `issueProvider` whitelisted in `saveSession` | Rejects `"jira"`, `"asana"`, any non-allowed value | TC-153 |
| IPC trust boundary | Renderer cannot read `.linear-token` file | Main process holds token, only result of operations is returned | Architectural (TC-114) |

---

## 7. Performance Tests

| Test | Scenario | Threshold | Test Case |
|------|----------|-----------|-----------|
| `fetchIssues` with 100 issues | Normal load | Response stored in cache within 100ms of mock response | TC-109 |
| `listSessions` with 1000 sessions including issue columns | Extended pagination query | Query completes in under 500ms | Extend TC-405 pattern from existing database.test.ts |
| Client-side search filter | Filter 100 issues by query string | Filter completes within single render cycle (< 16ms) | TC-305 |
| Cache hit | Second `fetchIssues` call for same team | No network call made (cache avoids latency) | TC-109 |

---

## 8. Test Data Requirements

| Data Set | Purpose | Source |
|----------|---------|--------|
| Mock Linear issue objects | Component and hook tests | Inline fixtures in test files; follow `LinearIssue` type shape |
| Mock Linear team objects | Settings and team picker tests | Inline fixtures; follow `LinearTeam` type shape |
| Legacy session rows (issue_number only) | Backward compat tests | Inserted directly via raw SQL in database tests |
| Mock GraphQL responses | LinearProvider unit tests | Inline JSON objects matching expected GraphQL response shape |
| In-memory SQLite database | All database tests | `initDatabase(":memory:")` with better-sqlite3 shim |

### Mock LinearIssue Fixture
```typescript
const mockLinearIssue: LinearIssue = {
  id: "issue-uuid-1",
  identifier: "ENG-42",
  title: "Fix authentication timeout on mobile",
  url: "https://linear.app/team/issue/ENG-42",
  priority: 2,
  state: { name: "In Progress", type: "started" },
  updatedAt: "2026-02-23T10:00:00.000Z",
};
```

### Mock LinearTeam Fixtures
```typescript
const mockTeams: LinearTeam[] = [
  { id: "team-1", name: "Engineering", key: "ENG" },
  { id: "team-2", name: "Design", key: "DES" },
];
```

### Mock electronAPI Extension (for renderer tests)
```typescript
const mockElectronAPI = {
  // ... existing session, settings, issues, shell mocks ...
  linear: {
    setToken: vi.fn().mockResolvedValue(undefined),
    deleteToken: vi.fn().mockResolvedValue(undefined),
    testConnection: vi.fn().mockResolvedValue({ displayName: "Jane Dev" }),
    listTeams: vi.fn().mockResolvedValue(mockTeams),
    setTeam: vi.fn().mockResolvedValue(undefined),
    getTeam: vi.fn().mockResolvedValue({ teamId: "team-1", teamName: "Engineering" }),
    fetchIssues: vi.fn().mockResolvedValue([mockLinearIssue]),
    providerStatus: vi.fn().mockResolvedValue({ configured: true, teamSelected: true, teamName: "Engineering" }),
  },
};
```

---

## 9. Test Environment

| Environment | Purpose | Config |
|-------------|---------|--------|
| Unit (node) | Main process tests: LinearProvider, database, token-storage | `// @vitest-environment node` directive; `better-sqlite3` aliased to shim via `vitest.config.ts` |
| Unit (jsdom) | Renderer tests: hooks, components | Default jsdom environment; `window.electronAPI` mocked via `vi.stubGlobal` |
| Integration (node) | IPC handler round-trips | `// @vitest-environment node`; inline mock providers |

### Running Tests
```bash
# All tests
bun run test

# Single file (main process)
bun vitest run electron/main/__tests__/linear-provider.test.ts

# Single file (renderer)
bun vitest run src/renderer/src/components/__tests__/IssuesPage.test.tsx

# Watch mode
bun run test:watch
```

### Key Patterns to Follow
- Main process tests MUST use `// @vitest-environment node` directive at top of file
- Database tests MUST call `initDatabase(":memory:")` in `beforeEach` and `closeDatabase()` in `afterEach`
- Renderer tests MUST mock `window.electronAPI` via `vi.stubGlobal("electronAPI", mockElectronAPI)` in `beforeEach`
- Fetch mocking: `vi.spyOn(global, "fetch").mockResolvedValue(...)` in node environment tests
- All async assertions MUST use `await waitFor(...)` from `@testing-library/react`

---

## 10. Acceptance Criteria Verification

| AC ID | Acceptance Criteria (from PRD) | Test Cases | Pass Criteria |
|-------|-------------------------------|------------|---------------|
| AC-001 | Enter valid Linear API key and save → key stored, Linear issues become available | TC-121, TC-122, TC-212, TC-701 | `setToken` called, provider initialized, issues fetchable |
| AC-002 | Click "Test Connection" → display name shown on success, error on failure | TC-102, TC-103, TC-213, TC-214 | Success: display name rendered. Failure: error message rendered |
| AC-003 | Open team selection → list of teams from workspace shown, one selectable | TC-106, TC-215, TC-216 | Team list rendered, selection calls `setTeam` |
| AC-004 | Open Issues sidebar on Linear tab → list of open issues with identifier, title, status, priority | TC-304, TC-307, TC-308 | All 4 fields visible per issue card |
| AC-005 | Save session with selected Linear issue → session stores Linear issue reference | TC-151, TC-602, TC-701 | `issueProvider: "linear"`, `issueId: "LIN-N"` stored in DB |
| AC-006 | View session history → Linear issue identifier and title shown for linked sessions | TC-321, TC-322, TC-323 | Badge with identifier and title visible |
| AC-007 | Both GitHub and Linear configured → tabs visible in sidebar, can switch | TC-301, TC-304 | Both tabs render, Linear tab switches to Linear issues |
| AC-008 | Both providers configured → issue picker shows both options | TC-601, TC-602, TC-603 | Tab switching works, correct `IssueRef` emitted |
| AC-009 | Type in search field → list filters to matching issues | TC-305, TC-306 | Non-matching issues disappear, matching issues remain |
| AC-010 | Priority and status labels visible per issue | TC-307, TC-308 | State name and priority label visible per card |
| AC-011 | Click "Disconnect" → API key and team removed, Linear not shown | TC-113, TC-205, TC-218 | `deleteToken` called, UI returns to unconfigured state |
| AC-012 | Legacy sessions with `issue_number` display correctly after migration | TC-323, TC-702 | "#N" badge shown for pre-existing sessions |

---

## 11. Test Summary

| Type | Count | P0 | P1 | P2 |
|------|-------|----|----|----|
| Unit (LinearProvider) | 14 | 9 | 4 | 1 |
| Unit (token-storage) | 8 | 6 | 2 | 0 |
| Unit (database) | 7 | 6 | 1 | 0 |
| Unit (useLinearIssues) | 4 | 3 | 1 | 0 |
| Component (SettingsPage) | 8 | 5 | 3 | 0 |
| Component (IssuesPage) | 11 | 6 | 3 | 2 |
| Component (IssuePickerDropdown) | 5 | 4 | 0 | 1 |
| Component (SessionHistoryItem) | 5 | 4 | 0 | 1 |
| Component (ProviderTabs) | 2 | 2 | 0 | 0 |
| Integration | 5 | 4 | 1 | 0 |
| **Total** | **69** | **49** | **15** | **5** |

### File Locations

| Test File | New or Extended |
|-----------|----------------|
| `electron/main/issue-providers/__tests__/linear-provider.test.ts` | New |
| `electron/main/issue-providers/__tests__/token-storage.test.ts` | New |
| `electron/main/__tests__/database.test.ts` | Extended (TC-141 through TC-156) |
| `electron/main/__tests__/linear-integration.test.ts` | New |
| `src/renderer/src/hooks/__tests__/useLinearIssues.test.ts` | New |
| `src/renderer/src/components/__tests__/SettingsPage.test.tsx` | Extended |
| `src/renderer/src/components/__tests__/IssuesPage.test.tsx` | Extended |
| `src/renderer/src/components/__tests__/IssuePickerDropdown.test.tsx` | Extended |
| `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` | Extended (TC-321 through TC-325) |
| `src/renderer/src/components/__tests__/ProviderTabs.test.tsx` | New |