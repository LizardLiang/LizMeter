# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Work Time Logging (Jira Worklog Integration) |
| **Author** | Athena (PM Agent) |
| **Status** | Draft |
| **Date** | 2026-02-24 |
| **Version** | 1.0 |

---

## 1. Executive Summary

LizMeter users who track Pomodoro sessions linked to Jira issues currently have no way to push their tracked time back into Jira. They must manually open Jira, navigate to the issue, and log work -- a tedious context switch that defeats the purpose of a streamlined time tracker.

This feature adds a "Log Work" button to session history cards for Jira-linked sessions. When clicked, it sends the session's actual duration to the Jira worklog API. The operation is non-blocking: session saves are never impacted by worklog failures. A new `worklog_status` column tracks whether time has been logged, failed, or not yet attempted, and the UI shows clear visual indicators for each state.

The scope is intentionally limited to Jira Cloud and Server. Linear and GitHub Issues do not expose native worklog APIs, so they are excluded.

---

## 2. Problem Statement

### Current Situation
LizMeter already supports linking sessions to Jira issues (browse, select, attach to session). However, the time data stays local. Users who want their Jira timesheets to reflect actual work must manually re-enter the duration in Jira -- duplicating effort and introducing transcription errors.

### Target Users
| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Developer with Jira | Individual contributor using Jira for project tracking | Log time to Jira without leaving LizMeter |
| Team Lead | Manager who reviews Jira worklogs for reporting | Accurate, timely worklogs from team members |

### Pain Points
1. **Manual double-entry**: Users track time in LizMeter, then re-enter it in Jira -- slow and error-prone.
2. **Forgotten worklogs**: Users forget to log time in Jira after completing a session, leading to incomplete timesheets.
3. **Context switching**: Opening Jira to log work interrupts the flow of starting the next Pomodoro.

---

## 3. Goals & Success Metrics

### Business Goals
- Reduce friction between local time tracking and Jira worklog reporting
- Increase the value of the Jira integration (users who log work are stickier)
- Maintain the app's reliability -- worklog failures must never block core session saving

### Success Metrics
| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Worklog adoption rate | 0% (feature does not exist) | 50% of Jira-linked sessions logged within 1 week | Count sessions where `worklog_status = 'logged'` vs total Jira-linked sessions |
| Manual Jira worklog entries | Baseline (all manual) | Reduced (users rely on LizMeter) | Qualitative -- user feedback |
| Worklog failure rate | N/A | < 5% of attempts | Count `worklog_status = 'failed'` / total attempts |

### Out of Scope
- **Linear worklog integration**: Linear has no native worklog API
- **GitHub Issues worklog integration**: GitHub has no native worklog API
- **Automatic logging on session save**: User decided on manual trigger only
- **Editing logged time**: Once logged, the worklog is final (users can edit in Jira directly)
- **Bulk worklog operations**: Logging multiple sessions at once
- **Worklog deletion/update**: Only creation is supported
- **Custom worklog comments**: V1 uses a standard auto-generated comment (e.g., "Logged via LizMeter")

---

## 4. Requirements

### P0 - Must Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-001 | "Log Work" button on Jira-linked session cards | As a user, I want to log my session time to Jira with one click so I don't have to open Jira | Given a session card linked to a Jira issue with `worklog_status` of `not_logged` or `failed`, When I click "Log Work", Then the actual duration is sent to Jira's worklog API |
| FR-002 | Worklog status tracking per session | As a user, I want to see whether time was already logged so I don't double-log | Given a session linked to Jira, When I view session history, Then I see a visual indicator showing `not_logged`, `logged`, or `failed` status |
| FR-003 | Non-blocking error handling | As a user, I want session saving to always succeed even if Jira is down | Given a worklog API call fails, When the error occurs, Then the session remains saved, a warning toast is shown, and the session is marked `failed` |
| FR-004 | Retry on failure | As a user, I want to retry a failed worklog without re-doing my session | Given a session with `worklog_status = 'failed'`, When I click the retry button on the session card, Then the worklog API call is retried |
| FR-005 | New database column for worklog status | As the system, I need to persist worklog state across app restarts | Given the app starts, When the database initializes, Then a `worklog_status` column exists on the `sessions` table with values `not_logged` (default), `logged`, or `failed` |
| FR-006 | Store Jira worklog ID on success | As the system, I need to know which Jira worklog corresponds to a session to prevent duplicates | Given a successful worklog API call, When the response returns, Then the Jira worklog ID is stored in a new `worklog_id` column on the session |

### P1 - Should Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-010 | Settings toggle for worklog feature | As a user, I want to disable the worklog feature if I don't use Jira time tracking | Given the settings panel, When I toggle "Enable Jira Worklog", Then the "Log Work" button is hidden/shown on all session cards accordingly |
| FR-011 | Loading state during worklog submission | As a user, I want to know my worklog is being submitted | Given I click "Log Work", When the API call is in progress, Then the button shows a loading/spinner state and is disabled |
| FR-012 | Success confirmation | As a user, I want confirmation that my time was logged | Given a successful worklog API call, When it completes, Then the status indicator updates to `logged` and a brief success toast appears |

### P2 - Nice to Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-020 | Worklog comment customization | As a user, I want to customize what comment is sent with my worklog | Given the settings panel, When I edit the worklog comment template, Then future worklogs use that template |
| FR-021 | Duration preview before logging | As a user, I want to see exactly what will be logged before confirming | Given I hover over or click "Log Work", When the action is previewed, Then I see "Log Xh Ym to PROJ-123" |

### Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Worklog API call must not block the UI thread; use async IPC handler |
| Reliability | Session save must succeed independently of worklog success; these are separate operations |
| Data Integrity | Duplicate worklog prevention: if `worklog_status = 'logged'` and `worklog_id` is set, the "Log Work" button must be disabled |
| Security | Jira credentials (already stored for issue fetching) are reused; no new credential storage needed |
| Compatibility | Must work with both Jira Cloud (API v3) and Jira Server (API v2), matching existing provider logic |
| Migration | Database migration must be idempotent (same pattern as existing `issue_provider` migration) |

---

## 5. User Flows

### Primary Flow: Log Work to Jira

```
1. User completes a Pomodoro session linked to a Jira issue (e.g., PROJ-123)
2. Session saves to local database with worklog_status = 'not_logged'
3. User opens session history (or it's already visible)
4. User sees the session card for PROJ-123 with a "Log Work" button
5. User clicks "Log Work"
6. Button enters loading state (spinner, disabled)
7. Main process calls Jira worklog API: POST /rest/api/{version}/issue/PROJ-123/worklog
   Body: { timeSpentSeconds: <actualDurationSeconds>, comment: "Logged via LizMeter" }
8. On success:
   a. worklog_status updated to 'logged', worklog_id stored
   b. Button is replaced by a "Logged" indicator (e.g., green checkmark)
   c. Brief success toast shown
9. User continues working -- no context switch to Jira needed
```

### Retry Flow: Failed Worklog

```
1. User clicks "Log Work" but the API call fails (network error, auth issue, etc.)
2. Warning toast appears: "Failed to log work to PROJ-123. You can retry later."
3. Session card shows a "failed" indicator (e.g., orange warning icon) with a "Retry" button
4. User clicks "Retry" (now or later, even after app restart)
5. Same API call is attempted again
6. On success: transitions to 'logged' state (same as primary flow step 8)
7. On repeated failure: remains in 'failed' state, toast shown again
```

### Edge Case: Session Without Jira Link

```
1. User completes a session with no issue linked, or linked to GitHub/Linear
2. Session card does NOT show any "Log Work" button
3. worklog_status column is 'not_logged' but no action is available
```

### Edge Case: Already Logged Session

```
1. User views a session where worklog_status = 'logged'
2. "Log Work" button is replaced by a non-interactive "Logged" indicator
3. No duplicate logging is possible from the UI
```

### Error Flows
- **401/403 (Auth failed)**: Toast: "Jira authentication failed. Check your credentials in Settings." Status set to `failed`.
- **404 (Issue not found)**: Toast: "Issue PROJ-123 was not found in Jira. It may have been deleted." Status set to `failed`.
- **429 (Rate limited)**: Toast: "Jira rate limit reached. Try again in a few minutes." Status set to `failed`.
- **Network error**: Toast: "Could not reach Jira. Check your internet connection." Status set to `failed`.

---

## 6. Dependencies & Risks

### Dependencies
| Dependency | Type | Impact |
|------------|------|--------|
| Existing Jira provider (`jira-provider.ts`) | Internal | Reuse authentication, base URL, request infrastructure |
| Jira REST API worklog endpoint | External | Core functionality depends on this API being available |
| Existing session save flow | Internal | Worklog must be a separate operation that does not interfere with session saving |
| SQLite database schema | Internal | New columns required via idempotent migration |

### Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Jira API is temporarily unavailable | Medium | Low | Non-blocking design with retry; sessions always save locally |
| User's Jira permissions don't include worklog creation | Low | Medium | Surface clear error message from API response; document in settings |
| Worklog is created but DB update fails (crash after API call) | Very Low | Medium | On next "Log Work" click, Jira may reject as duplicate or create a second entry. Storing `worklog_id` helps detect this. |
| Jira Server instances with custom worklog fields | Low | Low | V1 only sends `timeSpentSeconds` and `comment`; custom fields are out of scope |

---

## 7. Open Questions

| Question | Status |
|----------|--------|
| Should the worklog comment include the session title if one exists? | Open -- leaning yes for V1 (e.g., "LizMeter: <session title>") |
| Should the `started` timestamp be sent to Jira (the `started` field in worklog API)? | Open -- sending `completedAt - actualDurationSeconds` as start time would improve accuracy |

---

## 8. External API Dependencies

### Jira Worklog API
| Aspect | Details |
|--------|---------|
| **Endpoint** | `POST /rest/api/{version}/issue/{issueIdOrKey}/worklog` |
| **API Versions** | Cloud: v3, Server: v2 (matches existing provider logic) |
| **Authentication** | Basic auth (email:apiToken for Cloud, username:password for Server) -- already configured |
| **Request Body** | `{ "timeSpentSeconds": number, "comment": string }` (Cloud v3 uses ADF for comment) |
| **Response** | `{ "id": string, ... }` -- worklog ID needed for storage |
| **Rate Limits** | Standard Jira rate limits apply (already handled in provider) |
| **Permissions Required** | User must have "Log Work" permission on the Jira project |
| **Documentation** | [Atlassian REST API - Add worklog](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/#api-rest-api-3-issue-issueidorkey-worklog-post) |

**Note on Cloud v3 comment format**: Jira Cloud v3 expects the `comment` field in ADF (Atlassian Document Format), not plain string. The existing `jira-provider.ts` already handles ADF parsing for reading comments. The worklog creation will need to produce ADF for Cloud v3 or plain string for Server v2.

---

## 9. External Research Summary

### Research Conducted
| Topic | Source | Key Finding |
|-------|--------|-------------|
| Jira worklog API shape | Existing codebase (`jira-provider.ts`) | Auth, base URL, API version logic already implemented; worklog endpoint follows same pattern |
| Linear time tracking | Linear documentation | Linear has no native worklog/time-tracking API; out of scope confirmed |
| GitHub Issues time tracking | GitHub API docs | GitHub Issues has no native worklog API; out of scope confirmed |
| Existing data model | `database.ts`, `types.ts` | Sessions already have `issue_provider`, `issue_id`, `actual_duration_seconds` -- all data needed for worklog is present |

### Recommended Approach
Extend the existing `JiraProvider` class with an `addWorklog` method that mirrors the existing `request()` pattern. Add a new IPC channel (`worklog:log`) separate from session save to maintain non-blocking behavior. Add two new columns to the sessions table (`worklog_status`, `worklog_id`) via idempotent migration.

**Why this approach:**
- Reuses existing auth and request infrastructure in `jira-provider.ts`
- Keeps worklog completely decoupled from session save (separate IPC call, separate UI action)
- Idempotent migration follows established pattern in `database.ts`
- Storing `worklog_id` enables duplicate detection

**Alternatives considered:**
- **Auto-log on session save**: Rejected by user -- manual trigger preferred for control
- **Separate worklog table**: Adds complexity; a column on sessions is sufficient for 1:1 relationship
- **Support all providers**: Linear and GitHub lack worklog APIs; would require workarounds (comments as pseudo-worklogs) that add complexity without real value

---

## 10. Requirements Analysis (Appendix)

### Gaps Identified During Analysis
| Area | Gap Identified | Resolution |
|------|----------------|------------|
| Trigger mechanism | Whether to auto-log or manually trigger | User clarified: manual button post-save |
| Duration to log | Planned vs actual duration | User clarified: actual duration |
| Provider scope | Which issue trackers support worklogs | User clarified: Jira only (Linear/GitHub lack worklog APIs) |
| Failure handling | Blocking vs non-blocking on error | User clarified: non-blocking with retry |

### Assumptions Made
| Assumption | Basis | Risk if Wrong |
|------------|-------|---------------|
| Jira worklog `comment` field in Cloud v3 requires ADF format | Jira Cloud v3 API documentation and existing ADF handling in codebase | If plain string works for worklogs in v3, the ADF construction is unnecessary but harmless |
| One worklog per session (1:1 relationship) | User requirement is single "Log Work" action per session | If users want to split a session across multiple worklogs, the data model would need a separate table |
| Existing Jira credentials have worklog permissions | Most Jira projects grant "Log Work" to members by default | If permissions are missing, the error handling will surface this clearly |

### Requirements Completeness
- **Initial requirement detail level**: Detailed (user provided 6 key features with specific decisions)
- **Questions asked**: 0 questions (all requirements pre-clarified by user)
- **Gaps filled**: 4 of 4 identified gaps resolved by user decisions
- **Confidence level**: High