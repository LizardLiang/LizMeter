---
status: ready
started: 2026-08-29T21:18:16+08:00
completed: 2026-08-29T21:26:58+08:00
---

# Tactical Plan: Dense Sequential Todo Ids Across Synced Machines

## Request

Plan the implementation of dense sequential todo ids across synced machines in LizMeter (D:/Programing/React/LizMeter).

DECISION ALREADY LOCKED BY THE USER (do not re-litigate — the alternatives were argued and rejected):
Todo ids become densely sequential (1,2,3...) on every machine, allocated from a persisted high-water mark, with bump-on-collision resolved deterministically at merge via the existing HLC order. Existing big ids get a one-time renumber, then the scheme is frozen.

PROBLEM BEING FIXED: once sync is enabled, `createTodo` stops using AUTOINCREMENT and takes an id from `allocateNextTodoId` (electron/main/sync/device-identity.ts:167) = `deviceNumber * 100_000_000 + localCounter`, where deviceNumber is drawn randomly from 1..10,000,000 (drawUnusedDeviceNumber, :148). Only the legacy machine is device 0 and keeps small ids. So the second machine shows ids like #473829100000001, rendered raw as `#{todo.id}` at TodosPage.tsx:274 and TodoPicker.tsx:148.

REJECTED ALTERNATIVES (for context, do not revisit):
- Per-project prefix (LIZ-42) — user retracted it; ids are already the external reference handle in notes and MCP calls
- Lock file with a lease in the shared folder — the cloud-drive transport cannot do atomic exclusive create; it forks the lock into conflicted copies. oplog.ts:4 states each device writes ONLY its own file as the design's entire safety property, and stray-files.ts + its test (stray-files.test.ts:58) exist precisely because conflicted copies are a known, tested failure mode
- Accepting gaps, single-writer, or adding a coordination server — all rejected by the user

VERIFIED CHANGE SURFACE (confirm and refine, these were read from the code this session):
1. Delete `allocateNextTodoId` and `TODO_ID_BLOCK_STRIDE` (device-identity.ts:167, :30). `allocateTodoIdIfSyncEnabled` (sync-writer.ts:54) draws from a persisted `sync.nextTodoId` high-water mark — NOT `MAX(id)+1`, which would let a deleted todo's number be reused and silently reassign a live reference.
2. `id` becomes a mutable synced field. It already flows through the oplog (database.ts:2799). The comment there asserting it is "never reassigned by the receiving device" and the merge-engine special case at merge-engine.ts:415-425 (`explicitId` path into `insertPlaceholderRow`, :422) both need rewriting. New rule: an arriving row claiming an id held by a different uuid loses to the earlier row by HLC; the later one bumps to the local high-water mark.
3. The bump MUST be recorded back to the oplog. If a device bumps locally without recording it, the two machines permanently disagree about that todo's id — silent divergence.
4. Add ON UPDATE CASCADE to the four FKs onto todos.id: todo_label_links.todo_id (database.ts:244), todos.parent_id (:269), todo_attachments.todo_id (:284). SQLite cannot ALTER a constraint, so declare it during the one-time table rebuild the migration already requires; a bump then becomes a single UPDATE.
5. Migration runs on device 0 ONLY — order all todos by created_at with uuid tie-break, assign 1..N, replicate as ordinary oplog id updates. Running the same pass independently on both machines diverges if machine 2 has unsynced todos.

KNOWN RESIDUALS the user has already accepted:
- Deletes still leave gaps (reusing a dead number would repoint a live reference). Already true today under AUTOINCREMENT.
- The migration invalidates any #N already referenced in notes or via the MCP tools.

CONTEXT: second machine already has todos with big ids, so the migration path is required, not optional. Test surface includes electron/main/sync/__tests__/ and the sql.js vitest shim (database tests must pass ":memory:").

## Summary

Replace the block-allocated todo id scheme (`deviceNumber × 100_000_000 + counter`) with a dense per-device high-water mark, and make `todos.id` an ordinary last-write-wins synced field so a collision between two machines resolves through machinery the sync engine already has. A todo whose number is taken by an earlier-created peer row is moved to a fresh number, and that move is published so both machines converge. A confirm-gated Settings migration folds the existing block-allocated ids into the dense run without touching any id the user has already referenced.

Grounding turned up two things the brief did not: the adopting machine starts from a genuinely fresh database (`applyPendingSyncActionAfterInit`, sync-manager.ts:304-316), so there is no pre-existing 1..N id collision to handle on adoption; and only three distinct foreign keys point at `todos.id`, not four — `database.ts:544` is the `ALTER` that adds `parent_id`, the same constraint as `:269`.

## Implementation Plan

### Phase 1 — Allocation

1. `electron/main/sync/device-identity.ts`: delete `TODO_ID_BLOCK_STRIDE` (:30), `allocateNextTodoId` (:167), `initialLocalCounter` (:181), and the `NEXT_LOCAL_COUNTER_KEY` setting (:27). Rewrite the module header (:2-4), which describes the block scheme as the design. **Keep** `getOrAssignDeviceNumber`, `drawUnusedDeviceNumber`, and the device-0 reservation — the device number is still the HLC tie-break (`hlc.ts` `tick`/`receive`) and is surfaced in Settings via `getSyncStatus` (sync-manager.ts:166-170). Only the id arithmetic goes.
2. Add a `sync.nextTodoId` setting and a replacement allocator that returns the stored value and persists `value + 1` **before** returning — preserving the existing crash-safety property (lose at most one number, never reuse one). Seed from `COALESCE(MAX(id), 0) + 1` when unset, which covers both a machine enabling sync over existing data and a machine that has just rebuilt from a peer's snapshot.
3. `sync-writer.ts:54` `allocateTodoIdIfSyncEnabled` keeps its name, signature, and null-when-sync-off contract, so `createTodo` (database.ts:2746) and its two insert branches need no change at all.
4. Add a watermark advance called at the end of `applyOplogEntries` (merge-engine.ts:168, alongside the existing `recomputeLocalPositionFromSyncOrder` calls): raise `sync.nextTodoId` to `max(current, highest todo id seen this pass + 1)`. This is what stops a machine returning from an offline window from walking straight back into its peer's used numbers.

### Phase 2 — `id` as a last-write-wins field

5. `sync-writer.ts:102`: remove `if (field === "id") continue` so `id` gets a `sync_field_clocks` row like every other field. The comment there ("consumed once at insert time, never a real LWW field") asserts the opposite of the new rule and must be rewritten, not just deleted.
6. `merge-engine.ts:498`: remove the matching skip in `applyFieldsLww` and handle `id` as a special column — it is the primary key, so the write path is a collision check plus an `UPDATE`, not a plain `UPDATE`.
7. `merge-engine.ts:313-327` `applyUpsert`: the `explicitId` path becomes "use the incoming id if free, otherwise resolve the collision". Rewrite the comment at :319-321, which states ids are "replicated verbatim … never reassigned".
8. Collision resolution helper: given a desired id and the incoming row's creation clock, if that id is held locally by a **different** uuid, compare clocks — the earlier-created row keeps the number, the later one is allocated a fresh number from the high-water mark, and that move is published with `recordUpsert(database, "todos", loserUuid, { id: newId })`. Convergence comes from LWW on the `id` field: it does not require both devices to independently compute the same replacement number.
9. **PK-update ordering — the highest-risk step.** `foreign_keys = ON` (database.ts:95) plus a taken primary key means a naive `UPDATE todos SET id = ?` throws, and `runMergePassSafely` funnels generic errors into a bare `console.warn` (sync-manager.ts:130) — so a throw here fails *silently, on every pass, forever*. This is the exact shape of R2-B3 (a bare `DELETE` that threw a FK violation and rolled back the whole wipe unnoticed). Vacate the target id before writing it: move the incumbent first, or stage through a temporary out-of-range id inside the same transaction. A test that a collision commits rather than throws is mandatory, not optional.

### Phase 3 — Schema

10. Add `ON UPDATE CASCADE` to the three foreign keys onto `todos.id`: `todos.parent_id` (database.ts:269), `todo_label_links.todo_id` (:244), `todo_attachments.todo_id` (:284). SQLite cannot `ALTER` a constraint, so this is the documented 12-step rebuild (create new table, copy, drop, rename) inside a transaction, with `PRAGMA foreign_keys` handled per SQLite's procedure. Make it idempotent — skip when the constraint is already present — since it runs on every startup path that calls `initDatabase`.

### Phase 4 — Migration

11. `renumberBlockAllocatedTodoIds(database)` (extend `sync/migration.ts` or add a sibling module): select todos with `id >= 100_000_000` ordered by `created_at` with `uuid` as tie-break, assign consecutive numbers starting at `MAX(id below the threshold) + 1`, and publish each as `recordUpsert(..., { id: newId })`. One transaction. Back up first with `backupDbWithSiblings(dbPath, "renumber", "copy")`, matching every other one-way step in this repo. Re-running finds nothing above the threshold and is a no-op.
12. IPC handler plus a Settings control, confirm-gated on the refuse-once-then-proceed pattern already used by `requiresAdoptConfirmation` (sync-manager.ts:235) and `requiresUnsyncedDbConfirmation` (:262). The confirmation text must say to update the other machines first.

### Phase 5 — Notice

13. New `sync_notices` kind for a reassignment; one `addSyncNotice` per merge pass that bumped anything, listing old id → new id per todo. Deliberately **no** `notifyUser` call — unlike the discarded-edit path in `runMergePassSafely` (sync-manager.ts:82-89).

### Phase 6 — MCP

14. `mcp/lizmeter-todo-mcp.mjs`: `todo_list` returns each todo's `uuid` alongside its numeric id; `todo_update` (:243) and `todo_complete` (:316) accept an optional `uuid` and refuse the write when the id/uuid pair no longer matches, with an error telling the caller to re-list. Numeric ids stay the addressing scheme; update both tool descriptions.

### Phase 7 — Renderer

15. `TodosPage.tsx:274` and `TodoPicker.tsx:148` need no display change — they already render `#{todo.id}`. But `MarkdownEditor`'s `todoId` prop (MarkdownEditor.tsx:492, :629) goes stale if a merge reassigns the open todo's id. Verify the existing `onTodosChanged` refresh path (sync-manager.ts:45, :81) re-targets or closes the editor cleanly rather than writing to a dead id.

### What Ares must NOT change

- `getOrAssignDeviceNumber` / `drawUnusedDeviceNumber` / the device-0 reservation — the device number remains the HLC tie-break and the Settings display; it is simply no longer an id block.
- The uuid-keyed machinery — `sync_field_clocks`, `sync_tombstones`, `sync_id_aliases`, and the attachment key `(todo_uuid, sha256)` are all keyed by uuid and are unaffected by an id change. This is why an id change is cheap.
- `CURRENT_OPLOG_VERSION` (oplog.ts:15) — bumping it would make old builds *skip* new entries entirely (silent loss), which is strictly worse than the temporary disagreement the confirm gate already handles.
- `row-codec.ts`'s `id` exclusion in `encodeRowFields` (:86) — `id` is added explicitly by its three call sites (database.ts:2799, migration.ts:83, snapshot.ts:133) and that split stays.
- The adoption path (sync-manager.ts:304-316) — a fresh private database is the reason adoption has no id-collision problem; do not "fix" it.

## Validation

- `bun vitest run electron/main/sync/__tests__/` — `device-identity.test.ts` asserts the block arithmetic and must be rewritten; `sync-e2e.test.ts` asserts verbatim id replication and needs the collision case added.
- New test — two-device concurrent create: both claim the same id, both devices end up agreeing on the outcome, neither todo lost.
- New test — a collision **commits** rather than throwing. This is the guard against the R2-B3-shaped silent rollback; without it the failure mode is invisible.
- New test — referential integrity: reassign a todo's id and assert its parent link, label links, and attachment all still resolve. **Probe `ON UPDATE CASCADE` under the sql.js shim first** — the shim forwards `PRAGMA` (src/test/better-sqlite3-shim.ts:101) so it should hold, but this is assumed rather than verified, and step 10's whole approach depends on it.
- New test — migration: ids below the threshold unchanged, above-threshold ids appended in `created_at` order, second run a no-op.
- New test — high-water advance: after merging entries whose highest id is 73, the next local create is 74.
- New test — snapshot rebuild: `buildSnapshotEntries` stamps every entry with one uniform HLC (snapshot.ts:105), so a rebuild delivers all ids with equal clocks; assert ids survive a rebuild unshuffled.
- `bun run lint` and `bun run fmt:check` (dprint does not cover `electron/` per CLAUDE.md, so formatting there is by hand).
- Manual: two machines against a real shared folder, or extend the `adopt-real-db.test.ts` fixture approach.

## Assumptions

- **The sql.js vitest shim honours `ON UPDATE CASCADE`.** Probe this before building Phase 3. Risk if wrong: the table rebuild is unusable in tests and the cascade must be replaced with explicit `UPDATE` statements across the three referencing tables.
- **The user has two machines, both under their control, both updated before the migration runs.** The confirm gate depends on this assertion rather than detecting peer build versions. Risk if wrong: a straggler old build keeps issuing block ids, and the migration has to be run again after it updates.
- **Historical oplog entries carrying an `id` with no recorded clock are safe to replay.** They take their own entry HLC as the clock. In a snapshot rebuild every entry shares one HLC, so ids arrive with equal clocks and resolution falls to the uuid tie-break. Risk if wrong: a rebuild reshuffles ids — covered by the snapshot-rebuild test above.
- **Deletes leave permanent gaps** — accepted by the user; reusing a dead number would repoint an existing reference.
- **The migration invalidates any reference to a machine-2 id** written before it runs — accepted by the user.

## Spec Delta

Capability: todo-sync · File: `.claude/feature/2026-08-29-dense-sequential-todo-ids-across-synced-machines/spec-delta/todo-sync.md` · Validated: yes (`kratos spec validate` → OK)
Status: **pending** — promote with `/kratos:spec-archive 2026-08-29-dense-sequential-todo-ids-across-synced-machines` after implementation.
Requirements:
- Dense sequential todo id allocation
- Todo id high-water mark advances on merge
- Todo id collision resolution at merge
- Todo id reassignment is published
- Referential integrity across a todo id change
- One-time renumber of block-allocated todo ids
- Todo id reassignment is reported
- MCP writes reject a stale todo id

## Discovery Ledger

| Quadrant | Findings |
|----------|----------|
| Known knowns | 8 branches resolved with named file:line evidence (oplog `id` publication at database.ts:2799 / migration.ts:83 / snapshot.ts:133; collision detection needed because merge-engine.ts:420-424 inserts `explicitId` verbatim; bump write-back required since nothing re-derives it; deviceNumber retained for the HLC tie-break; both skip-guards at sync-writer.ts:102 and merge-engine.ts:498). **Reclassified by the evidence check: 1** — the brief's "four FKs onto todos.id" is three; database.ts:544 is the `ALTER` adding the same `parent_id` constraint as :269. |
| Known unknowns | 20 facets enumerated; 5 asked, 15 resolved from the repo or recorded as assumptions; 0 open. |
| Unknown knowns | **Mine:** (a) assumed both machines get upgraded together → became the migration-trigger question; (b) assumed "dense" meant renumbering everything → became the migration-scope question, asked first, and the user chose the narrower reading; (c) assumed an id change is invisible to the UI → became the MarkdownEditor stale-`todoId` step. **User's:** "serial" had two materially different readings (renumber all vs. preserve device-0 and append) — asked before anything else. **Repo's:** `foreign_keys = ON` (database.ts:95) makes a PK update throw without cascade; `runMergePassSafely` swallows generic errors into `console.warn` (sync-manager.ts:130), so such a throw is silent; dprint/ESLint do not cover `electron/` (CLAUDE.md); the sql.js shim forwards `PRAGMA` (better-sqlite3-shim.ts:101) but its cascade support is unverified. |
| Unknown unknowns | **premortem:** (1) "sync broke permanently — merge throws a PK constraint every pass and rolls back silently" → became Phase 2 step 9 and a mandatory commit-not-throw test; (2) "half my numbers changed overnight" → drove the migration-scope question; (3) "counters seeded independently, machine 2 collided right after the migration" → became the watermark-advance step (Phase 1 step 4) and its test. **inversion:** if "bumps are rare" is false — a machine offline a week creates a *batch* of colliding todos, all bumped at once → drove the bump-notice question, and the notice was specified to list every affected todo rather than a count. **boundary:** zero state (fresh device counter seeding → step 2's `COALESCE(MAX(id),0)+1`), concurrent create (the core case), partial failure (crash mid-migration → single transaction + idempotent re-run), ×10 (a bump cascading into another taken id → resolution loops rather than assuming one hop), clock skew (HLC clamping already raises a `clock-drift` notice and would change who wins a tie — accepted, no branch needed). **actors:** end user (renderer step 15), Claude via MCP (`todo_update`/`todo_complete` take numeric ids at mcp/lizmeter-todo-mcp.mjs:251,320 → became the MCP-race question), the next developer (both skip-guard comments actively assert the old rule → steps 5 and 7 rewrite them rather than deleting them), the widget window (reads through the same IPC, no separate branch), ops/backup (every one-way step here takes `backupDbWithSiblings` first → step 11). **analogous (repo history):** `git log electron/main/sync/` shows the feature shipped in 2 commits followed by 4 rounds of fixes; two are direct precedents — **B-5** (marking an entry applied when its work was skipped makes the skip permanent) constrains how a partially-applied bump is marked, and **R2-B3** (a bare `DELETE` threw a FK violation and rolled back a whole transaction silently) is the same trap an id `UPDATE` re-opens → step 9. **escape:** two gaps no facet had covered — (a) `sync_applied_ops` idempotency versus a bump: re-reading an entry after a bump must not re-bump, so the collision check must compare uuids and no-op when the row already holds the id; (b) `id` has never had a clock (sync-writer.ts:102), so every historical oplog entry carries one with no recorded clock, and snapshot entries all share a single uniform HLC (snapshot.ts:105) → became the third assumption and the snapshot-rebuild test. |

## Locked Decisions

- **Migration scope** — Q: The one-time renumber has two readings of "serial". Device 0's todos already have small ids 1..N (the ones actually referenced); machine 2's are the big ones. What does the migration renumber? → **A: Preserve device-0 ids, append the big ones**
  Machine 1's ids are frozen. Machine 2's big ids are reassigned to continue the run after machine 1's highest id, ordered by `created_at`. Consequence: id order stops matching creation order for the appended batch, and the migration's blast radius is limited to ids that were already unusable.

- **Bump signal** — Q: When a sync bumps one or more of your todos to new numbers, are you told? → **A: Sync notice in Settings, no OS popup**
  Uses the existing `addSyncNotice` path (a new notice kind), listing old id → new id per bumped todo. Deliberately does not call `notifyUser`, unlike the discarded-edit path in `runMergePassSafely`.

- **Migration trigger** — Q: If machine 1 renumbers while machine 2 is still on the old build, machine 2 keeps handing out big ids and ignores the renumber until it updates. How should the migration be triggered? → **A: Explicit action in Settings, with a warning**
  A confirm-gated button that backs up, renumbers, and publishes. Follows the existing `requiresAdoptConfirmation` / `requiresUnsyncedDbConfirmation` refuse-once-then-proceed pattern. No build-version detection needed; the user asserts both machines are updated.

- **MCP race** — Q: Claude gets id 43 from `todo_list`, then calls `todo_update(43)`. If a merge bumped that todo to 74 in between and another todo won 43, the update silently edits the wrong todo. How should the MCP tools handle that? → **A: Keep numeric ids, reject stale writes**
  `todo_list` additionally returns each todo's uuid; `todo_update` / `todo_complete` accept an optional uuid alongside the numeric id and refuse the write when the pair no longer matches, with an error telling the caller to re-list. Numeric ids stay the addressing scheme.

## Decision Tree

```
Task: Dense sequential todo ids across synced machines
├── Allocation on create (sync ON)? → persisted `sync.nextTodoId` high-water mark ✓ [leaf]
│   ├── Seeded from? → COALESCE(MAX(id),0)+1 when unset ✓ [leaf]
│   └── Crash safety? → persist current+1 before returning, as today ✓ [leaf]
├── Allocation when sync is OFF? → unchanged AUTOINCREMENT ✓ [leaf]
│   Evidence: sync-writer.ts:54 returns null when sync is off; createTodo's else-branch already handles it
├── Watermark advance on merge? → raise to max(seen id)+1 at the end of applyOplogEntries ✓ [leaf]
├── Publication of `id` through the oplog? → exists already ✓ [leaf]
│   Evidence: database.ts:2799, migration.ts:83, snapshot.ts:133
├── Collision detection at merge? → required ✓ [leaf]
│   Evidence: merge-engine.ts:420-424 inserts explicitId verbatim; a taken id throws a PK constraint
├── Collision resolution rule? → earlier creation clock keeps the number; loser takes a fresh one ✓ [leaf]
│   └── Must both devices compute the same replacement? → no; LWW on `id` settles it ✓ [leaf]
├── Bump write-back to the oplog? → required, via recordUpsert(todos, loserUuid, {id}) ✓ [leaf]
├── `id` as a real LWW field (remove both skip-guards, give it a clock)? → yes ✓ [leaf]
│   Evidence of the guards: sync-writer.ts:102, merge-engine.ts:498 — comments rewritten, not just deleted
├── PK update mechanics? → ON UPDATE CASCADE + vacate the target id before writing ✓ [leaf]
│   └── Silent-rollback risk? → sync-manager.ts:130 swallows it; commit-not-throw test is mandatory ✓ [leaf]
├── Migration scope — renumber every todo, or only the big ids? → preserve device-0, append the big ones ✓ [leaf]
│   ├── Ordering within the appended batch? → by created_at, uuid tie-break ✓ [leaf]
│   └── Id order ≠ creation order for that batch? → accepted ✓ [leaf]
├── Migration trigger? → explicit confirm-gated Settings action ✓ [leaf]
│   ├── Backup first? → backupDbWithSiblings(dbPath, "renumber", "copy") ✓ [leaf]
│   ├── Crash mid-run / re-run? → one transaction; second run finds nothing above the threshold ✓ [leaf]
│   └── Mixed-version window? → user asserts both machines updated; warning in the confirm ✓ [leaf]
├── Mixed-version risk — old build syncing with new build? → covered by the confirm gate ✓ [leaf]
├── Snapshot / rebuild path consistency? → uniform snapshot HLC → uuid tie-break ✓ [leaf]
│   Covered by an explicit rebuild test; recorded as an assumption
├── Adoption path — counter seeding on a freshly-rebuilt device? → same MAX(id)+1 seed, after hydration ✓ [leaf]
│   Evidence: sync-manager.ts:304-316 — adoption starts from a fresh private db, so no 1..N collision exists
├── UI when an id changes under the user? → display unchanged; verify MarkdownEditor's todoId re-targets ✓ [leaf]
├── MCP staleness? → todo_list returns uuid; writes refuse a mismatched id/uuid pair ✓ [leaf]
├── User-visible signal when a bump happens? → sync notice in Settings, no OS popup ✓ [leaf]
│   └── Batch renumber after a long offline window? → one entry per todo in the same notice ✓ [leaf]
├── Block machinery removal? → keep deviceNumber (HLC tie-break + Settings), delete only the arithmetic ✓ [leaf]
├── sql.js shim honours ON UPDATE CASCADE? → [assumed: yes — probe before Phase 3]
│   Risk if wrong: cascade replaced by explicit UPDATEs across three tables; table rebuild wasted
├── Historical entries carry `id` with no clock? → [assumed: safe — entry HLC becomes the clock]
│   Risk if wrong: a rebuild reshuffles ids; covered by the snapshot-rebuild test
├── Deletes still leave gaps? → [assumed: accepted residual]
└── Validation approach? → 7 new tests + existing suites, listed under Validation ✓ [leaf]
```

## Clarity

Target 0.95 · Approach 0.90 · Validation 0.90 → ambiguity 0.08 (PLAN_READY at ≤ 0.10) · Facets: 26 covered / 26 total, 0 open · Sweep: run — 9 facets surfaced (3 premortem, 1 inversion, 2 boundary, 1 actor, 2 escape)

## Handoff To Ares

Use this plan as the execution contract. If implementation uncovers a major mismatch, stop and report the mismatch before changing direction.

Two steps carry disproportionate risk and should be built first, in this order: **Phase 3's cascade probe** (the whole schema approach depends on it holding under the sql.js shim) and **Phase 2 step 9** (a PK collision that throws fails silently forever, per sync-manager.ts:130 — the commit-not-throw test is the only thing that would catch it).
