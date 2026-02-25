# Tech Spec Review (PM Perspective)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **PRD** | prd.md (v1.0) |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-24 |
| **Verdict** | Needs Revision |

---

## Review Summary

The tech spec demonstrates strong alignment with the PRD on core grouping logic, data structures, and the client-side-only approach. The grouping function design, issue key resolution strategy, and expand/collapse state management all faithfully reflect PRD requirements. However, one critical issue and several minor concerns prevent approval.

The critical issue is that the spec proposes `.module.scss` files for styling new components, which violates the codebase convention of inline styles only (`React.CSSProperties` objects). This must be corrected before implementation begins, as it affects four of the six new/modified files in the implementation plan.

---

## PRD Requirements Coverage

### P0 Requirements

| PRD ID | Requirement | Covered in Spec? | Notes |
|--------|-------------|-------------------|-------|
| FR-001 | Issue-first grouping hierarchy | Yes | Section 3 defines `IssueGroup` and `GroupedSessionData` types. Grouping key resolution table is comprehensive. |
| FR-002 | Date sub-groups within issue groups | Yes | `DateSubGroup` type with `dateKey`, `totalSeconds`, and `sessions` array. Sorting by date descending specified. |
| FR-003 | Total time per issue group | Yes | `IssueGroup.totalSeconds` and `IssueGroup.sessionCount` fields explicitly defined. |
| FR-004 | Total time per date sub-group | Yes | `DateSubGroup.totalSeconds` and session count derivable from `sessions.length`. |
| FR-005 | Collapsed by default | Yes | Key Design Decisions table confirms collapsed by default. Phase 3/4 implementation notes reference this. |
| FR-006 | Expand/collapse interaction | Yes | `useState<Set<string>>` for tracking expanded groups. Click handlers on headers. Phase 5 adds keyboard support. |
| FR-007 | Ungrouped sessions as flat items | Yes | `GroupedSessionData.ungroupedSessions` array. Rendering after all issue groups specified in component diagram and implementation plan. |
| FR-008 | Both Sidebar and History Page | Yes | Parallel integration in Phase 3 (Sidebar) and Phase 4 (HistoryPage). Shared grouping function with view-specific rendering. |

All P0 requirements are fully addressed.

### P1 Requirements

| PRD ID | Requirement | Covered in Spec? | Notes |
|--------|-------------|-------------------|-------|
| FR-010 | Visual collapse indicator (chevron) | Yes | `IssueGroupHeader` description includes "chevron". |
| FR-011 | Issue provider icon in group header | Yes | `IssueGroupHeader` description includes "provider icon". `IssueGroupKey.provider` field supports this. |
| FR-012 | Smooth expand/collapse animation | Yes | Section 6 details CSS `max-height` transition at 150ms. Phase 5 explicitly includes animation work. |
| FR-013 | Persist expand/collapse state per app session | Yes | In-memory `useState` satisfies per-app-session persistence. Key Design Decisions table confirms this choice. |

All P1 requirements are addressed.

### P2 Requirements

| PRD ID | Requirement | Covered in Spec? | Notes |
|--------|-------------|-------------------|-------|
| FR-020 | Expand all / Collapse all button | No | Not mentioned. Acceptable -- P2 items are optional. |
| FR-021 | Keyboard navigation for groups | Yes | Phase 5 includes "Add keyboard accessibility (Enter/Space on headers to toggle)". |

### Non-Functional Requirements

| NFR | Covered? | Notes |
|-----|----------|-------|
| 500 sessions < 50ms grouping | Yes | Section 6 estimates "well under 1ms" for 500 sessions with O(n) algorithm. Exceeds target. |
| Expand/collapse < 16ms | Yes | Collapsed content not rendered in DOM. CSS-only animation avoids JS layout work. |
| Works with tag filter | Yes | Section 8 testing strategy includes "Tag filter causes re-grouping of filtered results". Implementation is implicit -- re-grouping runs on every session array change. |
| Works with Load More pagination | Yes | Section 8 testing strategy includes Load More integration. Grouping function re-runs on the expanded session array. |
| Tokyo Night theme | Partially | Spec mentions "provider icon" and "chevron" but does not explicitly reference CSS variables from `index.html`. The styling approach itself is the critical issue (see below). |
| Accessibility (keyboard) | Yes | Phase 5 covers Enter/Space toggle. |

---

## Issues Found

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| **Critical** | Spec proposes `.module.scss` files for new components (`IssueGroupHeader.module.scss`, `DateSubGroupHeader.module.scss`) and modifications to existing `.module.scss` files (`HistoryPage.module.scss`, `Sidebar.module.scss`). The codebase convention is **inline styles only** using `React.CSSProperties` objects. No CSS files, no CSS modules, no SCSS. | Remove all `.module.scss` file references from the implementation plan. All styling for `IssueGroupHeader`, `DateSubGroupHeader`, and any new group-related styles must be defined as inline `React.CSSProperties` objects within the component files. The expand/collapse animation (CSS `max-height` transition) must also be implemented via inline styles or the existing `style` prop approach used throughout the codebase. |
| **Minor** | The `DateSubGroup` type does not include an explicit `sessionCount` field -- it relies on `sessions.length`. While functionally equivalent, the `IssueGroup` type has an explicit `sessionCount` for clarity. Consider consistency. | Add `sessionCount: number` to `DateSubGroup` for symmetry with `IssueGroup`, or document that `sessions.length` serves this purpose. Not blocking. |
| **Minor** | The spec resolves Open Question about legacy GitHub grouping key (using `issueUrl` with fallback to `issueNumber`) but the PRD left this as an open question. The resolution is reasonable but should be explicitly acknowledged as a design decision made during spec phase. | No change needed -- the resolution is sound. Just noting that the spec made a product-adjacent decision here. The approach (prefer `issueUrl` for cross-repo uniqueness) aligns with the PRD recommendation. |
| **Minor** | The animation approach (CSS `max-height` with generous upper bound of `2000px`) is a known technique with a subtle UX drawback: collapse speed varies based on actual content height vs the upper bound. For a group with 2 sessions, the 150ms transition will appear to "snap" because most of the transition range is empty space. | Consider using a smaller dynamic upper bound or a different animation technique (e.g., `requestAnimationFrame`-based height measurement on expand). Not blocking -- the approach works, just not ideal for all content sizes. |

---

## User Flow Alignment

The spec's component diagram and implementation phases map correctly to the PRD user flows:

- **Primary Flow (Viewing Grouped History)**: Covered by Phase 3 (Sidebar) and Phase 4 (HistoryPage). The flow from `useSessionHistory` -> `groupSessionsByIssue()` -> grouped rendering matches the PRD's step 3 exactly.
- **Load More Flow**: Covered implicitly -- the grouping function re-runs when `sessions` array changes. Testing strategy explicitly validates this.
- **Tag Filter Flow**: Same implicit coverage via `useMemo` dependency on `sessions`.
- **Edge Cases**: Testing strategy covers empty state, all-ungrouped state, single session per issue, and mixed providers. Aligns with PRD error/edge flows.

---

## Scope Alignment

The spec correctly stays within PRD scope boundaries:

- No database changes (confirmed in Section 3)
- No new IPC channels (confirmed in Section 4)
- No filtering by issue (listed in Non-Goals)
- No custom grouping criteria (listed in Non-Goals)
- No export/reporting (not mentioned, correctly omitted)
- Client-side only transformation (confirmed throughout)

The spec adds one item not in the PRD: fixing the HistoryPage issue badge to handle all providers (not just `issueNumber`). This is a reasonable bug fix to bundle with the feature and does not expand scope.

---

## Verdict

**NEEDS REVISION**

The spec must be revised to remove all `.module.scss` file references and replace them with inline style definitions using `React.CSSProperties` objects. This is the only blocking issue.

Once the styling approach is corrected to match the codebase convention, the spec is ready for approval. The core logic, data structures, implementation phasing, and testing strategy are all sound and well-aligned with the PRD.

### Required Changes Before Approval

1. Remove `IssueGroupHeader.module.scss` from "Files to Create"
2. Remove `DateSubGroupHeader.module.scss` from "Files to Create"
3. Remove `HistoryPage.module.scss` and `Sidebar.module.scss` from "Files to Modify" (no SCSS changes needed)
4. Update Phase 2 to specify inline styles for `IssueGroupHeader.tsx` and `DateSubGroupHeader.tsx`
5. Update Phase 3 step 7 and Phase 4 step 9 to reference inline styles instead of SCSS modifications
6. Update the animation approach in Section 6 to work with inline `style` props