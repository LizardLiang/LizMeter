# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Linear Integration |
| **Author** | Athena (PM Agent) |
| **Status** | Draft |
| **Date** | 2026-02-23 |
| **Version** | 1.0 |

---

## 1. Executive Summary

LizMeter is a pomodoro timer Electron app that already supports linking GitHub Issues to timer sessions. This feature extends that capability to support Linear, a popular project management tool used by engineering teams. Users will be able to browse, search, and link Linear issues to their pomodoro sessions, with the same level of integration currently available for GitHub Issues.

The integration follows the existing issue provider pattern established by the GitHub integration, adding Linear as a second provider. The Issues sidebar and issue selector in the save dialog will support both providers via a tab or toggle mechanism, allowing users to configure and use either or both services simultaneously.

This feature directly supports users who track their work in Linear rather than (or in addition to) GitHub Issues, enabling them to maintain a clear connection between focused work sessions and their project management workflow.

---

## 2. Problem Statement

### Current Situation
LizMeter currently supports only GitHub Issues as an issue tracker integration. Users can browse their assigned GitHub issues, link them to pomodoro sessions, and see which issue they worked on in session history. However, many development teams and individuals use Linear as their primary issue tracker. These users cannot connect their pomodoro sessions to the issues they are actually working on.

### Target Users
| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Linear User | Developer or knowledge worker who tracks work items in Linear | Link pomodoro sessions to Linear issues for time tracking awareness |
| Multi-tool User | Developer who uses both GitHub Issues and Linear across different projects | Switch between providers depending on which project they are working on |

### Pain Points
1. Users who track work in Linear cannot link sessions to their issues, losing the connection between focused work and task tracking
2. No way to browse Linear issues from within LizMeter to pick what to work on next
3. Users who use both GitHub and Linear must choose one or abandon issue linking entirely

---

## 3. Goals & Success Metrics

### Business Goals
- Expand issue tracker support beyond GitHub to cover a significant segment of the developer tool market
- Establish a multi-provider pattern that makes future integrations (Jira, Asana, etc.) straightforward
- Increase daily active usage by making LizMeter relevant to Linear-centric teams

### Success Metrics
| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Issue providers supported | 1 (GitHub) | 2 (GitHub + Linear) | Feature completion |
| Linear connection success rate | N/A | 95%+ on first attempt | Test connection button success vs failure |
| Sessions linked to Linear issues | 0 | Any non-zero adoption | Count of sessions with `linear_issue_id` |

### Out of Scope
- Creating or updating Linear issues from within LizMeter (read-only integration)
- Linear OAuth2 flow (personal API key only for v1)
- Linear project-level browsing (team-scoped issue list only)
- Syncing time spent back to Linear
- Linear notifications or webhooks
- Commenting on Linear issues from LizMeter

---

## 4. Requirements

### P0 - Must Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-001 | Linear API key configuration | As a user, I want to enter my Linear API key in Settings so that LizMeter can access my Linear issues | Given I am in Settings, When I enter a valid Linear API key and save, Then the key is stored securely and Linear issues become available |
| FR-002 | Test connection for Linear | As a user, I want to verify my Linear API key works before using it so that I can troubleshoot configuration issues | Given I have entered a Linear API key, When I click "Test Connection", Then I see my Linear display name on success or a clear error message on failure |
| FR-003 | Team selection | As a user, I want to select which Linear team to browse issues from so that I see only relevant issues | Given I have a valid Linear API key, When I open team selection, Then I see a list of teams from my Linear workspace and can pick one |
| FR-004 | Browse Linear issues | As a user, I want to browse my Linear issues in the Issues sidebar so that I can see what I need to work on | Given I have configured Linear with a team, When I open the Issues sidebar on the Linear tab, Then I see a list of open issues for my selected team showing identifier (e.g., "LIN-42"), title, status, and priority |
| FR-005 | Link Linear issue to session | As a user, I want to link a Linear issue to my pomodoro session when saving so that I can track which issue I worked on | Given I have completed a pomodoro, When I save the session, Then I can select a Linear issue from the issue selector and the session stores the Linear issue reference |
| FR-006 | Display linked Linear issues in history | As a user, I want to see which Linear issue a past session was linked to so that I can review my work history | Given I am viewing session history, When a session has a linked Linear issue, Then I see the Linear issue identifier and title displayed |
| FR-007 | Multi-provider sidebar (tabs or toggle) | As a user, I want to switch between GitHub and Linear in the Issues sidebar so that I can browse issues from either provider | Given both GitHub and Linear are configured, When I view the Issues sidebar, Then I see a tab or toggle to switch between GitHub and Linear issue lists |
| FR-008 | Multi-provider issue selector | As a user, I want to pick issues from either GitHub or Linear in the save dialog so that I can link the correct issue regardless of provider | Given both providers are configured, When I open the issue selector in the save dialog, Then I can choose between GitHub and Linear issues |

### P1 - Should Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-010 | Search/filter Linear issues | As a user, I want to search within my Linear issues so that I can quickly find the one I am working on | Given I am browsing Linear issues, When I type in a search field, Then the issue list filters to show matching issues by title or identifier |
| FR-011 | Display Linear issue metadata | As a user, I want to see priority and status labels on Linear issues so that I can identify urgent work | Given I am browsing Linear issues, When I see the issue list, Then each issue shows its priority level and workflow state with appropriate visual indicators |
| FR-012 | Delete Linear configuration | As a user, I want to remove my Linear API key and configuration so that I can disconnect the integration | Given I have configured Linear, When I click "Disconnect" in Settings, Then my Linear API key and team selection are removed and Linear issues are no longer shown |

### P2 - Nice to Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-020 | Open Linear issue in browser | As a user, I want to click a Linear issue to open it in my browser so that I can view full details | Given I see a Linear issue in the sidebar or history, When I click its link/URL, Then it opens in my default browser |
| FR-021 | Remember last active provider tab | As a user, I want the sidebar to remember which provider tab I last used so that it defaults to my preferred provider | Given I switch to the Linear tab, When I navigate away and return, Then the Linear tab is still selected |
| FR-022 | Force refresh Linear issues | As a user, I want to manually refresh the Linear issue list so that I see the latest changes | Given I am browsing Linear issues, When I click a refresh button, Then the cached list is cleared and issues are re-fetched from Linear |

### Non-Functional Requirements
| Category | Requirement |
|----------|-------------|
| Performance | Linear API calls should complete within 3 seconds under normal network conditions |
| Performance | In-memory issue cache to avoid redundant API calls within the same browsing session |
| Security | Linear API key must be stored in the same secure manner as the GitHub token (encrypted on disk via Electron safeStorage or equivalent existing pattern) |
| Reliability | Clear error messages for authentication failures, network issues, and rate limiting (Linear allows 1,500 requests/hour) |
| Consistency | Linear integration UI must match the existing GitHub integration UI in style, layout, and interaction patterns |
| Consistency | All styling must use inline React.CSSProperties with Tokyo Night theme colors |

---

## 5. User Flows

### Primary Flow: Configure Linear Integration
```
1. User opens Settings panel
2. User scrolls to "Linear" section (below existing GitHub section)
3. User enters their Linear personal API key
4. User clicks "Test Connection"
5. System validates the key and displays the user's Linear display name
6. System fetches available teams from the user's workspace
7. User selects a team from the dropdown
8. Configuration is saved
9. Issues sidebar now shows a tab/toggle for Linear
```

### Primary Flow: Link a Linear Issue to a Session
```
1. User starts a pomodoro timer
2. (Optionally) User browses Linear issues in sidebar and clicks one to pre-select it
3. Timer completes
4. Save dialog appears with issue selector
5. User selects Linear tab/toggle in the issue selector
6. User picks an issue from the Linear issue list
7. User clicks Save
8. Session is stored with the Linear issue reference (identifier, title, URL)
```

### Primary Flow: Browse Linear Issues
```
1. User clicks Issues tab in the navigation sidebar
2. Issues sidebar opens, defaulting to the last active provider tab
3. User clicks "Linear" tab (if not already selected)
4. System fetches open issues for the configured team
5. User sees list of issues with identifier, title, status, and priority
6. User can search/filter the list by typing
7. User can click an issue to pre-select it for their next session
```

### Error Flows
- **Invalid API key**: Test Connection shows "API key is invalid or has been revoked" with guidance to check Settings > Account > Security & Access in Linear
- **No team selected**: Issues sidebar shows "Please select a team in Settings" prompt
- **Network failure**: Issues list shows "Could not reach Linear. Check your internet connection." with a retry button
- **Rate limited**: Show "Linear API rate limit reached. Try again in a few minutes." (1,500 req/hour limit)

---

## 6. Dependencies & Risks

### Dependencies
| Dependency | Type | Impact |
|------------|------|--------|
| Linear GraphQL API (https://api.linear.app/graphql) | External | Core dependency; feature is non-functional if API is unavailable |
| `@linear/sdk` npm package (or raw GraphQL fetch) | External | Provides typed SDK for Linear API; alternative is raw fetch with hand-written queries |
| Existing issue provider abstraction (`IssueProvider` interface) | Internal | Must extend to support Linear's different data model (string IDs, team scoping, GraphQL) |
| Database schema migration | Internal | Must add `linear_issue_id TEXT` column (or equivalent) to sessions table |
| Existing UI components (IssuesSidebar, IssueSelector, SettingsPanel, HistoryPage) | Internal | Must be updated to support multi-provider switching |

### Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Linear API changes or deprecations | Low | High | Use official `@linear/sdk` which tracks API changes; pin version |
| `@linear/sdk` may have CJS/ESM compatibility issues with Electron | Medium | Medium | Test early; fall back to raw `fetch` with GraphQL queries if SDK is incompatible |
| Data model mismatch between GitHub (integer issue numbers) and Linear (string identifiers) | Medium | Medium | Design the multi-provider session storage to use a generic `issue_provider` + `issue_id` pattern, or keep separate columns |
| Rate limiting at 1,500 req/hour could affect heavy users | Low | Low | Implement in-memory caching (same pattern as GitHub provider) |
| Team selection adds configuration complexity vs GitHub's simpler repo-based model | Low | Low | Auto-select if user has only one team; provide clear team picker otherwise |

---

## 7. Open Questions

| Question | Status |
|----------|--------|
| Should we use `@linear/sdk` or raw `fetch` with GraphQL queries? (SDK adds a dependency but provides types; raw fetch is lighter) | Open - for Hephaestus to decide |
| Should sessions store a generic `issue_provider` + `issue_id` or a separate `linear_issue_id` column? | Open - for Hephaestus to decide |
| Should the multi-provider toggle be tabs at the top of the sidebar or a dropdown selector? | Open - UI preference, tabs recommended for quick switching |
| When both providers are configured, which one should be the default in the issue selector? | Open - suggest last-used provider |
| Should users be able to configure multiple Linear teams or just one at a time? | Resolved - v1 supports one team at a time; can change in Settings |

---

## 8. External API Dependencies

### Linear GraphQL API
| Aspect | Details |
|--------|---------|
| **Endpoint** | `https://api.linear.app/graphql` |
| **Authentication** | Personal API key via `Authorization: <API_KEY>` header |
| **SDK Option** | `@linear/sdk` (official TypeScript SDK, wraps GraphQL) |
| **Key Capabilities** | Query issues by team, search issues, query teams, query viewer (authenticated user) |
| **Issue Fields** | `id` (UUID), `identifier` (e.g., "LIN-42"), `title`, `url`, `state` (workflow state), `priority` (0-4), `assignee`, `labels`, `updatedAt` |
| **Team Fields** | `id`, `name`, `key` (prefix for issue identifiers) |
| **Rate Limits** | 1,500 requests per hour per API key |
| **Documentation** | [Linear Developers](https://linear.app/developers) |

### Key Differences from GitHub API
| Aspect | GitHub | Linear |
|--------|--------|--------|
| Protocol | REST | GraphQL |
| Issue ID format | Integer (`42`) | String identifier (`LIN-42`) + UUID |
| Scoping | Repository (owner/repo) | Team |
| Authentication | Personal access token | Personal API key |
| Status model | `open` / `closed` | Workflow states (Backlog, Todo, In Progress, Done, Cancelled) |
| Priority | None (via labels) | Native 0-4 scale (No priority, Urgent, High, Medium, Low) |