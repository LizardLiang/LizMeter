# Technical Specification Review (SA)

## Document Info
| Field | Value |
|-------|-------|
| **Reviewed** | tech-spec.md |
| **Reviewer** | Apollo (SA Agent) |
| **Date** | 2026-02-23 |
| **Verdict** | PASS WITH NOTES |

---

## Review Summary

The technical specification is well-structured, thorough, and demonstrates strong understanding of the existing codebase. The key architectural decisions (raw fetch over SDK, generic issue columns, discriminated union types, provider registry) are all sound and well-justified. The spec correctly identifies every file that needs modification, provides concrete implementation details, and has a solid backward compatibility strategy.

There are no critical or blocking issues. Several minor-to-moderate concerns are documented below, primarily around interface consistency, a missing search method in the provider class, and a type design that could be cleaner for future extensibility.

---

## Architecture Analysis

### Design Appropriateness
- **Rating**: Good
- **Assessment**: The design correctly evolves from a single-provider singleton to a multi-provider registry without over-engineering. The decision to NOT force Linear into the existing `IssueProvider` interface is pragmatic -- Linear's team-scoped, GraphQL-based model differs enough from GitHub's repo-scoped REST model that a shared interface would be awkward. However, this means two completely parallel code paths with no shared abstraction. For 2 providers this is acceptable. For 3+ providers, a refactor toward a common interface would become necessary.

### Scalability
- **Rating**: Good
- **Assessment**: The generic `issue_provider` + `issue_id` database columns scale to future providers without schema changes. The provider registry Map scales naturally. The main scalability concern is the renderer -- adding a third provider would require tabs/UI updates in multiple components.

### Reliability
- **Rating**: Good
- **Assessment**: Error handling is comprehensive with well-defined error codes and user-facing messages. The idempotent migration strategy is safe. The dual-write strategy for GitHub sessions ensures no data path is broken during the transition.

---

## Security Review

| Severity | Issue | Recommendation |
|----------|-------|----------------|
| Low | Linear API keys have full workspace access (no scope restriction) | Document in Settings UI help text. Recommend dedicated API key for LizMeter. |

### Security Strengths
- API key encrypted at rest via `safeStorage` (OS keychain)
- API key never crosses the IPC boundary to the renderer
- `shell:open-external` validates URL scheme (https/http only)
- Read-only access pattern limits blast radius

---

## Issues Summary

### Critical (Must Fix)
None.

### Major (Should Fix)
1. **Missing `searchIssues` method in `LinearProvider`**: The spec defines a `SearchIssues` GraphQL query but the `LinearProvider` class has no `searchIssues()` method and no `linear:search-issues` IPC channel. Either add server-side search or explicitly document client-side filtering.

2. **`IssueProviderStatus` type is not scalable**: Flat `linearConfigured`/`linearTeamSelected` fields won't scale. Use per-provider status endpoints (already designed via `linear:provider-status`) instead.

### Minor (Consider)
1. GraphQL errors mapped to `NETWORK_ERROR` code — should have dedicated `QUERY_ERROR` code
2. `LinearProvider` does not implement `IssueProvider` interface — no compile-time contract enforcement
3. `IssueRef` union uses different ID field names (`number` vs `identifier`) — document mapping
4. No `issueProvider` validation in `saveSession()` — should whitelist like `validateTimerType()`
5. Team auto-selection for single-team workspaces not specified in UI section

---

## Recommendations

| Priority | Recommendation |
|----------|---------------|
| High | Clarify search: client-side or server-side, align spec accordingly |
| High | Redesign `IssueProviderStatus` or remove in favor of per-provider endpoints |
| Medium | Add `issueProvider` validation in `saveSession()` |
| Medium | Add `QUERY_ERROR` code to `IssueProviderError` |
| Low | Document `IssueRef` field name asymmetry |
| Low | Specify auto-select for single-team workspaces |

---

## Verdict

**PASS WITH NOTES**

The architecture is technically sound. Core design (provider registry, database schema, type system, IPC design, backward compatibility) is solid. The 3 "should fix" items can be addressed during implementation.

- [x] Approved for next stage
- [ ] Requires revisions before proceeding