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
- **Schema dump tool runs under node, not bun.** `native/tools/schema-dump/dump.mjs` bundles with esbuild and runs the real better-sqlite3 (the repo copy is built for Electron's ABI; the bundled run resolves another copy).
- **Unknown `source` on todo create** (`"robot"`) fails deserialisation; TS fell back to `"user"`. The pipe layer (Phase 10) must map unknown values to `user` before building `CreateTodoInput`.
- **`Database::open` refuses a `sync.enabled` database** until the Phase 4 sync hook is passed to `open_with_sync`; opening a synced dev DB natively before then fails by design.

## Native port, phase 4 (2026-11-09)

- **FIXED 2026-11-09 — Snapshot rebuild lost a todo's parent link when the parent had a higher id.** Fixed in both engines: master a218415 + f4f17d9 (Electron 1.14.2), native branch 421de3f + fc89a2a (cherry-picks) + eeb4ff2 (Rust mirror); harness fixture `snapshot-order` matches.
- **Retry raises a spurious discard-after-delete notice** when a todo upsert deferred on a missing parent is followed by a delete of that todo in the same batch. Cosmetic (extra notice, no data loss); same in TS and Rust; a fix must land in both engines plus a harness fixture.
- **Superseded-link filter keys on raw uuids, not aliases.** If two uuids alias to one label and the pair is linked then unlinked under different uuids, the older link could replay. Rare; same in TS and Rust.
- **Tombstone clocks differ between two devices that delete the same row.** A merged delete uses `INSERT OR REPLACE`, so each device ends up holding the other's tombstone HLC. Harmless today (`isTombstoned` ignores the clock; snapshots embed it). Same in both engines.
- **`collectAttachmentBlobs` is a no-op during a merge.** TS guards on `isSyncEnabled`; a merge only runs with sync on. The Rust merge engine therefore never deletes blobs. Accepted local disk growth while sync is on (TS debt B-3, unchanged).
- **Rust drops entries TS would crash on.** An upsert or delete naming a link table, a link entry naming a row table (kept as a no-op in TS), or a missing `rowUuid`/`fields` counts as a skipped line in Rust (notice `oplog-entry-skipped`). TS passes the plausibility gate and throws later, which halts every merge pass (`merge-failed`). Peers never write such lines; the difference only matters for a hand-edited oplog.
- **Harness needs a Node-ABI better-sqlite3 in `<OS temp>/node_modules`.** The repo copy targets Electron.
- **Reach-check findings carried over from TS (parity, not fixed in phase 4):** stale device with no snapshot skips the oplog merge; `rebuild_from_snapshot` wipe and replay are separate transactions, so a failed replay leaves a wiped DB and each retry backs up the wiped DB; adopt raises the "offline for 90 days" notice; a peer renaming a row onto another row's name (`UNIQUE` NOCASE) fails every merge pass (`merge-failed`); an entry that can never apply (link to a deleted todo) is retried every pass and re-triggers the UI refresh; snapshot/oplog temp files (`*.tmp-<pid>-<ms>`) in the shared folder can raise a stray-file notice on a peer; `lastSnapshotAt` in the future suppresses snapshots. Fix in both engines together.

## Native port, phase 6a (2026-11-09)

- **Issue linking is todos only.** The native "Link issue" button and the stopwatch Start prompt list the app's todos with a search box and state chips. The Linear/Jira/GitHub tabs and the project and label chips of `TodoIssuePicker` come with phases 7 and 8. A fuzzy match here is a plain subsequence score, not `fuzzyMatch.ts`.
- **Claude Code linking** (was not wired on the Timer page): done in phase 6c, see below.
- **History "Log Work" / "Retry" pills** open the confirm dialog and, since phase 8, log through Jira (see the phase 8 notes).
- **Stopwatch settings are not persisted** (as in Electron): 8 h maximum, prompt for issue on. Settings (phase 6b) writes them to `Root.sw_settings`; they reset on restart like Electron's.
- **Date labels were en-US.** Fixed in phase 6b: `locale.rs` reads the Windows user locale.

## Native port, phase 6b (2026-11-09)

- **Settings: issue-tracker, widget avatar and music controls are inert.** GitHub, Linear and Jira forms render and validate empty input, then report that saving arrives with the provider port (phase 8). Widget enable, visibility and reset-position write the `widget_*` settings keys (the widget itself is phase 11); the avatar slots and the music cache controls (limit, usage, clear, yt-dlp version) do nothing until phases 9 and 11.
- **Data-folder move and sync controls were not exercised against real folders** (session rule). The move runs on a background task, then `PageEvent::Relaunch` starts a new process through `cmd` after a 2 s ping delay and quits. Check this once on a scratch data folder before cutover.
- **Date format is a reshaped Windows pattern, not ICU.** `locale.rs` takes the long-date and time patterns of the user locale and drops weekday, seconds and (for same-year dates) the year. Locales whose ICU short-month shape differs from that rule (for example some `de`/`ru` forms) can read differently from Electron.
- **Fonts:** DirectWrite returns the regular face of JhengHei UI and Arial for weight 600; the vendored gpui maps 600..700 to bold for those two families (`direct_write.rs`), as Chromium does. Other families keep the requested weight.
- **Stats 7d/14d/30d chart animation** grows a bar only when the same day (or tag) bar exists in both ranges, as the CSS height transition does on a keyed element.
- **Settings number inputs** accept digits only (the browser also accepts `e`, `+`, `-`, `.`); the stopwatch hours field accepts digits and one decimal point.

## Native port, phase 6c (2026-11-09)

- **No scan on timer start from `claude_tracker.project_dir_name`.** Electron's `TomatoClock` scans that project when the timer starts and opens the session picker. Nothing in Electron writes the setting (no Settings control), so the native timer links a session only through the select. The picker panel itself is ported: it opens from "Manage Sessions" and from "Add" on the new-session notice.
- **Linking a session scans on the UI thread.** `claude_scan(project)` and `claude_track_selected` run synchronously when a row is picked (Electron awaits them over IPC). The all-projects scan behind the open list runs on a background task. Measure the project scan on a large `~/.claude` before cutover.
- **A failed save drops the tracked Claude Code numbers.** The tracker is stopped before the save, as in Electron; a retry after a database error saves the session without them.
- **gpui `truncate()` shows no ellipsis in flex-resolved widths.** The text measure caches the untruncated line from the first pass, so Activity file names and the select label clip without the "…" Chromium draws. Fixed-width cases (the stopwatch issue badge) do show it.
- **Claude page paragraphs take their height from a fixed 584 px column** (`TEXT_W`): gpui measures wrapped text before the flex width is known. A window narrower than the page's 640 px max wraps one line more than the box reserves.
- **Long-date weekday is inferred.** `locale::with_weekday` adds the weekday to a Windows long-date pattern that lacks one (front for day-first locales, back for year-first ones such as zh-TW); a locale that glues the weekday on (ja: `2026年1月10日月曜日`) gets a space.

## Native port, phase 7a (2026-11-09)

- **No `todo:changed` push in the native services.** Electron refreshes the list when the MCP server or sync writes a todo. The native Todos page reloads when it is shown and after each of its own writes. Wire a change signal when the pipe server (phase 10) and the merge pass notify.
- **Collapsed groups persist in the `settings` table** under `ui.todos.collapsedStates` (Electron keeps them in `localStorage`). The table is not synced, so the choice stays per machine, as before.
- **Row hover tooltips are not ported** (notes summary on the row body, the priority, source and sub-issue titles). Electron sets them as `title` attributes.
- **gpui breaks lines only at spaces.** Chromium also breaks "sub-issue" at the hyphen, so one line of the shortcuts sheet wraps one word earlier in Electron.
- **A `margin-left: auto` flex child collapses the band's gaps in this gpui.** The group band uses a `flex_1` spacer instead of `ml_auto`.
- **`use gpui::*` brings `gpui::test` into scope.** A `#[cfg(test)]` module that does `use super::*` then recurses at `#[test]`: import the tested items by name.
- **Window-size and DPI for the Todos shot** match Electron within a frame offset of about 9 physical px (native window border); every measured row, band and menu metric lands within 1-2 physical px.

## Native port, phase 7b (2026-11-10)

- **gpui cannot defer a draw inside a deferred one** (`cannot call defer_draw during deferred drawing`, a panic). The todo dialogs live in `todo_widgets::window_layer`, an `anchored` layer that is not deferred, so the dropdown lists inside them (`SelectBox`, `Combobox`, `DatePicker`) can stay deferred. Never wrap a dialog that holds a dropdown in `deferred(...)`. The detail page's overflow menu and its backdrop are siblings, not nested, for the same reason.
- **gpui allows one `.hover(...)` per element.** A second call panics (`hover style already set`); choose the hover style before building the element (the selected calendar day does).
- **No `todo:changed` push reaches the detail page.** It reloads after its own writes and when opened. A title or notes field that holds an unsaved edit, or has focus, keeps its draft over an outside write; the page adopts the outside value on the next reload once the field is idle. Wire a change signal with the pipe server (phase 10) and the merge pass.
- **Title field multi-line paste.** A paste with line breaks collapses them to spaces and puts the caret at the end. Enter in the title is detected as "one typed line break" and moves focus to the notes, as Electron does; a one-character paste of a lone line break looks the same.
- **Combobox: a click on the field while the list is open closes the list** (the list closes on any mouse-down outside it). Electron keeps it open. Typing opens it again.
- **Calendar and weekday names are English** (`DatePicker` month label and S M T W T F S). Electron localises both. The date shown on the trigger uses the system pattern.
- **Radio buttons of the state manager are drawn, not native.** Electron shows Chromium's accent radio; the drawn one matches it at 13 px within a pixel.
- **No Tab-order walk.** The detail page and the dialogs take the mouse and the keys the controls handle themselves; Tab does not move between the form fields yet.
- **TodoIssuePicker is the todo section of `modal.rs`.** It now carries the project and label chips of `TodoIssuePicker.tsx`. The dialog is still the fixed 480 px box; the todo list shrinks when the chips wrap. The Timer's issue dropdown is not a separate native component yet (part 7C).

## Native port, phase 7c (2026-11-10)

- **Electron's list drag changes a todo's state; it does not order rows.** Dropping a row (or the selection it belongs to) on a group sets that group's state (`todosToMove`), so no per-todo lexorank is written. The lexorank positions belong to the state and project lists, which Electron reorders with buttons in the Manage dialog (no dnd there either). `a_reorder_stores_the_lexorank_keys_the_ts_code_generates_in_list_order` (sync_e2e.rs) asserts `sync_order` of a reordered list equals `generateOrderedKeys(3)` from `lexorank.ts` (`i`, `r`, `v`) and that a second device converges on the order.
- **No auto-scroll while dragging.** dnd-kit scrolls the list when the pointer nears an edge; the native list scrolls only with the wheel (which works mid-drag).
- **Empty-group drop strip is 38 px**, estimated from the `.emptyDrop` CSS (10 px padding plus one line); not measured in Electron (no empty group in the scratch data).
- **Drag threshold is gpui's 2 px**, dnd-kit's is 5 px.
- **Issue providers (phase 8).** `Services` has the calls the pages use (`issue_provider_status`, `github_issues`, `linear_issues`, `jira_issues`, `*_comments`, `linear_provider_status`, `jira_provider_status`, `worklog_log`) as a seam: no token exists, so the status reports nothing configured and every fetch fails with the deferred-channel text. Phase 8 replaces the bodies. The Issues page card, tab, loading, error, empty and comment states were compared with the SCSS and screenshotted from capture-hook fixtures (`MOCKED-UI`); Electron could not show them without a provider (contextBridge objects cannot be stubbed from the page).
- **Link issue popover shows the Todo tab only.** `IssuePickerDropdown`'s provider tabs, search box and external lists wait for phase 8 (the cards and filters exist in `issues_logic.rs`). Row titles show no ellipsis in the popover (gpui `truncate()` in a flex width, same as before).
- **Worklog dialog date-time fields are typed text** (`YYYY-MM-DD HH:MM`), not Chromium's segmented `datetime-local` with calendar icon. The confirm result goes to `Services::worklog_log`, which fails until phase 8; History shows the error text where Electron shows its toast (no toast component yet).
- **Capture screenshots**: PrintWindow returned black frames for a while in this session (display idle). `--screenshot` (gpui's own capture) worked and is what the phase 7c shots use.

## Native port, phase 8 (2026-11-10)

- **Token storage is DPAPI files, not Credential Manager.** `<userData>/native-tokens/<provider>.dpapi` (CryptProtectData with app entropy). Chosen because the files stay in the profile folder (never in the movable data folder), a scratch or soak folder carries its own tokens, tests run without touching the machine credential store, and there is no 2.5 KB blob cap. `migration.json` beside them records `migrated`, `failed` (a reason with no token text) or `done` (the user saved or removed the token natively, so the Electron file is never read again).
- **Electron token files are left in place.** The native app reads `.github-token`, `.linear-token`, `.jira-token` and `Local State` once and never writes or deletes them, so a rollback to Electron finds its tokens. Tokens saved natively afterwards do not reach Electron.
- **Migration is verified against real Electron output** (`tests/electron_migration.rs`, `#[ignore]`: needs a profile written by Electron for this Windows user; the sealed key cannot be committed). Run with `LIZMETER_TEST_ELECTRON_PROFILE`. The unit tests build the same `v10` format with a throwaway key.
- **Provider base URLs** can be overridden only in debug builds (`LIZMETER_GITHUB_API_URL`, `LIZMETER_LINEAR_API_URL`, `LIZMETER_JIRA_BASE_URL`); a release build ignores them. `Services::set_provider_endpoints` is the test seam.
- **Error texts are cleaner than Electron's.** Electron shows `Error invoking remote method '...': IssueProviderError: <text>` in Settings; native shows `<text>`. The History toast mapping (`failure_message`) is the same as Electron's.
- **GitHub requests copy Octokit's**, found by running Electron against the mock: `GET /user/issues` for the assigned list, `token <pat>` auth. One page only (per_page 100), as in Electron.
- **The 7C MOCKED-UI notes are now live**: Issues page (three tabs), issue prompt tracker rows, Link issue popover tabs and search, Settings token rows (saved, test OK, test failed, needs re-entry) and the History worklog toast (success and error) run against a local mock. Compared with Electron (its main-process `fetch` redirected to the mock with a `--require` patch): the Issues card put the repo chip above the title and the tab row was 3 px tall; both fixed. Remaining differences: the card number/state row is 1-2 px higher, the `✓` in the Connected line is the thin glyph (Electron falls back to a bold one) with a space before `· Core`, Settings inputs sit 2 px lower.
- **Not compared with Electron**: the Link issue popover tabs (the Electron popover did not open under CDP in this run) and the worklog success toast (Electron had no Jira credentials left by then). Native captures are in the scratchpad.
- **No live provider call was made.** A read-only smoke against real GitHub, Linear and Jira, and a real worklog, wait for the user's approval.
- **Reqwest blocking runs on gpui background threads**, 30 s timeout per call, no cancel. Leaving a page while a call runs lets it finish and drops the result.

## Native port, phase 9a (2026-11-10)

- **ffmpeg checksum: the Electron build cannot install ffmpeg on a fresh machine.** `binary-manager.ts` asks for `<archive>.sha256`; the real FFmpeg-Builds release has no such file, only `checksums.sha256` (verified: 404 on the archive URL, the manifest lists `ffmpeg-master-latest-win64-gpl.zip`). Electron therefore fails closed with `CHECKSUM_UNAVAILABLE` on a clean install (existing installs already hold ffmpeg). The native port tries `<archive>.sha256` first and falls back to the release `checksums.sha256`; still fail closed, a wrong digest is `HASH_MISMATCH`. The plan's note "soft-fail" is wrong: both builds fail closed. Fix `binary-manager.ts` the same way if Electron stays in use.
- **The ffmpeg real-download path was proven for yt-dlp only.** The one allowed download installed yt-dlp (SHA2-256SUMS checked, `--version` 2026.10.26) and then failed on the ffmpeg checksum URL above, before the fix. The fixed ffmpeg path is covered by a local-server test and by the real manifest saved at `crates/music/tests/fixtures/ffmpeg-builds-checksums.sha256`; a second 200 MB download was not made. Run `LIZMETER_TEST_USERDATA=<scratch> cargo test -p lizmeter-music --test real_download -- --ignored --nocapture` once to close it.
- **Playlist tracks are not protected from cache eviction** (neither TS nor native). The comment in `cache-manager.ts` says they are; `getEvictionCandidates` only excludes the ids passed in. Ported as is.
- **The decode probe does not catch a file cut off behind an intact header.** On this ffmpeg (N-125858) `-ss <end-5> -i cut.m4a -t 1 -f null` exits 0 with empty stderr when the data simply ends. It does catch damaged bytes. Same command in TS, same blind spot. The stall detector of the TS context (`CACHE_STALL_*`) that covered "stops halfway" in the browser has no native counterpart: playback of a short file ends and advances.
- **ffmpeg start-up costs 1-2 s on this machine** (`ffmpeg -version` takes 0.7-1.2 s, a 1 s decode 2 s: the 145 MB gpl build). Every play of a cached file, every seek and every speed change starts a fresh ffmpeg, so each has that gap. In-process decoding of the cached M4A (symphonia) would make seeks instant; the plan fixed ffmpeg, so it stays.
- **Playback speed and seek on a streaming track wait for the cache.** ffmpeg decodes the pipe once; `atempo` and `-ss` need a restart, which needs the finished file. `Transport::mark_seekable` applies a pending speed change when the cache completes. Electron could not seek a streaming track either (no Range support).
- **`removeTrackFromQueue` of the playing track advances from index -1** (first remaining item plays), as in `MusicPlayerContext.tsx`; the item after the removed one would be the natural choice. Ported as is, with a test.
- **Deliberate differences from the TS music code:** (1) a yt-dlp M4A failure after bytes went out is an error on the stream, not an Opus stream appended to the half M4A; (2) when the user switches track while the finished stream is being probed, the cache file is deleted (TS left an orphan file); (3) `reorder` with an out-of-range index does nothing (TS moved the playing index anyway); (4) enqueue on an empty queue with shuffle on builds a shuffle order (TS left shuffle silently off); (5) after a playlist import with shuffle on, the order covers the whole queue (TS set `[0]`); (6) the queue and player live in the service, so `library_delete` also removes the track from the queue.
- **No `music:stream:cached`/`playlist:imported`/media-key push channels.** They are `MusicEvent` values on `MusicService::set_listener`; position is read with `snapshot()` on the UI tick. `music:play` over `dispatch` returns `{ track, fromCache }` without `streamUrl`.
- **Media keys** (`music:media-key`) are not wired: the global shortcut registration is the host's (phase 5) and the music bar is phase 9B.
- **Real yt-dlp extraction was not run** (needs YouTube): metadata, playlist and audio extraction are tested against a fake yt-dlp that prints the documented output. Smoke it once with a URL of your choice before cutover.

## Native port, phase 9b (2026-11-10)

- **Cached tracks decode in-process.** `crates/music/src/native.rs` (symphonia, AAC in MP4) with `dsp.rs` (windowed-sinc resampler, WSOLA tempo 0.5-2.0 that keeps the pitch). Measured with `--do music-latency:<file>` on a 8 s AAC file, debug build, ms from the call to the first frame the device takes: play 270-507 -> 26-120, seek 240-280 -> 9-20, speed change 290 -> 9-20, seek at 1.5x 270 -> 10-20. A library `play()` (`--do music-library-play`) needs the binary check and the device open done first: the app does both in `MusicService::warm_up` at start; after that play reaches the device in 50-70 ms. The play-time integrity probe also reads the file in-process (`ProbeFile`), so a cached play no longer pays for two ffmpeg starts.
- **ffmpeg still decodes** a file symphonia cannot open (Opus saved under the `.m4a` name, a cut-off file whose header is not whole), a speed outside 0.5-2.0, and every stream that is still arriving. Those keep the 0.25-0.5 s start-up. A stream that finishes caching switches to the in-process path at the next seek, speed change or play, not while it plays (no seam to hide).
- **WSOLA, not a phase vocoder.** Speech and music at 0.5-2.0x sound clean in tests (pitch within 8 Hz of the source on a sine, no click above 0.03 per sample); heavy percussion at 2x can smear a transient. ffmpeg's `atempo` is the same family (WSOLA), so the sound is comparable, not identical.
- **Cut-off cache files are still a blind spot.** symphonia cannot open an MP4 whose audio is cut off (the `moov` sits after the audio), so it goes to ffmpeg, whose `-ss` decode probe exits 0 on a file that simply ends (9A note). The Health Check scan still uses ffmpeg only.
- **The data-folder-move guard now covers the music database** (`DbHandle::guarded`): every music call fails with "LizMeter is restarting to use the new data folder" while `Services::retired` is set, as the other services do (`music_writes_stop_with_the_other_services_once_the_data_folder_moved`).
- **Music UI is a port of `components/music/*`, with these differences:** track and queue rows never show a thumbnail image (Electron loads the YouTube thumbnail over the network; native shows the note glyph, no image loader exists yet); row titles in flex widths clip without "..." (the gpui `truncate()` limit noted in 6c), the bar title is a fixed 148 px and does show it; the queue and playlist drag draws a blue drop line instead of dnd-kit's row shifting and has no keyboard sensor; the library has no IntersectionObserver, a canvas at the end of the list asks for the next page when it enters the window; no Tab-order walk; the autoRepairNotice toast is not ported (nothing in the native service raises it).
- **Fonts.** The music CSS gives buttons no `font-family`, so Chromium draws their text in Arial; track rows, chips, tabs, menus and dialog buttons use `BTN_FONT` for the same reason, and text outside buttons uses the UI font. Line heights for Arial text are `round(size * 1.15)` (Chromium's `normal`).
- **Real-window captures in a debug build panic on any dialog** (`delta should always be between 0 and 1`: gpui's `debug_assert` rejects the `overshoot` easing of `modal_overlay`). Release builds and the frozen `--screenshot` path do not. Use the release binary for dialog captures.
- **Media keys** (play/pause, next, previous) are registered by `music_hub::start_media_keys` for a live window only (not `--screenshot`, `--do`, the widget). A key another app already holds is reported on stderr and skipped, as in Electron.
- **The consent dialog asked GitHub for the release sizes** during the Electron reference capture (22.5 MB and 192.8 MB shown); `--proxy-server` did not stop Electron's main-process fetch. No extraction request and no download was made. The native captures point both release URLs at a closed port.

## Native port, phase 10 (2026-11-10)

- **The pipe server is `crates/services/src/pipe.rs` (+ `pipe/server.rs`).** Same default path `\\.\pipe\lizmeter`, `LIZMETER_PIPE_PATH` override, both protocols, 262 144-character buffer limit counted in UTF-16 units, the limit reply `{"id":null,"ok":false,"error":"Message exceeds the 262144-character limit"}` followed by a clean close, the same error texts. Every command runs inside `Services::with_db`: the UI's write path, so the sync hook records it and the data-folder-move guard (`retired`) refuses it with "LizMeter is restarting to use the new data folder". A command is atomic under the database lock (Electron relied on one thread).
- **Proven equal to Electron:** `native/tools/pipe-equivalence/` sends a 179-step script to the real `pipe-server.ts` (node, real better-sqlite3) and to the native server: every reply line identical after masking timestamps and uuids. The MCP server (unchanged) gave identical text for 47 tool calls against both.
- **An owned pipe path is refused, never taken.** The first instance uses `FILE_FLAG_FIRST_PIPE_INSTANCE`, as libuv does. Native logs `[pipe] Server error: listen EADDRINUSE: address already in use <path>` and the app carries on without a pipe, as Electron logs `[pipe] Server error: Error: listen EADDRINUSE ...` and carries on. Checked both ways round (native on a Node-owned path, Node on a native-owned path): the first owner kept answering.
- **The pipe starts for a live window only** (not `--screenshot`, `--do`, the widget), like the media keys. A debug or release run without `LIZMETER_PIPE_PATH` binds the production path: never start it while the installed app runs unless you mean to test the refusal.
- **No `-dev` suffix.** Electron adds `-dev` under `VITE_DEV_SERVER_URL`; native has no dev server, so a native debug build uses the production path. Windows only (no unix socket).
- **Pending instances: 4**, like libuv. A burst of more than 4 simultaneous clients can see `ERROR_PIPE_BUSY` for a moment; Node clients (the MCP server) wait and retry, a raw client must too.
- **`todo:changed` is a poll.** The pipe bumps a counter after each write; the main window checks it every 250 ms and reloads the Todos page and an open detail page (a field with a draft keeps it). Screens that only show todos in passing (timer todo badges, pickers) refresh when next shown. Sync merges do not bump the counter yet.
- **Unknown `source` on create** (the phase 4 note): the pipe always sends `ai`, so it never reaches the deserialiser.
- **Small differences from the TS server, none visible to the MCP server:** (1) a UTF-8 character split across two reads is decoded whole (Node decodes each chunk alone and turns the halves into U+FFFD); (2) a non-string `agent` is refused before the title is validated (TS: after); (3) a `todoId` of 1e300 is treated as not an integer (TS: an integer, then a database error).

## Native port, phase 11B (2026-11-10)

- **Closed:** the "gpui `truncate()` shows no ellipsis in flex-resolved widths" gap (6c, 9b). The vendored `elements/text.rs` measure cache returned the first (untruncated) layout for any later width; it now also compares the truncation width. Todos titles, Activity file names, select labels and popover rows show the ellipsis.
- **Closed:** the row hover tooltips of the Todos list (7a): notes summary, priority, source, sub-issue crumb and count, and the `?` button, through `chrome::titled`. **Still open:** `title=` attributes elsewhere (detail page, attachments, state manager flags, music bar). The helper applies unchanged.
- **Closed:** queue and playlist rows now shift while dragging (9b), as dnd-kit's vertical sort does. Still no keyboard sensor and no auto-scroll.
- **Closed:** the state dot ring is cut to whole device pixels, as Chromium cuts `1.5px` (`ui::css_border`, fed by `Root::render`). The widget window and any other window with another scale reads the last value the main window set.
- **Dialog overlays are 28 px / 1.25 / 10 % tint, not Electron's 16 px** (user's readability rule). `native/docs/effects-coverage.md` lists the 12 overlay rules this affects.
- **`menuFadeIn` and `modalEntrance` draw opacity and the vertical rise only**; gpui cannot scale a laid-out element, so the 0.95 to 1 scale is missing.
- **`Sidebar.module.scss` is dead in Electron** (`Sidebar.tsx` is imported by nothing but its test); no native counterpart exists.
- **The effects gallery nav button shows only in debug builds or with `LIZMETER_GALLERY` set.**
- **Tooltips and the copy pill are not covered by screenshots** (they need a pointer or a clipboard action and no foreground input automation is allowed).

## Phase 12 (packaging, soak, cutover)

- **Release build has no console (`windows_subsystem = "windows"`).** `eprintln!` output (for example `[pipe] Server error`) is lost in the installed app. `--soak-setup` and `--soak-check` write to the parent console or to a redirected stdout. From PowerShell run them as `Start-Process <exe> -ArgumentList ... -Wait -NoNewWindow -PassThru`: a plain `& exe` does not wait for a GUI-subsystem program. A log file under the user-data folder would make runtime errors visible; not done.
- **Soak guard runs at launch only.** `--soak` refuses a OneDrive data folder when it starts. A move of the data folder from the soak app's Settings page to a OneDrive folder is not blocked.
- **Soak cannot prove two-machine convergence.** The test sync folder may not sit in OneDrive, so a soak runs on one machine. `--soak-check` compares todo `id|title` digests; the two-machine check happens in the real swap (runbook sections 4 and 5).
- **`cargo packager` caches NSIS in `%LOCALAPPDATA%\.cargo-packager`** (it ignores a `LOCALAPPDATA` override) and fails with `Plugin not found` while `NSISDIR` points at scoop's NSIS. Workaround (documented in CLAUDE.md, Packager.toml and the cutover runbook): `Remove-Item env:NSISDIR` in the shell before `cargo packager`.
- **Installer run in an isolated profile is not done.** No Windows Sandbox on the dev machine. The installer was built and compiled by makensis, never executed.
- **Native pipe guard vs fake profiles.** `Services::open_guarded` runs the Electron process check whenever the data folder is `%APPDATA%\lizmeter` (also a redirected `%APPDATA%`), so a running Electron build refuses a fake profile at that path in tests. Tests use another folder name.

## Live checks (2026-11-11)

- **Closed: real yt-dlp extraction.** `lizmeter.exe --data-dir <scratch> --do music-url:https://www.youtube.com/watch?v=jNQXAC9IVRw` (yt-dlp 2026.10.26): title "Me at the zoo", 19 s; play returned at 16-22 s (debug build, mostly yt-dlp), first streamed frame 5.4 s later, cached about 9 s after that; the replay came from the cache with the in-process decoder (`native_decode: true`). YouTube's cached file is DASH-fragmented MP4 (`major_brand: dash`); symphonia plays it.
- **Fixed in native, still open in Electron: a slow yt-dlp was deleted.** yt-dlp `--version` takes 3.3-4.3 s here (self-unpacking exe); the 5 s health check timed out in 1 of 4 release starts and the check deleted a working yt-dlp. Native (`dc19a2a`) keeps the file on a timeout. `electron/main/music/binary-manager.ts` (`execFileAsync(..., { timeout: 5000 })` then `unlinkSync`) has the same fault.
- **Playing a cached track blocks `play()` for about 8 s in a debug build** (the decode probe and the in-process open). Not measured in release.
