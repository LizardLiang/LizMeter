# Tech Spec Review (PM Perspective)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md v1.0 |
| **Against** | prd.md v1.0 |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-23 |
| **Verdict** | PASS WITH NOTES |

---

## Review Summary

The tech spec is thorough, well-structured, and demonstrates that Hephaestus performed a genuine codebase audit to correct the stale file references flagged during PRD review. All eight P0 requirements are addressed. The key architectural decisions (raw fetch over SDK, generic provider columns, tabs for multi-provider, IssueRef discriminated union) are well-reasoned and align with product goals. Backward compatibility is handled carefully with a dual-write strategy that preserves legacy GitHub sessions.

The spec earns a PASS WITH NOTES rather than a clean PASS because of a few product-level gaps: the search/filter requirement (P1 FR-010) has backend support but no explicit UI treatment, one PRD edge case (zero teams) is not addressed, and the "remember last active tab" behavior is explicitly scoped down to component state (lost on unmount) without noting that this partially satisfies the PRD's P2 FR-021.

---

## 1. PRD Alignment -- P0 Requirements

| PRD ID | Requirement | Spec Coverage | Status |
|--------|-------------|---------------|--------|
| FR-001 | Linear API key configuration | Spec Section 4 (IPC: `linear:set-token`), Section 10 (SettingsPage states), Section 6 (safeStorage encryption) | PASS |
| FR-002 | Test connection for Linear | Spec Section 4 (IPC: `linear:test-connection`), Section 9 (Viewer query returns `name`), Section 10 (SettingsPage shows display name) | PASS |
| FR-003 | Team selection | Spec Section 4 (IPC: `linear:list-teams`, `linear:set-team`, `linear:get-team`), Section 10 (SettingsPage team dropdown) | PASS |
| FR-004 | Browse Linear issues | Spec Section 4 (IPC: `linear:fetch-issues`), Section 10 (IssuesPage with tabs, Linear issue card showing identifier/title/status/priority) | PASS |
| FR-005 | Link Linear issue to session | Spec Section 3 (new DB columns), Section 5 (`IssueRef` union, `SaveSessionInput` extension), Section 10 (IssuePickerDropdown with tabs) | PASS |
| FR-006 | Display linked Linear issues in history | Spec Section 10 (SessionHistoryItem: issue badge with identifier, title, clickable URL) | PASS |
| FR-007 | Multi-provider sidebar (tabs) | Spec Section 10 (IssuesPage provider tabs, single-provider hides tabs, neither-configured shows generic message) | PASS |
| FR-008 | Multi-provider issue selector | Spec Section 10 (IssuePickerDropdown with tabs, single-provider shows issues directly) | PASS |

**All 8 P0 requirements are covered in the spec.**

---

## 2. User Experience Assessment

### Settings Configuration Flow
The three-state design for the Settings page (unconfigured, configured-no-team, configured-with-team) is well thought out and mirrors a natural progressive disclosure pattern. The "Test Connection" and "Disconnect" buttons at each stage give users clear control. The help text pointing to "Settings > Account > API in Linear" for key generation is a good onboarding detail.

**Verdict**: Good UX. Matches PRD User Flow 1 faithfully.

### Issue Browsing (IssuesPage)
The tab-based provider switching is appropriate for two providers. The decision to hide the tab bar when only one provider is configured avoids unnecessary UI complexity for single-provider users. The issue card layout (identifier, state, title, priority) surfaces the right information density.

**Verdict**: Good UX. Matches PRD User Flow 3.

### Issue Picker (Save Dialog)
Same tab pattern inside the dropdown. When both providers are configured, the user can switch; when only one is configured, they see issues directly. This avoids an extra interaction step for single-provider users.

**Verdict**: Good UX. Matches PRD User Flow 2.

### Session History
The badge approach (showing "LIN-42" for Linear, "#42" for GitHub) with clickable links to open in browser provides consistent visual treatment across providers. This also covers P2 FR-020 (open in browser).

**Verdict**: Good UX. Matches PRD FR-006.

### Concern: Empty States
The spec describes the "neither configured" state ("Configure an issue tracker in Settings") but does not explicitly describe the per-tab empty state when one provider is configured but the other is not. The PRD review (Issue 8) flagged this. The spec should indicate what the inactive provider's tab shows (e.g., "Configure GitHub in Settings" when on the GitHub tab but only Linear is set up).

---

## 3. Completeness -- Requirements Coverage

### P1 Requirements

| PRD ID | Requirement | Spec Coverage | Status |
|--------|-------------|---------------|--------|
| FR-010 | Search/filter Linear issues | Section 4 GraphQL: `SearchIssues` query exists. IPC: not listed as a separate channel -- search appears to be handled client-side or combined with `linear:fetch-issues`. | PARTIAL -- see note 1 |
| FR-011 | Display Linear issue metadata (priority, status) | Section 10 (issue card shows state label, priority indicator with color/icon) | PASS |
| FR-012 | Delete Linear configuration | Section 4 (IPC: `linear:delete-token`), Section 10 ("Disconnect" button in Settings) | PASS |

### P2 Requirements

| PRD ID | Requirement | Spec Coverage | Status |
|--------|-------------|---------------|--------|
| FR-020 | Open Linear issue in browser | Section 10 (SessionHistoryItem badge is clickable, opens `issueUrl` via `shell:open-external`) | PASS |
| FR-021 | Remember last active provider tab | Section 10 ("Tab selection persisted in useState, reset on unmount") -- partially addressed, acknowledged as P2 | PASS (P2, partial is acceptable) |
| FR-022 | Force refresh Linear issues | Section 4 (IPC: `linear:fetch-issues` with `forceRefresh` param), Section 7 (cache invalidation on force refresh) | PASS -- but no UI refresh button described |

### Non-Functional Requirements

| NFR | Spec Coverage | Status |
|-----|---------------|--------|
| Performance (3s API calls) | Section 7 mentions optimization strategies but no explicit timeout. Implicit in `fetch` behavior. | PASS (acceptable) |
| In-memory cache | Section 7 and Section 9 (cache in LinearProvider) | PASS |
| Security (encrypted storage) | Section 6 (safeStorage, .linear-token, key never leaves main process) | PASS |
| Error messages for auth/network/rate limit | Section 9 error handling table covers all cases from PRD | PASS |
| UI consistency with GitHub integration | Section 10 (same tab pattern, same card layout approach) | PASS |
| SCSS modules styling | Section 8 file inventory confirms SCSS modules throughout | PASS |

---

## 4. Scope Creep Assessment

The spec stays within PRD scope. No features were added that are not in the PRD. Key scope boundary observations:

- Read-only integration: confirmed in Non-Goals (no create/update)
- No OAuth2: confirmed, API key only
- Single team at a time: confirmed
- No time sync back to Linear: confirmed
- No plugin system: confirmed (Non-Goals explicitly rejects it)

The `IssueRef` discriminated union type and generic `issue_provider`/`issue_id` columns are forward-looking design choices, but they directly serve the stated PRD goal of "establishing a multi-provider pattern." This is strategic investment, not scope creep.

**Verdict**: No scope creep detected.

---

## 5. Migration and Backward Compatibility

The spec's backward compatibility plan (Section 12) is comprehensive and directly addresses the concern raised in PRD Review Issue 4:

- **Database**: New columns are additive (ALTER TABLE ADD COLUMN). Existing columns preserved. Legacy sessions continue working via fallback logic.
- **Dual-write strategy**: New GitHub-linked sessions write to both old columns (issue_number) and new columns (issue_provider + issue_id). This ensures no data loss regardless of which code path reads the data.
- **Rollback safety**: Old app versions ignore unknown columns. No data loss on downgrade.
- **Types**: New fields are optional. Existing code continues to compile and function.
- **Token storage**: Parameterized with backward-compatible defaults.

**Verdict**: Excellent. Backward compatibility is thoroughly handled. Existing users will experience zero disruption.

---

## 6. Edge Cases and Error States

| Edge Case | PRD Expectation | Spec Coverage | Status |
|-----------|-----------------|---------------|--------|
| Invalid API key | Clear error message | Section 9: 401 -> "API key is invalid or revoked" | PASS |
| No team selected | Prompt to select team | Section 9: "Please select a team in Settings" (UI-level) | PASS |
| Network failure | "Could not reach Linear" with retry | Section 9: NETWORK_ERROR message. Retry button not explicit in spec. | MINOR GAP |
| Rate limited | "Try again in a few minutes" | Section 9: 429 -> rate limit message | PASS |
| Only one provider configured | Show that provider only | Section 10: "If only one provider configured, show that tab only" | PASS |
| Neither provider configured | Generic setup prompt | Section 10: "Configure an issue tracker in Settings" | PASS |
| User has zero teams | PRD FR-003 edge case (PRD Review Issue 9) | NOT ADDRESSED in spec | MINOR GAP |
| Pre-selected issue from sidebar | PRD User Flow 2 step 2 | Section 8 (TomatoClock pendingIssue -> IssueRef). Implicit. | PASS |
| Legacy sessions display after migration | Must show old GitHub issues | Section 12: fallback from issue_provider to issue_number | PASS |

---

## Issues Found

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 1 | **Minor** | **Search UX unclear.** The spec defines a `SearchIssues` GraphQL query (Section 4) but there is no dedicated IPC channel for search. It is unclear whether search is client-side filtering of cached issues or a server-side query. The PRD FR-010 expects users to type in a search field and see filtered results. The mechanism should be explicit so the UI can be designed accordingly. | Clarify whether search triggers a new GraphQL query (via a `linear:search-issues` IPC channel) or filters the already-fetched issue list client-side. If server-side, add the IPC channel to the channel table. |
| 2 | **Minor** | **Zero teams edge case not addressed.** PRD Review Issue 9 flagged that FR-003 should handle users with no teams. The spec's SettingsPage states do not describe what happens when `linear:list-teams` returns an empty array. | Add to Section 10 (SettingsPage): "If team list is empty, show 'No teams found in your workspace.'" |
| 3 | **Minor** | **Force refresh button not in UI spec.** PRD FR-022 (P2) requests a refresh button. The backend supports `forceRefresh: true` via the IPC channel, but Section 10 does not describe a visible refresh button in the IssuesPage or its placement. | Add a refresh button to the IssuesPage Linear tab description, consistent with any existing refresh pattern on the GitHub tab. |
| 4 | **Minor** | **Retry button on network error not explicit.** PRD error flows specify "with a retry button" for network failures. The spec's error handling table defines the error message but does not mention a retry action in the UI. | Add to Section 10 or Section 9: "Network error state includes a retry button that re-fetches issues." |
| 5 | **Observation** | **Per-tab empty state for unconfigured provider.** When both tabs are visible but one provider is not configured, the spec does not describe what the unconfigured tab shows. This was flagged in PRD Review Issue 8. Since only configured provider tabs are shown (spec: "If only one provider is configured, show that tab only"), this is effectively addressed by hiding unconfigured tabs. Acceptable. | No action needed. The design decision to hide unconfigured tabs resolves this. |
| 6 | **Observation** | **GraphQL errors mapped to NETWORK_ERROR code.** In Section 9, GraphQL errors (200 response with errors array) are mapped to `NETWORK_ERROR` code. This is technically a misnomer since the network succeeded. Minor naming issue with no product impact. | No action needed from PM perspective. Implementation detail. |

---

## PRD Review Issue Resolution Check

The PRD review raised 9 issues. Checking whether the tech spec addressed them:

| PRD Review Issue | Addressed in Spec? | Notes |
|-----------------|-------------------|-------|
| 1. Stale file names | YES | Section 8 has verified file inventory with correct names |
| 2. SCSS modules vs inline styles | YES | Section 8 confirms SCSS modules throughout |
| 3. Type system redesign needed | YES | Section 5 defines new types, IssueRef union, extended Session/SaveSessionInput |
| 4. Backward compatibility | YES | Section 12 is comprehensive |
| 5. Single-provider to multi-provider | YES | Section 2 (provider registry Map replacing singleton) |
| 6. Token storage parameterization | YES | Section 8 (token-storage.ts parameterized by provider name) |
| 7. Pre-selection for Linear issues | YES | Section 8 (TomatoClock pendingIssue type changed to IssueRef) |
| 8. Per-provider empty states | PARTIALLY | Handled by hiding unconfigured tabs (acceptable design) |
| 9. Zero teams edge case | NO | Not addressed (Minor Issue 2 above) |

---

## Verdict

**PASS WITH NOTES**

The tech spec demonstrates strong alignment with the PRD. All 8 P0 requirements are fully covered. The architectural decisions are sound and serve both immediate needs and the longer-term multi-provider strategy. Backward compatibility is handled thoroughly. The spec addressed 8 of 9 issues raised during PRD review.

The four minor issues identified (search mechanism ambiguity, zero-teams edge case, missing refresh button in UI, missing retry button on error) are all low-severity gaps that can be resolved during implementation without requiring a spec revision cycle. None of them represent missing features or architectural oversights.

**The spec is approved to proceed to the next pipeline stage.**