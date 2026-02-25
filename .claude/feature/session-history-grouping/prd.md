# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Session History Grouping |
| **Author** | Athena (PM Agent) |
| **Status** | Draft |
| **Date** | 2026-02-24 |
| **Version** | 1.0 |

---

## 1. Executive Summary

Session History Grouping transforms the flat, chronological session list in LizMeter into a structured, hierarchical view organized first by linked issue, then by date. Users who track time against issues (Linear, Jira, GitHub) will immediately see total time invested per issue and per day, without manually scanning individual rows.

This feature applies to both the Sidebar (260px panel) and the History Page. Groups are collapsible and collapsed by default, showing only summary information (issue name, total time, session count). Sessions without a linked issue remain as flat, ungrouped items displayed after all issue groups.

The change addresses a core usability gap: as session count grows, finding "how much time did I spend on issue X?" requires mental arithmetic across scattered rows. Grouping eliminates that friction entirely.

---

## 2. Problem Statement

### Current Situation

Session history is displayed as a flat, reverse-chronological list in both the Sidebar and History Page. Each session is an independent row showing duration, date, title, tags, and optionally a linked issue badge. There is no aggregation or grouping of any kind.

### Target Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Issue-focused developer | Tracks time against Linear/Jira/GitHub issues daily | See total time per issue at a glance |
| Freelancer/consultant | Uses sessions to bill time per task | Quick per-issue time summaries without export |
| Casual user | Uses timer without linking issues | Unchanged experience; ungrouped sessions still visible |

### Pain Points

1. **No time-per-issue visibility** -- Users must mentally sum durations across multiple sessions linked to the same issue, especially when sessions span multiple days.
2. **Visual clutter** -- Long flat lists make it hard to find sessions related to a specific issue.
3. **No daily summaries** -- Even within a single issue, there is no breakdown of time spent per day.

---

## 3. Goals & Success Metrics

### Business Goals

- Improve session history usability for users who link sessions to issues
- Reduce time-to-answer for "how much time did I spend on X?"
- Maintain simplicity for users who do not use issue linking

### Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Time to find total hours on an issue | Manual counting (30s+) | Instant (visible in collapsed header) | User observation |
| Sessions visible before scrolling (Sidebar) | ~6 flat rows | ~10+ collapsed groups | Count visible items |
| User complaints about history readability | Baseline (qualitative) | Reduction | Feedback |

### Out of Scope

- Filtering by issue (existing tag filter remains; issue-level filter is a separate future feature)
- Drag-and-drop reordering of groups
- Custom grouping criteria (e.g., group by tag, group by timer type)
- Export or reporting of grouped data
- Changing the underlying data model or database schema for sessions
- Server-side grouping via new SQL queries (grouping is a renderer-side transformation of existing data)

---

## 4. Requirements

### P0 - Must Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-001 | Issue-first grouping hierarchy | As a user, I want sessions grouped by issue so I can see total time per issue | Given sessions linked to issues exist, When I view history, Then sessions are grouped under their issue header with issue name/identifier displayed |
| FR-002 | Date sub-groups within issue groups | As a user, I want to see daily breakdowns within each issue group | Given an issue group contains sessions from multiple days, When I expand the issue group, Then sessions are sub-grouped by date with per-date total time shown |
| FR-003 | Total time per issue group | As a user, I want to see the aggregate time for each issue without expanding | Given an issue group is collapsed, When I look at the header, Then I see the total duration (sum of actualDurationSeconds) and session count |
| FR-004 | Total time per date sub-group | As a user, I want daily totals within an issue group | Given a date sub-group header is visible, When I look at it, Then I see the total duration for that date and session count for that date |
| FR-005 | Collapsed by default | As a user, I want a compact overview without noise | Given I open the app or navigate to history, When groups render, Then all issue groups and date sub-groups are collapsed showing only summary headers |
| FR-006 | Expand/collapse interaction | As a user, I want to drill into a group to see individual sessions | Given a collapsed group header, When I click it, Then it expands to show its children (date sub-groups or individual sessions). Clicking again collapses it. |
| FR-007 | Ungrouped sessions as flat items | As a user with sessions not linked to issues, I want them still visible | Given sessions exist with no linked issue (issueProvider is null AND issueNumber is null AND issueId is null), When I view history, Then those sessions appear as individual flat items after all issue groups |
| FR-008 | Both Sidebar and History Page | As a user, I want consistent grouping in both views | Given the grouping feature is active, When I view the Sidebar history section or the History Page, Then both display the grouped layout |

### P1 - Should Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-010 | Visual collapse indicator | As a user, I want to know if a group is expanded or collapsed | Given a group header, When I look at it, Then a chevron/arrow indicator shows the current expand/collapse state |
| FR-011 | Issue provider icon in group header | As a user, I want to know which provider an issue is from | Given an issue group header, When I look at it, Then I see a small indicator of the provider (GitHub, Linear, Jira) alongside the issue identifier |
| FR-012 | Smooth expand/collapse animation | As a user, I want a polished interaction | Given I click a group header, When the group expands or collapses, Then the transition is animated (height transition, ~150ms) |
| FR-013 | Persist expand/collapse state per session | As a user, I want my expanded groups to stay expanded during a single app session | Given I expand an issue group, When I navigate away and come back to history, Then the group remains expanded until app restart |

### P2 - Nice to Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-020 | Expand all / Collapse all button | As a user, I want to quickly toggle all groups | Given the history view, When I click "Expand all" or "Collapse all", Then all groups toggle accordingly |
| FR-021 | Keyboard navigation for groups | As a user, I want to expand/collapse with keyboard | Given a group header is focused, When I press Enter or Space, Then it toggles expand/collapse |

### Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Grouping transformation of 500 sessions should complete in under 50ms (renderer-side, no perceptible lag) |
| Performance | Expand/collapse should be instant (<16ms frame budget) with no layout shift |
| Compatibility | Must work with existing tag filter -- when a tag filter is active, grouping applies to the filtered results |
| Compatibility | Must work with existing "Load more" pagination -- newly loaded sessions integrate into existing groups or create new ones |
| Visual consistency | Group headers must follow the Tokyo Night dark theme (colors from CSS variables in index.html) |
| Accessibility | Group headers should be focusable and operable via keyboard (Enter/Space to toggle) |

---

## 5. User Flows

### Primary Flow: Viewing Grouped History

```
1. User opens LizMeter (Sidebar visible) or navigates to History Page
2. System loads sessions via existing session:list IPC (flat list)
3. Renderer groups sessions client-side:
   a. Partition sessions into "has issue" and "no issue"
   b. Group "has issue" sessions by unique issue identity (provider + issueId, or legacy issueNumber)
   c. Within each issue group, sub-group by date (completedAt date portion)
   d. Sort issue groups by most recent session (descending)
   e. Sort date sub-groups within each issue group by date (descending)
4. System renders:
   a. Issue group headers (collapsed) -- showing: issue identifier, issue title, provider badge, total time, session count
   b. After all issue groups: ungrouped sessions as flat items (same rendering as today)
5. User clicks an issue group header
6. Group expands to show date sub-group headers
7. User clicks a date sub-group header
8. Sub-group expands to show individual session rows/cards
9. User can interact with individual sessions as before (delete, manage tags, open issue link)
```

### Flow: Load More with Groups

```
1. User sees "Load more (N remaining)" button at bottom
2. User clicks Load more
3. System fetches next page of sessions (existing pagination)
4. Renderer merges new sessions into existing group structure:
   a. New sessions for existing issues merge into their issue group
   b. New sessions for new issues create new issue groups
   c. New ungrouped sessions append to the ungrouped section
5. Expand/collapse state of existing groups is preserved
```

### Flow: Tag Filter with Groups

```
1. User selects a tag filter
2. System re-fetches sessions filtered by tag (existing behavior)
3. Renderer re-groups the filtered results using the same grouping logic
4. Groups reflect only sessions matching the tag filter
```

### Error/Edge Flows

- **All sessions are ungrouped (no issues linked)**: No issue group headers appear. All sessions render as flat items, identical to current behavior.
- **Single session per issue**: Issue group still appears with "1 session" in header. Expanding shows one date sub-group with one session.
- **Multiple providers, same issue title**: Sessions are grouped by unique issue identity (provider + issueId), NOT by title. Two issues with the same title from different providers are separate groups.
- **Legacy GitHub sessions (issueProvider null, issueNumber set)**: Treated as GitHub issues for grouping purposes. Grouped by issueNumber.

---

## 6. Dependencies & Risks

### Dependencies

| Dependency | Type | Impact |
|------------|------|--------|
| Existing session:list IPC and pagination | Internal | Grouping builds on top of existing data fetching; no changes to IPC needed |
| Session.issueProvider, Session.issueId fields | Internal | Used to determine grouping key; already exist in data model |
| Tokyo Night CSS variables | Internal | Group headers must use existing theme tokens |

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Large session counts cause slow grouping | Low | Medium | Grouping is O(n) with a hash map; 500 sessions is trivial. Monitor and optimize only if needed. |
| Pagination loads partial issue groups | Medium | Low | Merging new pages into existing groups is a well-defined operation. "Load more" may reveal that an existing group has more sessions -- the count/total in the header should update. |
| Sidebar width (260px) too narrow for group headers | Medium | Medium | Design group headers to be compact: truncate issue titles with ellipsis, use abbreviated time format (e.g., "2h 15m"). |
| Users may be confused by collapsed-by-default | Low | Low | Collapse indicator (chevron) makes interactivity obvious. P1 requirement. |

---

## 7. Open Questions

| Question | Status | Impact |
|----------|--------|--------|
| Should the grouping key for legacy GitHub sessions (issueProvider=null, issueNumber set) use `issueNumber` or `issueUrl`? | Open | Affects whether sessions for the same issue number across different repos are grouped together. Recommendation: use issueUrl if available, fall back to issueNumber. |
| Should "Load more" count reflect total ungrouped sessions or total groups? | Open | The existing "N remaining" text counts sessions. With grouping, this still makes sense since pagination is session-based. Recommendation: keep as-is (session count). |

---

## 8. External API Dependencies

No external API dependencies. This feature is entirely client-side, transforming data already fetched via existing IPC channels. No new network calls, third-party libraries, or external service integrations are required.

---

## 9. External Research Summary

No external research was required for this feature. The grouping pattern (hierarchical collapsible lists) is a well-established UI pattern. The implementation is entirely scoped to the existing codebase with no new dependencies.

### Recommended Approach

Client-side grouping in the renderer layer. The existing `session:list` IPC returns a flat array of sessions with all necessary fields (`issueProvider`, `issueId`, `issueNumber`, `issueTitle`, `issueUrl`, `completedAt`). A pure function transforms this flat array into a grouped data structure that the UI components consume.

**Why this approach:**
- No database schema changes needed
- No new IPC channels needed
- Grouping logic is testable as a pure function
- Existing pagination continues to work unchanged
- Renderer already has all data needed for grouping

**Alternatives considered:**
- Server-side grouping via SQL GROUP BY -- rejected because it would require a new IPC channel, new query structure, and would complicate pagination. The session counts are small enough that client-side grouping is efficient.
- Virtual scrolling with grouped data -- rejected as premature optimization. Can be added later if performance becomes an issue with very large histories.

---

## 10. Requirements Analysis (Appendix)

### Gaps Identified During Analysis

| Area | Gap Identified | Resolution |
|------|----------------|------------|
| Grouping hierarchy | Which dimension comes first (date or issue)? | User clarified: issue first, then date |
| Ungrouped sessions | How to handle sessions with no linked issue? | User clarified: flat items after all issue groups |
| View scope | Which views get grouping? | User clarified: both Sidebar and History Page |
| Default state | Expanded or collapsed by default? | User clarified: collapsed by default with total time and session count |

### Assumptions Made

| Assumption | Basis | Risk if Wrong |
|------------|-------|---------------|
| Grouping is performed client-side in the renderer | Session data already contains all fields needed for grouping; session volumes are manageable client-side | Low risk -- if volumes become large, can move to server-side grouping later |
| Issue identity is determined by (issueProvider + issueId) or legacy issueNumber | These fields uniquely identify an issue in the current data model | Low risk -- if a new provider is added, the same pattern extends naturally |
| Expand/collapse state does not persist across app restarts | In-memory state is simpler; P1 requirement only asks for per-session persistence | Low risk -- can add localStorage persistence later if users request it |
| The "Load more" button and pagination remain session-based, not group-based | Changing pagination to be group-aware would require backend changes | Medium risk -- partial groups at page boundaries may look slightly odd, but merging handles this |

### Open Questions

| Question | Impact if Unresolved | Owner |
|----------|---------------------|-------|
| Legacy GitHub grouping key (issueNumber vs issueUrl) | Sessions for same issue number in different repos might be incorrectly grouped or split | Engineering (Hephaestus) to decide based on data reality |
| Whether Sidebar compact view needs a different group header design than History Page | Sidebar is 260px; History Page is full-width. Same component might not fit both. | Engineering (Hephaestus) to propose during tech spec |

### Requirements Completeness

- **Initial requirement detail level**: Detailed (user provided grouping hierarchy, collapse behavior, view scope, and ungrouped session handling)
- **Questions asked**: 0 (all critical decisions were pre-clarified by the user)
- **Gaps filled**: 4 of 4 identified gaps resolved via user decisions
- **Confidence level**: High