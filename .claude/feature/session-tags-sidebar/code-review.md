# Code Review: Session Tags & Sidebar

Reviewer: Hermes | Date: 2026-02-20 | Verdict: **revisions-required**

---

## Executive Summary

**The code review cannot be completed because the implementation does not exist.**

The pipeline status shows stage `5-spec-review-sa` as the last completed stage. No implementation work has been performed. All source files listed in the review checklist (new components, new hooks, modified files, test files) are absent from the codebase. The existing source files (`types.ts`, `database.ts`, `ipc-handlers.ts`, `preload/index.ts`) remain in their pre-feature state with no tag-related changes. There is no `implementation-notes.md` file.

This code review was invoked prematurely. The feature must go through stages 6 (implementation by Ares) and 7 (testing) before stage 8 (code review by Hermes) can proceed.

---

## Correctness Findings (Critical)

### CR-1: No implementation exists (BLOCKER)

**Severity**: Critical / Blocker

**Evidence**: All 18 source files and 7 test files listed in the review mandate are missing:

**Missing new files (expected but not found):**
- `src/renderer/hooks/useTagManager.ts`
- `src/renderer/hooks/useSidebar.ts`
- `src/renderer/components/TagBadge.tsx`
- `src/renderer/components/TagColorPicker.tsx`
- `src/renderer/components/TagPicker.tsx`
- `src/renderer/components/TagManager.tsx`
- `src/renderer/components/CurrentSessionPanel.tsx`
- `src/renderer/components/SessionHistoryPanel.tsx`
- `src/renderer/components/Sidebar.tsx`
- `src/renderer/components/SidebarToggle.tsx`

**Expected modifications not present in:**
- `src/shared/types.ts` -- no `Tag`, `SessionTag`, `CreateTagInput`, `UpdateTagInput`, `TagAssignInput` types; `Session` lacks `tags` field; `ListSessionsInput` lacks `tagId`; `ElectronAPI` lacks `tag` namespace
- `electron/main/database.ts` -- no `PRAGMA foreign_keys = ON`; no `tags`/`session_tags` tables; no tag CRUD functions; no `getSetting`/`setSetting`
- `electron/main/ipc-handlers.ts` -- no tag IPC handlers; no `settings:get-key`/`settings:set-key` handlers
- `electron/preload/index.ts` -- no `tag` namespace; no `settings.getKey`/`settings.setKey`
- `src/renderer/hooks/useTimer.ts` -- no `onSessionSaved` callback
- `src/renderer/hooks/useSessionHistory.ts` -- no `tagId` filter parameter
- `src/renderer/App.tsx` -- no layout restructure
- `src/renderer/components/TomatoClock.tsx` -- no changes
- `src/test/better-sqlite3-shim.ts` -- not checked (no tag-related changes expected without implementation)

**Missing test files:**
- `electron/main/__tests__/tags-database.test.ts`
- `electron/main/__tests__/ipc-handlers.test.ts` (tag additions)
- `src/renderer/hooks/__tests__/useTagManager.test.ts`
- `src/renderer/hooks/__tests__/useSidebar.test.ts`
- `src/renderer/components/__tests__/TagBadge.test.tsx`
- `src/renderer/components/__tests__/TagManager.test.tsx`
- `src/renderer/components/__tests__/Sidebar.test.tsx`

**Missing documentation:**
- `implementation-notes.md` -- required by the review mandate pre-read list

---

## Security Assessment

N/A -- no code to assess.

---

## Test Coverage Assessment

N/A -- no tests to assess.

---

## Frontend Design Assessment

N/A -- no UI code to assess.

---

## Deviations from Spec

N/A -- no implementation to compare against spec.

---

## Checklist Status

All checklist items are **blocked** due to missing implementation:

- [ ] PRAGMA foreign_keys = ON is the FIRST pragma after db open -- **NOT IMPLEMENTED**
- [ ] session_tags has ON DELETE CASCADE on BOTH FK columns -- **NOT IMPLEMENTED**
- [ ] tags table has UNIQUE(name COLLATE NOCASE) -- **NOT IMPLEMENTED**
- [ ] All 7 tag:* IPC channels: handler registered + preload exposed + TypeScript typed -- **NOT IMPLEMENTED**
- [ ] session:save backward compat -- **NOT IMPLEMENTED**
- [ ] Cascade delete actually tested -- **NOT IMPLEMENTED**
- [ ] onSessionSaved callback passes tagIds -- **NOT IMPLEMENTED**
- [ ] pendingTagIds cleared after session save -- **NOT IMPLEMENTED**
- [ ] IPC handlers validate all inputs -- **NOT IMPLEMENTED**
- [ ] No SQL injection -- **NOT IMPLEMENTED**
- [ ] No XSS -- **NOT IMPLEMENTED**
- [ ] All new components use named exports -- **NOT IMPLEMENTED**
- [ ] All imports use explicit .ts/.tsx extensions -- **NOT IMPLEMENTED**
- [ ] No CSS files -- **NOT IMPLEMENTED**
- [ ] No `any` types -- **NOT IMPLEMENTED**
- [ ] No unused variables or imports -- **NOT IMPLEMENTED**
- [ ] Tag palette colors use raw hex -- **NOT IMPLEMENTED**
- [ ] Sidebar has smooth 220ms transition -- **NOT IMPLEMENTED**
- [ ] TagBadge uses pill design with 15% opacity background -- **NOT IMPLEMENTED**
- [ ] 8 Tokyo Night colors present in TagColorPicker -- **NOT IMPLEMENTED**
- [ ] CurrentSessionPanel shows meaningful state for all timer states -- **NOT IMPLEMENTED**
- [ ] cascade delete test verifies row is actually gone -- **NOT IMPLEMENTED**
- [ ] backward compat test -- **NOT IMPLEMENTED**
- [ ] Tests cover all P0 requirements -- **NOT IMPLEMENTED**
- [ ] No tests that only test mocks -- **NOT IMPLEMENTED**

---

## Verdict & Rationale

**Verdict: revisions-required**

**Rationale**: This is not a code quality issue -- there is simply no code to review. The implementation stage (stage 6, assigned to Ares) has not been executed. The pipeline jumped from stage 5 (spec review by Apollo) directly to stage 8 (code review by Hermes), skipping the implementation and testing stages entirely.

**Required action**: Run the implementation pipeline stages before re-invoking code review:
1. Stage 6: Implementation (Ares) -- implement all files per tech spec
2. Stage 7: Testing -- run `bun run test`, `bun run lint`, `bun run fmt:check`
3. Stage 8: Code review (Hermes) -- re-invoke this review after implementation is complete

---

## Recommendations (non-blocking)

1. **Verify pipeline stage gating**: The orchestrator should check that previous stages are complete AND that implementation artifacts exist before invoking code review. Stage completion in `status.json` alone is insufficient -- the actual files must be present on disk.

2. **SA review notes remain valid**: Apollo's M-1 (sql.js PRAGMA verification) and M-2 (`onSessionSaved` callback detail) should be addressed during implementation. These findings from `spec-review-sa.md` are still pending.