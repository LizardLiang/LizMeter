# Tech Spec Review (PM Perspective)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **Against** | prd.md |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-24 |
| **Verdict** | APPROVED |

---

## Review Summary

The tech spec demonstrates strong alignment with the PRD. All P0 (Must Have) requirements are addressed with clear implementation paths. The spec makes sound architectural decisions that support the product goals. Minor non-blocking gaps are noted below.

---

## P0 Requirements Coverage

| PRD ID | Requirement | Spec Coverage | Status |
|--------|-------------|---------------|--------|
| FR-001 | Mode toggle between Pomodoro and Time Tracking | `ModeToggle` component in `TomatoClock.tsx`, `AppMode` type, mode persistence via settings | Pass |
| FR-002 | Count-up stopwatch timer | `useStopwatch` hook with independent reducer, 250ms wall-clock tick, HH:MM:SS display | Pass |
| FR-003 | Start / Pause / Resume / Stop controls | `StopwatchView` component with full control set, FSM states: idle → running → paused | Pass |
| FR-004 | Auto-prompt to link issue on start | `IssuePromptDialog` modal, reuses existing Jira/Linear integrations, skip option | Pass |
| FR-005 | Save stopwatch sessions to history | Reuses `session:save` IPC with `timerType: "stopwatch"`, `plannedDurationSeconds: 0` | Pass |
| FR-006 | Stopwatch sessions in unified history | Same history list, "Stopwatch" badge with cyan styling, elapsed-only display format | Pass |
| FR-007 | Configurable maximum duration | `stopwatch.max_duration_seconds` setting, default 8h, "No limit" option (value 0) | Pass |

**Assessment**: All 7 P0 requirements fully covered.

---

## P1 Requirements Coverage

| PRD ID | Requirement | Spec Coverage | Status |
|--------|-------------|---------------|--------|
| FR-010 | Elapsed time persists across mode switches | Mode toggle guard prevents switch while running; stopwatch state independent of UI | Pass |
| FR-011 | Session title defaults to linked issue | `IssuePromptDialog` sets title from selected issue | Pass |
| FR-012 | Visual indicator of running stopwatch | Not explicitly specified in tech spec | Minor Gap |
| FR-013 | Skip prompt preference in settings | `stopwatch.prompt_for_issue` setting key defined | Pass |

---

## Non-Functional Requirements

| Category | Spec Approach | Status |
|----------|---------------|--------|
| Performance | 250ms wall-clock tick (proven pattern), no DB queries during running | Pass |
| Consistency | Tokyo Night theme, inline styling, same patterns as existing components | Pass |
| Data Integrity | Same `sessions` table, `VALID_TIMER_TYPES` whitelist extended | Pass |
| Usability | Top-level mode toggle, auto-prompt with skip | Pass |

---

## Issues Found

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| Minor | FR-012 (running stopwatch indicator in Pomodoro mode) not detailed in spec | Add brief note about indicator UI when mode is toggled while stopwatch runs. Currently guarded by disabling toggle, so this is a P1 gap that can be addressed in implementation. |
| Minor | The spec uses `plannedDurationSeconds: 0` while the PRD says "N/A or omitted". Either works but should be consistent. | Spec's approach (0) is pragmatic given NOT NULL constraint. Document in implementation notes. |
| Minor | Interaction between stopwatch sessions and existing tag system not clarified | Spec shows TagPicker integration in StopwatchView — this is covered implicitly but could be more explicit. |

---

## Verdict

**APPROVED**

The tech spec is well-aligned with the PRD. All P0 requirements have clear implementation paths. The architectural decisions (reusing existing tables, separate hook, mode toggle) are sound. Three minor non-blocking issues identified as recommendations for implementation phase.