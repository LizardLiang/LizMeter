# Tech Spec Review (Architecture)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **Reviewer** | Apollo (SA Agent) |
| **Date** | 2026-02-24 |
| **Verdict** | APPROVED |

---

## Review Summary

The tech spec is architecturally sound. It follows existing codebase patterns faithfully, makes minimal invasive changes, and avoids over-engineering. The decision to create a separate `useStopwatch` hook rather than extending `useTimer` is the right call — it keeps concerns isolated while reusing the proven wall-clock tick pattern. No blocking issues found.

---

## Architecture Assessment

### Pattern Consistency
| Area | Existing Pattern | Spec Approach | Verdict |
|------|-----------------|---------------|---------|
| State management | `useReducer` FSM in `useTimer` | New `useReducer` FSM in `useStopwatch` | Consistent |
| Timer accuracy | 250ms interval + wall-clock arithmetic | Same approach | Consistent |
| Session persistence | `session:save` IPC to SQLite | Reuse same channel | Consistent |
| Settings storage | Key-value in `settings` table | New keys, same pattern | Consistent |
| Component styling | Inline `React.CSSProperties`, Tokyo Night | Same approach specified | Consistent |
| Type definitions | Central `src/shared/types.ts` | Extends existing types there | Consistent |
| Validation | `VALID_TIMER_TYPES` whitelist in `database.ts` | Adds `"stopwatch"` to whitelist | Consistent |

### Data Model Review
| Decision | Assessment |
|----------|-----------|
| No new tables | Correct — `sessions` table accommodates the new type without schema changes |
| `timer_type = "stopwatch"` | Sound — TEXT column with no CHECK constraint, backward compatible |
| `planned_duration_seconds = 0` | Pragmatic — column has NOT NULL constraint, 0 is semantically clear |
| Settings keys with `stopwatch.` prefix | Good namespacing, consistent with existing `timer.` prefix pattern |

### Component Architecture
| Decision | Assessment |
|----------|-----------|
| Separate `useStopwatch` hook | Correct — avoids polluting `useTimer` with count-up branching logic |
| `ModeToggle` as separate component | Good separation of concerns |
| `IssuePromptDialog` reusing existing issue components | Excellent reuse of existing integrations |
| Mode state in `TomatoClock.tsx` | Appropriate — already the root composition component |

---

## Potential Issues

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| Minor | `getDurationForType()` in `useTimer.ts` has exhaustive switch on `TimerType` — adding `"stopwatch"` to the union will cause a type error | Add a `"stopwatch"` case returning 0, or narrow the function's input type |
| Minor | `saveSession()` validates `plannedDurationSeconds > 0` — will reject stopwatch's `0` | Add `timerType === "stopwatch"` guard around the `> 0` check |
| Informational | `IssueRef` discriminated union already covers Jira variant — confirm `IssuePromptDialog` maps correctly | Verify during implementation |

---

## Security & Performance

- No new IPC channels — attack surface unchanged
- `"stopwatch"` added to validation whitelist — prevents injection
- 250ms tick interval proven and sufficient
- No DB queries during running — only on save
- Mode toggle is lightweight conditional render

---

## Verdict

**APPROVED**

The architecture is clean, minimal, and follows established patterns. Three minor issues are straightforward implementation details that will surface at compile time. No blocking concerns.