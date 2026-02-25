# Test Plan

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Work Time Logging (Jira Worklog Integration) |
| **Author** | Artemis (QA Agent) |
| **Date** | 2026-02-24 |
| **PRD Version** | 1.0 |
| **Tech Spec Version** | Draft (2026-02-24) |

---

## 1. Test Overview

### Scope
This test plan covers all changes required to implement the Jira Worklog Integration feature:
- Database migration adding `worklog_status` and `worklog_id` columns to the `sessions` table
- New `getSessionById()` and `updateWorklogStatus()` database functions
- `JiraProvider.addWorklog()` method and `request()` refactoring for POST support
- `worklog:log` IPC handler with input validation and error handling
- `SessionHistoryItem` component worklog UI (Log Work button, Logged indicator, Retry button, loading state)
- `useSessionHistory` hook `logWork()` function and `worklogLoading` state
- `SessionHistory` component toast notification system
- `worklog` namespace in preload contextBridge

### Out of Scope
- Settings toggle for worklog feature (FR-010, deferred to post-V1)
- Worklog comment customization (FR-020, P2, excluded from V1)
- Duration preview before logging (FR-021, P2, excluded from V1)
- Worklog editing, deletion, or bulk operations (explicitly excluded in PRD)
- Linear and GitHub Issues worklog (no worklog API exists for these providers)
- Automated E2E tests against a live Jira instance (requires external infrastructure)

### Test Approach
Tests are organized in three layers following the existing project patterns:

1. **Unit tests (node environment)** - Database functions and Jira provider methods in isolation using `initDatabase(":memory:")` and `vi.spyOn(global, "fetch")`. Files live in `__tests__/` directories alongside source.
2. **Unit tests (jsdom environment)** - React components and hooks using `@testing-library/react`, mocking `window.electronAPI` via `vi.stubGlobal`.
3. **Integration tests (node environment)** - IPC handler logic tested with a real in-memory SQLite database and mocked Jira provider calls, exercising the full `worklog:log` handler pipeline.

All test files use explicit `.ts`/`.tsx` import extensions, named imports, and the `bun vitest run` test runner. Test IDs follow the existing numbering convention with a `WL-` prefix (Work Log).

---

## 2. Requirements Coverage Matrix

| Req ID | Requirement | Test Cases | Priority |
|--------|-------------|------------|----------|
| FR-001 | "Log Work" button on Jira-linked session cards | TC-WL-201, TC-WL-202, TC-WL-203, TC-WL-204 | P0 |
| FR-002 | Worklog status tracking per session | TC-WL-205, TC-WL-206, TC-WL-207 | P0 |
| FR-003 | Non-blocking error handling | TC-WL-301, TC-WL-302, TC-WL-303, TC-WL-401, TC-WL-402 | P0 |
| FR-004 | Retry on failure | TC-WL-208, TC-WL-304 | P0 |
| FR-005 | New database columns for worklog status | TC-WL-101, TC-WL-102, TC-WL-103, TC-WL-104 | P0 |
| FR-006 | Store Jira worklog ID on success | TC-WL-108, TC-WL-305 | P0 |
| FR-011 | Loading state during worklog submission | TC-WL-209, TC-WL-210 | P1 |
| FR-012 | Success confirmation (toast) | TC-WL-403, TC-WL-404 | P1 |
| NFR: Async IPC | Worklog does not block UI thread | TC-WL-306 | P0 |
| NFR: Duplicate prevention | Already-logged sessions cannot be re-logged | TC-WL-107, TC-WL-203, TC-WL-307 | P0 |
| NFR: Cloud v3 + Server v2 | ADF comment for Cloud, plain string for Server | TC-WL-151, TC-WL-152 | P0 |
| NFR: Idempotent migration | Migration runs safely on existing databases | TC-WL-102 | P0 |
| NFR: Session save independence | Session save is unaffected by worklog failures | TC-WL-308 | P0 |
| NFR: Minimum 60s | Sessions under 60s do not show Log Work button | TC-WL-204, TC-WL-309 | P0 |

---

## 3. Test Cases

### Unit Tests — Database Layer

**File**: `electron/main/__tests__/database.test.ts`
**Environment**: `// @vitest-environment node`
**Setup**: `initDatabase(":memory:")` in `beforeEach`, `closeDatabase()` in `afterEach`

---

#### TC-WL-101: Migration adds worklog_status and worklog_id columns
| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Fresh in-memory database initialized via `initDatabase(":memory:")`

**Test Steps**:
1. Call `saveSession({ title: "Test", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500 })`
2. Verify the returned `Session` object has `worklogStatus` field equal to `"not_logged"`
3. Verify the returned `Session` object has `worklogId` field equal to `null`
4. Call `listSessions({})` and verify `sessions[0].worklogStatus === "not_logged"`
5. Verify `sessions[0].worklogId === null`

**Expected Result**:
- New sessions default to `worklogStatus: "not_logged"` and `worklogId: null`
- Both fields are present in the returned `Session` object from `saveSession()`
- Both fields are present in the results returned from `listSessions()`

---

#### TC-WL-102: Migration is idempotent (running twice does not throw)
| Field | Value |
|-------|-------|
| **Requirement** | FR-005, NFR: Idempotent migration |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Database initialized once via `initDatabase(":memory:")`

**Test Steps**:
1. Call `closeDatabase()`
2. Call `initDatabase(":memory:")` a second time
3. Verify no error is thrown
4. Call `saveSession(...)` and verify it succeeds normally

**Expected Result**:
- Second call to `initDatabase()` does not throw
- The `cols.includes("worklog_status")` guard prevents duplicate `ALTER TABLE` execution
- Database is fully functional after double-init

---

#### TC-WL-103: getSessionById returns session with worklog fields
| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Fresh in-memory database
- One session saved via `saveSession()`

**Test Steps**:
1. Save a session and capture its `id`
2. Call `getSessionById(id)`
3. Verify the returned session has all standard `Session` fields populated correctly
4. Verify `worklogStatus === "not_logged"` and `worklogId === null`
5. Call `getSessionById("non-existent-uuid")`
6. Verify it returns `null`

**Expected Result**:
- `getSessionById(id)` returns the full `Session` object including `worklogStatus` and `worklogId`
- `getSessionById("non-existent")` returns `null` without throwing

---

#### TC-WL-104: getSessionById returns session with tags
| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Session saved with associated tags

**Test Steps**:
1. Save a session, attach a tag to it
2. Call `getSessionById(id)`
3. Verify the `tags` array is populated on the returned session

**Expected Result**:
- Tags are included in the session returned by `getSessionById()`

---

#### TC-WL-105: updateWorklogStatus sets status to 'logged' and stores worklog ID
| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Session saved in database with `worklog_status = 'not_logged'`

**Test Steps**:
1. Save a session and capture its `id`
2. Call `updateWorklogStatus(id, "logged", "10042")`
3. Call `getSessionById(id)`
4. Verify `worklogStatus === "logged"`
5. Verify `worklogId === "10042"`

**Expected Result**:
- `worklog_status` is updated to `"logged"` in the database
- `worklog_id` is stored as `"10042"`

---

#### TC-WL-106: updateWorklogStatus sets status to 'failed' without worklog ID
| Field | Value |
|-------|-------|
| **Requirement** | FR-003, FR-004 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Session saved in database

**Test Steps**:
1. Save a session and capture its `id`
2. Call `updateWorklogStatus(id, "failed")`
3. Call `getSessionById(id)`
4. Verify `worklogStatus === "failed"`
5. Verify `worklogId === null`

**Expected Result**:
- Status is set to `"failed"`
- `worklog_id` remains `null` when `worklogId` parameter is omitted

---

#### TC-WL-107: updateWorklogStatus does not overwrite a logged session's worklog_id
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Duplicate prevention |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Session in `logged` state with `worklogId = "10042"`

**Test Steps**:
1. Save a session, call `updateWorklogStatus(id, "logged", "10042")`
2. Call `updateWorklogStatus(id, "failed")` (simulating a second attempt)
3. Call `getSessionById(id)`
4. Verify `worklogStatus === "failed"` (status is overwritten)
5. Verify `worklogId === null` (worklog_id is NOT preserved when no worklogId param passed)

**Note**: The IPC handler guards against calling `updateWorklogStatus` on already-logged sessions. This test verifies the DB function behavior at the data layer level — the handler must not reach this path. Separate integration tests (TC-WL-307) verify the guard.

---

#### TC-WL-108: listSessions returns worklog fields for all sessions
| Field | Value |
|-------|-------|
| **Requirement** | FR-002, FR-006 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Multiple sessions in various worklog states

**Test Steps**:
1. Save three sessions
2. Call `updateWorklogStatus(session1.id, "logged", "10042")`
3. Call `updateWorklogStatus(session2.id, "failed")`
4. Leave session3 at default (`not_logged`)
5. Call `listSessions({})`
6. Verify `sessions[0].worklogStatus` and `sessions[0].worklogId` are correct for each session

**Expected Result**:
- `listSessions()` returns all three sessions with their respective `worklogStatus` and `worklogId` values
- Logged session has `worklogStatus: "logged"` and `worklogId: "10042"`
- Failed session has `worklogStatus: "failed"` and `worklogId: null`
- Default session has `worklogStatus: "not_logged"` and `worklogId: null`

---

#### TC-WL-109: saveSession return value includes worklog default fields
| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/database.test.ts` |

**Preconditions**:
- Fresh in-memory database

**Test Steps**:
1. Call `saveSession({ title: "Test", timerType: "work", plannedDurationSeconds: 1500, actualDurationSeconds: 1500 })`
2. Verify the returned session object contains `worklogStatus: "not_logged"`
3. Verify the returned session object contains `worklogId: null`

**Expected Result**:
- `saveSession()` return value satisfies the full `Session` interface including the new worklog fields

---

### Unit Tests — Jira Provider Layer

**File**: `electron/main/issue-providers/__tests__/jira-provider.test.ts`
**Environment**: `// @vitest-environment node`
**Setup**: Use `vi.spyOn(global, "fetch")` to mock HTTP calls; restore mocks in `afterEach`

---

#### TC-WL-151: addWorklog sends correct request for Jira Cloud v3 (ADF comment)
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Cloud v3 + Server v2 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- `JiraProvider` initialized with Cloud credentials (`authType: "cloud"`)

**Test Steps**:
1. Spy on `global.fetch` to return `{ ok: true, status: 201, json: () => Promise.resolve({ id: "10042", timeSpentSeconds: 1500 }) }`
2. Call `provider.addWorklog("PROJ-123", 1500, "2026-02-24T09:05:00.000Z", "LizMeter: Fix login bug")`
3. Capture the fetch call arguments
4. Verify the URL is `{baseUrl}/rest/api/3/issue/PROJ-123/worklog`
5. Verify the HTTP method is `POST`
6. Verify `Content-Type: application/json` header is present
7. Verify the request body contains `timeSpentSeconds: 1500`
8. Verify the request body's `comment` is an ADF object: `{ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "LizMeter: Fix login bug" }] }] }`
9. Verify `started` field is present and in Jira timestamp format (ending in `+0000`)
10. Verify the return value is `{ id: "10042" }`

**Expected Result**:
- Cloud v3 requests use the ADF comment format
- `started` timestamp is correctly formatted and included
- Return value contains the worklog ID from the API response

---

#### TC-WL-152: addWorklog sends correct request for Jira Server v2 (plain string comment)
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Cloud v3 + Server v2 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- `JiraProvider` initialized with Server credentials (`authType: "server"`)

**Test Steps**:
1. Spy on `global.fetch` to return success response with `{ id: "20001" }`
2. Call `provider.addWorklog("PROJ-456", 3600, "2026-02-24T08:00:00.000Z", "LizMeter: Review PR")`
3. Parse the request body from the fetch spy
4. Verify the URL is `{baseUrl}/rest/api/2/issue/PROJ-456/worklog`
5. Verify `comment` is a plain string: `"LizMeter: Review PR"` (not an ADF object)
6. Verify `timeSpentSeconds: 3600`

**Expected Result**:
- Server v2 requests use plain string comment format
- Correct API version (`/2/`) is used in the URL

---

#### TC-WL-153: addWorklog formats the started timestamp correctly
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec 8.3 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- `JiraProvider` with Cloud credentials

**Test Steps**:
1. Spy on `global.fetch` to return success
2. Call `provider.addWorklog("PROJ-1", 900, "2026-02-24T10:15:00.000Z", "Test")`
3. Parse the request body
4. Verify `started` value is `"2026-02-24T10:15:00.000+0000"` (ISO with `+0000` suffix, not `Z`)

**Expected Result**:
- `formatJiraTimestamp()` correctly converts `Z`-suffixed ISO strings to Jira format with `+0000`

---

#### TC-WL-154: addWorklog returns worklog ID from API response
| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy returns `{ id: "10042", timeSpentSeconds: 1500, started: "..." }`

**Test Steps**:
1. Call `provider.addWorklog("PROJ-1", 1500, "...", "Test")`
2. Verify return value is `{ id: "10042" }`
3. Verify the `id` is cast to string (Jira may return numeric IDs in some versions)

**Expected Result**:
- `addWorklog()` returns `{ id: "10042" }` as a string

---

#### TC-WL-155: addWorklog throws IssueProviderError with AUTH_FAILED on 401
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy returns `{ ok: false, status: 401 }`

**Test Steps**:
1. Spy on `global.fetch` to return a 401 response
2. Call `provider.addWorklog("PROJ-1", 1500, "...", "Test")`
3. Verify it rejects with `IssueProviderError`
4. Verify `error.code === "AUTH_FAILED"`

**Expected Result**:
- 401 response triggers `AUTH_FAILED` error code

---

#### TC-WL-156: addWorklog throws IssueProviderError with AUTH_FAILED on 403
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy returns `{ ok: false, status: 403 }`

**Test Steps**:
1. Spy on `global.fetch` to return a 403 response
2. Call `provider.addWorklog("PROJ-1", 1500, "...", "Test")`
3. Verify it rejects with `IssueProviderError` and `code === "AUTH_FAILED"`

**Expected Result**:
- 403 response triggers `AUTH_FAILED` (insufficient worklog permission)

---

#### TC-WL-157: addWorklog throws IssueProviderError with NOT_FOUND on 404
| Field | Value |
|-------|-------|
| **Requirement** | FR-003, Tech Spec Section 4 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy returns `{ ok: false, status: 404 }`

**Test Steps**:
1. Spy on `global.fetch` to return a 404 response
2. Call `provider.addWorklog("DELETED-1", 1500, "...", "Test")`
3. Verify it rejects with `IssueProviderError` and `code === "NOT_FOUND"`

**Expected Result**:
- 404 response triggers `NOT_FOUND` error code
- This requires the new 404 handling added to `request()`

---

#### TC-WL-158: addWorklog throws IssueProviderError with RATE_LIMITED on 429
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy returns `{ ok: false, status: 429 }`

**Test Steps**:
1. Spy on `global.fetch` to return a 429 response
2. Call `provider.addWorklog("PROJ-1", 1500, "...", "Test")`
3. Verify it rejects with `IssueProviderError` and `code === "RATE_LIMITED"`

**Expected Result**:
- 429 response triggers `RATE_LIMITED` error code

---

#### TC-WL-159: addWorklog throws IssueProviderError with NETWORK_ERROR on fetch failure
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy rejects with `TypeError("Failed to fetch")`

**Test Steps**:
1. Spy on `global.fetch` to throw `new TypeError("Failed to fetch")`
2. Call `provider.addWorklog("PROJ-1", 1500, "...", "Test")`
3. Verify it rejects with `IssueProviderError` and `code === "NETWORK_ERROR"`

**Expected Result**:
- Network failure wraps in `NETWORK_ERROR` error code

---

#### TC-WL-160: request() method regression — GET requests still work after refactor
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec Section 8.3 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Fetch spy returns a valid Jira issue search response

**Test Steps**:
1. Spy on `global.fetch` to return a valid search response
2. Call `provider.fetchIssues("PROJ")` (which uses `request()` internally as a GET)
3. Verify the request was made as a `GET` with no `Content-Type` header and no body
4. Verify results are returned correctly (regression check)

**Expected Result**:
- The `request()` refactoring does not break existing GET behavior
- No `Content-Type` header or body on GET requests

---

#### TC-WL-161: addWorklog uses comment with session title when title is provided
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec Section 8.4 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `electron/main/issue-providers/__tests__/jira-provider.test.ts` |

**Preconditions**:
- Provider initialized for Cloud v3

**Test Steps**:
1. Call `provider.addWorklog("PROJ-1", 1500, "...", "LizMeter: Fix login bug")`
2. Verify the ADF comment text node contains `"LizMeter: Fix login bug"`

**Expected Result**:
- Comment text in the ADF body matches the `comment` argument passed in

---

### Integration Tests — IPC Handler

**File**: `electron/main/__tests__/worklog-ipc.test.ts` (new file, node environment)
**Environment**: `// @vitest-environment node`
**Setup**: `initDatabase(":memory:")` in `beforeEach`, mock `getJiraProvider()` via `vi.mock` or dependency injection

**Note**: The IPC handler logic in `ipc-handlers.ts` should be extracted into a testable `logWorkToJira(input, db, provider)` pure function, or the tests can use `vi.mock` to stub the module-level `getJiraProvider()` and database imports. The exact approach depends on implementation; the test descriptions below assume the handler's core logic is directly invocable.

---

#### TC-WL-301: Handler successfully logs work and updates DB to 'logged'
| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-006 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Components Tested**:
- `worklog:log` IPC handler logic
- `JiraProvider.addWorklog()` (mocked)
- `updateWorklogStatus()` (real, in-memory DB)

**Preconditions**:
- Session exists in database: Jira-linked, `actualDurationSeconds: 1500`, `worklogStatus: "not_logged"`
- `getJiraProvider()` returns a mock provider with `addWorklog()` resolving to `{ id: "10042" }`

**Test Steps**:
1. Initialize in-memory database
2. Save a Jira-linked session (`issueProvider: "jira"`, `issueId: "PROJ-123"`, `actualDurationSeconds: 1500`)
3. Mock the Jira provider to resolve `addWorklog()` with `{ id: "10042" }`
4. Invoke the `worklog:log` handler with `{ sessionId, issueKey: "PROJ-123" }`
5. Verify the handler returns `{ worklogId: "10042" }`
6. Query the session via `getSessionById(sessionId)`
7. Verify `worklogStatus === "logged"` and `worklogId === "10042"`

**Expected Result**:
- Handler returns the worklog ID
- Database is updated with `logged` status and worklog ID

---

#### TC-WL-302: Handler sets status to 'failed' and re-throws on API error
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Components Tested**:
- `worklog:log` IPC handler error path

**Preconditions**:
- Session exists with `worklogStatus: "not_logged"`
- Mock provider `addWorklog()` rejects with `IssueProviderError("Auth failed", "AUTH_FAILED")`

**Test Steps**:
1. Save a Jira-linked session
2. Mock provider to reject with `AUTH_FAILED`
3. Invoke the `worklog:log` handler
4. Verify the handler rejects (re-throws)
5. Verify `getSessionById(sessionId).worklogStatus === "failed"`
6. Verify `getSessionById(sessionId).worklogId === null`

**Expected Result**:
- Handler re-throws the error (so renderer can display a toast)
- Database is updated to `failed` status
- `worklog_id` remains `null`

---

#### TC-WL-303: Handler rejects with INELIGIBLE for sessions with duration < 60s
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Minimum 60s |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Preconditions**:
- Session exists with `actualDurationSeconds: 45`

**Test Steps**:
1. Save a session with `actualDurationSeconds: 45`, `issueProvider: "jira"`, `issueId: "PROJ-1"`
2. Invoke the `worklog:log` handler
3. Verify the handler rejects with `IssueProviderError` with `code === "INELIGIBLE"`
4. Verify `addWorklog()` was NOT called on the mock provider
5. Verify `worklogStatus` remains `"not_logged"` (status is NOT set to `failed` for ineligible sessions)

**Expected Result**:
- Handler throws `INELIGIBLE` before calling the Jira API
- Database is not modified for ineligible sessions

**Edge Cases**:
- Duration of exactly 59s: should throw `INELIGIBLE`
- Duration of exactly 60s: should NOT throw (proceed to API call)

---

#### TC-WL-304: Handler allows retry from 'failed' state
| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Preconditions**:
- Session exists with `worklogStatus: "failed"` (previous attempt failed)
- Mock provider resolves successfully on this attempt

**Test Steps**:
1. Save a session, then set it to `failed` via `updateWorklogStatus(id, "failed")`
2. Mock provider to resolve `{ id: "20001" }`
3. Invoke the `worklog:log` handler
4. Verify the handler returns `{ worklogId: "20001" }`
5. Verify `worklogStatus === "logged"` and `worklogId === "20001"` in the DB

**Expected Result**:
- Sessions in `failed` state are retried successfully using the same `worklog:log` channel

---

#### TC-WL-305: Handler calculates started timestamp from completedAt and actualDurationSeconds
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec Section 8.4 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Preconditions**:
- Session with known `completedAt = "2026-02-24T10:30:00.000Z"` and `actualDurationSeconds = 1500`

**Test Steps**:
1. Save a session with the known timestamps
2. Mock `addWorklog` and capture its arguments
3. Invoke the handler
4. Verify the `started` argument to `addWorklog` equals `"2026-02-24T10:05:00.000Z"` (10:30 minus 25 minutes)

**Expected Result**:
- `started = completedAt - actualDurationSeconds` is correctly computed

---

#### TC-WL-306: Handler is async and does not block the calling thread
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Async IPC |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Test Steps**:
1. Mock `addWorklog` to resolve after a 50ms delay (`new Promise(resolve => setTimeout(resolve, 50))`)
2. Invoke the `worklog:log` handler
3. Verify the handler returns a `Promise` (not a direct value)
4. Await the Promise and verify success

**Expected Result**:
- The handler is an `async` function that returns a Promise
- The API call delay does not block

---

#### TC-WL-307: Handler rejects with INELIGIBLE when session is already 'logged'
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Duplicate prevention |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Preconditions**:
- Session exists with `worklogStatus: "logged"` and `worklogId: "10042"`

**Test Steps**:
1. Save a session and update it to `logged` state with `updateWorklogStatus(id, "logged", "10042")`
2. Invoke the `worklog:log` handler
3. Verify it rejects with `IssueProviderError` and `code === "INELIGIBLE"`
4. Verify `addWorklog()` was NOT called

**Expected Result**:
- Already-logged sessions cannot be logged again via the handler
- `worklogStatus` and `worklogId` remain unchanged

---

#### TC-WL-308: Session save is unaffected if worklog handler fails
| Field | Value |
|-------|-------|
| **Requirement** | FR-003, NFR: Session save independence |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Test Steps**:
1. Save a session via `saveSession(...)` — verify it succeeds
2. Mock provider to throw `NETWORK_ERROR`
3. Invoke the `worklog:log` handler on the saved session — verify it throws
4. Re-query the session via `getSessionById(id)` or `listSessions()`
5. Verify the session still exists in the database with all its original data intact

**Expected Result**:
- The session save and worklog operations are completely independent
- A worklog failure does not corrupt or remove session data

---

#### TC-WL-309: Handler rejects with INELIGIBLE when issueKey does not match a Jira session (boundary)
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Minimum 60s |
| **Type** | Integration |
| **Priority** | P1 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Test Steps**:
1. Save a session with `actualDurationSeconds: 60` (exactly the minimum)
2. Mock provider to resolve successfully
3. Invoke the `worklog:log` handler
4. Verify no `INELIGIBLE` error is thrown
5. Verify the worklog is submitted

**Expected Result**:
- Exactly 60s sessions are eligible (the threshold is `>= 60`, not `> 60`)

---

#### TC-WL-310: Handler throws when no Jira provider is configured
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec Section 8.4 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Test Steps**:
1. Configure `getJiraProvider()` to return `null` (no credentials configured)
2. Save a valid Jira-linked session
3. Invoke the `worklog:log` handler
4. Verify it throws `IssueProviderError` with `code === "NO_TOKEN"`

**Expected Result**:
- Missing credentials produce a clear `NO_TOKEN` error before any DB or API operations

---

#### TC-WL-311: Handler generates comment with session title when title exists
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec Section 8.4 |
| **Type** | Integration |
| **Priority** | P1 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Test Steps**:
1. Save a session with `title: "Fix login bug"` and Jira link
2. Mock `addWorklog` and capture its arguments
3. Invoke the handler
4. Verify the `comment` argument to `addWorklog` is `"LizMeter: Fix login bug"`

**Expected Result**:
- Comment format is `"LizMeter: {title}"` when title is present

---

#### TC-WL-312: Handler generates fallback comment when session has no title
| Field | Value |
|-------|-------|
| **Requirement** | Tech Spec Section 8.4 |
| **Type** | Integration |
| **Priority** | P1 |
| **File** | `electron/main/__tests__/worklog-ipc.test.ts` |

**Test Steps**:
1. Save a session with `title: null` or empty title and Jira link
2. Mock `addWorklog` and capture arguments
3. Invoke the handler
4. Verify the `comment` argument is `"Logged via LizMeter"`

**Expected Result**:
- Fallback comment `"Logged via LizMeter"` is used when no session title exists

---

### Unit Tests — Renderer Components

**File**: `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx`
**Environment**: jsdom (default)
**Setup**: `vi.stubGlobal("electronAPI", mockElectronAPI)` in `beforeEach`

---

#### TC-WL-201: "Log Work" button is visible for Jira-linked sessions with not_logged status
| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `issueId: "PROJ-123"`, `actualDurationSeconds: 1500`, `worklogStatus: "not_logged"`

**Test Steps**:
1. Render `<SessionHistoryItem session={jiraSession} onDelete={vi.fn()} onLogWork={vi.fn()} worklogLoading={false} />`
2. Query for a button matching `"Log Work"` by role or text
3. Verify the button exists in the DOM

**Expected Result**:
- "Log Work" button is rendered for eligible Jira sessions

---

#### TC-WL-202: "Log Work" button is hidden for non-Jira sessions
| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Sessions with `issueProvider: "linear"`, `issueProvider: "github"`, and `issueProvider: null`

**Test Steps**:
1. Render `SessionHistoryItem` for each non-Jira session variant
2. Verify no "Log Work" button is present in any case
3. Verify no worklog-related UI is rendered

**Expected Result**:
- No worklog UI appears for Linear, GitHub, or unlinked sessions

---

#### TC-WL-203: "Log Work" button is hidden when worklogStatus is 'logged'
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Duplicate prevention |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `worklogStatus: "logged"`, `worklogId: "10042"`

**Test Steps**:
1. Render `SessionHistoryItem` with the logged session
2. Verify no "Log Work" button is in the DOM
3. Verify a "Logged" indicator IS present (e.g., green checkmark, text "Logged")
4. Verify the "Logged" indicator is non-interactive (no click handler)

**Expected Result**:
- Already-logged sessions show a non-interactive "Logged" indicator, not a button
- Duplicate logging is prevented at the UI level

---

#### TC-WL-204: "Log Work" button is hidden for sessions shorter than 60 seconds
| Field | Value |
|-------|-------|
| **Requirement** | NFR: Minimum 60s |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `actualDurationSeconds: 45`, `worklogStatus: "not_logged"`

**Test Steps**:
1. Render `SessionHistoryItem` with the short session
2. Verify no "Log Work" button is in the DOM
3. Verify no worklog UI of any kind is rendered

**Expected Result**:
- Sessions below the 60s minimum do not display any worklog UI

**Edge Cases**:
- `actualDurationSeconds: 59`: no button
- `actualDurationSeconds: 60`: button IS shown
- `actualDurationSeconds: 61`: button IS shown

---

#### TC-WL-205: "Logged" indicator is shown for sessions with worklogStatus 'logged'
| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `worklogStatus: "logged"`, `worklogId: "10042"`, `actualDurationSeconds: 1500`

**Test Steps**:
1. Render the component
2. Verify a "Logged" indicator is visible (match by text `"Logged"` or accessible label)
3. Verify the "Log Work" button is NOT in the DOM
4. Verify the "Retry" button is NOT in the DOM

**Expected Result**:
- "Logged" indicator appears exclusively for logged sessions
- No interactive worklog buttons are shown

---

#### TC-WL-206: "Retry" button is shown for sessions with worklogStatus 'failed'
| Field | Value |
|-------|-------|
| **Requirement** | FR-002, FR-004 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `worklogStatus: "failed"`, `actualDurationSeconds: 1500`

**Test Steps**:
1. Render the component
2. Verify a "Retry" button is present (role="button" with text "Retry" or equivalent)
3. Verify the "Log Work" button is NOT in the DOM
4. Verify the "Logged" indicator is NOT in the DOM

**Expected Result**:
- Failed sessions show a "Retry" button instead of "Log Work"

---

#### TC-WL-207: Correct worklog indicator per worklogStatus state
| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Test Steps**:
1. Render the component for each `worklogStatus` value: `not_logged`, `logged`, `failed`
2. Verify exactly the correct UI element is shown in each case:
   - `not_logged` → "Log Work" button
   - `logged` → "Logged" indicator (non-interactive)
   - `failed` → "Retry" button

**Expected Result**:
- Exactly one worklog UI state is displayed per session, matching the `worklogStatus` value

---

#### TC-WL-208: "Retry" button calls onLogWork with correct arguments
| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `issueId: "PROJ-456"`, `worklogStatus: "failed"`

**Test Steps**:
1. Create `onLogWork = vi.fn()`
2. Render `<SessionHistoryItem session={failedSession} onLogWork={onLogWork} worklogLoading={false} />`
3. Click the "Retry" button
4. Verify `onLogWork` was called with `("session-id", "PROJ-456")`

**Expected Result**:
- "Retry" button fires the same `onLogWork(sessionId, issueKey)` callback as "Log Work"

---

#### TC-WL-209: Loading state disables button and shows spinner
| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `worklogStatus: "not_logged"`, `worklogLoading: true`

**Test Steps**:
1. Render `<SessionHistoryItem session={jiraSession} worklogLoading={true} onLogWork={vi.fn()} />`
2. Verify the "Log Work" button is disabled (`aria-disabled` or `disabled` attribute)
3. Verify a loading indicator (spinner) is rendered
4. Click the disabled button
5. Verify `onLogWork` was NOT called

**Expected Result**:
- While `worklogLoading` is `true`, the button is disabled and shows a spinner
- Clicking a disabled loading button does not trigger the callback

---

#### TC-WL-210: "Log Work" button calls onLogWork with sessionId and issueKey
| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Preconditions**:
- Session with `issueProvider: "jira"`, `issueId: "PROJ-123"`, `id: "test-session-uuid"`, `worklogStatus: "not_logged"`, `actualDurationSeconds: 1500`

**Test Steps**:
1. Create `onLogWork = vi.fn()`
2. Render the component with `onLogWork={onLogWork}` and `worklogLoading={false}`
3. Click the "Log Work" button
4. Verify `onLogWork` was called exactly once with `("test-session-uuid", "PROJ-123")`

**Expected Result**:
- "Log Work" button fires `onLogWork(sessionId, issueKey)` with the correct IDs

---

### Unit Tests — Renderer Hook

**File**: `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts`
**Environment**: jsdom (default)
**Setup**: `vi.stubGlobal("electronAPI", mockElectronAPI)` with `worklog: { log: vi.fn() }` added to mock

---

#### TC-WL-401: logWork calls worklog:log IPC with correct arguments
| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Preconditions**:
- `window.electronAPI.worklog.log` is mocked to resolve `{ worklogId: "10042" }`

**Test Steps**:
1. Set up mock: `mockElectronAPI.worklog = { log: vi.fn().mockResolvedValue({ worklogId: "10042" }) }`
2. Render the hook via `renderHook(() => useSessionHistory())`
3. Wait for initial load
4. Call `result.current.logWork("session-uuid", "PROJ-123")`
5. Await completion
6. Verify `mockElectronAPI.worklog.log` was called with `{ sessionId: "session-uuid", issueKey: "PROJ-123" }`

**Expected Result**:
- `logWork()` correctly delegates to the IPC channel with the right input shape

---

#### TC-WL-402: logWork refreshes session list on success
| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Preconditions**:
- IPC `worklog.log` resolves successfully
- `session.list` returns updated data after the worklog call

**Test Steps**:
1. Mock `worklog.log` to resolve
2. Render hook and wait for initial load
3. Capture initial `session.list` call count
4. Call `result.current.logWork("session-uuid", "PROJ-123")`
5. Wait for update
6. Verify `session.list` was called again (session list refreshed)

**Expected Result**:
- Session list is refreshed after a successful worklog so the UI shows the updated `worklogStatus`

---

#### TC-WL-403: logWork on success triggers success toast
| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Preconditions**:
- `worklog.log` mock resolves with `{ worklogId: "10042" }`
- Session duration is 1500s (25 minutes)

**Test Steps**:
1. Render `<SessionHistory />` with mocked APIs
2. Trigger a `logWork("session-uuid", "PROJ-123")` action
3. Wait for the IPC call to complete
4. Verify a success toast is displayed with text matching `"Logged"` and `"PROJ-123"`

**Expected Result**:
- Success toast appears after successful worklog with issue key and duration

---

#### TC-WL-404: logWork on AUTH_FAILED error triggers error toast
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Preconditions**:
- `worklog.log` mock rejects with `IssueProviderError("Auth failed", "AUTH_FAILED")`

**Test Steps**:
1. Render `<SessionHistory />` with mocked APIs
2. Mock `worklog.log` to reject
3. Trigger `logWork`
4. Verify an error toast appears with message about authentication failure

**Expected Result**:
- Auth failure shows `"Jira authentication failed. Check your credentials."` or equivalent

---

#### TC-WL-405: logWork sets worklogLoading to true during API call
| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Preconditions**:
- `worklog.log` mock uses a delayed promise

**Test Steps**:
1. Mock `worklog.log` to delay 100ms before resolving
2. Render the hook
3. Call `result.current.logWork("session-uuid", "PROJ-123")` (do not await)
4. Immediately verify `result.current.worklogLoading["session-uuid"] === true`
5. Wait for resolution
6. Verify `result.current.worklogLoading["session-uuid"] === false` (or undefined)

**Expected Result**:
- `worklogLoading` is set to `true` during the API call and cleared on completion

---

#### TC-WL-406: logWork error does not crash the hook — sets worklogLoading to false
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Preconditions**:
- `worklog.log` mock rejects

**Test Steps**:
1. Mock `worklog.log` to reject
2. Render the hook
3. Call `result.current.logWork("session-uuid", "PROJ-123")` and await
4. Verify `worklogLoading["session-uuid"]` is `false` after the error
5. Verify the hook is still usable (call `deleteSession` and verify it works)

**Expected Result**:
- Error in `logWork` does not leave the hook in an inconsistent state
- `worklogLoading` is cleared even on error

---

### Unit Tests — Toast Notifications

**File**: `src/renderer/src/components/__tests__/SessionHistory.test.tsx`
**Environment**: jsdom (default)

---

#### TC-WL-501: Success toast auto-dismisses after 4 seconds
| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Test Steps**:
1. Use `vi.useFakeTimers()` in the test
2. Trigger a successful worklog
3. Verify the success toast is visible
4. Advance fake timers by 4000ms
5. Verify the toast is no longer in the DOM

**Expected Result**:
- Success toasts auto-dismiss after 4 seconds

---

#### TC-WL-502: Error toast messages match each error code
| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Test Cases Per Error Code**:

| Error Code | Expected Toast Message |
|------------|----------------------|
| `AUTH_FAILED` | `"Jira authentication failed. Check your credentials."` |
| `NOT_FOUND` | `"Issue PROJ-123 not found in Jira."` |
| `RATE_LIMITED` | `"Jira rate limit reached. Try again later."` |
| `NETWORK_ERROR` | `"Could not reach Jira. Check your connection."` |
| `INELIGIBLE` (already logged) | `"Worklog already logged for this session."` |
| `INELIGIBLE` (too short) | `"Session too short (minimum 60 seconds for Jira)."` |

**Test Steps** (for each error code):
1. Mock `worklog.log` to reject with the specific error
2. Trigger `logWork`
3. Verify the correct toast message is displayed
4. Verify the toast type is `"error"` (error styling)

**Expected Result**:
- Each error code maps to a user-friendly, specific error toast message

---

## 4. Edge Cases & Boundaries

| Category | Test Case | Input | Expected |
|----------|-----------|-------|----------|
| Boundary | Minimum eligible duration | `actualDurationSeconds: 60` | "Log Work" button shown, API called |
| Boundary | Just below minimum | `actualDurationSeconds: 59` | No "Log Work" button shown; INELIGIBLE if forced via IPC |
| Boundary | Zero duration (stopwatch abandoned) | `actualDurationSeconds: 0` | No button; INELIGIBLE if IPC called |
| Boundary | Very long session (8 hours) | `actualDurationSeconds: 28800` | Correctly logged as `28800` seconds |
| State | Already logged session re-clicked via IPC | `worklogStatus: "logged"` with direct IPC call | INELIGIBLE error; DB unchanged |
| State | Failed session retried successfully | `worklogStatus: "failed"` then success | Transitions to `logged` with new worklog ID |
| State | Failed session retried, fails again | `worklogStatus: "failed"` then failure | Remains `failed`, toast shown again |
| Data | Session with null title | `title: null` | Comment falls back to `"Logged via LizMeter"` |
| Data | Session title exceeds 255 chars | `title: "a".repeat(300)` | Comment is sent; verify no API error (Jira handles it, or truncate) |
| Data | ADF with special characters in title | `title: 'Fix <script>alert("xss")</script>'` | Characters are included in ADF text node verbatim (Jira handles sanitization) |
| Network | App goes offline mid-request | `fetch` throws `TypeError` | NETWORK_ERROR toast; session marked `failed` |
| Network | Jira returns unexpected 5xx error | HTTP 500 response | NETWORK_ERROR or generic error; session marked `failed` |
| Crash recovery | Session stays `not_logged` if app crashes before DB update | Simulated crash after API call but before `updateWorklogStatus` | Next "Log Work" attempt re-sends worklog (potential duplicate); `worklog_id` stored on success to detect this |
| Concurrent | Two rapid clicks on "Log Work" before loading state activates | Double-click | Only one IPC call made (button is disabled on first click) |

---

## 5. Security Tests

| Test | Description | Expected |
|------|-------------|----------|
| Auth header not exposed to renderer | `worklog.log()` preload method does not accept auth headers | Preload method signature only accepts `{ sessionId, issueKey }` |
| Session title in comment | Long or malicious titles sent in worklog comment | Jira handles sanitization; no local XSS risk since comment is sent to Jira server |
| Credential reuse safety | `addWorklog()` uses existing auth infrastructure | No new credential storage or transmission paths; existing `Authorization` header construction |
| IPC input type checking | Non-string `sessionId` or `issueKey` sent to handler | Handler validates type before DB/API calls; rejects with appropriate error |
| Worklog ID storage | `worklog_id` stored in DB is a non-sensitive identifier | No sensitive data stored; `worklog_id` is a Jira resource ID |

---

## 6. Performance Tests

| Test | Scenario | Threshold |
|------|----------|-----------|
| `updateWorklogStatus` write speed | Update worklog status on a single session | < 5ms (synchronous SQLite write) |
| `getSessionById` read speed | Look up session by primary key ID | < 5ms (indexed primary key lookup) |
| `listSessions` with worklog fields | Query 1000 sessions including new columns | < 500ms (regression from existing TC-405) |
| Async IPC call | `worklog:log` handler returns a Promise without blocking | Verifiable by asserting handler returns a Promise immediately |

---

## 7. Test Data Requirements

| Data Set | Purpose | Source |
|----------|---------|--------|
| Jira-linked session (`actualDurationSeconds: 1500`) | Happy path worklog test | Created via `saveSession()` in test setup |
| Jira-linked session (`actualDurationSeconds: 45`) | Sub-minimum duration rejection | Created via `saveSession()` in test setup |
| Jira-linked session (`actualDurationSeconds: 60`) | Exact minimum boundary | Created via `saveSession()` in test setup |
| Session in `logged` state | Duplicate prevention tests | Created via `saveSession()` + `updateWorklogStatus("logged", "10042")` |
| Session in `failed` state | Retry flow tests | Created via `saveSession()` + `updateWorklogStatus("failed")` |
| Non-Jira sessions (github, linear, null) | Provider exclusion tests | Created via `saveSession()` with respective `issueProvider` |
| Mock Jira API success response | Provider unit tests | `{ id: "10042", timeSpentSeconds: 1500 }` JSON fixture |
| Mock Jira API error responses (401, 403, 404, 429) | Error handling tests | `vi.spyOn(global, "fetch")` returning appropriate HTTP status mocks |

---

## 8. Test Environment

| Environment | Purpose | Config |
|-------------|---------|--------|
| Unit (node) | Database and provider tests | `// @vitest-environment node`, `initDatabase(":memory:")`, better-sqlite3 shim via `vitest.config.ts` alias |
| Unit (jsdom) | Renderer component and hook tests | Default jsdom environment, `vi.stubGlobal("electronAPI", mockElectronAPI)` |
| Integration (node) | IPC handler end-to-end with real DB | `// @vitest-environment node`, `initDatabase(":memory:")`, `vi.mock` for provider |

**better-sqlite3 Note**: All database tests must use `initDatabase(":memory:")`. The native module alias in `vitest.config.ts` points to the `sql.js` WASM shim, which supports in-memory databases. No file-system database paths should be used in tests.

**Mock electronAPI shape** (add `worklog` namespace to existing mock):
```typescript
const mockElectronAPI = {
  // ... existing namespaces (session, settings, issues, shell) ...
  worklog: {
    log: vi.fn().mockResolvedValue({ worklogId: "10042" }),
  },
};
```

**baseSession fixture extension** (add worklog fields to existing `Session` base fixture):
```typescript
const baseSession: Session = {
  // ... existing fields ...
  worklogStatus: "not_logged",
  worklogId: null,
};
```

---

## 9. Acceptance Criteria Verification

| AC ID | Acceptance Criteria | Test Cases | Pass Criteria |
|-------|--------------------|-----------:|---------------|
| AC-001 | "Log Work" button appears on Jira-linked, not_logged sessions | TC-WL-201 | Button renders in DOM |
| AC-002 | "Log Work" button absent on non-Jira sessions | TC-WL-202 | queryByRole("button") returns null |
| AC-003 | "Log Work" button absent on sessions < 60s | TC-WL-204 | No button for 59s session; button present for 60s session |
| AC-004 | Clicking "Log Work" calls worklog IPC with sessionId and issueKey | TC-WL-210, TC-WL-401 | IPC mock called with correct args |
| AC-005 | Button shows loading/spinner and is disabled during API call | TC-WL-209, TC-WL-405 | `disabled` attribute present; `onLogWork` not called on click |
| AC-006 | On success: status updates to `logged`, success toast shown | TC-WL-108, TC-WL-301, TC-WL-403 | DB updated; toast visible |
| AC-007 | On success: "Logged" indicator replaces button | TC-WL-203, TC-WL-205 | "Logged" text/icon in DOM; button absent |
| AC-008 | On failure: warning toast with specific message shown | TC-WL-302, TC-WL-502 | Error toast with correct message per error code |
| AC-009 | On failure: session marked `failed` in DB | TC-WL-302, TC-WL-106 | `worklogStatus === "failed"` in DB |
| AC-010 | On failure: "Retry" button shown on session card | TC-WL-206 | "Retry" button in DOM |
| AC-011 | "Retry" button sends same IPC call as "Log Work" | TC-WL-208, TC-WL-304 | Same `worklog:log` channel called; `failed` session transitions to `logged` |
| AC-012 | "Log Work" button absent when `worklogStatus = 'logged'` | TC-WL-203 | No button when `worklogStatus === "logged"` |
| AC-013 | Worklog ID stored in DB on success | TC-WL-105, TC-WL-301 | `worklogId` field equals Jira-returned ID |
| AC-014 | DB migration is idempotent | TC-WL-102 | Double `initDatabase()` does not throw |
| AC-015 | Session save unaffected by worklog failure | TC-WL-308 | Session retrievable after worklog failure |
| AC-016 | Cloud v3 uses ADF comment format | TC-WL-151 | Request body `comment` is ADF object |
| AC-017 | Server v2 uses plain string comment | TC-WL-152 | Request body `comment` is a plain string |
| AC-018 | `started` timestamp sent with worklog | TC-WL-153, TC-WL-305 | `started` field present in request body, correctly computed |

---

## 10. Test Summary

| Type | Count | P0 | P1 | P2 |
|------|-------|----|----|----|
| Unit (Database) | 9 | 7 | 2 | 0 |
| Unit (Jira Provider) | 11 | 9 | 2 | 0 |
| Integration (IPC Handler) | 12 | 10 | 2 | 0 |
| Unit (Renderer Component) | 10 | 8 | 2 | 0 |
| Unit (Renderer Hook) | 6 | 4 | 2 | 0 |
| Unit (Toast Notifications) | 2 | 1 | 1 | 0 |
| **Total** | **50** | **39** | **11** | **0** |

### P0 Coverage by Requirement

| Requirement | P0 Test Count | Status |
|-------------|--------------|--------|
| FR-001 (Log Work button) | 4 | Covered |
| FR-002 (Worklog status tracking) | 4 | Covered |
| FR-003 (Non-blocking error handling) | 7 | Covered |
| FR-004 (Retry on failure) | 3 | Covered |
| FR-005 (DB columns) | 5 | Covered |
| FR-006 (Store worklog ID) | 3 | Covered |
| NFR: Cloud v3 + Server v2 | 2 | Covered |
| NFR: Duplicate prevention | 3 | Covered |
| NFR: Minimum 60s | 3 | Covered |
| NFR: Idempotent migration | 1 | Covered |
| NFR: Session save independence | 1 | Covered |
| NFR: Async IPC | 1 | Covered |

**P0 Requirements: 12/12 (100%) covered**