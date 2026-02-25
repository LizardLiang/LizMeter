# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Jira Integration |
| **Author** | Athena (PM Agent) |
| **Status** | Approved |
| **Date** | 2026-02-23 |
| **Version** | 1.1 (post-review revision) |

---

## 1. Executive Summary

Add Jira Cloud as a third issue provider in LizMeter, alongside the existing GitHub Issues and Linear integrations. Users will be able to connect their Atlassian account, browse Jira issues by project (with optional JQL filtering), and link issues to timer sessions.

This integration follows the established provider-based architecture. The database already supports arbitrary providers via the `provider` column, so the work is primarily API integration, settings UI expansion, and ensuring a consistent user experience across all three providers.

---

## 2. Problem Statement

### Current Situation
LizMeter supports linking timer sessions to GitHub Issues and Linear issues. Users who track work in Jira -- one of the most widely used project management tools -- cannot link their Jira issues to sessions. They must manually note which Jira ticket they are working on, breaking the seamless workflow that GitHub and Linear users enjoy.

### Target Users
| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Jira user | Developer or team member whose org uses Jira Cloud for issue tracking | Link Jira issues to timer sessions without leaving the app |
| Multi-tool user | Developer who uses Jira alongside GitHub/Linear | Switch between providers or use Jira as their issue source |

### Pain Points
1. Jira users cannot link issues to timer sessions, making session context incomplete
2. No way to browse Jira issues from within LizMeter
3. Manual tracking of which Jira ticket a session relates to is error-prone

---

## 3. Goals & Success Metrics

### Business Goals
- Expand issue provider coverage to include the most widely used project management tool
- Maintain a consistent user experience across all issue providers
- Follow existing architectural patterns to minimize complexity

### Success Metrics
| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Supported issue providers | 2 (GitHub, Linear) | 3 (+ Jira) | Provider count |
| Jira issues browsable | No | Yes | Feature exists and returns issues |
| Jira issues linkable to sessions | No | Yes | Session records show Jira issue key |
| Test connection works | N/A | Yes | Settings shows connection success/failure |

### Out of Scope
- Jira Server / Data Center support (Cloud only for v1)
- OAuth 2.0 authentication flow (API token approach only)
- Writing back to Jira (e.g., logging time, updating issue status)
- Jira webhooks or real-time sync
- Jira boards, sprints, or epics browsing (project-level issues only)
- Displaying Jira fields beyond key, title, status, priority, and assignee

---

## 4. Requirements

### P0 - Must Have
| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-001 | Add "Jira" as a selectable issue provider | As a user, I want to select Jira as my issue provider so I can browse Jira issues | Given the issue settings panel, When I open the provider dropdown, Then "Jira" appears as an option alongside GitHub and Linear |
| FR-002 | Jira authentication via API token | As a user, I want to enter my Jira credentials so the app can fetch my issues | Given Jira is selected as provider, When I enter my Atlassian domain, email, and API token, Then the credentials are saved securely in settings |
| FR-003 | Test connection for Jira | As a user, I want to verify my Jira credentials work before browsing issues | Given Jira credentials are entered, When I click "Test Connection", Then I see a success or failure message indicating whether the API responded correctly |
| FR-004 | Browse issues by Jira project key | As a user, I want to enter a project key and see issues from that project | Given valid Jira credentials and a project key (e.g. "PROJ"), When I browse issues, Then I see a list of recent issues from that project |
| FR-005 | Link Jira issue to timer session | As a user, I want to link a Jira issue to my current timer session | Given I am viewing Jira issues, When I select an issue, Then it is linked to my current/next session and the issue key (e.g. PROJ-123) is displayed |
| FR-006 | Display issue key, title, and status in issue list | As a user, I want to see basic issue information when browsing | Given Jira issues are loaded, When I view the issue list, Then each issue shows its key, title, and status -- consistent with GitHub and Linear display |

### P1 - Should Have
| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-010 | Display priority and assignee in issue list | As a user, I want to see priority and assignee to help pick which issue to work on | Given Jira issues are loaded, When I view the issue list, Then each issue also shows its priority level and assignee name (if assigned) |
| FR-011 | Optional JQL filter field | As a power user, I want to enter a JQL query to filter issues beyond project scope | Given Jira is selected, When I enter a JQL string in the optional filter field, Then the issue list reflects the JQL query results instead of the default project listing |
| FR-012 | Clickable issue link opens in browser | As a user, I want to click an issue to open it in Jira | Given a Jira issue is displayed, When I click its key or a link icon, Then it opens the issue in my default browser at `https://{domain}.atlassian.net/browse/{key}` |

### P2 - Nice to Have
| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-020 | Issue type icon (Bug, Story, Task) | As a user, I want visual distinction between issue types | Given Jira issues are loaded, When I view the list, Then each issue shows an icon or label for its type |
| FR-021 | Remember last used project key | As a user, I want the app to remember my project key between sessions | Given I previously entered a project key, When I reopen the app, Then the project key field is pre-filled |

### Non-Functional Requirements
| Category | Requirement |
|----------|-------------|
| Performance | Issue list should load within 3 seconds for up to 50 issues |
| Security | API tokens must be stored in the app's settings store, never logged or exposed |
| Consistency | Jira integration UI and behavior must be consistent with GitHub and Linear patterns |
| Error handling | Clear error messages for invalid credentials, unreachable domain, invalid project key, and malformed JQL |
| Compatibility | Jira Cloud REST API v3 only; no Server/Data Center support required |

---

## 5. User Flows

### Primary Flow: Configure Jira and Browse Issues
```
1. User opens Issue Settings
2. User selects "Jira" from the provider dropdown
3. Settings UI shows three fields: Atlassian Domain, Email, API Token
4. User enters credentials
5. User clicks "Test Connection"
6. System calls Jira API (GET /rest/api/3/myself) to validate credentials
7. System shows success message with the authenticated user's display name
8. User enters a Jira project key (e.g. "PROJ")
9. User clicks browse/refresh
10. System fetches issues from the project via Jira REST API
11. Issue list displays with key, title, status, priority, and assignee
```

### Secondary Flow: Link Issue to Session
```
1. User views the issue list (populated from Jira)
2. User clicks/selects an issue
3. Issue is linked to the current or next timer session
4. Session record stores: issue key, title, URL, provider = "jira"
5. Session history shows the linked Jira issue
```

### Secondary Flow: JQL Filtering
```
1. User has Jira configured with valid credentials
2. User enters a JQL query in the optional filter field
   (e.g. "assignee = currentUser() AND status != Done")
3. System sends JQL to Jira search API
4. Issue list updates with filtered results
5. If JQL is invalid, system shows Jira's error message
```

### Error Flows
- **Invalid credentials**: "Test Connection" shows failure with HTTP status context (401 = bad token, 403 = permission issue)
- **Invalid domain**: Show "Could not reach {domain}.atlassian.net. Please check the domain name."
- **Invalid project key**: Show "Project '{key}' not found. Please verify the project key in Jira."
- **Invalid JQL**: Show Jira's JQL parse error message to help the user fix their query
- **Rate limited**: Show "Jira API rate limit reached. Please wait a moment and try again."
- **Network error**: Show "Could not connect to Jira. Please check your internet connection."

---

## 6. Dependencies & Risks

### Dependencies
| Dependency | Type | Impact |
|------------|------|--------|
| Jira Cloud REST API v3 | External | Core functionality depends on Atlassian API availability and stability |
| Existing provider architecture | Internal | Must extend IssueProvider type, ExternalIssue interface, IPC handlers |
| Atlassian account with API token | User | User must generate an API token at id.atlassian.com |

### Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Jira API rate limiting | Medium | Medium | Implement reasonable fetch limits (50 issues max per request) |
| API token generation friction | Medium | Low | Provide clear instructions/link to Atlassian API token page in settings UI |
| JQL complexity causing confusion | Low | Low | Make JQL optional; default to simple project-based browsing |

---

## 7. External API Details

### Jira Cloud REST API v3
| Aspect | Details |
|--------|---------|
| **Base URL** | `https://{domain}.atlassian.net/rest/api/3/` |
| **Authentication** | Basic Auth: email as username, API token as password (Base64 encoded) |
| **Key Endpoints** | `GET /myself` (test connection), `GET /search` (JQL search), `GET /project/{key}` (validate project) |
| **Search Endpoint** | `GET /search?jql={jql}&maxResults=50&fields=summary,status,priority,assignee,issuetype` |
| **Issue URL Pattern** | `https://{domain}.atlassian.net/browse/{issueKey}` |

### Authentication Header
```
Authorization: Basic base64({email}:{apiToken})
```

### Response Mapping to ExternalIssue
| Jira Field | ExternalIssue Field | Notes |
|------------|---------------------|-------|
| `issue.key` | `key` | e.g. "PROJ-123" |
| `issue.fields.summary` | `title` | Issue title |
| `issue.fields.status.name` | `status` | e.g. "In Progress" |
| `issue.id` | `id` | Jira's internal ID |
| constructed URL | `url` | `https://{domain}.atlassian.net/browse/{key}` |
| `"jira"` | `provider` | Constant |
| `issue.fields.priority.name` | (extended) | P1: display in list |
| `issue.fields.assignee.displayName` | (extended) | P1: display in list |

---

## 8. Architectural Integration

Jira MUST integrate into the existing multi-provider architecture:

| Aspect | Current Pattern | Jira Integration |
|--------|----------------|------------------|
| **Type union** | `IssueProvider = "github" \| "linear"` in `src/shared/types.ts` | Add `\| "jira"` to the union |
| **API module** | `electron/main/github-api.ts`, `linear-api.ts` | Create `electron/main/jira-api.ts` with same `fetchIssues()` signature |
| **IPC handlers** | Provider switch in `electron/main/ipc-handlers.ts` for `issues:fetch` and `issues:test-connection` | Add `"jira"` cases to existing switches |
| **Settings UI** | `IssueSettings.tsx` renders provider-specific fields | Add Jira fields (domain, email, token, project key, optional JQL) |
| **Issue list** | `IssueList.tsx` renders `ExternalIssue[]` generically | No changes needed — Jira issues map to `ExternalIssue` |
| **Database** | `session_issues` table has `provider` column (text) | No schema changes — stores `"jira"` as provider value |
| **Settings storage** | Key-value pairs: `github_token`, `linear_api_key`, etc. | Add: `jira_domain`, `jira_email`, `jira_api_token`, `jira_project_key`, `jira_jql_filter` |
| **Preload API** | `window.electronAPI` exposes issue methods | No changes — existing IPC channels are provider-agnostic |

### Pagination
Initial fetch returns up to 50 issues (Jira API default `maxResults=50`). No pagination UI for v1 — matches existing GitHub/Linear behavior which also fetch a fixed batch.