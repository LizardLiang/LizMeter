# PRD Review

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | prd.md v1.0 — Issue Tracker Integration |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-22 |
| **Verdict** | APPROVED WITH NOTES |

---

## Review Summary

The PRD is well-structured and appropriately scoped for a Phase 1 GitHub integration. The decision to use PAT-based authentication with `safeStorage` encryption is sound — it avoids OAuth complexity while keeping credentials secure. The `IssueProvider` abstraction layer is a smart forward-looking design choice that incurs minimal overhead now. Requirements are clearly prioritized, acceptance criteria are testable, and out-of-scope boundaries are explicit.

**Ready to proceed to Stage 3: Tech Spec** with the notes below incorporated.

---

## Section-by-Section Analysis

### Problem Statement
**Pass.** The pain points are concrete and specific to the developer persona. The three personas (solo dev, team dev) are credible. Traceability gap is clearly articulated.

### Goals & Success Metrics
**Pass with Notes.** Metrics are measurable. "40% of sessions linked" is ambitious but appropriate as a target. Note: success metrics assume a single user installation with a configured token — the denominator should be clarified as "sessions created by users who have configured a GitHub token", not all sessions.

### Requirements — P0
**Pass.** Six P0 requirements form a coherent MVP. Acceptance criteria are specific and testable. Good call explicitly stating "token NEVER reaches renderer process" in FR-001's AC.

### Requirements — P1
**Pass.** FR-010 through FR-013 are the right P1 scope. Token removal (FR-013) is critical and appropriately included.

### Non-Functional Requirements
**Pass.** Security constraints are comprehensive. Performance targets (3s fetch, 200ms picker) are realistic. Graceful degradation table is thorough.

### User Flows
**Pass.** Four flows cover the core user journeys. Error flows are practical. The "token revoked" error flow is a good catch that many PRDs miss.

### Dependencies & Risks
**Pass.** The schema migration risk is the most important and is well-handled (ALTER TABLE ADD COLUMN is SQLite-safe). safeStorage Linux fallback risk is noted.

### Architecture Notes
**Pass.** The IPC channel definitions and session table changes are clearly specified. This section gives Hephaestus exactly what he needs.

---

## Issues Found

| Severity | Area | Issue | Recommendation |
|----------|------|-------|----------------|
| Minor | FR-003 — Issues Page | The requirement says "assigned to the authenticated user" but GitHub's `GET /issues` endpoint returns issues assigned to the user across ALL repos they have access to. This may be too broad for users with access to hundreds of repositories. | Add a note in FR-003 and FR-011 that the initial fetch is scoped to issues where `assignee=me` + optionally filtered by configured repo list (FR-011 repo filter). Make the repo filter default to "all" but recommend users configure specific repos. |
| Minor | FR-006 — Session Linking | The requirement states that the issue reference is saved when "a session completes." It should clarify whether this also applies when a session is manually reset/abandoned (i.e., is the issue reference only saved on session completion, or also on manual save if supported?). | Add AC: "If the timer is reset without completing, the linked issue selection is cleared and NOT saved. Issue linkage is only persisted on session completion." |
| Minor | Open Questions | Three open questions remain unresolved (repo scope, auto-refresh, issue title auto-fill). These should be resolved before Hephaestus begins the tech spec to avoid blocking him mid-stream. | Resolve as: (1) repos limited to user-configured list (default: all assigned issues); (2) manual refresh only for MVP; (3) selecting an issue auto-fills the session title as opt-in default (user can override). |
| Minor | FR-003 + FR-005 | Neither requirement specifies what happens when the issue list is empty (user has no assigned open issues). The Issues page empty state is defined (FR-008 covers no-token state) but not the "token configured, no issues" state. | Add AC to FR-003: "If the authenticated user has no assigned open issues matching the current filters, display an empty state: 'No open issues assigned to you. Visit GitHub to check your assignments.'" |
| Nit | Architecture Notes — IPC | `issues:fetch` should be `issues:list` for consistency with existing channel naming convention (`session:list`, `session:save`). | Rename to `issues:list` in the IPC channel table. Low impact but good to establish consistency before the tech spec locks the names. |

---

## Completeness Check for Tech Spec Handoff

| Area | Covered? | Notes |
|------|----------|-------|
| Data model requirements | ✅ Yes | 5 nullable columns on sessions table well-specified |
| IPC channel changes | ✅ Yes | 5 new channels defined; existing `session:save` needs `issue_*` fields added |
| Navigation changes | ✅ Yes | New `"issues"` page state in App.tsx; NavSidebar entry |
| Security architecture | ✅ Yes | safeStorage, main-process-only API calls, token isolation |
| Migration strategy | ✅ Yes | ADD COLUMN (non-destructive, nullable) |
| Performance constraints | ✅ Yes | 3s fetch, 200ms picker |
| Provider abstraction | ✅ Yes | IssueProvider interface with 3 methods defined |
| Error states | ✅ Yes | Network error, rate limit, invalid token, revoked token |
| Graceful degradation | ✅ Yes | No-token state, API-failure state |
| Out-of-scope boundaries | ✅ Yes | Linear, OAuth, posting to GitHub all explicitly excluded |

---

## Verdict

**APPROVED WITH NOTES**

The PRD is ready to move to Stage 3: Tech Spec. All five issues are minor; none are blocking. Hephaestus should:

1. Resolve the three open questions as recommended above before writing the spec
2. Define the empty-state for "token configured but no issues" as part of the Issues page spec
3. Use `issues:list` instead of `issues:fetch` for IPC channel naming consistency
4. Scope `GET /issues` calls to `assignee=me` + optionally filtered repo list
5. Clarify in the session save spec that issue linkage is only persisted on session completion, not on reset/abandon