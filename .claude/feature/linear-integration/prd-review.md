# PRD Review

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | prd.md v1.0 |
| **Reviewer** | Athena (PM Agent) |
| **Date** | 2026-02-23 |
| **Verdict** | APPROVED WITH NOTES |

---

## Review Summary

The PRD is well-structured, covers the core user needs, and correctly identifies the major differences between GitHub and Linear APIs. The requirements are clearly prioritized and the user flows are reasonable. However, several assumptions about the current codebase are incorrect -- the research document that informed this PRD contains stale file names and outdated architectural claims. These inaccuracies do not invalidate the product requirements themselves, but they must be corrected so that Hephaestus can create an accurate tech spec. Additionally, the PRD underestimates the scope of changes needed to the existing type system and provider architecture, which has implications for effort estimation and risk assessment.

---

## Section Analysis

### 1. Executive Summary
- **Status**: Pass
- **Comments**: Clear, concise, and well-scoped. Correctly positions this as extending an existing pattern.

### 2. Problem Statement
- **Status**: Pass
- **Comments**: Problem is real and well-articulated. The two personas (Linear-only user and multi-tool user) are the right ones to focus on.

### 3. Goals and Success Metrics
- **Status**: Pass
- **Comments**: Metrics are pragmatic for a v1 feature. The "any non-zero adoption" target for Linear session linking is honest and appropriate. The multi-provider pattern goal is strategically sound.

### 4. Requirements
- **Status**: Needs Work (Minor)
- **Comments**: See Issues Found below. The core requirements are solid but there are gaps around data model changes and backward compatibility that need to be acknowledged at the product level, even if the solutions are technical decisions for Hephaestus.

### 5. User Flows
- **Status**: Pass
- **Comments**: The three primary flows (configure, link, browse) cover the main use cases well. Error flows are reasonable. One gap noted below regarding the save dialog flow.

### 6. Dependencies and Risks
- **Status**: Needs Work (Minor)
- **Comments**: Several risks are underestimated and one critical dependency is missing. See Issues Found.

### 7. Open Questions
- **Status**: Pass
- **Comments**: Good set of open questions. The PRD correctly delegates technical decisions (SDK vs raw fetch, column strategy) to Hephaestus.

### 8. External API Dependencies
- **Status**: Pass
- **Comments**: The Linear API comparison table is excellent and gives Hephaestus exactly what is needed. Rate limit documentation is accurate (1,500 req/hour).

---

## Issues Found

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 1 | **Major** | PRD references file names that do not exist in the codebase. It mentions `IssuesSidebar.tsx`, `IssueSelector.tsx`, `SettingsPanel.tsx`, and `CompletionActions.tsx`. The actual files are `IssuesPage.tsx`, `SettingsPage.tsx` (in `src/renderer/src/components/`). There is no `IssueSelector` or `CompletionActions` component. The Metis research document that informed this PRD contains the same stale names. | Update the PRD's Dependencies section (Section 6) to reference the correct file names: `IssuesPage.tsx`, `SettingsPage.tsx`. Remove references to components that do not exist. Hephaestus should verify the full component inventory before starting the tech spec. |
| 2 | **Major** | The PRD states all styling uses "inline React.CSSProperties" (NFR section and research doc). The actual codebase has migrated to **SCSS modules** (e.g., `IssuesPage.module.scss`, `SettingsPage.module.scss`). The CLAUDE.md still says inline styles, but the code does not match. | Update NFR "Consistency" to say styling must follow the current pattern (SCSS modules with Tokyo Night theme), not inline styles. Hephaestus needs accurate styling guidance. |
| 3 | **Major** | The existing `Issue` type in `types.ts` is GitHub-shaped: `number: number` (integer), `repo: string`, `state: "open" \| "closed"`. Linear issues have string identifiers (`LIN-42`), no repo concept, and workflow states (Backlog, Todo, In Progress, Done, Cancelled) instead of open/closed. The PRD acknowledges this difference in Section 8 but does not explicitly call out that **the shared `Issue` type must be redesigned or a parallel `LinearIssue` type created**. This is a significant cross-cutting change. | Add a requirement or explicit note in Section 4 (Non-Functional Requirements) or Section 6 (Dependencies) stating: "The existing shared type system (`Issue`, `SaveSessionInput`, `Session`) is GitHub-specific and must be extended to accommodate Linear's data model. This is a prerequisite for all other requirements." |
| 4 | **Major** | The existing `SaveSessionInput` and `Session` types use `issueNumber: number` to store the linked issue reference. Linear issues use string identifiers. The PRD mentions this in Open Questions ("generic `issue_provider` + `issue_id` or separate `linear_issue_id`?") but does not flag it as a **backward compatibility concern**. Existing sessions with GitHub issue numbers must continue to work after the schema migration. | Add an explicit non-functional requirement: "Backward compatibility -- existing sessions with GitHub issue references must remain intact and displayable after any schema changes." |
| 5 | **Minor** | The existing provider architecture is a **single-provider singleton** (`issue-providers/index.ts` holds one `currentProvider`). The PRD assumes both providers can be active simultaneously (FR-007, FR-008 require switching between them in the sidebar and selector). This is architecturally feasible but the PRD should acknowledge that the current architecture supports only one provider at a time. | Add to Dependencies (Section 6, Internal): "The current provider manager (`issue-providers/index.ts`) supports only a single active provider. Must be extended to support multiple concurrent providers." |
| 6 | **Minor** | The existing token storage is hardcoded to a single file (`.github-token`). Linear will need its own token storage. The PRD's NFR says "stored in the same secure manner as the GitHub token" which is correct intent, but the current implementation is not parameterized for multiple providers. | No PRD change needed -- this is a technical detail for Hephaestus. The NFR wording is sufficient. |
| 7 | **Minor** | FR-005 (link Linear issue to session) describes the save dialog flow but does not mention what happens when the user has **pre-selected an issue from the sidebar** before the timer completes. The GitHub integration has a `selectedIssue` state in the main orchestrator component. The PRD should clarify whether the pre-selection mechanism applies to Linear issues too. | Add to FR-005 acceptance criteria or User Flow 2: "If the user pre-selected a Linear issue from the sidebar before the timer started, that issue should be pre-populated in the save dialog's issue selector." |
| 8 | **Minor** | The PRD does not specify what happens when a user has **only Linear configured** (no GitHub). The current `IssueProviderStatus` type returns `provider: "github" \| null`. The Issues page shows "No GitHub token configured" as its empty state. The PRD should specify the empty/unconfigured states for each provider independently. | Add to User Flows (Error Flows): "When only Linear is configured, the Issues page should show Linear issues by default. The GitHub tab should show a prompt to configure GitHub. Vice versa when only GitHub is configured." |
| 9 | **Minor** | FR-003 (team selection) does not specify when team selection happens relative to token save. The user flow (Section 5, Flow 1) shows teams being fetched immediately after test connection. What if the API key is valid but team fetch fails? What if the user has zero teams? | Add edge cases to FR-003 acceptance criteria: "If the user has no teams, show 'No teams found in your workspace.' If team fetch fails after successful authentication, show the error and allow retry." |
| 10 | **Observation** | The PRD's Out of Scope section is well-defined and appropriately conservative for v1. The decision to use personal API keys only (no OAuth2) is pragmatic given this is a desktop app. | No change needed. Good scoping decision. |

---

## Codebase Reality Check

The following table corrects the assumptions from the Metis research document that informed this PRD:

| PRD/Research Assumption | Actual Codebase State |
|------------------------|----------------------|
| `IssuesSidebar.tsx` component | Does not exist. The component is `IssuesPage.tsx` at `src/renderer/src/components/` |
| `IssueSelector.tsx` component | Does not exist in the codebase |
| `CompletionActions.tsx` component | Does not exist in the codebase |
| `SettingsPanel.tsx` component | Does not exist. It is `SettingsPage.tsx` at `src/renderer/src/components/` |
| Components at `src/renderer/components/` | Actual path is `src/renderer/src/components/` |
| Inline `React.CSSProperties` styling | Codebase uses SCSS modules (`.module.scss` files) |
| `TomatoClock.tsx` orchestrates state | Needs verification -- file not found at expected path |
| `HistoryPage.tsx` displays issues | Needs verification -- file not found at expected path |
| `github.ts` at `electron/main/` | Actual file is `electron/main/issue-providers/github-provider.ts` |

Hephaestus MUST perform a fresh file inventory before starting the tech spec. The research document's file mapping is unreliable.

---

## Verdict

**APPROVED WITH NOTES**

The PRD is fundamentally sound. The product requirements, user personas, success metrics, and scope are all well-defined and appropriate for a v1 Linear integration. The feature fills a real gap and the multi-provider pattern is strategically valuable.

However, the PRD contains several factual inaccuracies about the current codebase (wrong file names, wrong styling approach) inherited from the research phase. These do not affect the WHAT and WHY of the product requirements, but they will mislead Hephaestus during tech spec creation if left uncorrected.

**Recommended actions before tech spec begins:**
1. Correct the file name references in Sections 5 and 6 (Issues 1, 2)
2. Add the backward compatibility NFR (Issue 4)
3. Add the type system dependency note (Issue 3)
4. Clarify the single-provider-only vs multi-provider sidebar interaction (Issues 5, 8)

These are documentation fixes, not requirement changes. The PRD is approved to proceed to tech spec with the understanding that Hephaestus will reference the actual codebase, not the stale file names in this document.