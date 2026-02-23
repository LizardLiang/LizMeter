# PRD Review: Session Tags & Sidebar

| Field    | Value                        |
|----------|------------------------------|
| Reviewer | Athena (PM Agent)            |
| Date     | 2026-02-20                   |
| Verdict  | **approved-with-notes**      |

---

## Summary

The PRD is well-structured and comprehensive. It covers data model, IPC channels, UI component hierarchy, design specs, edge cases (via Open Questions), and non-functional requirements. The proposed schema cleanly supports all stated requirements. The document is in strong shape for handoff to a tech spec, with a handful of minor gaps noted below.

---

## Strengths

1. **Thorough data model** -- The `tags` / `session_tags` schema is correct, uses appropriate composite PK, indexes, and cascade deletes. The `COLLATE NOCASE` on `name` neatly handles the duplicate-name validation at the DB level.

2. **IPC channel completeness** -- All CRUD operations plus assign/unassign/count are enumerated with typed inputs and outputs. The modification to `session:list` (adding optional `tagId` filter) is backward-compatible.

3. **Edge cases addressed** -- The Open Questions section explicitly decides on tag deletion + active filter, timer reset clearing tags, and tag assignment triggering history refresh. These are the three most common miss areas and all are resolved.

4. **Design specifications are actionable** -- Sidebar expanded/collapsed dimensions, animation curves, TagBadge styling (color-at-opacity, border, hover/active states) give enough detail for an engineer to implement without a separate design file.

5. **Good alignment with existing stack** -- Inline styles, named exports, IPC pattern extension, settings table reuse for sidebar state, and `:memory:` testing strategy all align with `CLAUDE.md` conventions.

6. **Clear non-goals** -- Explicitly ruling out multi-tag filter, hierarchy, drag-and-drop, and keyboard shortcuts prevents scope creep.

---

## Issues Found

### P1 -- Minor (non-blocking, should be addressed during tech spec)

**P1-1: `ListSessionsResult.total` semantics under tag filter**
The PRD says `session:list` gains an optional `tagId` filter, but does not specify whether `total` in `ListSessionsResult` should reflect the filtered count or the global session count. For correct pagination, `total` must be the filtered count when a `tagId` is provided. This should be stated explicitly.

**P1-2: Missing `PRAGMA foreign_keys = ON` in existing `initDatabase()`**
The PRD correctly notes this pragma must be added, but the existing `database.ts` does not set it. The PRD's Implementation Notes section mentions it, but it should be promoted to a P0 functional requirement (or at minimum an explicit migration step) since without it, `ON DELETE CASCADE` silently does nothing in SQLite.

**P1-3: `session:save` tag assignment race condition**
The PRD states tag assignment for the current session happens via separate `tag:assign` calls after `session:save` returns the session ID. If the app crashes between save and assign, tags are lost. This is acceptable for v1 given the low stakes, but should be acknowledged. Consider noting that a future improvement could accept tag IDs in the `session:save` payload and assign within a single transaction.

**P1-4: `saveSession` return type is now stale**
The existing `saveSession()` returns a `Session` object. The PRD adds `tags: SessionTag[]` to the `Session` interface. After the change, `saveSession()` must return `tags: []` (since tags are assigned post-save). This should be explicitly noted to avoid type errors.

**P1-5: CSS variables for `--tn-cyan`, `--tn-orange`, `--tn-magenta` are missing from `index.html`**
The Tag Color Palette includes cyan (`#7dcfff`), orange (`#ff9e64`), and magenta (`#c678dd`), but `index.html` only defines variables through `--tn-red`. If TagBadge styling references CSS variables for these colors, they need to be added. Alternatively, the PRD could specify that tag colors use hex values directly (which the `color` column does), but the sidebar design section references `var(--tn-*)` patterns, so this inconsistency should be resolved.

**P1-6: No maximum tag count specified**
Open Question #2 decides "no limit" on tags per session, but there is also no limit on total tags. With 100+ tags, the TagPicker dropdown could become unwieldy. Consider noting a soft UX cap (e.g., scrollable with max-height) or deferring search/filter within the picker to a future iteration.

### P2 -- Nitpick

**P2-1: `SessionTag` vs `Tag` type redundancy**
The PRD defines both `Tag` (with `createdAt`) and `SessionTag` (without `createdAt`). This is a reasonable optimization for the join query, but the relationship between the two types should be explicitly stated (e.g., "`SessionTag` is a projection of `Tag` for embedding in `Session` responses").

**P2-2: `tag:list` ordering**
`tag:list` is specified to return tags ordered by `created_at ASC`. Users might expect alphabetical order. This is a minor UX decision that should be a conscious choice -- either is fine, but the tech spec implementer should know it was intentional.

**P2-3: Sidebar right positioning vs. window resize**
The PRD specifies a right-side sidebar with the timer left-anchored. However, the existing layout uses `maxWidth: 640px` with `margin: 0 auto` (centered). The PRD's component tree introduces `AppLayout` as a flex row, which will fundamentally change the centering behavior. The transition from centered single-column to flex row should be noted as a layout-breaking change that affects the timer's visual positioning.

---

## Verdict & Rationale

**Verdict: approved-with-notes**

The PRD is complete enough for an engineer to write a tech spec and begin implementation. The data model is sound, IPC channels are comprehensive, edge cases are addressed, and the UI specifications are detailed. The issues identified are all addressable during the tech spec phase without requiring a PRD rewrite.

The most important item to resolve in the tech spec is **P1-2** (foreign keys pragma) since it is a correctness requirement that the cascade deletes depend on, and **P1-1** (filtered total count) since it affects pagination behavior.

---

## Recommendations

1. **Tech spec should explicitly add `PRAGMA foreign_keys = ON`** as a migration step with a test verifying cascade behavior.
2. **Clarify `total` semantics** in `ListSessionsResult` under tag filter -- should be filtered count.
3. **Add missing CSS variables** (`--tn-cyan`, `--tn-orange`, `--tn-magenta`) to `index.html`, or document that tag colors use raw hex values in inline styles.
4. **Acknowledge the save-then-assign two-step** as a known limitation and consider bundling tag IDs into `SaveSessionInput` in a future iteration.
5. **Add `tags: []` to `saveSession` return** in the tech spec to satisfy the updated `Session` type.
6. **Note the layout-breaking change** from centered single-column to flex row in the tech spec so it is handled deliberately.