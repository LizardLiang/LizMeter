# PM Review: Tech Spec -- Session Tags & Sidebar

| Field    | Value                        |
|----------|------------------------------|
| Reviewer | Athena (PM Agent)            |
| Date     | 2026-02-20                   |
| Verdict  | **approved-with-notes**      |

---

## Requirements Coverage Matrix

Every P0 functional requirement from the PRD is mapped to a concrete implementation location in the tech spec below.

| PRD Req | Requirement | Spec Coverage | Status |
|---------|-------------|---------------|--------|
| F-01 | **Tags table** | Database Layer > New DDL: `CREATE TABLE IF NOT EXISTS tags (...)` with correct schema (TEXT PK, UNIQUE COLLATE NOCASE name, TEXT color, TEXT created_at). | Covered |
| F-02 | **Junction table** | Database Layer > New DDL: `CREATE TABLE IF NOT EXISTS session_tags (...)` with composite PK, cascade deletes on both FKs, index on `tag_id`. | Covered |
| F-03 | **Tag CRUD IPC** | IPC Layer > New Channels: `tag:create`, `tag:list`, `tag:update`, `tag:delete` all specified with input/output types, validation behavior, and error semantics. | Covered |
| F-04 | **Tag assignment IPC** | IPC Layer > New Channels: `tag:assign` and `tag:unassign` with `TagAssignInput`, idempotent behavior (`INSERT OR IGNORE`, no-op delete). | Covered |
| F-05 | **Session list with tags** | Database Layer > Modified `listSessions`: post-processing step attaches `tags: SessionTag[]` to each session via prepared statement loop. | Covered |
| F-06 | **Filter by tag IPC** | Database Layer > Modified `listSessions`: accepts optional `tagId`, uses `INNER JOIN session_tags` when present. `ListSessionsInput` gains `tagId` field. | Covered |
| F-07 | **Sidebar component** | Component Architecture: `Sidebar.tsx` with four sections (CurrentSessionPanel, TagManager, SessionHistoryPanel, SidebarToggle). Expanded/collapsed states specified. | Covered |
| F-08 | **TagBadge component** | Component Architecture > TagBadge: pill shape, color dot, opacity-based theming, active filter state, remove button, sm/md sizes. Full visual spec provided. | Covered |
| F-09 | **TagPicker component** | Component Architecture > TagPicker: popover with checkboxes, inline create, max height scroll, close-on-outside-click, escape key, focus trap, aria-label. | Covered |
| F-10 | **Current Session panel** | Component Architecture > CurrentSessionPanel: shows timer status with dot indicators (idle/running/paused/completed), title, TagPicker for pending tags. | Covered |
| F-11 | **Sidebar toggle** | Component Architecture > SidebarToggle: chevron button, aria-label, transitions (width 220ms, opacity 150ms). Collapsed/expanded dimensions (48px/260px). | Covered |

### P1 Requirements Coverage

| PRD Req | Requirement | Spec Coverage | Status |
|---------|-------------|---------------|--------|
| F-12 | **Tag color picker** | TagColorPicker component: 4x2 grid of 8 hex swatches, selected indicator, stateless controlled component. | Covered |
| F-13 | **Delete confirmation** | TagManager component: click delete icon triggers confirmation with session count fetched via `tag:count`. Local state tracks `deleteConfirmId` and `deleteSessionCount`. | Covered |
| F-14 | **Sidebar state persistence** | `useSidebar` hook + new generic `settings:get-key` / `settings:set-key` IPC channels + `getSetting`/`setSetting` DB functions. Key: `sidebar.expanded`. | Covered |
| F-15 | **Auto-assign color** | `getNextAutoColor()` helper: `TAG_COLORS[count % 8]`. Cycles through palette based on total tag count. | Covered |
| F-16 | **Inline tag rename** | TagManager: double-click to enter inline edit mode. Local state `editingTagId`. Same validation as create (non-empty, max 50 chars, no duplicates). | Covered |

---

## User Story Fulfillment Analysis

| User Story | Technical Path | Assessment |
|------------|---------------|------------|
| US-1: Create a tag | `TagManager` inline input -> `useTagManager.createTag` -> `tag:create` IPC -> `createTag()` DB function with validation (empty, length, duplicate). Auto-color via `getNextAutoColor()`. | Fully fulfilled |
| US-2: Rename a tag | `TagManager` double-click inline edit -> `useTagManager.updateTag` -> `tag:update` IPC -> `updateTag()` DB function. Same validation. Refresh propagates to all rendered `TagBadge` instances. | Fully fulfilled |
| US-3: Change tag color | `TagColorPicker` popover from color dot click -> `updateTag` with new color -> re-render. 8-color palette specified. | Fully fulfilled |
| US-4: Delete a tag | Delete icon -> `tag:count` to get affected session count -> confirmation UI -> `tag:delete` IPC -> `deleteTag()` DB function. CASCADE handles junction cleanup. Active filter cleared if deleted tag was filtered. | Fully fulfilled |
| US-5: Assign tags to current session | `CurrentSessionPanel` with `TagPicker` -> `pendingTagIds` in React state -> on session completion, `onSessionSaved` callback iterates `pendingTagIds` and calls `tag:assign` for each. Tags cleared on timer reset. | Fulfilled (with noted limitation -- see Issues) |
| US-6: Edit tags on past sessions | `SessionHistoryItem` gains tag picker trigger -> `TagPicker` popover -> `tag:assign` / `tag:unassign` IPC -> immediate persist. Session re-renders with updated badges. History refresh triggered. | Fully fulfilled |
| US-7: Filter by tag | Click `TagBadge` -> `onFilterByTag(tagId)` -> `activeFilterTagId` state in App -> `useSessionHistory(tagId)` re-fetches -> filtered `total` for pagination. Click again to clear. Pagination resets to offset 0. | Fully fulfilled |
| US-8: Toggle sidebar | `SidebarToggle` button -> `useSidebar.toggle()` -> width transition 220ms + opacity transition 150ms. Collapsed shows icon strip (48px). State persisted via `settings:set-key("sidebar.expanded")`. Main content flex-grows to fill. | Fully fulfilled |

---

## Issues Found

### Issue 1: `useSidebar` hook implementation is incomplete (Severity: Medium)

The `useSidebar` hook code in the spec contains placeholder comments (`// Implementation: read "sidebar.expanded" from settings on mount`) rather than actual implementation. The architecture decision (generic `settings:get-key`/`settings:set-key` channels) is sound, and the DB functions and IPC channels are fully specified elsewhere in the document. However, the hook body itself has TODO-quality code that an implementer might copy verbatim. The `toggle` function does not actually call `settings.setKey`.

**Recommendation**: The implementer should treat the `useSidebar` hook as pseudocode and wire up the `settings.getKey("sidebar.expanded")` / `settings.setKey("sidebar.expanded", String(next))` calls. This is low risk since all the supporting infrastructure is properly specified.

### Issue 2: Two-step save-then-assign crash window (Severity: Low, Acknowledged)

The spec explicitly documents this as an acceptable v1 limitation in the Architecture Decisions table: "If the app crashes between save and assign, tags are lost but the session is preserved." It further notes a future iteration may accept `tagIds` in `SaveSessionInput` for transactional save.

**PM Assessment**: Acceptable. The crash window is extremely small (milliseconds between save return and assign calls). The user can retroactively add tags via US-6 if this edge case occurs. The spec correctly identifies the mitigation path.

### Issue 3: Pending tags in component state -- sufficient for the requirement? (Severity: Low)

The spec stores pending tag IDs for the current (unsaved) session in `useState<string[]>` in `App.tsx` or `TomatoClock.tsx`. This means:
- Tags survive timer state transitions (idle -> running -> paused -> running) since the state is held at a parent level, not inside `useTimer`.
- Tags are cleared on timer reset (via `useEffect` watching `state.status`).
- Tags are NOT persisted across page refreshes during an active session (the session itself is also not persisted mid-run, so this is consistent).

**PM Assessment**: Sufficient. The behavior matches the existing session model where nothing is persisted until completion. The `onSessionSaved` callback pattern is clean.

### Issue 4: Sidebar width discrepancy with PRD (Severity: Low)

The PRD specifies sidebar width as "280-320px expanded / 44px collapsed." The tech spec settles on "260px expanded / 48px collapsed." The 260px vs 280-320px is a 20-60px difference.

**PM Assessment**: Acceptable. 260px is a reasonable width for the content described. The PRD provided a range, and the spec chose a value that preserves more main content area. The collapsed width of 48px vs 44px is negligible. No user story is impacted by this.

### Issue 5: `tag:count` IPC channel -- is it needed? (Severity: Low)

The PRD includes `tag:count` as a dedicated channel. The spec implements it and uses it in `TagManager` for the delete confirmation dialog ("Delete tag 'X'? It will be removed from N sessions."). The `deleteTag` function also does the same count query internally before deleting.

**PM Assessment**: The channel serves a real UX purpose (showing the count before the user confirms deletion). While the count could theoretically be done inside `deleteTag` and returned in a confirmation flow, the current two-step approach (count -> confirm -> delete) is cleaner and avoids a modal-inside-IPC pattern. Keep it.

### Issue 6: Pagination + filter UX clarity (Severity: Low)

The spec handles pagination-under-filter correctly at the technical level:
- `total` reflects filtered count when `tagId` is present (Architecture Decisions table).
- `useSessionHistory` resets offset to 0 when `tagId` changes.
- The `SessionHistoryPanel` has a filter indicator bar with a "clear" button.

The only missing detail is what happens to "Load More" behavior. The existing `onLoadMore` pattern presumably increments offset by `limit`. With filtered results, this works correctly since `total` is the filtered count, so the "Load More" button would hide when all filtered results are loaded.

**PM Assessment**: Technically complete. The UX is clear enough: the filter indicator tells the user they are in filtered mode, and pagination respects the filtered set. No gap.

### Issue 7: Frontend design detail level (Severity: Low)

The spec provides extensive visual specifications: exact hex colors, opacity values for all badge states, pixel dimensions, transition curves, font sizes, section header typography, dot indicator states, popover styling, and an ASCII layout diagram.

**PM Assessment**: This is above average for a tech spec. A designer could produce production-grade UI from these specs. The TagBadge visual spec alone has 6 distinct states (default, hover, active, with-remove, sm, md). The CurrentSessionPanel has 4 timer-state visualizations. The collapsed sidebar has icon specifications. This is sufficient.

### Issue 8: New IPC channels not in original PRD scope (Severity: Informational)

The spec introduces two additional IPC channels not in the PRD: `settings:get-key` and `settings:set-key`. These are a reasonable architectural addition for sidebar state persistence (F-14) and avoid polluting the existing `TimerSettings` type. They also open the door for future generic settings without schema changes.

**PM Assessment**: Good architectural decision. No scope concern.

---

## PRD Review Issues Resolution Check

All six P1 and three P2 issues from the PRD review (`prd-review.md`) are addressed:

| PRD Review Issue | Resolution in Tech Spec |
|-----------------|------------------------|
| P1-1: `total` semantics under tag filter | Explicitly decided: filtered count. Noted in Architecture Decisions and in `listSessions` code comment. |
| P1-2: Missing `PRAGMA foreign_keys = ON` | Added as first pragma after DB open. Architecture Decision entry. Test case TC-322 verifies cascade. |
| P1-3: Save-then-assign race condition | Documented in Architecture Decisions as acceptable v1 limitation with future mitigation path. |
| P1-4: `saveSession` return type | Explicitly returns `tags: []`. Code shown in modified `saveSession`. Test TC-324. |
| P1-5: Missing CSS variables | Decided: raw hex values everywhere, no CSS variables added. Noted in Frontend Design Spec. |
| P1-6: No max tag count | Decided: no hard limit. TagPicker has `maxHeight: 240px` with scroll. Search deferred to future. |
| P2-1: `SessionTag` vs `Tag` | Explicitly noted as "projection" via `Pick<Tag, "id" | "name" | "color">`. |
| P2-2: `tag:list` ordering | Explicitly decided as intentional (`created_at ASC`) with rationale. |
| P2-3: Layout-breaking change | Noted in Architecture Decisions as "deliberate layout-breaking change." `AppLayout` preserves timer centering via internal `maxWidth: 640px; margin: 0 auto`. |

---

## Verdict & Rationale

**Verdict: approved-with-notes**

The tech spec is thorough, well-structured, and covers all P0 and P1 requirements from the PRD. Every user story has a clear, traceable technical path to fulfillment. All edge cases raised in the PRD review are explicitly addressed with documented decisions and rationale.

The spec provides production-quality database function implementations, complete IPC channel definitions with error semantics, detailed component props interfaces, and an extensive visual design specification. The implementation order (28 steps, bottom-up) is dependency-aware and avoids broken builds at any step. The testing strategy covers all layers (DB, hooks, components, E2E) with 25 specific test cases for the database alone.

The notes are minor:
1. The `useSidebar` hook body contains placeholder comments instead of working code -- the implementer should wire up the `settings.getKey`/`settings.setKey` calls that are properly specified elsewhere in the document.
2. The sidebar width (260px) is narrower than the PRD range (280-320px) -- this is acceptable and may actually be preferable.

No revisions are required. The spec is ready for implementation.