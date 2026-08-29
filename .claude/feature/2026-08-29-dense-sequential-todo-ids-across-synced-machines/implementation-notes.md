# Implementation Notes: Dense Sequential Todo Ids Across Synced Machines

Completed: 2026-08-29T22:00:47+08:00
Plan: `.claude/.Arena/tactical-plans/2026-08-29-dense-sequential-todo-ids-across-synced-machines.md`
Spec delta: `.claude/feature/2026-08-29-dense-sequential-todo-ids-across-synced-machines/spec-delta/todo-sync.md` (pending)

## What was built

Todo ids are dense and sequential (1, 2, 3…) on every machine. The block scheme
(`deviceNumber × 100_000_000 + counter`) that produced ids like `473829100000001` on every machine
except the folder-originating one is gone.

A todo's visible number is now **derived**, not communicated. Each machine publishes only its
*claim* — the number it issued — and every machine independently computes the same final assignment
from the full set of claims. Two machines that have seen the same todos therefore agree without
exchanging a single message about the resolution.

## Two deviations from the approved plan

Both were approved mid-implementation after being surfaced with evidence.

### 1. `defer_foreign_keys` instead of `ON UPDATE CASCADE` (Phase 3 removed)

The plan's Phase 3 called for rebuilding `todos`, `todo_label_links`, and `todo_attachments` with
`ON UPDATE CASCADE`. The mandated probe confirmed cascade works under the sql.js shim — but reading
the schema showed `todos` has ~15 columns accreted across three migrations (`migrateSyncColumns`,
`migrateTodosToStates`, `migrateProjectTextToRows`), so the rebuild would mean dynamically
reproducing an exact column set plus indexes and copying every row **on live user data, on every
existing install**, purely to change one constraint.

`PRAGMA defer_foreign_keys = ON` gives the identical guarantee inside the transaction
`applyOplogEntries` already opens. Phase 3 became one pragma and no migration.
Guarded by `electron/main/sync/__tests__/deferred-fk.test.ts`.

### 2. The plan's collision rule did not converge — replaced with deterministic derivation

**This was a real defect in the approved design, caught by the tests.** The plan asserted:

> Convergence comes from LWW on the `id` field: it does not require both devices to independently
> compute the same replacement number.

That is false. Built as specified, it produced **permanent divergence** — the exact failure the
plan existed to prevent. When machine A evicts B's row it writes `id` with A's fresh clock; when B
evicts the same row it writes with B's. Each machine's own write is always newest in its own frame,
so each permanently rejects the other's. Measured: ten merge passes, ids stable from pass 1, the
two machines never agreeing.

```
A = 7:B-0, 8:B-1, 9:B-2, 10:B-3, 11:B-4
B = 7:B-1, 8:B-2, 9:B-3, 10:B-4, 11:B-0
```

The fix makes the assignment a **pure function of shared data** rather than a negotiation. A new
immutable `todos.claimed_id` column carries the number the creating machine issued;
`reconcileTodoIds` derives every visible id from the complete set of claims (earliest claimant by
`created_at`, uuid tie-break — the same total order `convergeOnName` already uses for FR-010).
No arbitration, so nothing to disagree about. Regression-guarded by
`"agrees after both machines have seen the same todos, and stops moving"`.

An uncontested todo's claim is always free, so it is reassigned its own number on every pass and
never moves — the stability property the user was promised.

## Fail-then-pass evidence

| Check | RED | GREEN |
|---|---|---|
| Dense ids across machines | `expected 544535200000001 to be less than 10000` | 15/15 in `todo-id-sync.test.ts` |
| Watermark advance | `expected 111532900000001 to be greater than 722162200000004` | passing |
| Reassignment notice | `expected 0 to be greater than 0` | passing |
| Convergence over 10 passes | `agree=false` × 10 | agrees by pass 3, then stops changing |
| Renumber migration | (new file) | 6/6 in `renumber-migration.test.ts` |
| MCP stale-write guard | (new tests) | 5 new cases in `pipe-server.test.ts` |
| Deferred FK mechanism | `UPDATE ... throws` without deferral | 4/4 in `deferred-fk.test.ts` |

## Files

**Sync core** — `device-identity.ts` (block arithmetic → `sync.nextTodoId` watermark +
`advanceTodoIdWatermark`; `TODO_ID_BLOCK_STRIDE` → `LEGACY_TODO_ID_BLOCK_STRIDE`, kept only so the
migration can recognize old ids), `merge-engine.ts` (`reconcileTodoIds`, `moveTodoRowId`,
`noticeUserVisibleRenumbering`), `sync-writer.ts`, `migration.ts`
(`renumberBlockAllocatedTodoIds`, `countBlockAllocatedTodos`), `sync-manager.ts`, `sync-ipc.ts`.

**Schema/data** — `database.ts`: `claimed_id` column (idempotent, backfilled from `id`),
`createTodo` sets and publishes it.

**Surfaces** — `pipe-server.ts` (`uuid` in `todo.list`, `expectUuid` guard on writes),
`mcp/lizmeter-todo-mcp.mjs` (remembers listed uuids, replays them on write),
`preload/index.ts`, `shared/types.ts` (`RenumberOutcome`, `todo-id-reassigned` notice kind),
`SettingsPage.tsx` (confirm-gated renumber control), `TodosPage.tsx`.

**Tests** — new: `todo-id-sync.test.ts` (15), `renumber-migration.test.ts` (6),
`deferred-fk.test.ts` (4). Rewritten: `device-identity.test.ts`, and `sync-e2e.test.ts`'s FR-005
case, which asserted the retired "two offline machines never claim the same number" contract that
dense ids deliberately give up.

## Notable implementation details

- **The notice reports only what the user saw.** A row arriving during a pass briefly occupies a
  parking slot before reconciliation places it. Comparing a uuid→id snapshot taken before the pass
  against the state after means that bookkeeping never reaches the user; only a todo that was
  already on screen under a different number is reported.
- **Two-phase moves via negative ids.** Primary-key uniqueness is *not* deferrable, so
  `reconcileTodoIds` moves every affected row to a temporary negative id before placing it,
  making the intermediate state safe regardless of how the permutation is shaped.
- **`TodosPage` derives the open dialog's todo by id** instead of holding the snapshot it opened
  with, so a renumber (or delete) under an open dialog re-points or closes it rather than saving
  against a dead number.
- **Legacy `id` entries still accepted.** A peer on an older build publishes `id`; it is folded
  into that row's `claimed_id` rather than written to the primary key.

## Deliberately not changed

`CURRENT_OPLOG_VERSION` (bumping it would make old builds skip new entries entirely — silent loss,
worse than the disagreement the confirm gate handles), `getOrAssignDeviceNumber` and the device-0
reservation (the device number is still the HLC tie-break and the Settings display), the uuid-keyed
machinery, the adoption path, and `row-codec.ts`'s `id` exclusion.

## Validation

`bun run test` — **1475 passed, 80 files, 0 failures.**
`bun run lint` — **0 errors**, 6 warnings, all pre-existing and in files this work did not touch.

`bun run fmt:check` passes — for the first time. It previously failed on ~123 files with
`Text differed by line endings`, which turned out to be pre-existing CRLF/LF noise unrelated to
this work: `core.autocrlf=true` wrote CRLF into the working tree while dprint defaults to LF, so
the pre-commit hook could never pass and its formatting/lint gate was effectively dead. Fixed by
the `.gitattributes` commit preceding this one, which changed no file contents (git was already
storing LF). Note dprint does not cover `electron/` (per CLAUDE.md), where most of this change
lives.

## Not done

- **No real two-machine run.** Everything is verified through the two-device harness against a real
  temp folder, not two physical machines against a real cloud drive.
- **Mixed-version behaviour is untested.** The confirm gate asks the user to update every machine
  first; a peer left on the old build keeps issuing block ids and would need the migration run
  again afterwards. That path has no automated test.
