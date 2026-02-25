# PRD Review

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | prd.md |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-24 |
| **Verdict** | Approved |

---

## Review Summary

This is a well-structured, high-confidence PRD for a clearly scoped feature. The problem statement accurately reflects the current flat-list behavior observed in both `Sidebar.tsx` and `HistoryPage.tsx`. The grouping hierarchy (issue-first, then date) is unambiguous, the acceptance criteria are testable, and the scope boundaries are sensible. The PRD correctly identifies that all required data fields (`issueProvider`, `issueId`, `issueNumber`, `issueTitle`, `issueUrl`, `completedAt`) already exist on the `Session` type, and that grouping can be performed client-side without IPC or schema changes.

The document is ready for tech spec work with only minor items to address.

---

## Section Analysis

### Problem Statement
- **Status**: Pass
- **Comments**: Accurately describes the current flat-list UX in both Sidebar and History Page. The pain points are concrete and map directly to the proposed solution. The three user personas cover the spectrum well, including the important "casual user" persona whose experience should remain unchanged.

### Requirements
- **Status**: Pass
- **Comments**: P0 requirements are comprehensive and cover the full grouping lifecycle: hierarchy, aggregation, default state, interaction, ungrouped fallback, and cross-view consistency. Acceptance criteria use Given/When/Then format and are testable. The P0/P1/P2 prioritization is appropriate -- the visual indicator (FR-010) and animation (FR-012) are correctly placed at P1 rather than P0, keeping the core behavior unblocked by polish.

### Success Metrics
- **Status**: Pass (minor note)
- **Comments**: The "time to find total hours on an issue" metric is the right primary measure. The "sessions visible before scrolling" metric is a reasonable proxy for information density improvement. However, all three metrics rely on qualitative observation rather than instrumentation. This is acceptable for a personal desktop app -- adding analytics telemetry would be over-engineering. The metrics are pragmatic for the context.

### User Flows
- **Status**: Pass
- **Comments**: The primary flow is detailed and correctly describes the two-level expand interaction (issue group -> date sub-group -> sessions). The "Load More with Groups" flow correctly addresses the merge behavior and state preservation. The edge cases (all ungrouped, single session per issue, cross-provider same title, legacy GitHub) are well-identified and reflect real scenarios in the codebase.

### Dependencies & Risks
- **Status**: Pass
- **Comments**: Dependencies are correctly identified as all internal. The risk around sidebar width (260px) is real and important -- the current `Sidebar.tsx` uses a fixed 260px width. The mitigation (truncate with ellipsis, abbreviated time) is the right approach.

### Scope & Boundaries
- **Status**: Pass
- **Comments**: The out-of-scope list is explicit and well-chosen. Excluding filtering-by-issue, custom grouping criteria, and export keeps this feature tightly scoped. The decision to keep grouping client-side (no SQL GROUP BY) is pragmatically correct given the data volumes of a personal time tracker.

---

## Issues Found

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| Minor | **Jira issue display identifier not specified in group header**: FR-001 says "issue name/identifier displayed" but does not specify what identifier to show for Jira issues. GitHub uses `#number`, Linear uses `identifier` (e.g., "LIN-42"), but Jira sessions store `issueId` which is an opaque string -- the user-facing identifier is the Jira `key` (e.g., "PROJ-123"), which is not currently stored on the Session type. | Clarify in the PRD that the group header should display: GitHub = `#issueNumber`, Linear = `issueId` (which is actually the identifier like "LIN-42"), Jira = `issueTitle` (as fallback since key is not persisted). Alternatively, flag as an open question for engineering to resolve when they inspect the actual stored data. |
| Minor | **Grouping key for Jira sessions needs clarification**: The PRD states grouping uses `(issueProvider + issueId)`, but for Jira sessions the `issueId` field stores the Jira issue ID (internal). This should work for grouping uniqueness, but should be explicitly confirmed. | Add a note that Jira grouping key is `issueProvider="jira" + issueId`, and that `issueTitle` is used for display since `key` is not persisted on Session. |
| Minor | **Interaction between SessionHistory.tsx (old component) and new grouping unclear**: The codebase has both `SessionHistory.tsx` (simple list used in the old layout) and `Sidebar.tsx` (which renders its own session rows). The PRD says "both Sidebar and History Page" but does not mention `SessionHistory.tsx`. | This is a tech spec concern, not a PRD issue. The PRD correctly scopes to the two user-facing views. Engineering will determine which components to modify or replace. No PRD change needed. |
| Informational | **HistoryPage currently only shows `issueNumber` for issue badge, not `issueProvider`-aware display**: The `SessionCard` in `HistoryPage.tsx` only checks `session.issueNumber` (line 69), unlike `SessionHistoryItem.tsx` which handles all three providers. | This is a pre-existing UI inconsistency, not caused by this PRD. However, the grouping feature will naturally surface this gap since group headers will show provider-aware identifiers while expanded session cards in HistoryPage may not. Recommend noting this as a tech spec concern. |

---

## Alignment with Codebase

The PRD's assumptions align well with the actual codebase:

1. **Data model**: The `Session` type in `src/shared/types.ts` contains all fields referenced by the PRD (`issueProvider`, `issueId`, `issueNumber`, `issueTitle`, `issueUrl`, `completedAt`, `actualDurationSeconds`). No schema changes needed -- confirmed.

2. **Pagination**: The `useSessionHistory` hook uses offset-based pagination with `DEFAULT_LIMIT = 50`. The PRD's "Load More" merge flow is compatible with this approach.

3. **Tag filtering**: The hook supports `activeTagFilter` which re-fetches from offset 0. The PRD correctly states that grouping applies to filtered results.

4. **Sidebar width**: Confirmed at 260px in `Sidebar.tsx` (line 83). The risk is real but manageable.

5. **Client-side grouping**: Sessions are already fully loaded into renderer state (`sessions` array in `useSessionHistory`). Grouping transformation can be applied as a pure function before rendering. No architectural changes needed.

---

## Verdict

**APPROVED**

The PRD is comprehensive, well-scoped, and accurately reflects the current codebase state. The requirements are testable, the user flows are detailed, and the scope boundaries are explicit. The minor issues identified (Jira identifier display, HistoryPage issue badge inconsistency) are addressable during tech spec without requiring PRD revision. The feature is ready to proceed to technical specification.