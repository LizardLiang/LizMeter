# Spec Review — PM Perspective

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **Against** | prd.md |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-22 |
| **Verdict** | APPROVED WITH NOTES |

---

## Review Summary

The tech spec faithfully translates PRD requirements into implementable components. All 8 P0 requirements are addressed. The architecture decisions (safeStorage token encryption, denormalized issue columns on sessions, provider abstraction) are sound. The spec is ready for Stage 6 after the SA review revisions are applied.

---

## P0 Requirements Traceability

| ID | Requirement | Spec Coverage | Status |
|----|-------------|---------------|--------|
| FR-001 | GitHub PAT entry in Settings | §8 SettingsPage extension with token input section | ✅ Covered |
| FR-002 | Token validation on save | §6 `issues:provider-status` + SettingsPage calls `providerStatus` after save; validation via `validateToken()` in GitHubProvider | ✅ Covered |
| FR-003 | Issues page — list assigned issues | §8 `IssuesPage.tsx` component with 5 states | ✅ Covered |
| FR-004 | Issues page navigation | §8 `NavSidebar.tsx` — add `"issues"` to `NavPage`; new nav item | ✅ Covered |
| FR-005 | Timer page — issue picker | §8 `IssuePickerDropdown.tsx`, integrated into `TomatoClock.tsx` | ✅ Covered |
| FR-006 | Session–issue linking | §3 DB columns; §7 `session:save` extended; §8 TomatoClock passes issue fields on save | ✅ Covered |
| FR-007 | History page — linked issue badge | §8 HistoryPage extension with `#number` clickable link | ✅ Covered |
| FR-008 | No-token graceful state | §8 IssuesPage states include "No token" empty state; picker hidden when unconfigured | ✅ Covered |

All P0 requirements are fully covered. ✅

---

## P1 Requirements Coverage

| ID | Requirement | Spec Coverage | Status |
|----|-------------|---------------|--------|
| FR-010 | Issue search/filter | `IssuePickerDropdown` has search input (client-side filter); `IssuesPage` has search | ✅ Covered |
| FR-011 | Repository filter | §5 `IssuesListInput.repo` param; Issues page dropdown | ✅ Covered |
| FR-012 | Unlink issue from Timer | `IssuePickerDropdown` has clear (×) button that calls `onSelect(null)` | ✅ Covered |
| FR-013 | Token removal | §8 SettingsPage extension — "Remove token" button calls `issues.deleteToken()` | ✅ Covered |

All P1 requirements covered. ✅

---

## User Flow Alignment

| PRD Flow | Spec Implementation | Aligned |
|----------|--------------------|---------|
| Configure token | SettingsPage section → `issues:set-token` IPC → safeStorage | ✅ |
| Browse Issues page | `IssuesPage` with `useIssues` hook, loading/empty/error states | ✅ |
| Link issue before timer | `IssuePickerDropdown` in TomatoClock; auto-fills title; clears on reset | ✅ |
| View in History | Session row shows `#number` badge → `shell.openExternal` | ✅ |
| No-token state | IssuesPage empty state with Settings link; picker hidden | ✅ |

---

## Success Metrics Assessment

| Metric | Achievable? | Notes |
|--------|-------------|-------|
| 40% sessions linked (users with token) | Yes | Issue picker is prominent in TomatoClock; auto-fill reduces friction |
| <15s to link and start | Yes | Issue picker opens instantly (cached); selecting sets title immediately |
| 90% token setup completion | Yes | SettingsPage flow is a simple paste-and-save |

---

## Out-of-Scope Verification

| PRD Out-of-Scope Item | Spec Compliance |
|-----------------------|-----------------|
| Linear (no code, just abstraction) | Only `GitHubProvider` implemented; `IssueProvider` interface enables future Linear | ✅ |
| OAuth | Only PAT token input; no OAuth mentioned | ✅ |
| Posting back to GitHub | No comment/time-log IPC channels defined | ✅ |
| Issue creation | No create endpoints or UI | ✅ |

---

## Issues Found

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| Minor | `shell.openExternal` exposure is listed as an open question. If it doesn't already exist in the preload, it needs to be added before implementation begins — History page depends on it. | Confirm presence or add `shell.openExternal` before starting History page work |
| Minor | PRD FR-007 (History page) says issue badge is "clickable". The spec implements this via `shell.openExternal` in the renderer directly. For security, the URL should be validated in the main process handler (http/https only) as §12 specifies — ensure this is not skipped during implementation. | Flag for Ares during implementation |
| Minor | The spec says issue title auto-fills session title on selection (per PRD Open Question resolution). The PRD review noted this should be user-overridable. The spec confirms "user can override" but doesn't specify whether clearing the issue also clears the title. Recommend: clearing the issue does NOT clear a manually-typed title — only auto-filled title should revert. | Add clarification note in TomatoClock implementation |

---

## Verdict

**APPROVED WITH NOTES**

All P0 and P1 requirements are covered. User flows are faithfully translated. The three minor notes above should be addressed during implementation (not spec revisions). The spec is approved from a PM perspective pending SA review resolution.

The SA reviewer has flagged 3 critical issues in the tech spec (missing `initProviderFromDisk` call, unresolved `@octokit/rest` ESM/CJS question, `safeStorage` error handling). These must be resolved in tech-spec.md before Stage 6 (Test Plan) begins. PM concurs that those are valid technical concerns and the gate should remain at Stage 3 until addressed.