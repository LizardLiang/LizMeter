# Technical Specification Review (SA)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **Reviewer** | Apollo (SA Agent) |
| **Date** | 2026-02-24 |
| **Verdict** | Concerns |

---

## Review Summary

The tech spec is well-structured and demonstrates strong architectural thinking. The decision to keep grouping as a pure client-side transformation is sound and proportionate to the problem. The data structures are well-designed, the issue key resolution handles all provider cases correctly, and the testing strategy is comprehensive. However, there are several issues that need attention before implementation, most notably a critical styling convention contradiction, a missing Jira handler in the HistoryPage `SessionCard` (correctly identified by the spec but under-specified for the fix), and a pre-existing Jira gap in `useTimer.ts` that should be acknowledged.

---

## Architecture Analysis

### Design Appropriateness
- **Rating**: Excellent
- **Assessment**: Pure client-side grouping is the right call for this feature. The data is already present in the renderer, volumes are small (sub-500 sessions typically), and O(n) hash-map grouping is trivial. Avoiding new IPC channels and database changes keeps the surface area minimal. The separation of concerns -- pure grouping utility, shared header components, view-specific rendering -- is clean and follows the existing codebase patterns well.

### Scalability
- **Rating**: Good
- **Assessment**: The spec correctly identifies that 500 sessions is the practical upper bound and that O(n) grouping is well under 1ms. The `useMemo` strategy is appropriate. One minor concern: if "Load more" is clicked many times, the accumulated `sessions` array grows in memory. Since re-grouping runs on every change, the spec should note that the grouping function should be careful not to create unnecessary intermediate allocations (e.g., avoid repeated `.sort()` on the same data). In practice this is unlikely to matter, but it is worth a comment in the implementation.

### Reliability
- **Rating**: Good
- **Assessment**: The feature is purely additive with no destructive changes. The rollback plan (git revert) is trivially safe since no schema or IPC changes are involved. The expand/collapse state being in-memory (`useState`) means no persistence bugs. The one reliability concern is around the `max-height` CSS animation technique -- using a fixed upper bound of 2000px means extremely large groups may clip content. This is unlikely but should be documented as a known limitation.

---

## Security Review

### Vulnerabilities Found
| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| None | No security issues identified | N/A | N/A |

### Security Strengths
- No new IPC channels, no new data flows, no new permissions
- Pure transformation of data already loaded into the renderer process
- No user input is interpreted as code or HTML (issue titles are rendered as text content)

---

## Performance Assessment

### Bottlenecks Identified
| Component | Issue | Impact | Mitigation |
|-----------|-------|--------|------------|
| Re-grouping on every render | If `useMemo` dependency is not correctly set, grouping could run on every render | Low -- grouping is fast, but unnecessary work | Spec correctly proposes `useMemo` with `[sessions]` dependency. Ensure the identity of `sessions` is stable (no new array reference on unrelated re-renders). The existing `useSessionHistory` hook uses `useState` so the reference is stable unless sessions actually change. |
| CSS max-height animation | Using `max-height: 2000px` causes the browser to animate through "empty" height, making collapse faster than expand for small groups | Low -- visual polish issue | Consider using a CSS class toggle with `display: none` for instant collapse and `max-height` only for expand, or accept the minor visual asymmetry |

### Performance Risks
- No significant performance risks. The spec's analysis is accurate and thorough.
- The note about not needing virtual scrolling is correct -- collapsed groups keep the DOM small.

---

## Integration Analysis

### Compatibility
- **With Existing Systems**: Excellent. The spec correctly identifies that `useSessionHistory` returns raw `Session[]` and the grouping is a view-level concern layered on top. No changes to the hook, IPC, or database.
- **API Design**: The `groupSessionsByIssue()` function API is clean, pure, and well-typed. The separation of `hasLinkedIssue()` and `getIssueGroupKey()` as exported helpers enables reuse and testability.
- **Data Flow**: Correct. The spec accurately maps the flow from `useSessionHistory` -> `groupSessionsByIssue()` -> UI components.

---

## Issues Summary

### Critical (Must Fix)

1. **Styling approach contradicts CLAUDE.md convention** -- The project's `CLAUDE.md` states: "All styling is inline `React.CSSProperties` -- no CSS files or CSS-in-JS libraries." However, upon examining the actual codebase, **every component uses `.module.scss` files** (25 SCSS modules found across `src/renderer/src/components/`). The CLAUDE.md is outdated and does not reflect reality. The tech spec's use of `.module.scss` files is **consistent with the actual codebase patterns**. **Resolution**: The tech spec is correct to propose `.module.scss` files. The CLAUDE.md should be updated separately to reflect the actual styling convention. No change needed in the tech spec itself.

2. **HistoryPage `SessionCard` issue badge fix is under-specified** -- The spec correctly identifies that `HistoryPage.tsx` line 69 only checks `session.issueNumber` and misses Linear/Jira issues. However, the fix is described vaguely as "extract IssueBadge or inline a simplified version." The spec should specify which approach to use. Recommendation: Extract the `IssueBadge` component from `SessionHistoryItem.tsx` into its own file (`src/renderer/src/components/IssueBadge.tsx`) and reuse it in both `SessionHistoryItem` and `SessionCard`. This avoids code duplication and is consistent with the DRY principle the spec already advocates.

### Major (Should Fix)

1. **Missing Jira handler in `useTimer.ts`** -- The spec references Jira as a supported provider for grouping, but `useTimer.ts` (line 253-268) only handles `github` and `linear` when saving session issue fields. Jira issues linked via the pomodoro timer flow are silently dropped. While this is a pre-existing bug outside the scope of this feature, the spec should acknowledge it (perhaps in Open Questions or as a related bug to file) since it directly affects whether Jira sessions appear in groups.

2. **`SessionHistoryItem.tsx` `IssueBadge` does not handle Jira** -- The existing `IssueBadge` in `SessionHistoryItem.tsx` handles `linear`, `github`, and legacy GitHub, but has no branch for `provider === "jira"`. The spec proposes reusing this component but does not mention adding Jira support to it. The grouping feature will create Jira issue groups whose individual sessions show no issue badge in the `SessionHistoryItem` view. This should be addressed as part of the feature work.

3. **Spec references components that do not exist in the codebase** -- The spec's component diagram references `Sidebar.tsx` containing `SessionRow` and `HistoryPage.tsx` containing `SessionCard`. These are actually **internal functions** within those files, not separate components. The spec should clarify that these are the existing inline sub-components, not separate files. The spec also does not mention `SessionHistoryItem.tsx` which is a separate component for rendering sessions in a different context -- the relationship between these renderers should be clarified.

### Minor (Consider)

1. **GitHub display ID inconsistency** -- The spec says GitHub's display ID is `"#{issueId}"` but for GitHub, `issueId` is `String(issue.number)` (e.g., "42"). So the display would be "#42" which is correct. However, the spec's table (Section 3) says `"#{issueId}"` for github but `"#{issueNumber}"` for legacy-github. Since both resolve to the same visual format, this is fine functionally, but the spec should be clearer that for GitHub, `issueId` IS the stringified issue number.

2. **Date label format not specified** -- The `DateSubGroup.dateLabel` is described as "Human-readable date label" but the exact format is not specified. The Sidebar uses `month: "short", day: "numeric"` (e.g., "Feb 24") while HistoryPage uses `month: "short", day: "numeric", year: "numeric"` (e.g., "Feb 24, 2026"). The spec should specify which format to use, or whether the `compact` prop on the header components determines the format.

3. **Expand/collapse state reset on tag filter change** -- When the user changes the tag filter, `useSessionHistory` resets and re-fetches sessions. The grouped data will be recomputed, but the expand/collapse state (`Set<string>`) will still reference old group keys. If the same issue appears in the filtered results, the group will remain expanded. If an issue disappears, its key lingers harmlessly in the Set. This is acceptable behavior but should be documented -- or the expand/collapse state should be reset when the tag filter changes.

4. **`formatDuration` is duplicated** -- Both `Sidebar.tsx` and `HistoryPage.tsx` define their own `formatDuration` function with identical implementations. The spec proposes adding new shared components but does not suggest extracting this common utility. A `src/renderer/src/utils/format.ts` already exists -- consider adding `formatDuration` there.

---

## Recommendations

| Priority | Recommendation | Rationale |
|----------|---------------|-----------|
| High | Extract `IssueBadge` into its own file and add Jira support | Avoids code duplication, fixes an existing gap for Jira display, and makes the component reusable across SessionHistoryItem, SessionCard, and the new group headers |
| High | Specify the `IssueBadge` extraction as a concrete file in the "Files to Create" table | The current spec is ambiguous about where the fix lives |
| Medium | Acknowledge the `useTimer.ts` Jira gap as a related bug | Users linking Jira issues via pomodoro mode will not see those sessions grouped by issue |
| Medium | Add Jira branch to the `IssueBadge` component | Currently missing from `SessionHistoryItem.tsx` |
| Low | Specify the exact date label format for `DateSubGroup.dateLabel` | Prevents implementation ambiguity |
| Low | Extract shared `formatDuration` to `src/renderer/src/utils/format.ts` | Reduces duplication across Sidebar and HistoryPage |
| Low | Document the `max-height: 2000px` clipping limitation | Edge case awareness for very large groups |

---

## Verdict

**CONCERNS**

The architecture is technically solid and the approach is appropriate for the problem. The spec demonstrates thorough analysis of the data model, provider scenarios, and performance characteristics. However, several issues should be addressed before implementation:

- The `IssueBadge` extraction and Jira support should be specified concretely as a file to create
- The `useTimer.ts` Jira gap should be acknowledged as a known related issue
- The existing `IssueBadge` in `SessionHistoryItem.tsx` needs a Jira branch added

None of these are architectural blockers -- they are specification completeness issues that, if left unaddressed, will surface as implementation questions or bugs during development.

---

## Gate Decision

- [x] Approved for next stage (with revisions recommended)
- [ ] Requires revisions before proceeding

The spec is sound enough to proceed to implementation, but the implementer should address the high-priority recommendations above during development. The concerns are additive refinements, not fundamental architectural problems.