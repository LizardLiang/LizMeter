# Technical Specification

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Work Time Logging (Jira Worklog Integration) |
| **Author** | Hephaestus (Tech Spec Agent) |
| **Status** | Draft |
| **Date** | 2026-02-24 |
| **PRD Version** | 1.0 |

---

## 1. Overview

### Summary
Add the ability to log completed session durations to Jira as worklogs via a manual "Log Work" button on session history cards. The feature extends the existing Jira provider with a new `addWorklog()` method, adds two columns to the sessions table (`worklog_status`, `worklog_id`), introduces a new `worklog:log` IPC channel, and renders worklog status indicators and action buttons in the session history UI.

### Goals
- Enable one-click worklog creation from session cards to Jira issues
- Track worklog state (`not_logged`, `logging`, `logged`, `failed`) per session persistently
- Keep worklog operations fully decoupled from session save (non-blocking)
- Support both Jira Cloud (API v3, ADF comments) and Jira Server (API v2, plain text comments)

### Non-Goals
- Auto-logging on session completion (manual trigger only)
- Worklog editing or deletion (creation only)
- Bulk worklog operations (one session at a time)
- Support for Linear or GitHub Issues (no native worklog APIs)
- Custom worklog comment templates (V1 uses auto-generated comment)

---

## 2. Architecture

### System Context
This feature adds a new lateral data flow alongside the existing session save path. Session saving remains unchanged. Worklog logging is a separate user-initiated action that calls a new IPC handler, which delegates to the Jira provider, then updates the session record in the database.

```
                        Session Card UI
                       /               \
              [Save Session]      [Log Work] (new)
                    |                   |
            session:save IPC     worklog:log IPC (new)
                    |                   |
              saveSession()      logWorkToJira() (new)
              (database.ts)       (ipc-handlers.ts)
                    |                   |
                 SQLite           JiraProvider.addWorklog() (new)
                                        |
                                  Jira REST API
                                  POST /rest/api/{v}/issue/{key}/worklog
                                        |
                                  On success: updateWorklogStatus() (new, database.ts)
```

### Key Design Decisions

| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Single IPC channel `worklog:log` for both initial log and retry | Retry is semantically identical to initial log; no reason to split channels | Separate `worklog:retry` channel (unnecessary complexity) |
| Columns on `sessions` table (not a separate `worklogs` table) | 1:1 relationship between session and worklog; no need for a join table | Separate `worklogs` table (adds join complexity for no benefit) |
| `request()` method made semi-public (new overload with method/body) | Reuses all existing auth, error handling, and retry logic | New standalone `fetch` call in `addWorklog()` (duplicates auth logic) |
| ADF comment for Cloud v3, plain string for Server v2 | Jira Cloud v3 API requires ADF format for the `comment` field | Always send plain string (would fail on Cloud v3 or be silently ignored) |
| Send `started` timestamp with worklog | Improves Jira timesheet accuracy; `started = completedAt - actualDurationSeconds` | Omit `started` (Jira defaults to current time, which may be hours after session) |
| Include session title in comment when available | More useful worklog comments in Jira (e.g., "LizMeter: Fix login bug") | Always use generic "Logged via LizMeter" (less informative) |
| Minimum 60s for worklog eligibility | Jira API requires `timeSpentSeconds >= 60` | Allow any duration (API would reject < 60s) |
| Toast notifications via a simple state-based approach | No external library needed; matches existing app simplicity | Install a toast library (over-engineering for this use case) |

---

## 3. Data Model

### Database Schema Changes

```sql
-- Idempotent migration: add worklog columns to sessions table
-- Pattern matches existing issue_provider migration in database.ts (lines 86-96)

ALTER TABLE sessions ADD COLUMN worklog_status TEXT NOT NULL DEFAULT 'not_logged';
ALTER TABLE sessions ADD COLUMN worklog_id TEXT;
```

**Column Details:**

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `worklog_status` | TEXT | `'not_logged'` | One of: `not_logged`, `logged`, `failed` |
| `worklog_id` | TEXT | NULL | Jira worklog ID returned on success (e.g., `"10042"`) |

**Note on DEFAULT for existing rows**: SQLite `ALTER TABLE ADD COLUMN` with `DEFAULT` applies the default to all existing rows. Since existing sessions have never been logged, `'not_logged'` is correct. The `NOT NULL DEFAULT 'not_logged'` constraint ensures new sessions also default correctly.

### Entity Relationships
```
sessions (existing)
  |-- id (PK)
  |-- title
  |-- timer_type
  |-- planned_duration_seconds
  |-- actual_duration_seconds
  |-- completed_at
  |-- issue_provider         --> "jira" | "github" | "linear" | null
  |-- issue_id               --> Jira issue key (e.g., "PROJ-123")
  |-- worklog_status  (NEW)  --> "not_logged" | "logged" | "failed"
  |-- worklog_id      (NEW)  --> Jira worklog ID (null until logged)
  |-- ... (other existing columns)
```

### Data Migration
- Migration is idempotent using the existing `PRAGMA table_info` pattern
- Check `cols.includes("worklog_status")` before running ALTER TABLE
- No data transformation needed -- default values are correct for all existing rows

---

## 4. API Design

### New IPC Channel

#### `worklog:log`
**Purpose**: Log a session's duration as a Jira worklog

**Input** (from renderer):
```typescript
interface WorklogLogInput {
  sessionId: string;   // UUID of the session to log
  issueKey: string;    // Jira issue key (e.g., "PROJ-123")
}
```

**Response** (on success):
```typescript
interface WorklogLogResult {
  worklogId: string;   // Jira-assigned worklog ID
}
```

**Errors** (thrown as IssueProviderError):
| Code | Condition |
|------|-----------|
| `NO_TOKEN` | No Jira credentials configured |
| `AUTH_FAILED` | 401/403 from Jira API |
| `NETWORK_ERROR` | Network failure or non-specific HTTP error |
| `RATE_LIMITED` | 429 from Jira API |
| `QUERY_ERROR` | 400 from Jira API (bad request) |
| `NOT_FOUND` | 404 from Jira API (issue does not exist) |
| `INELIGIBLE` | Session duration < 60s or worklog already logged |

**Handler logic** (in `ipc-handlers.ts`):
1. Validate `sessionId` exists in database and has `worklog_status !== 'logged'`
2. Validate `actualDurationSeconds >= 60`
3. Look up session data (completedAt, actualDurationSeconds, title)
4. Call `jiraProvider.addWorklog(issueKey, timeSpentSeconds, started, comment)`
5. On success: update `worklog_status = 'logged'` and `worklog_id = response.id` in database
6. On failure: update `worklog_status = 'failed'` in database, re-throw error
7. Return `{ worklogId }`

### Jira Worklog API

#### POST /rest/api/{version}/issue/{issueIdOrKey}/worklog

**Cloud v3 request body**:
```json
{
  "timeSpentSeconds": 1500,
  "started": "2026-02-24T10:30:00.000+0000",
  "comment": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          {
            "type": "text",
            "text": "LizMeter: Fix login bug"
          }
        ]
      }
    ]
  }
}
```

**Server v2 request body**:
```json
{
  "timeSpentSeconds": 1500,
  "started": "2026-02-24T10:30:00.000+0000",
  "comment": "LizMeter: Fix login bug"
}
```

**Response** (both versions):
```json
{
  "id": "10042",
  "timeSpentSeconds": 1500,
  "started": "2026-02-24T10:30:00.000+0000"
}
```

---

## 5. Security Considerations

### Authentication
- Reuses existing Jira credentials already stored by the Jira provider setup flow
- No new credential storage or prompts needed
- Basic auth header (email:apiToken for Cloud, username:password for Server) is constructed identically to existing requests

### Authorization
- Jira "Log Work" permission is required on the target project
- If the user lacks this permission, Jira returns 403 which is surfaced as a clear error message
- No client-side permission check is possible; we rely on server-side enforcement

### Data Protection
- No new sensitive data is introduced
- `worklog_id` is a non-sensitive Jira resource ID
- Session titles sent in worklog comments are user-controlled data already stored locally

---

## 6. Performance Considerations

### Expected Load
- Worklog calls are user-initiated, one at a time, at most once per completed session
- Typical usage: 4-8 worklogs per day per user (matching Pomodoro sessions)
- No batch operations, no background polling

### Optimization Strategies
- Worklog API call is fully async (does not block UI thread or session save)
- UI shows loading state during the API call to prevent double-clicks
- Database updates (worklog_status, worklog_id) are synchronous (better-sqlite3) and sub-millisecond

### Caching
- No caching needed for worklog operations (write-only, no reads from Jira)
- Session list query already fetches worklog_status/worklog_id as part of the SELECT

---

## 7. Implementation Plan

### Files to Create
| File | Purpose |
|------|---------|
| None | All changes are modifications to existing files |

### Files to Modify

| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add `worklogStatus` and `worklogId` fields to `Session` interface; add `WorklogLogInput` and `WorklogLogResult` types; add `worklog` namespace to `ElectronAPI` interface; add `WorklogStatus` type alias |
| `electron/main/database.ts` | Add idempotent migration for `worklog_status` and `worklog_id` columns; add `worklog_status`/`worklog_id` to all SELECT queries in `listSessions()`; add `updateWorklogStatus()` function; add `getSessionById()` helper; extend `SessionRow` interface; extend `saveSession()` return to include new fields |
| `electron/main/issue-providers/jira-provider.ts` | Add `addWorklog()` public method; refactor `request()` to accept optional method and body parameters; add `buildAdfComment()` private helper; add 404 handling to `request()` |
| `electron/main/issue-providers/types.ts` | Add `NOT_FOUND` and `INELIGIBLE` to `IssueProviderError.code` union type |
| `electron/main/ipc-handlers.ts` | Add `worklog:log` IPC handler with full validation, Jira API call, and database update |
| `electron/preload/index.ts` | Add `worklog` namespace with `log` method |
| `src/renderer/src/components/SessionHistoryItem.tsx` | Add "Log Work" button, "Logged" indicator, "Failed/Retry" indicator based on `worklogStatus`; add loading state |
| `src/renderer/src/hooks/useSessionHistory.ts` | Add `logWork(sessionId, issueKey)` function that calls `worklog:log` IPC and refreshes on completion |
| `src/renderer/src/components/SessionHistory.tsx` | Pass `logWork` handler down to `SessionHistoryItem`; add toast notification display area |

### Sequence of Changes

**Phase 1: Backend Foundation (Types + Database + Provider)**

1. **`src/shared/types.ts`** -- Add `WorklogStatus` type, extend `Session` interface with `worklogStatus` and `worklogId`, add `WorklogLogInput`/`WorklogLogResult` types, add `worklog` namespace to `ElectronAPI`
2. **`electron/main/issue-providers/types.ts`** -- Add `NOT_FOUND` and `INELIGIBLE` to error code union
3. **`electron/main/database.ts`** -- Add idempotent migration, update `SessionRow` interface, update all `listSessions` SELECT queries to include `worklog_status`/`worklog_id`, add `getSessionById()` and `updateWorklogStatus()` functions, update `saveSession()` return value
4. **`electron/main/issue-providers/jira-provider.ts`** -- Refactor `request()` to support POST with JSON body, add `addWorklog()` method with ADF/plain-text comment construction, add 404 error handling

**Phase 2: IPC Layer**

5. **`electron/main/ipc-handlers.ts`** -- Register `worklog:log` handler with validation, Jira provider call, and database status update
6. **`electron/preload/index.ts`** -- Expose `worklog.log()` via contextBridge

**Phase 3: Renderer UI**

7. **`src/renderer/src/hooks/useSessionHistory.ts`** -- Add `logWork()` function and `worklogLoading` state (map of sessionId -> boolean)
8. **`src/renderer/src/components/SessionHistoryItem.tsx`** -- Add worklog status indicator and "Log Work"/"Retry" button with loading state
9. **`src/renderer/src/components/SessionHistory.tsx`** -- Wire `logWork` to item components; add toast notification state and rendering

---

## 8. Detailed Implementation Notes

### 8.1 Type Changes (`src/shared/types.ts`)

```typescript
// New type alias
export type WorklogStatus = "not_logged" | "logged" | "failed";

// Extend Session interface (add two fields)
export interface Session {
  // ... existing fields ...
  worklogStatus: WorklogStatus;
  worklogId: string | null;
}

// New input/result types
export interface WorklogLogInput {
  sessionId: string;
  issueKey: string;
}

export interface WorklogLogResult {
  worklogId: string;
}

// Add to ElectronAPI
export interface ElectronAPI {
  // ... existing namespaces ...
  worklog: {
    log: (input: WorklogLogInput) => Promise<WorklogLogResult>;
  };
}
```

### 8.2 Database Migration (`electron/main/database.ts`)

Add after the existing `issue_provider` migration block (after line 96):

```typescript
// Idempotent migration: add worklog tracking columns
if (!cols.includes("worklog_status")) {
  db.exec("ALTER TABLE sessions ADD COLUMN worklog_status TEXT NOT NULL DEFAULT 'not_logged'");
  db.exec("ALTER TABLE sessions ADD COLUMN worklog_id TEXT");
}
```

New functions:

```typescript
export function getSessionById(id: string): Session | null {
  const database = getDb();
  const row = database.prepare(
    `SELECT id, title, timer_type as timerType,
            planned_duration_seconds as plannedDurationSeconds,
            actual_duration_seconds as actualDurationSeconds,
            completed_at as completedAt,
            issue_number as issueNumber,
            issue_title as issueTitle,
            issue_url as issueUrl,
            issue_provider as issueProvider,
            issue_id as issueId,
            worklog_status as worklogStatus,
            worklog_id as worklogId
     FROM sessions WHERE id = ?`
  ).get(id) as SessionRow | undefined;
  if (!row) return null;
  // Map to Session (including tags)
  const tags = listTagsForSession(id);
  return { ...mapRow(row), tags };
}

export function updateWorklogStatus(
  sessionId: string,
  status: "not_logged" | "logged" | "failed",
  worklogId?: string
): void {
  const database = getDb();
  if (worklogId) {
    database.prepare(
      "UPDATE sessions SET worklog_status = ?, worklog_id = ? WHERE id = ?"
    ).run(status, worklogId, sessionId);
  } else {
    database.prepare(
      "UPDATE sessions SET worklog_status = ? WHERE id = ?"
    ).run(status, sessionId);
  }
}
```

### 8.3 Jira Provider Changes (`jira-provider.ts`)

Refactor the private `request()` method to accept optional HTTP method and body:

```typescript
private async request(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<Response> {
  const method = options?.method ?? "GET";
  const headers: Record<string, string> = {
    "Authorization": this.authHeader,
    "Accept": "application/json",
  };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new IssueProviderError(
      `Could not reach ${this.baseUrl}. Check the domain and your internet connection.`,
      "NETWORK_ERROR",
    );
  }

  // ... existing error handling, plus add 404:
  if (response.status === 404) {
    throw new IssueProviderError(
      "Resource not found in Jira. The issue may have been deleted.",
      "NOT_FOUND",
    );
  }
  // ... rest of existing error handling ...
}
```

New public method:

```typescript
async addWorklog(
  issueKey: string,
  timeSpentSeconds: number,
  started: string,  // ISO 8601 timestamp
  comment: string
): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    timeSpentSeconds,
    started: this.formatJiraTimestamp(started),
  };

  if (this.authType === "server") {
    // Server v2: plain string comment
    body.comment = comment;
  } else {
    // Cloud v3: ADF format
    body.comment = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: comment },
          ],
        },
      ],
    };
  }

  const response = await this.request(
    `/rest/api/${this.apiVersion}/issue/${issueKey}/worklog`,
    { method: "POST", body }
  );
  const data = await response.json();
  return { id: String(data.id) };
}

private formatJiraTimestamp(isoString: string): string {
  // Jira expects: "2026-02-24T10:30:00.000+0000"
  // Convert ISO 8601 to Jira format
  const date = new Date(isoString);
  return date.toISOString().replace("Z", "+0000");
}
```

### 8.4 IPC Handler (`ipc-handlers.ts`)

```typescript
ipcMain.handle("worklog:log", async (_event, input: { sessionId: string; issueKey: string }) => {
  const provider = getJiraProvider();
  if (!provider) throw new IssueProviderError("No Jira credentials configured", "NO_TOKEN");

  // Fetch session from database
  const session = getSessionById(input.sessionId);
  if (!session) throw new Error("Session not found");

  // Guard: already logged
  if (session.worklogStatus === "logged" && session.worklogId) {
    throw new IssueProviderError("Worklog already logged for this session", "INELIGIBLE");
  }

  // Guard: duration too short
  if (session.actualDurationSeconds < 60) {
    throw new IssueProviderError(
      "Session duration is less than 60 seconds (Jira minimum)",
      "INELIGIBLE"
    );
  }

  // Calculate started timestamp: completedAt - actualDurationSeconds
  const completedDate = new Date(session.completedAt);
  const startedDate = new Date(completedDate.getTime() - session.actualDurationSeconds * 1000);
  const started = startedDate.toISOString();

  // Build comment
  const comment = session.title
    ? `LizMeter: ${session.title}`
    : "Logged via LizMeter";

  try {
    const result = await provider.addWorklog(
      input.issueKey,
      session.actualDurationSeconds,
      started,
      comment
    );
    updateWorklogStatus(input.sessionId, "logged", result.id);
    return { worklogId: result.id };
  } catch (err) {
    updateWorklogStatus(input.sessionId, "failed");
    throw err;
  }
});
```

### 8.5 Preload (`electron/preload/index.ts`)

Add after the `jira` namespace:

```typescript
worklog: {
  log: (input: { sessionId: string; issueKey: string }) =>
    ipcRenderer.invoke("worklog:log", input),
},
```

### 8.6 Renderer: Session History Item

The `SessionHistoryItem` component will conditionally render worklog controls based on:
1. `session.issueProvider === "jira"` -- only Jira-linked sessions show worklog UI
2. `session.actualDurationSeconds >= 60` -- minimum Jira requirement
3. `session.worklogStatus` -- determines which control to show

| worklogStatus | UI Element |
|---------------|-----------|
| `not_logged` | "Log Work" button (blue) |
| `logged` | "Logged" indicator (green checkmark, non-interactive) |
| `failed` | "Retry" button (orange/warning) |
| (loading) | Spinner + disabled button (transient state, tracked in React) |

Props addition:
```typescript
interface SessionHistoryItemProps {
  session: Session;
  onDelete: (id: string) => void;
  onLogWork?: (sessionId: string, issueKey: string) => void;  // new
  worklogLoading?: boolean;  // new
}
```

### 8.7 Toast Notifications

Implement a minimal toast system using React state in `SessionHistory.tsx`:

```typescript
interface Toast {
  id: string;
  message: string;
  type: "success" | "error";
}
```

- Toasts are rendered as absolutely-positioned elements at the bottom of the session history panel
- Auto-dismiss after 4 seconds via `setTimeout`
- No external library needed
- Inline `React.CSSProperties` styling consistent with existing codebase patterns

Toast messages:
| Scenario | Type | Message |
|----------|------|---------|
| Worklog created | success | `"Logged {duration} to {issueKey}"` |
| Auth failure | error | `"Jira authentication failed. Check your credentials."` |
| Issue not found | error | `"Issue {issueKey} not found in Jira."` |
| Rate limited | error | `"Jira rate limit reached. Try again later."` |
| Network error | error | `"Could not reach Jira. Check your connection."` |
| Already logged | error | `"Worklog already logged for this session."` |
| Duration too short | error | `"Session too short (minimum 60 seconds for Jira)."` |

---

## 9. Testing Strategy

### Unit Tests

**Database (`electron/main/__tests__/database.test.ts`)**:
- Migration creates `worklog_status` and `worklog_id` columns
- Migration is idempotent (running twice does not error)
- `getSessionById()` returns session with worklog fields
- `updateWorklogStatus()` updates status and worklog_id correctly
- `listSessions()` returns sessions with worklog fields populated
- New sessions default to `worklog_status = 'not_logged'`, `worklog_id = null`

**Jira Provider (`electron/main/issue-providers/__tests__/jira-provider.test.ts`)**:
- `addWorklog()` sends correct request body for Cloud v3 (ADF comment)
- `addWorklog()` sends correct request body for Server v2 (plain string comment)
- `addWorklog()` includes `started` timestamp in correct format
- `addWorklog()` returns worklog ID from response
- `addWorklog()` throws IssueProviderError on 404
- `request()` still works correctly for GET requests (regression)

**Renderer (`src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx`)**:
- "Log Work" button visible for Jira-linked sessions with `worklogStatus: 'not_logged'`
- "Log Work" button hidden for non-Jira sessions
- "Log Work" button hidden for sessions < 60s duration
- "Logged" indicator shown for `worklogStatus: 'logged'`
- "Retry" button shown for `worklogStatus: 'failed'`
- Loading state disables button and shows spinner
- `onLogWork` callback fires with correct sessionId and issueKey

### Integration Tests

**IPC Handler (mock Jira API + real SQLite)**:
- `worklog:log` handler creates worklog and updates database on success
- `worklog:log` handler sets `failed` status on Jira API error
- `worklog:log` rejects sessions with `worklogStatus: 'logged'`
- `worklog:log` rejects sessions with `actualDurationSeconds < 60`
- `worklog:log` throws when no Jira provider is configured

### E2E Tests

- Full flow: complete a session linked to a Jira issue, click "Log Work", verify status changes to "Logged"
- (Requires mock Jira server or API interception)

---

## 10. Rollout Plan

### Feature Flags
Not applicable for V1. The worklog UI is naturally gated by:
1. Jira provider must be configured
2. Session must be linked to a Jira issue
3. Session must have `actualDurationSeconds >= 60`

If none of these conditions are met, no worklog UI appears. This is an implicit feature gate.

### Rollback Plan
1. **Database**: The new columns (`worklog_status`, `worklog_id`) are additive and nullable/defaulted. They do not break older code that does not reference them. Rolling back the code will simply leave unused columns in the database.
2. **UI**: Removing the renderer changes immediately hides all worklog UI.
3. **Provider**: The `addWorklog()` method is only called from the `worklog:log` handler; removing the handler disconnects the feature entirely.

No data migration rollback is needed because:
- SQLite does not support `DROP COLUMN` in older versions, but the columns are harmless if unused
- No existing data is modified by this feature

---

## 11. Open Questions

| Question | Status | Resolution |
|----------|--------|------------|
| Should `started` timestamp be sent to Jira? | Resolved | Yes. Compute as `completedAt - actualDurationSeconds`. Improves Jira timesheet accuracy. |
| Should session title appear in worklog comment? | Resolved | Yes. Format: `"LizMeter: {title}"` when title exists, fallback to `"Logged via LizMeter"`. |
| Jira Cloud v3 ADF format for comment? | Resolved | Yes. Cloud v3 uses ADF; Server v2 uses plain string. Provider method handles both based on `authType`. |
| Minimum duration for worklog eligibility? | Resolved | 60 seconds (Jira API minimum). Sessions below this threshold do not show "Log Work" button. |
| Settings toggle for worklog feature (P1)? | Deferred | Not in V1 scope. The feature is implicitly gated by Jira configuration. Can be added later as a `worklog.enabled` setting. |