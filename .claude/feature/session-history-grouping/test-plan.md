# Test Plan

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Session History Grouping |
| **Author** | Artemis (QA Agent) |
| **Date** | 2026-02-24 |
| **PRD Version** | 1.0 |
| **Tech Spec Version** | R1 |

---

## 1. Test Overview

### Scope

This test plan covers the session history grouping feature: a client-side transformation of flat session lists into a hierarchical view grouped by linked issue (primary) and date (secondary). The scope includes:

- The `groupSessionsByIssue()` pure utility function and its helper functions
- The `formatDuration()` utility added to `format.ts`
- The `formatDateLabel()` helper within `groupSessions.ts`
- The extracted `IssueBadge` component with all provider support (github, linear, jira, legacy-github)
- The `IssueGroupHeader` component (expand/collapse, provider icon, total time, session count)
- The `DateSubGroupHeader` component (expand/collapse, date label, total time, session count)
- Sidebar.tsx integration with grouped rendering and expand/collapse state
- HistoryPage.tsx integration with grouped rendering and expand/collapse state
- State reset behavior when tag filter changes
- Pagination integration ("Load more") with grouped view

### Out of Scope

- E2E tests via Playwright (the tech spec marks these as "not strictly required"; component-level tests are sufficient)
- The pre-existing `useTimer.ts` Jira field persistence bug (acknowledged as out-of-scope in tech-spec Known Issues section 11)
- Performance benchmarking beyond the assertions in unit tests
- Accessibility auditing beyond keyboard interaction (Enter/Space to toggle groups)
- Database schema or IPC handler tests (no backend changes in this feature)
- The P2 "Expand all / Collapse all" button (FR-020 is not being implemented)

### Test Approach

1. **Unit tests first** -- The `groupSessionsByIssue()` function is pure (no DOM, no React), making it the highest-value test target. Comprehensive unit tests validate all grouping logic, key resolution, date labeling, and aggregation math.
2. **Component tests** -- React component tests using `@testing-library/react` + `vitest` validate rendering, expand/collapse interactions, and state management. All renderer tests mock `window.electronAPI` via `vi.stubGlobal`.
3. **Integration tests** -- Tests that exercise Sidebar.tsx and HistoryPage.tsx with the full grouping pipeline to verify end-to-end rendering from sessions array to grouped UI.
4. **Edge case coverage** -- Dedicated cases for empty inputs, all-ungrouped sessions, single-session groups, cross-provider uniqueness, and legacy GitHub sessions.

---

## 2. Requirements Coverage Matrix

| Req ID | Requirement | Test Cases | Priority |
|--------|-------------|------------|----------|
| FR-001 | Issue-first grouping hierarchy | TC-001, TC-002, TC-003, TC-101, TC-102, TC-200, TC-201 | P0 |
| FR-002 | Date sub-groups within issue groups | TC-004, TC-005, TC-103, TC-202 | P0 |
| FR-003 | Total time per issue group | TC-006, TC-104 | P0 |
| FR-004 | Total time per date sub-group | TC-007, TC-105 | P0 |
| FR-005 | Collapsed by default | TC-200, TC-300 | P0 |
| FR-006 | Expand/collapse interaction | TC-201, TC-202, TC-301, TC-302, TC-303 | P0 |
| FR-007 | Ungrouped sessions as flat items | TC-008, TC-009, TC-106, TC-203, TC-305 | P0 |
| FR-008 | Both Sidebar and History Page | TC-200, TC-201, TC-300, TC-301 | P0 |
| FR-010 | Visual collapse indicator (chevron) | TC-204, TC-304 | P1 |
| FR-011 | Issue provider icon in group header | TC-205, TC-305 | P1 |
| FR-012 | Smooth expand/collapse animation | TC-206, TC-306 | P1 |
| FR-013 | Persist expand/collapse state per app session | TC-207, TC-307 | P1 |
| FR-021 | Keyboard navigation (Enter/Space) | TC-208, TC-308 | P2 |
| NFR-PERF | 500 sessions group in under 50ms | TC-050 | P0 |
| NFR-COMPAT-FILTER | Works with tag filter | TC-209, TC-309 | P0 |
| NFR-COMPAT-PAGINATE | Works with Load more pagination | TC-210, TC-310 | P0 |

---

## 3. Test Cases

### Unit Tests -- groupSessions.ts (Pure Function)

Test file location: `src/renderer/src/utils/__tests__/groupSessions.test.ts`

---

#### TC-001: Empty array returns empty groups and empty ungrouped list

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-007 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: None.

**Test Steps**:
1. Call `groupSessionsByIssue([])`.

**Expected Result**:
- `issueGroups` is an empty array `[]`
- `ungroupedSessions` is an empty array `[]`

---

#### TC-002: All sessions without issues go to ungroupedSessions

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-007 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Three sessions with `issueProvider: null`, `issueNumber: null`, `issueId: null`.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups` is `[]`
- `ungroupedSessions` contains all three sessions

---

#### TC-003: Sessions with the same issue are collected into one IssueGroup

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Two sessions with `issueProvider: "github"`, `issueId: "42"`, same date.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups.length === 1`
- `issueGroups[0].sessionCount === 2`
- `ungroupedSessions` is `[]`

---

#### TC-004: Sessions for same issue across multiple dates produce correct date sub-groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Three sessions all linked to `issueProvider: "linear"`, `issueId: "LIN-10"`, completed on two different calendar days.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups.length === 1`
- `issueGroups[0].dateSubGroups.length === 2`
- Each `DateSubGroup.dateKey` is a valid YYYY-MM-DD string
- `DateSubGroup.sessionCount` matches sessions on that date

---

#### TC-005: Date sub-groups are sorted descending (most recent first)

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Sessions for one issue on three different dates: 2026-02-10, 2026-02-15, 2026-02-20.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `dateSubGroups[0].dateKey === "2026-02-20"`
- `dateSubGroups[1].dateKey === "2026-02-15"`
- `dateSubGroups[2].dateKey === "2026-02-10"`

---

#### TC-006: totalSeconds aggregation is correct per issue group

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Three sessions linked to same issue with `actualDurationSeconds` of 300, 600, 900.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups[0].totalSeconds === 1800`
- `issueGroups[0].sessionCount === 3`

---

#### TC-007: totalSeconds aggregation is correct per date sub-group

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Four sessions linked to same issue. Two sessions on date A (500s, 700s), two on date B (300s, 200s).

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- The sub-group for date A has `totalSeconds === 1200`
- The sub-group for date B has `totalSeconds === 500`

---

#### TC-008: Mixed linked and unlinked sessions are correctly partitioned

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Five sessions: two linked to issue A, one linked to issue B, two with no issue.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups.length === 2`
- `ungroupedSessions.length === 2`
- Issue A group has `sessionCount === 2`
- Issue B group has `sessionCount === 1`

---

#### TC-009: Ungrouped sessions preserve order (completedAt descending)

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Three ungrouped sessions with completedAt timestamps at T+0, T+1hr, T+2hr (input order is arbitrary).

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `ungroupedSessions[0]` is the session at T+2hr
- `ungroupedSessions[2]` is the session at T+0

---

#### TC-010: Issue groups are sorted by most recent session (latestCompletedAt descending)

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Sessions for issue A (most recent: 2026-02-20) and issue B (most recent: 2026-02-22).

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups[0].issueKey` corresponds to issue B
- `issueGroups[1].issueKey` corresponds to issue A

---

#### TC-011: GitHub sessions use key "github:{issueId}"

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: "github"`, `issueId: "42"`.

**Test Steps**:
1. Call `getIssueGroupKey(session)`.

**Expected Result**:
- `key === "github:42"`
- `provider === "github"`
- `displayId === "#42"`

---

#### TC-012: Linear sessions use key "linear:{issueId}"

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: "linear"`, `issueId: "LIN-42"`.

**Test Steps**:
1. Call `getIssueGroupKey(session)`.

**Expected Result**:
- `key === "linear:LIN-42"`
- `provider === "linear"`
- `displayId === "LIN-42"`

---

#### TC-013: Jira sessions use key "jira:{issueId}"

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: "jira"`, `issueId: "PROJ-123"`.

**Test Steps**:
1. Call `getIssueGroupKey(session)`.

**Expected Result**:
- `key === "jira:PROJ-123"`
- `provider === "jira"`
- `displayId === "PROJ-123"`

---

#### TC-014: Legacy GitHub sessions with issueUrl use key "legacy-github:{issueUrl}"

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: null`, `issueNumber: 7`, `issueUrl: "https://github.com/owner/repo/issues/7"`.

**Test Steps**:
1. Call `getIssueGroupKey(session)`.

**Expected Result**:
- `key === "legacy-github:https://github.com/owner/repo/issues/7"`
- `provider === "legacy-github"`
- `displayId === "#7"`

---

#### TC-015: Legacy GitHub sessions without issueUrl fall back to "legacy-github-num:{issueNumber}"

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: null`, `issueNumber: 7`, `issueUrl: null`.

**Test Steps**:
1. Call `getIssueGroupKey(session)`.

**Expected Result**:
- `key === "legacy-github-num:7"`
- `provider === "legacy-github"`
- `displayId === "#7"`

---

#### TC-016: Legacy GitHub sessions with same issueNumber but different issueUrl are separate groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Two legacy sessions both with `issueNumber: 5` but different `issueUrl` values (different repos).

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups.length === 2`
- Each group has `sessionCount === 1`

---

#### TC-017: Sessions from different providers with same issueId string are separate groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: One session with `issueProvider: "github"`, `issueId: "42"` and one with `issueProvider: "linear"`, `issueId: "42"`.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups.length === 2`
- The two groups have different `issueKey.key` values

---

#### TC-018: hasLinkedIssue returns true when issueProvider and issueId are set

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Unit |
| **Priority** | P0 |

**Test Steps**:
1. Call `hasLinkedIssue` with a session having `issueProvider: "github"` and `issueId: "1"`.

**Expected Result**: Returns `true`.

---

#### TC-019: hasLinkedIssue returns true for legacy GitHub (issueProvider null, issueNumber set)

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Unit |
| **Priority** | P0 |

**Test Steps**:
1. Call `hasLinkedIssue` with `issueProvider: null`, `issueNumber: 7`, `issueId: null`.

**Expected Result**: Returns `true`.

---

#### TC-020: hasLinkedIssue returns false when no issue fields are set

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Unit |
| **Priority** | P0 |

**Test Steps**:
1. Call `hasLinkedIssue` with `issueProvider: null`, `issueNumber: null`, `issueId: null`.

**Expected Result**: Returns `false`.

---

#### TC-021: DateSubGroup.sessionCount matches the number of sessions in the sub-group

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Two sessions linked to the same issue on the same date.

**Test Steps**:
1. Call `groupSessionsByIssue(sessions)`.

**Expected Result**:
- `issueGroups[0].dateSubGroups[0].sessionCount === 2`
- `issueGroups[0].dateSubGroups[0].sessions.length === 2`

---

### Unit Tests -- formatDateLabel (within groupSessions.ts)

---

#### TC-030: formatDateLabel returns "Today" for current date

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Injectable `now` date of 2026-02-24.

**Test Steps**:
1. Call `formatDateLabel("2026-02-24", new Date("2026-02-24T12:00:00.000Z"))`.

**Expected Result**: Returns `"Today"`.

---

#### TC-031: formatDateLabel returns "Yesterday" for previous calendar day

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Injectable `now` date of 2026-02-24.

**Test Steps**:
1. Call `formatDateLabel("2026-02-23", new Date("2026-02-24T12:00:00.000Z"))`.

**Expected Result**: Returns `"Yesterday"`.

---

#### TC-032: formatDateLabel returns absolute format for dates older than yesterday (same year)

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Injectable `now` date of 2026-02-24.

**Test Steps**:
1. Call `formatDateLabel("2026-02-10", new Date("2026-02-24T12:00:00.000Z"))`.

**Expected Result**: Returns a string matching "Feb 10" (locale-appropriate short month + day, no year for current year).

---

#### TC-033: formatDateLabel includes year for dates in a different year

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |

**Preconditions**: Injectable `now` date of 2026-02-24.

**Test Steps**:
1. Call `formatDateLabel("2025-12-15", new Date("2026-02-24T12:00:00.000Z"))`.

**Expected Result**: Returns a string that includes "2025" (year is shown for cross-year dates), e.g., "Dec 15, 2025".

---

#### TC-034: formatDateLabel default now parameter uses current date

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P1 |

**Test Steps**:
1. Construct a dateKey matching today's actual date.
2. Call `formatDateLabel(todayDateKey)` with no `now` argument.

**Expected Result**: Returns `"Today"`.

---

### Unit Tests -- formatDuration (format.ts)

Test file location: `src/renderer/src/utils/__tests__/format.test.ts` (additions to existing file)

---

#### TC-040: formatDuration returns "0m" for 0 seconds

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Test Steps**:
1. Call `formatDuration(0)`.

**Expected Result**: `"0m"`.

---

#### TC-041: formatDuration returns minutes only for durations under one hour

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Test Steps**:
1. Call `formatDuration(300)` (5 minutes).
2. Call `formatDuration(2700)` (45 minutes).

**Expected Result**:
- `formatDuration(300) === "5m"`
- `formatDuration(2700) === "45m"`

---

#### TC-042: formatDuration returns "Xh Ym" for durations over one hour

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, FR-004 |
| **Type** | Unit |
| **Priority** | P0 |

**Test Steps**:
1. Call `formatDuration(4980)` (1 hour 23 minutes).
2. Call `formatDuration(7200)` (2 hours exactly).

**Expected Result**:
- `formatDuration(4980) === "1h 23m"`
- `formatDuration(7200) === "2h 0m"`

---

#### TC-043: formatDuration handles fractional seconds by truncating/flooring

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, FR-004 |
| **Type** | Unit |
| **Priority** | P1 |

**Test Steps**:
1. Call `formatDuration(299)` (4 minutes 59 seconds).
2. Call `formatDuration(3659)` (59 minutes 59 seconds).

**Expected Result**:
- `formatDuration(299) === "4m"` (sub-minute seconds are not shown in the compact format)
- `formatDuration(3659) === "1h 0m"` or `"59m"` depending on format threshold -- confirm which is implemented and assert accordingly

---

### Performance Unit Test

---

#### TC-050: groupSessionsByIssue processes 500 sessions in under 50ms

| Field | Value |
|-------|-------|
| **Requirement** | NFR-PERF |
| **Type** | Unit (performance) |
| **Priority** | P0 |

**Preconditions**: Generate 500 sessions programmatically with a variety of providers, issues, and dates.

**Test Steps**:
1. Generate 500 mock sessions across 30 unique issues (mix of github, linear, jira, legacy-github) and ungrouped sessions.
2. Record `Date.now()` before calling `groupSessionsByIssue(sessions)`.
3. Record `Date.now()` after.

**Expected Result**: Elapsed time is less than 50ms.

---

### Component Tests -- IssueBadge

Test file location: `src/renderer/src/components/__tests__/IssueBadge.test.tsx`

---

#### TC-100: IssueBadge renders GitHub provider badge

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: "github"`, `issueId: "42"`, `issueTitle: "Fix bug"`, `issueUrl: "https://github.com/..."`.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.

**Expected Result**:
- Text `"#42"` is in the document.
- Text `"Fix bug"` is in the document.

---

#### TC-101: IssueBadge renders Linear provider badge

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: "linear"`, `issueId: "LIN-42"`, `issueTitle: "Auth timeout"`.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.

**Expected Result**:
- Text `"LIN-42"` is in the document.
- Text `"Auth timeout"` is in the document.
- Text `"#42"` is NOT in the document.

---

#### TC-102: IssueBadge renders Jira provider badge

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: "jira"`, `issueId: "PROJ-123"`, `issueTitle: "Deploy pipeline"`.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.

**Expected Result**:
- Text `"PROJ-123"` is in the document.
- Text `"Deploy pipeline"` is in the document.

---

#### TC-103: IssueBadge renders legacy GitHub badge

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: Session with `issueProvider: null`, `issueNumber: 7`, `issueTitle: "Old issue"`, `issueUrl: "https://github.com/..."`.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.

**Expected Result**:
- Text `"#7"` is in the document.
- Text `"Old issue"` is in the document.

---

#### TC-104: IssueBadge renders nothing when no issue is linked

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: Session with all issue fields null.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.
2. Inspect the rendered output.

**Expected Result**: No issue identifier text (`#\d+`, `LIN-`, `PROJ-`) is in the document.

---

#### TC-105: IssueBadge clicking badge opens issueUrl in external browser

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P1 |

**Preconditions**: Session with `issueProvider: "linear"`, `issueId: "LIN-42"`, `issueUrl: "https://linear.app/team/LIN-42"`. Mock `window.electronAPI.shell.openExternal`.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.
2. Fire click on the badge element.

**Expected Result**: `window.electronAPI.shell.openExternal` was called with `"https://linear.app/team/LIN-42"`.

---

#### TC-106: IssueBadge clicking when issueUrl is null does not call openExternal

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P1 |

**Preconditions**: Session with `issueProvider: "github"`, `issueId: "10"`, `issueUrl: null`.

**Test Steps**:
1. Render `<IssueBadge session={session} />`.
2. Fire click on the badge element.

**Expected Result**: `window.electronAPI.shell.openExternal` is NOT called.

---

### Component Tests -- IssueGroupHeader

Test file location: `src/renderer/src/components/__tests__/IssueGroupHeader.test.tsx`

---

#### TC-110: IssueGroupHeader renders issue identifier and title

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-003 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: IssueGroupKey with `provider: "github"`, `displayId: "#42"`, `title: "Fix auth"`. Total 1800 seconds, 3 sessions.

**Test Steps**:
1. Render `<IssueGroupHeader issueKey={...} totalSeconds={1800} sessionCount={3} isExpanded={false} onToggle={fn} />`.

**Expected Result**:
- `"#42"` is in the document.
- `"Fix auth"` is in the document.
- `"3"` (session count) is in the document (or "3 sessions").

---

#### TC-111: IssueGroupHeader renders total time via formatDuration

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: `totalSeconds: 4980` (1h 23m).

**Test Steps**:
1. Render `<IssueGroupHeader ... totalSeconds={4980} ... />`.

**Expected Result**: Text `"1h 23m"` appears in the document.

---

#### TC-112: IssueGroupHeader collapsed by default shows chevron in collapsed state

| Field | Value |
|-------|-------|
| **Requirement** | FR-005, FR-010 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: `isExpanded={false}`.

**Test Steps**:
1. Render `<IssueGroupHeader ... isExpanded={false} ... />`.
2. Inspect chevron element or aria attribute.

**Expected Result**: Chevron or indicator represents a collapsed state (e.g., aria-expanded="false" or rotated class).

---

#### TC-113: IssueGroupHeader expanded shows chevron in expanded state

| Field | Value |
|-------|-------|
| **Requirement** | FR-006, FR-010 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: `isExpanded={true}`.

**Test Steps**:
1. Render `<IssueGroupHeader ... isExpanded={true} ... />`.

**Expected Result**: Chevron or indicator represents an expanded state.

---

#### TC-114: IssueGroupHeader click calls onToggle

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P0 |

**Test Steps**:
1. Render `<IssueGroupHeader ... onToggle={mockFn} />`.
2. Fire click on the header element.

**Expected Result**: `mockFn` was called once.

---

#### TC-115: IssueGroupHeader keyboard Enter triggers onToggle

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | Component |
| **Priority** | P2 |

**Test Steps**:
1. Render `<IssueGroupHeader ... onToggle={mockFn} />`.
2. Fire `keyDown` event with `key: "Enter"` on the header element.

**Expected Result**: `mockFn` was called once.

---

#### TC-116: IssueGroupHeader keyboard Space triggers onToggle

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | Component |
| **Priority** | P2 |

**Test Steps**:
1. Render `<IssueGroupHeader ... onToggle={mockFn} />`.
2. Fire `keyDown` event with `key: " "` on the header element.

**Expected Result**: `mockFn` was called once.

---

#### TC-117: IssueGroupHeader has correct ARIA role for accessibility

| Field | Value |
|-------|-------|
| **Requirement** | NFR accessibility |
| **Type** | Component |
| **Priority** | P1 |

**Test Steps**:
1. Render `<IssueGroupHeader ... isExpanded={false} ... />`.
2. Query by role.

**Expected Result**: The header element has `role="button"` and `tabIndex={0}`.

---

### Component Tests -- DateSubGroupHeader

Test file location: `src/renderer/src/components/__tests__/DateSubGroupHeader.test.tsx`

---

#### TC-120: DateSubGroupHeader renders date label and total time

| Field | Value |
|-------|-------|
| **Requirement** | FR-002, FR-004 |
| **Type** | Component |
| **Priority** | P0 |

**Preconditions**: `dateLabel: "Today"`, `totalSeconds: 1800`, `sessionCount: 2`.

**Test Steps**:
1. Render `<DateSubGroupHeader dateLabel="Today" totalSeconds={1800} sessionCount={2} isExpanded={false} onToggle={fn} />`.

**Expected Result**:
- `"Today"` is in the document.
- `"30m"` or equivalent formatted duration is in the document.
- `"2"` (session count) is in the document.

---

#### TC-121: DateSubGroupHeader click calls onToggle

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P0 |

**Test Steps**:
1. Render `<DateSubGroupHeader ... onToggle={mockFn} />`.
2. Fire click on the header.

**Expected Result**: `mockFn` was called once.

---

#### TC-122: DateSubGroupHeader collapsed vs expanded state is reflected visually

| Field | Value |
|-------|-------|
| **Requirement** | FR-005, FR-006, FR-010 |
| **Type** | Component |
| **Priority** | P0 |

**Test Steps**:
1. Render `<DateSubGroupHeader ... isExpanded={false} ... />`.
2. Check aria-expanded or chevron direction.
3. Re-render with `isExpanded={true}`.
4. Check again.

**Expected Result**: The visual/ARIA indicator changes between the two states.

---

### Integration Tests -- Sidebar.tsx

Test file location: `src/renderer/src/components/__tests__/Sidebar.test.tsx` (new or existing file)

**Setup note**: All Sidebar tests must mock `window.electronAPI` via `vi.stubGlobal("electronAPI", mockElectronAPI)` with at minimum `session.list` and `session.delete` mocked.

---

#### TC-200: Sidebar renders issue group headers when sessions have linked issues

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-008 |
| **Type** | Integration |
| **Priority** | P0 |

**Components Tested**: Sidebar.tsx, groupSessionsByIssue, IssueGroupHeader

**Preconditions**: `session.list` mock returns two sessions linked to the same GitHub issue `#42`.

**Test Steps**:
1. Render Sidebar with mocked electronAPI.
2. Wait for session data to load.

**Expected Result**:
- An issue group header containing `"#42"` is visible.
- Individual session rows are NOT visible (group is collapsed by default).

---

#### TC-201: Sidebar: clicking issue group header expands to show date sub-groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-006, FR-001 |
| **Type** | Integration |
| **Priority** | P0 |

**Components Tested**: Sidebar.tsx, IssueGroupHeader, DateSubGroupHeader

**Preconditions**: `session.list` returns sessions for one issue across two different dates.

**Test Steps**:
1. Render Sidebar. Wait for load.
2. Click the issue group header.

**Expected Result**:
- Two date sub-group headers appear (one per date).
- Individual session rows are NOT yet visible (date sub-groups are still collapsed).

---

#### TC-202: Sidebar: clicking date sub-group header expands to show sessions

| Field | Value |
|-------|-------|
| **Requirement** | FR-006, FR-002 |
| **Type** | Integration |
| **Priority** | P0 |

**Components Tested**: Sidebar.tsx, DateSubGroupHeader, SessionRow

**Preconditions**: Sessions for one issue, one date.

**Test Steps**:
1. Render Sidebar. Wait for load.
2. Click the issue group header.
3. Click the date sub-group header.

**Expected Result**: Individual session rows (or title text) are now visible.

---

#### TC-203: Sidebar: ungrouped sessions appear after issue groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: `session.list` returns one linked session (issue A) and two unlinked sessions.

**Test Steps**:
1. Render Sidebar. Wait for load.

**Expected Result**:
- Issue group header for issue A is present.
- The two ungrouped sessions are rendered as flat items after the issue group.
- Ungrouped sessions do not require expanding to see.

---

#### TC-204: Sidebar: group headers display chevron indicator

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Integration |
| **Priority** | P1 |

**Test Steps**:
1. Render Sidebar with linked sessions.
2. Inspect issue group header for a chevron element.

**Expected Result**: A chevron or equivalent expand indicator is present on the group header.

---

#### TC-205: Sidebar: group headers display provider information

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Integration |
| **Priority** | P1 |

**Preconditions**: Sessions from each of github, linear, jira providers.

**Test Steps**:
1. Render Sidebar. Wait for load.
2. Inspect each group header.

**Expected Result**: Each group header shows a visual indicator of the provider (icon, label, or accessible text).

---

#### TC-206: Sidebar: expand/collapse has CSS transition applied

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Integration |
| **Priority** | P1 |

**Test Steps**:
1. Render Sidebar with linked sessions.
2. Inspect the collapsible content element's styles.

**Expected Result**: The collapsible wrapper has a CSS transition or inline style property for animation (e.g., `transition: max-height 150ms ease-out` or similar).

---

#### TC-207: Sidebar: expand/collapse state persists during the same component lifetime (no re-mount)

| Field | Value |
|-------|-------|
| **Requirement** | FR-013 |
| **Type** | Integration |
| **Priority** | P1 |

**Preconditions**: One issue group.

**Test Steps**:
1. Render Sidebar.
2. Click issue group header to expand.
3. Trigger a simulated unrelated re-render (e.g., pass new unrelated props).
4. Check if the group remains expanded.

**Expected Result**: The group is still expanded after the re-render (state is preserved in `useState`).

---

#### TC-208: Sidebar: Enter/Space keyboard on group header toggles it

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | Integration |
| **Priority** | P2 |

**Test Steps**:
1. Render Sidebar with linked sessions.
2. Focus the issue group header element.
3. Fire `keyDown` with `key: "Enter"`.
4. Verify expanded.
5. Fire `keyDown` with `key: " "` (space).
6. Verify collapsed.

**Expected Result**: Both Enter and Space toggle the expand state.

---

#### TC-209: Sidebar: tag filter change resets expand/collapse state

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT-FILTER |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: Sidebar supports a `selectedTagId` prop. Two sessions linked to the same issue. Mock `session.list` to return filtered results when tagId is passed.

**Test Steps**:
1. Render Sidebar.
2. Click issue group header to expand it.
3. Change `selectedTagId` prop (simulate tag filter change).
4. Wait for re-render.

**Expected Result**: Previously expanded group is now collapsed (state reset occurred). All groups start collapsed after filter change.

---

#### TC-210: Sidebar: loading more sessions merges into existing groups

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT-PAGINATE |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: Initial `session.list` returns page 1 with 2 sessions for issue A. Second call (Load more) returns 1 more session for the same issue A and 1 new session for issue B.

**Test Steps**:
1. Render Sidebar with page 1.
2. Click issue group for issue A, expand it.
3. Click "Load more".
4. Wait for re-render.

**Expected Result**:
- Issue A group now shows updated `sessionCount` and `totalSeconds` (incorporating the new session).
- Issue B group appears as a new group.
- Issue A group remains expanded (expand state is preserved across Load more).

---

### Integration Tests -- HistoryPage.tsx

Test file location: `src/renderer/src/components/__tests__/HistoryPage.test.tsx` (new or existing file)

---

#### TC-300: HistoryPage renders issue group headers when sessions have linked issues

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-008 |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: `session.list` returns sessions linked to two different issues.

**Test Steps**:
1. Render HistoryPage with mocked electronAPI.
2. Wait for load.

**Expected Result**:
- Two issue group headers are visible.
- Individual session rows are NOT visible (collapsed by default).

---

#### TC-301: HistoryPage: clicking issue group header expands to date sub-groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Integration |
| **Priority** | P0 |

**Test Steps**:
1. Render HistoryPage. Wait for load.
2. Click one issue group header.

**Expected Result**: Date sub-group headers for that issue appear.

---

#### TC-302: HistoryPage: clicking date sub-group expands to show session cards

| Field | Value |
|-------|-------|
| **Requirement** | FR-006, FR-002 |
| **Type** | Integration |
| **Priority** | P0 |

**Test Steps**:
1. Render HistoryPage. Wait for load.
2. Click issue group header to expand.
3. Click date sub-group header to expand.

**Expected Result**: Individual session card content (session title or duration) is visible.

---

#### TC-303: HistoryPage: clicking expanded header collapses it again

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Integration |
| **Priority** | P0 |

**Test Steps**:
1. Render HistoryPage. Wait for load.
2. Click issue group header to expand.
3. Click the same header again.

**Expected Result**: Date sub-groups are no longer visible; group is collapsed.

---

#### TC-304: HistoryPage: group headers show chevron indicator

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Integration |
| **Priority** | P1 |

**Test Steps**: Same as TC-204 but for HistoryPage.

**Expected Result**: Chevron or expand indicator present on group headers.

---

#### TC-305: HistoryPage: ungrouped sessions appear as flat items after groups

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: Mix of linked and unlinked sessions.

**Test Steps**:
1. Render HistoryPage. Wait for load.

**Expected Result**:
- Issue group headers are shown at top.
- Ungrouped sessions appear below, visible without expanding.

---

#### TC-306: HistoryPage: expand/collapse has animation transition applied

| Field | Value |
|-------|-------|
| **Requirement** | FR-012 |
| **Type** | Integration |
| **Priority** | P1 |

**Test Steps**: Same approach as TC-206 but for HistoryPage collapsible elements.

**Expected Result**: Collapsible element has transition styles applied.

---

#### TC-307: HistoryPage: expand state persists within component lifetime

| Field | Value |
|-------|-------|
| **Requirement** | FR-013 |
| **Type** | Integration |
| **Priority** | P1 |

**Test Steps**: Same approach as TC-207 but for HistoryPage.

**Expected Result**: Expanded groups remain expanded after unrelated re-renders.

---

#### TC-308: HistoryPage: keyboard navigation toggles group headers

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | Integration |
| **Priority** | P2 |

**Test Steps**: Same as TC-208 but for HistoryPage.

**Expected Result**: Enter and Space both toggle the targeted group header.

---

#### TC-309: HistoryPage: tag filter change resets all expand/collapse state

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT-FILTER |
| **Type** | Integration |
| **Priority** | P0 |

**Test Steps**: Same as TC-209 but for HistoryPage.

**Expected Result**: All groups collapse when tag filter changes.

---

#### TC-310: HistoryPage: Load more preserves expand state and merges new sessions

| Field | Value |
|-------|-------|
| **Requirement** | NFR-COMPAT-PAGINATE |
| **Type** | Integration |
| **Priority** | P0 |

**Test Steps**: Same as TC-210 but for HistoryPage.

**Expected Result**: Existing expanded groups remain expanded; new sessions are incorporated into existing or new groups.

---

### Edge Case and Regression Tests

---

#### TC-400: All sessions ungrouped -- no issue group headers appear, classic flat list renders

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: All returned sessions have no linked issue.

**Test Steps**:
1. Render Sidebar or HistoryPage with all-ungrouped sessions.

**Expected Result**:
- No issue group header elements in the DOM.
- All sessions appear as flat items directly, matching pre-feature behavior.

---

#### TC-401: Single session per issue -- group appears with "1 session" count

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-003 |
| **Type** | Integration |
| **Priority** | P0 |

**Preconditions**: Each linked session belongs to a unique issue (no two sessions share an issue).

**Test Steps**:
1. Render Sidebar with three sessions, each for a different issue.

**Expected Result**:
- Three issue group headers are shown.
- Each shows a session count of 1.

---

#### TC-402: Sessions with issueTitle null show group header without title text

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 |
| **Type** | Component |
| **Priority** | P1 |

**Preconditions**: Session with `issueProvider: "github"`, `issueId: "99"`, `issueTitle: null`.

**Test Steps**:
1. Call `groupSessionsByIssue([session])` and inspect `issueGroups[0].issueKey.title`.
2. Render `<IssueGroupHeader issueKey={...} ... />` with `title: null`.

**Expected Result**:
- `issueKey.title === null`.
- IssueGroupHeader renders without crashing (renders display ID without title, or gracefully hides title area).

---

#### TC-403: SessionHistoryItem still uses IssueBadge correctly after extraction (regression)

| Field | Value |
|-------|-------|
| **Requirement** | FR-001 (regression) |
| **Type** | Component (regression) |
| **Priority** | P0 |

**Preconditions**: After refactoring `SessionHistoryItem.tsx` to use the extracted `IssueBadge`.

**Test Steps**:
1. Run the existing `TC-Linear-321` through `TC-Linear-325` tests from `SessionHistoryItem.test.tsx`.

**Expected Result**: All existing tests pass without modification. Behavior is unchanged.

---

#### TC-404: HistoryPage SessionCard shows correct IssueBadge for all providers (regression)

| Field | Value |
|-------|-------|
| **Requirement** | FR-008 |
| **Type** | Integration (regression) |
| **Priority** | P0 |

**Preconditions**: HistoryPage renders sessions for github, linear, jira providers (previously the HistoryPage only handled `issueNumber` check).

**Test Steps**:
1. Render HistoryPage with one session each for github, linear, jira, legacy-github.
2. Expand all groups down to individual session cards.
3. Inspect badge text for each session card.

**Expected Result**:
- GitHub session card shows `"#42"`.
- Linear session card shows `"LIN-42"`.
- Jira session card shows `"PROJ-123"`.
- Legacy session card shows `"#7"`.

---

## 4. Edge Cases and Boundaries

| Category | Test Case | Input | Expected |
|----------|-----------|-------|----------|
| Boundary | Empty session array | `groupSessionsByIssue([])` | `{ issueGroups: [], ungroupedSessions: [] }` |
| Boundary | Single session with issue | One session | One group, one date sub-group, one session |
| Boundary | 500 sessions | Performance test | Groups computed in < 50ms |
| Boundary | All sessions same issue same date | N sessions | One group, one date sub-group, all N sessions within |
| Boundary | Zero seconds duration | `actualDurationSeconds: 0` | Aggregated correctly (0s contributes 0 to total) |
| Invalid | issueProvider set but issueId null | `issueProvider: "github"`, `issueId: null` | Session treated as ungrouped (hasLinkedIssue returns false) |
| Invalid | issueProvider null and issueNumber null | both null | hasLinkedIssue returns false, session is ungrouped |
| Edge | Cross-year date label | dateKey from prior year | Year included in label (e.g., "Dec 15, 2025") |
| Edge | Same issue number different repos (legacy) | Same `issueNumber`, different `issueUrl` | Two separate groups |
| Edge | Same issueId different providers | `issueId: "42"` for github and linear | Two separate groups |
| Edge | issueTitle is null | `issueTitle: null` | Group header renders without crashing |
| Edge | Null issueUrl on badge | `issueUrl: null` | Clicking badge does not call openExternal |
| Edge | Sessions arrive in non-chronological order | Input unsorted | Groups still sorted by latestCompletedAt descending |
| Edge | Date sub-group at day boundary | Sessions at 23:59 and 00:01 same calendar day | One sub-group |
| Edge | formatDuration(59) | 59 seconds | `"0m"` or `"1m"` -- assert whichever is implemented |

---

## 5. Security Tests

| Test | Description | Expected |
|------|-------------|----------|
| XSS via issueTitle | Render `IssueGroupHeader` with `title` containing `<script>alert('xss')</script>` | Text is rendered as plain text, not executed as HTML. React's default escaping prevents XSS. |
| XSS via issueId/displayId | Render `IssueGroupHeader` with `displayId` containing `<img onerror=...>` | Text rendered safely, no script execution |
| issueUrl redirect | `IssueBadge` with `issueUrl` pointing to `javascript:alert(1)` | `openExternal` call passes the URL to Electron shell; Electron's `shell.openExternal` should sanitize or block non-http URLs. Test that the component does not itself construct or evaluate the URL. |

---

## 6. Performance Tests

| Test | Scenario | Threshold |
|------|----------|-----------|
| TC-050: groupSessionsByIssue 500 sessions | Single call with 500 sessions, 30 issues, mixed providers | < 50ms |
| Expand/collapse frame budget | Collapse triggered via click; check no synchronous JS > 16ms | No layout thrash (all CSS-driven) |
| useMemo stability | sessions reference unchanged after unrelated re-render | groupSessionsByIssue is NOT called again (memoization works) |

---

## 7. Test Data Requirements

| Data Set | Purpose | Source |
|----------|---------|--------|
| `baseSession` fixture | Shared base for all session-related tests | Defined in test files (no issue fields set) |
| `githubSession` fixture | Session with `issueProvider: "github"`, `issueId: "42"`, `issueTitle`, `issueUrl` | Defined inline in tests |
| `linearSession` fixture | Session with `issueProvider: "linear"`, `issueId: "LIN-42"`, `issueTitle`, `issueUrl` | Defined inline in tests |
| `jiraSession` fixture | Session with `issueProvider: "jira"`, `issueId: "PROJ-123"`, `issueTitle`, `issueUrl` | Defined inline in tests |
| `legacyGithubSession` fixture | Session with `issueProvider: null`, `issueNumber: 7`, `issueTitle`, `issueUrl` | Defined inline in tests |
| `legacyGithubNoUrlSession` fixture | Session with `issueProvider: null`, `issueNumber: 7`, `issueUrl: null` | Defined inline in tests |
| `500SessionsBatch` generator | Performance test data: 500 sessions across 30 issues | Generated programmatically in TC-050 |
| `mockElectronAPI` | Standard electronAPI mock for renderer component tests | `vi.stubGlobal("electronAPI", { session: { list: vi.fn(), delete: vi.fn() }, shell: { openExternal: vi.fn() } })` |

---

## 8. Test Environment

| Environment | Purpose | Config |
|-------------|---------|--------|
| Unit (Vitest + node) | Pure function tests for groupSessions.ts | `vitest.config.ts` `environmentMatchGlobs` maps `utils/**` to node environment; no DOM required |
| Component (Vitest + jsdom) | React component tests for IssueBadge, IssueGroupHeader, DateSubGroupHeader, Sidebar, HistoryPage | jsdom environment; `window.electronAPI` stubbed via `vi.stubGlobal` |
| CI | Automated run on every commit | `bun run test` (single run, Vitest) |

---

## 9. Acceptance Criteria Verification

| AC ID | Acceptance Criteria (from PRD) | Test Cases | Pass Criteria |
|-------|-------------------------------|------------|---------------|
| AC-FR001 | Sessions are grouped under their issue header with issue name/identifier displayed | TC-003, TC-200, TC-300 | Group header visible with correct displayId and title |
| AC-FR002 | Sessions are sub-grouped by date with per-date total time shown when group is expanded | TC-004, TC-007, TC-120, TC-202, TC-301 | Date sub-group headers visible with dateLabel and formatted totalSeconds |
| AC-FR003 | Collapsed group header shows total duration and session count | TC-006, TC-111, TC-200 | formatDuration output and session count visible in collapsed header |
| AC-FR004 | Date sub-group header shows total duration for that date and session count | TC-007, TC-120 | DateSubGroupHeader renders totalSeconds and sessionCount correctly |
| AC-FR005 | All issue groups and date sub-groups are collapsed on initial render | TC-200, TC-300, TC-401 | No session rows visible without any user clicks |
| AC-FR006 | Clicking collapsed header expands it; clicking expanded header collapses it | TC-201, TC-202, TC-301, TC-302, TC-303 | Toggle behavior verified with fireEvent.click |
| AC-FR007 | Sessions with no linked issue appear as individual flat items after all issue groups | TC-008, TC-203, TC-305, TC-400 | Ungrouped sessions visible without expansion, positioned after groups |
| AC-FR008 | Both Sidebar and HistoryPage display grouped layout | TC-200, TC-201, TC-300, TC-301 | Parallel integration tests verify both views |
| AC-FR010 | Chevron/arrow indicator shows current expand/collapse state | TC-112, TC-113, TC-122, TC-204, TC-304 | Indicator changes between expanded and collapsed states |
| AC-FR011 | Provider indicator (GitHub, Linear, Jira) visible in group header | TC-110, TC-115, TC-205 | Provider icon or accessible text present for all provider types |
| AC-FR012 | Transition is animated on expand/collapse (~150ms) | TC-206, TC-306 | CSS transition property present on collapsible wrapper |
| AC-FR013 | Expanded groups remain expanded after navigating away and returning (same app session) | TC-207, TC-307 | useState preserves expanded Set across re-renders |
| AC-NFR-FILTER | Grouping applies to filtered results; tag filter change resets expand state | TC-209, TC-309 | Re-grouped filtered results shown; all groups collapsed after filter change |
| AC-NFR-PAGINATE | Load more integrates into existing groups | TC-210, TC-310 | Session and time totals update; expand state preserved |
| AC-NFR-PERF | 500 sessions grouped in < 50ms | TC-050 | Elapsed time assertion passes |

---

## 10. Test Summary

| Type | Count | P0 | P1 | P2 |
|------|-------|----|----|----|
| Unit (groupSessions) | 25 | 20 | 3 | 2 |
| Unit (formatDuration) | 4 | 3 | 1 | 0 |
| Component (IssueBadge) | 7 | 4 | 2 | 1 |
| Component (IssueGroupHeader) | 8 | 5 | 2 | 1 (TC-115, TC-116 counted under component) |
| Component (DateSubGroupHeader) | 3 | 3 | 0 | 0 |
| Integration (Sidebar) | 11 | 7 | 3 | 1 |
| Integration (HistoryPage) | 11 | 7 | 3 | 1 |
| Edge / Regression | 5 | 4 | 1 | 0 |
| **Total** | **74** | **53** | **15** | **6** |

### Notes

- All P0 requirements (FR-001 through FR-008, NFR-PERF, NFR-COMPAT-FILTER, NFR-COMPAT-PAGINATE) have at least one P0 test case.
- The extracted `IssueBadge` component is tested both in isolation (TC-100 through TC-106) and as part of regression coverage for `SessionHistoryItem` (TC-403) and `HistoryPage` (TC-404).
- The `formatDuration` tests are additions to the existing `src/renderer/src/utils/__tests__/format.test.ts` file.
- The `groupSessions.test.ts` file is a new file with no DOM dependency -- it runs in the Vitest node environment and imports only `Session` types plus the pure utility functions.