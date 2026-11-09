# Known Debt / Deferred Items

## sql.js test shim: `Statement.run()` doesn't return `{ changes, lastInsertRowid }`

**Where:** `src/test/better-sqlite3-shim.ts`

**Issue:** `better-sqlite3`'s `Statement.run()` returns `{ changes, lastInsertRowid }`. The
Vitest shim's `run()` returns `this` (the `Statement` instance) instead, so any
production code that reads `result.changes` or `result.lastInsertRowid` gets
`undefined` under tests (not a thrown error — `undefined` silently flows through).

**Known affected call sites** (`electron/main/database.ts`):
- `createPlaylist()` — `result.lastInsertRowid` used as the new playlist id.
- `addTrackToPlaylist()` — `result.lastInsertRowid` used as the new entry id.
- Several `result.changes === 0` not-found checks (e.g. `updateTag`, `deletePlaylist`,
  `renamePlaylist`, `reorderPlaylistTrack`) silently never throw under tests, since
  `undefined === 0` is `false`.

**Workaround used in `electron/main/__tests__/music-library.test.ts`:** look the
created playlist's id up via `listPlaylists()` (a plain `SELECT`, unaffected) instead
of trusting `createPlaylist()`'s returned `id`.

**Fix (deferred, not in scope for this change):** extend the shim's `Statement.run()`
to return `{ changes: this._db.getRowsModified(), lastInsertRowid: ... }` — sql.js
exposes `db.getRowsModified()`; `lastInsertRowid` can be read via
`SELECT last_insert_rowid()`. Would let the affected call sites (and their
not-found-error paths) be tested directly instead of worked around.

## Green tests hide schema-order bugs: `foreign_keys = ON` plus a fresh-device test fixture

**Where:** `electron/main/sync/snapshot.ts:314-323` (`rebuildFromSnapshot`'s `wipe()`),
`electron/main/sync/__tests__/snapshot.test.ts`

**Issue:** `wipe()` deletes `todo_states` before `todos`, and `todos.state_id` has no `ON DELETE`
action while `foreign_keys = ON`. Every rebuild on a device that has todos raises
`FOREIGN KEY constraint failed`, so FR-019's stale-machine rebuild has never worked. All 9 tests in
`snapshot.test.ts` pass because the device that rebuilds is always the *fresh* one: device A creates
the todos, device B has seeded states and zero todos, so nothing references the rows being deleted.
Two full review rounds read this code without catching it.

**Pattern to watch:** any test that exercises a destructive or migration path against a device,
account, or tenant that has no data proves only that the path runs on empty state. `foreign_keys =
ON` (`database.ts:95`) means delete *order* is load-bearing across the whole schema, and delete
order is invisible to a reader — it only shows up when real rows exist.

**Fix (not applied — belongs to the feature's fix round):** reassign or null `todos.state_id` before
deleting `todo_states`, mirroring `deleteTodoState` and `merge-engine.ts:217-227`; or order the wipe
child-first while keeping the apply parent-first; or `PRAGMA defer_foreign_keys = ON` inside the
transaction. Add a rebuild test against a device that has todos. Take the `.pre-rebuild-*.bak`
backup in the same change — fixing the foreign key alone converts a silent no-op into live data
loss.

## `sync_devices` never learns about peers

**Where:** `electron/main/sync/device-identity.ts:148-160`, `:190-204`;
`electron/main/sync/sync-manager.ts:122-141`; `electron/main/sync/merge-pass.ts:22`

**Issue:** `registerDevice` has exactly two production call sites (`migration.ts:66`,
`sync-manager.ts:251`) and both pass `getDeviceId()`. Nothing anywhere inserts a peer. Three
consequences follow from that one omission:

1. `drawUnusedDeviceNumber`'s `taken` set is empty at every real call, so the `while` loop guarding
   against a device-number collision is unreachable, not merely weak.
2. The doc comments at `device-identity.ts:122` and `:153` describe that guard as real, and `:153`
   also says "a 4-billion-wide draw" when `RANDOM_DEVICE_NUMBER_MAX` is `10_000_000`.
3. `getSyncStatus` reads the same table, so the Settings "Machines" list
   (`SettingsPage.tsx:1383-1391`) always renders exactly one entry — this machine — and never names
   the peer, even after successfully merging its oplog. FR-030 requires "a list of participating
   machines".

**Fix (deferred):** have `runMergePass` call `registerDevice` for each peer oplog file it reads. It
already extracts `deviceId` at `merge-pass.ts:22`, and `hlc.deviceNumber` is on every entry it
applies. One change closes the FR-030 gap and makes both comments true.

## Cloud-drive directory listings are used as an atomic claim

**Where:** `electron/main/sync/device-identity.ts:101-105, :140`;
`electron/main/sync/sync-manager.ts:169-174`

**Issue:** both "should this be an adopt or an enable" and "may this device take block 0" are decided
by `readdirSync` on a folder whose contents a cloud client populates asynchronously. Two machines set
up in the same sitting, or a folder the user hand-creates on the second machine via the folder
picker's `createDirectory` option (`ipc-handlers.ts:658`), can both read the folder as virgin and both
take block 0. Their todo ids then overlap, `merge-engine.ts:422` inserts an explicit id with no
conflict clause, and every merge pass thereafter aborts on the primary-key violation — silently, via
`sync-manager.ts:99`.

**Pattern to watch:** a check-then-act over a cloud-synced folder is not a lock. Any "am I first"
decision in this feature needs a durable claim written into the folder itself, and ideally
reconciliation on a later pass, because no cross-machine atomic primitive exists over OneDrive.

**Fix (deferred):** create this device's own empty `<deviceId>.oplog.jsonl` in the same step as the
draw, deciding from the pre-creation observation. Note `isVirginSyncFolder` does *not* exclude this
device's own file while `targetHasOtherDevicesData` does, so a naive check-then-create inverts the
result and denies block 0 to the originating machine, breaking FR-016.

## `todo_attachments` reuses a merge key that delete-wins treats as permanent

**Where:** `electron/main/sync/oplog.ts:67` (`attachmentRowKey`);
`electron/main/sync/merge-engine.ts:595-603` (`applyAttachmentUpsert`);
`electron/main/sync/sync-writer.ts:76-122` (`recordUpsert` / `recordDelete`)

**Issue:** every other synced table keys on a uuid that is never reissued, so
`isTombstoned`'s unconditional existence check is a safe implementation of delete-wins. Attachments
key on `${todoUuid}:${sha256}` — content-derived and therefore **reusable**. `recordDelete` writes a
tombstone under that key and nothing ever clears it, so detaching a file and re-attaching the same
bytes to the same todo leaves a live row *and* a live tombstone. Any peer merging that sequence
discards the re-add and raises a `discard-after-delete` notice implying a peer deleted the file.
Commit `7552825` made `buildSnapshotEntries` emit attachment upserts, which is correct and closes a
much larger silent loss — but it also gives this pre-existing flaw a second trigger surface, the
stale-machine rebuild.

**Pattern to watch:** delete-wins is only sound where the key is single-use. Any future synced table
keyed on content, a natural key, or anything else a user can recreate needs an HLC comparison
against the tombstone rather than an existence test.

**Fix (deferred):** either clear the matching `sync_tombstones` row inside `recordUpsert` when the
key is recreated, or make `applyAttachmentUpsert` compare the upsert's HLC against the tombstone's.
The second is the smaller change and matches how the rest of the merge engine resolves conflicts.

## The startup and data-move choreography breaks on every edit, in the same three files

**Where:** `electron/main/index.ts` (`app.whenReady()`), `electron/main/ipc-handlers.ts`
(`data-location:move`), `src/renderer/src/components/SettingsPage.tsx` (the confirmation ternary)

**Issue:** four consecutive review rounds have found new defects concentrated in these three files,
each time introduced by the fix for the previous round's finding in the same file. Round 4's H4-W2 is
the sharpest case: the commit that fixed the first half of H3-W2 reproduced its second half —
an unguarded `fs.writeFileSync` at the top of a catch block — twelve lines above the original, which
is still open. These three files hold the feature's entire irreversible-action decision sequence and
have **no test coverage at any layer**. `SettingsPage.tsx` has no test file at all, though 27 sibling
components have one and the project's `vi.stubGlobal("electronAPI")` pattern is exactly what it
needs.

**Pattern to watch:** when successive fix rounds keep landing new defects in the same untested file,
the finding is the absence of the test harness, not the individual defects.

**Fix (deferred):** extract the adopt/enable/move decision sequence into a pure function over
explicit inputs, then add `SettingsPage.test.tsx`. Round 3's H3-W3 (the two-dialog deadlock) would
have been caught mechanically by either.

## sql.js test shim tolerates bind values that crash real better-sqlite3 (JS booleans) -- FIXED 2026-09-14

**Resolution:** both deferred fixes landed together (commit `209e8ce`). (1) `row-codec.ts` now
exports `toBindValue()`, coercing `true`/`false` to `1`/`0`; `merge-engine.ts`'s `applyFieldsLww`
generic branch, `applySessionUpsert`'s equivalent branch, and the `todos.claimed_id` site all call
it before binding. `database.ts`'s `createTodoState`/`updateTodoState` also now publish `0`/`1`
instead of raw booleans (producer-side hygiene; the consumer fix is what actually unblocks
already-written entries, since those cannot be retroactively rewritten). (2) The shim's
`Statement.run`/`get`/`all` now reject any bind parameter that is not
`string | number | bigint | Uint8Array | null`, throwing the same
`TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null` real
better-sqlite3 throws. Regression coverage: `electron/main/sync/__tests__/row-codec.test.ts`
(pure `toBindValue` unit test), `merge-engine-bind-coercion.test.ts` (captures the actual bound
parameter via a `database.prepare` spy, independent of the shim), and
`merge-boolean-field-e2e.test.ts` (two-device harness; meaningful now that the shim is hardened --
confirmed by reverting the fix and observing this exact test throw the exact production
`TypeError` before restoring it). Full suite (1591 tests) passed unchanged after the shim
hardening -- no other call site in the codebase binds a raw boolean.

**Original issue, preserved for context:**

**Where:** `src/test/better-sqlite3-shim.ts` (`Statement.run`/`get`/`all`, all delegate to sql.js's
own `bind()`); triggering call sites `electron/main/sync/merge-engine.ts:721` (`applyFieldsLww`'s
generic column branch) and `:770` (`applySessionUpsert`'s equivalent branch).

**Issue:** `applyFieldsLww` and `applySessionUpsert` bind an oplog field's `change.value` straight
into `UPDATE ${table} SET ${fieldName} = ? WHERE id = ?` with no type coercion, for any field that
isn't one of `row-codec.ts`'s three declared foreign keys. `OplogFieldValue` (`oplog.ts:29`)
explicitly types `boolean` as a legal field value, and `createTodoState`
(`electron/main/database.ts:1944`) does write raw JS booleans (`is_completed: false, is_default:
false`) into the oplog. Real `better-sqlite3` refuses to bind a JS boolean at all —
`TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null` — thrown
synchronously from the native binding layer, not a SQLite-level error. The sql.js shim's `bind()`
call swallows this silently (coerces or ignores), so every sync test in this codebase that exercises
a boolean-valued oplog field passes green while the same code throws in the real Electron app. This
is exactly how the 2026-09-14 stuck-merge-pass bug shipped undetected: `applyOplogEntries` wraps the
whole pass in one `database.transaction()`, so the boolean bind throw rolled back all 58 pending
entries, `runMergePassSafely` (`sync-manager.ts:130`) funneled the `TypeError` into a bare
`console.warn`, and it retried identically, silently, every 30 seconds.

**Pattern to watch:** the shim is a WASM build of real SQLite, so it gets *query semantics* right
(this project's own `deferred-fk.test.ts` proves `defer_foreign_keys` works correctly under it) —
but it is not a faithful stand-in for `better-sqlite3`'s own JS-to-native binding layer, which is
stricter than SQLite itself about parameter types (rejects raw booleans, `undefined`, plain objects,
etc.). Any oplog/merge code path that binds a value's *type* without normalizing it first is
untested for that failure mode, no matter how thorough the surrounding sync test suite looks.

**Fix (deferred):** two independent fixes, both real. (1) Coerce booleans (and ideally reject/coerce
any non-bindable type) to `0`/`1` before the `UPDATE` in `applyFieldsLww`'s generic branch and
`applySessionUpsert`'s equivalent branch — the actual bug fix. (2) Make the shim binding-strict to
match `better-sqlite3`: have `Statement.run`/`get`/`all` throw the same
`TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null` for any parameter
that isn't `string | number | bigint | Buffer/Uint8Array | null`, so a future field of an unbindable
type fails the test suite instead of shipping silently. Add a regression test with a boolean-valued
oplog field through `runMergePass`, once (1) and (2) both land.

## Todo-linked session features: two live-lookup consumers, one only indirectly tested

**Where:** `src/renderer/src/hooks/useTodoLiveInfo.ts`; consumers
`src/renderer/src/components/IssueBadge.tsx` and `src/renderer/src/components/IssueGroupHeader.tsx`;
`src/renderer/src/components/TodosPage.tsx`'s `highlightTodoId` scroll/flash effect.

**Issue:** the 2026-08-31 timer-link-to-todos-item feature added `useTodoLiveInfo` (live-joins a
Todo-linked badge/group to the Todo's current title, snapshot fallback on lookup failure) and used
it from both `IssueBadge.tsx` and `IssueGroupHeader.tsx`. Only `IssueBadge.test.tsx` exercises it
directly (live title override, snapshot fallback, click-to-navigate). `IssueGroupHeader.test.tsx`'s
10 pre-existing tests still pass unchanged because none of its fixtures use `provider:"todo"` --
they exercise the hook's early-exit path, not the live-lookup path. Similarly, `TodosPage.tsx`'s
`highlightTodoId`/`onHighlightConsumed` props (scroll-into-view, expand a collapsed state group,
brief flash animation) have no dedicated test; `TodosPage.test.tsx`'s 69 tests all pass because none
of them pass `highlightTodoId`.

**Pattern to watch:** a shared hook consumed from two components is only as tested as its
least-tested consumer. A future change to `useTodoLiveInfo` (e.g. batching the fetch, changing the
fallback rule) could silently break `IssueGroupHeader`'s rendering while `IssueBadge.test.tsx` stays
green.

**Fix (deferred, not required by the tactical plan's test list):** add a `provider:"todo"` fixture
case to `IssueGroupHeader.test.tsx` (live title override + snapshot fallback, mirroring
`IssueBadge.test.tsx`), and a `TodosPage.test.tsx` case that renders with `highlightTodoId` set and
asserts the target row scrolls into view / gets the `rowFlashed` class / its state group expands if
collapsed.

## Native port, phase 1 (2026-11-09)

- **Color emoji lacks COLRv1 gradients.** The vendored gpui draws Segoe UI Emoji through
  `TranslateColorGlyphRun(DWRITE_GLYPH_IMAGE_FORMATS_COLR)`, which returns the flat COLRv0 layers. Chromium shows the
  shaded COLRv1 art (`native/tools/emoji.html` vs `--page emojisample`). `IDWritePaintReader` is present in the
  `windows` 0.58 crate that gpui uses, so the paint tree can be read; a software painter for gradients, transforms and
  glyph clips is not written. `crates/app/assets/icons/tomato.png` stays baked until it exists.
- **Inline `code` runs use the surrounding font size.** gpui's `shape_text` takes one font size per line, so the
  `0.85em` size and the bordered chip of `.ProseMirror code` are not drawn; only the monospace family, color and
  background are.
- **Rich input scroll.** The 120 px max-height surface scrolls with the wheel; the caret is kept in view by a
  best-effort offset adjustment and has no automated test.
- **Pasted multi-paragraph `<li>` shapes** (two `<p>` in one `<li>`) parse into separate list items. TipTap's own
  typing never creates them.

## Native port, phase 2 (2026-11-09)

- **Inline `code` size and chip.** Still one font size per line in gpui: inline code is drawn at the line size (Chromium: 0.92em with padded chip). Fence lines use 0.92 for the whole line.
- **Fenced code highlighting is a generic tokenizer** (comments, strings, numbers, keywords, types, properties), not the per-language parsers CodeMirror loads. Colours differ for some languages.
- **Bare URL autolinks** cover `http(s)://` and `www.`; GFM `mailto:` and bare e-mail addresses are not marked.
- **Wrapped list items** lose the hanging indent: the first row is shifted left by 1.4em for the bullet and continuation rows shift with it.
- **Notes cap counts chars**, TS counts UTF-16 units; images load from files only (http and `app-media:` need the Phase 5 resolver via `set_image_resolver`); uppercase of h5/h6 has no letter-spacing.
- Table and image widgets keep the line's side padding; Electron draws tables flush with the framed card edge.

## Native port, phase 3 (2026-11-09)

- **Legacy project-text migration skips padded spellings.** `migrateProjectTextToRows` (TS) and `migrate_project_text_to_rows` (Rust) match `project = ? COLLATE NOCASE` with the trimmed name, so a legacy row spelled `"  LizMeter  "` is not repointed when another spelling creates the project. Kept identical for parity; the migration ran long ago on real data.
- **No `user_version`.** Schema equality (`native/crates/db/tests/schema_equality.rs`) relies on `schema.sql` being a byte copy of the `db.exec` text in `database.ts`: `sqlite_master` stores that text, comments included. Any schema edit must land in both files and regenerate `tests/fixtures/electron-schema.json` (`node native/tools/schema-dump/dump.mjs ...`).
- **Sync hook is a seam, not the engine.** `lizmeter_db::SyncHook` has only the no-op `NoSync` until Phase 4 ports `sync-writer.ts`. `Database::set_sync_hook` installs the real one. A device with sync enabled must not run on `NoSync` (ids and oplog would diverge).
- **UTF-16 limits.** Title, notes and label caps use `js_len`/`js_truncate` (UTF-16 units, as in JS). Truncating inside a surrogate pair drops the whole pair; JS keeps a lone surrogate.
- **Attachment URL resolver** (`resolveAttachmentPath`, traversal guard) is not ported yet: Phase 5 with the `app-media` scheme.
- **Numbers the typed API narrows.** `SaveSessionInput` durations are `i64`; the TS accepted any JS number (a float planned duration would have been stored as REAL). Fractional input now fails at deserialisation.
- **Schema dump tool runs under node, not bun.** `native/tools/schema-dump/dump.mjs` bundles with esbuild and runs the real better-sqlite3 (the repo copy is built for Electron's ABI; the bundled run resolves another copy). Same approach as `scripts/verify-real-better-sqlite3.mjs`.
- **Unknown `source` on todo create** (`"robot"`) fails deserialisation; TS fell back to `"user"`. The pipe layer (Phase 10) must map unknown values to `user` before building `CreateTodoInput`.
- **`Database::open` refuses a `sync.enabled` database** until the Phase 4 sync hook is passed to `open_with_sync`; opening a synced dev DB natively before then fails by design.

## Native port, phase 4 (2026-11-09)

- **Snapshot rebuild loses a todo's parent link when the parent has a higher id than the child.** Found by `native/tools/sync-equivalence/run.mjs` (mixed run, fresh-device adopt). `buildSnapshotEntries` emits todos in row order; `rebuildFromSnapshot`/adopt applies them in one pass; a child's `parent_uuid` entry is applied before its parent exists, stays unmarked (B-5), and nothing re-reads a snapshot, so the link is dropped. Ids move during merges, so a child can sit below its parent. The TS engine and the Rust port behave the same (the harness proves it), so parity holds; the fix (emit parents first, or re-apply deferred snapshot entries) must land in both engines. Not fixed in phase 4: Electron code stays untouched until cutover.
- **Tombstone clocks differ between two devices that delete the same row.** A merged delete uses `INSERT OR REPLACE`, so each device ends up holding the other's tombstone HLC. Harmless today (`isTombstoned` ignores the clock; snapshots embed it). Same in both engines.
- **`collectAttachmentBlobs` is a no-op during a merge.** TS guards on `isSyncEnabled`; a merge only runs with sync on. The Rust merge engine therefore never deletes blobs. Accepted local disk growth while sync is on (TS debt B-3, unchanged).
- **Rust drops entries TS would crash on.** An upsert or delete naming a link table, a link entry naming a row table (kept as a no-op in TS), or a missing `rowUuid`/`fields` counts as a skipped line in Rust (notice `oplog-entry-skipped`). TS passes the plausibility gate and throws later, which halts every merge pass (`merge-failed`). Peers never write such lines; the difference only matters for a hand-edited oplog.
- **Harness needs a Node-ABI better-sqlite3 in `<OS temp>/node_modules`.** Same prerequisite as `scripts/verify-real-better-sqlite3.mjs`; the repo copy targets Electron.
