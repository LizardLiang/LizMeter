# SA Review: Tech Spec -- Session Tags & Sidebar

| Field    | Value                        |
|----------|------------------------------|
| Reviewer | Apollo (SA)                  |
| Date     | 2026-02-20T06:11:36.004Z     |
| Verdict  | **approved-with-notes**      |

---

## Architecture Assessment

The tech spec is well-structured and demonstrates strong alignment with the existing codebase patterns. The bottom-up implementation order, the adherence to the existing IPC invoke/handle pattern, and the careful separation of concerns across the three Electron processes are all correct. The spec author clearly read the actual source files and designed around the real code rather than assumed abstractions.

The overall approach -- two new tables, seven new IPC channels, two new hooks, and a layout restructure -- is proportional to the feature scope and does not introduce unnecessary complexity.

---

## Findings

### Critical

None.

### Major

**M-1: `PRAGMA foreign_keys = ON` in the sql.js shim is a no-op by default**

The spec correctly places `db.pragma("foreign_keys = ON")` before DDL in `initDatabase()`. However, the existing `better-sqlite3-shim.ts` (lines 61-67) wraps all pragma calls in a try/catch that silently swallows errors. While sql.js does support `PRAGMA foreign_keys = ON`, the current shim implementation runs it via `this._db.run(...)` which should work. The concern is that `ON DELETE CASCADE` behavior is critical for tests TC-313, TC-322, and TC-323 -- if the pragma silently fails in the shim, those tests will pass incorrectly (deletes will succeed but cascade won't fire, and test assertions on cascade behavior will fail). The implementer **must verify** that `PRAGMA foreign_keys = ON` is actually effective in sql.js in-memory mode within the shim. If not, the shim's `pragma()` method needs to actually execute the pragma rather than catching and ignoring errors.

**M-2: `useTimer` save effect does not return the saved Session, making tag assignment difficult**

The spec proposes adding an `onSessionSaved?: (session: Session) => void` callback to `useTimer`. However, the existing save effect (lines 227-245 of `useTimer.ts`) calls `window.electronAPI.session.save(...)` in a `.then()` chain but currently discards the returned `Session` object (the `.then()` receives it but does nothing with it). The spec's approach is correct in principle, but the implementation detail is incomplete -- the spec shows the hook signature change but then the `useSidebar` hook section has a placeholder comment ("Implementation: read..."). The `onSessionSaved` callback approach is sound, but Ares should note that the `.then()` handler must capture and forward the saved session:

```typescript
.then((savedSession) => {
  setSaveError(null);
  onSessionSaved?.(savedSession);
})
```

This is explicitly called out in the spec's prose but not shown in a code snippet for the modified `useTimer`, which could lead to implementation ambiguity.

### Minor

**m-1: `useSidebar` hook is underspecified**

The `useSidebar` hook (lines 797-828) contains placeholder comments like "Implementation: read 'sidebar.expanded' from settings on mount" and "This requires a generic setting save..." rather than concrete implementation code. While the spec does resolve this later by introducing `getSetting`/`setSetting` and `settings:get-key`/`settings:set-key`, the hook's code block itself is not a complete implementation. This is inconsistent with every other code block in the spec which provides copy-paste-ready implementations. Ares will need to fill in the gaps.

**m-2: The `settings:set-key` IPC handler receives two separate arguments**

The handler is defined as:
```typescript
ipcMain.handle("settings:set-key", (_event, key: string, value: string) => setSetting(key, value));
```

The preload exposes it as:
```typescript
setKey: (key: string, value: string) => ipcRenderer.invoke("settings:set-key", key, value),
```

This works because `ipcRenderer.invoke` passes additional arguments positionally and `ipcMain.handle` receives them as `(_event, arg1, arg2, ...)`. However, the existing codebase pattern (visible in `session:save`, `settings:save`) uses a single input object for multi-field payloads. While two positional args are technically fine, it is a minor inconsistency. Not blocking.

**m-3: `Session` type gains mandatory `tags: SessionTag[]` -- breaking change to existing code**

Adding `tags` to the `Session` interface means every place that constructs a `Session` object must now include `tags`. The spec correctly handles `saveSession()` (adds `tags: []`), `listSessions()` (post-processes to attach tags), and existing tests (updates mock objects). However, the spec does not mention `deleteSession()` or any other place where `Session` objects might be constructed or expected. This is likely fine since `deleteSession` returns `void`, but Ares should audit all existing code that constructs `Session` objects to ensure they include `tags`.

**m-4: The `listSessions` post-processing loop executes N+1 queries**

For each page of sessions (up to 50), the modified `listSessions` runs one additional query per session to fetch its tags. With the default page size of 50, this means up to 51 queries per call. The spec explicitly chose this over `GROUP_CONCAT` to avoid JSON parsing complexity, which is a reasonable v1 trade-off given the target scale (<1000 sessions). However, for performance, the implementer could use a single `WHERE session_id IN (?, ?, ...)` query with dynamic placeholders to batch-fetch all tags for the page. This is a suggestion, not a blocker.

### Nit

**n-1: `electron-api.d.ts` listed as a modified file but not shown**

The spec lists `src/renderer/src/electron-api.d.ts` as a modified file (to update the `Window.electronAPI` type), but does not provide the actual code change. Since the `ElectronAPI` interface in `types.ts` is the source of truth, the `.d.ts` file just needs to reference it. Minor omission.

**n-2: Total IPC channel count in the overview says "seven new IPC channels, one modified"**

But the body of the spec actually introduces 9 new channels: 7 tag channels + 2 settings key channels (`settings:get-key`, `settings:set-key`). The overview should say "nine new IPC channels."

**n-3: `TagPicker` uses `anchorRef?: React.RefObject<HTMLElement>` but no positioning logic is described**

The spec mentions "Popover anchored below trigger button" but does not specify how positioning works (absolute positioning relative to anchor? Portal? `getBoundingClientRect`?). This is a UI implementation detail that Ares can resolve.

---

## Verdict & Rationale

**Verdict: approved-with-notes**

The spec is architecturally sound and demonstrates excellent alignment with the existing codebase. The database schema design is correct SQLite with proper foreign key constraints, the IPC pattern follows established conventions, no new native modules are introduced (no ABI concerns), and the hook designs follow the project's existing patterns (`useReducer` FSM, refresh-token, `useCallback` wrappers).

The two Major findings are implementation clarity issues rather than architectural flaws:
- M-1 (sql.js PRAGMA) requires a quick verification during implementation
- M-2 (`onSessionSaved` callback) is described in prose but missing from the code snippet

Neither requires a spec revision -- both can be addressed by Ares during implementation with awareness of these notes.

The N+1 query pattern in `listSessions` is acceptable for v1 given the expected data volume. The `useSidebar` placeholder code is the weakest section of the spec but the surrounding context (generic key/value settings channels) provides enough information for implementation.

---

## Recommendations for Ares

1. **Verify PRAGMA foreign_keys in sql.js shim** (M-1): Before writing cascade tests, run a quick spike to confirm `PRAGMA foreign_keys = ON` is effective in the shim. If not, update the shim's `pragma()` method to actually execute the SQL rather than silently catching errors. The current catch block (line 65) was designed for WAL/filesystem pragmas -- `foreign_keys` should not be caught.

2. **Complete the `onSessionSaved` callback in `useTimer`** (M-2): The `.then()` handler in the save effect must capture the returned `Session` and invoke the callback. Ensure the callback is also listed in `UseTimerReturn` or passed as a hook parameter.

3. **Complete the `useSidebar` hook implementation** (m-1): The spec provides `getSetting`/`setSetting` DB functions and `settings:get-key`/`settings:set-key` IPC channels. Wire them into the hook: call `settings.getKey("sidebar.expanded")` in the `useEffect` mount, and `settings.setKey("sidebar.expanded", String(next))` in the `toggle` callback.

4. **Audit all `Session` object constructions** (m-3): After adding `tags: SessionTag[]` to the `Session` interface, run `bun run build` early to catch any TypeScript errors from missing `tags` fields in existing code.

5. **Consider batch tag fetching** (m-4): If performance is a concern later, replace the N+1 per-session tag query in `listSessions` with a single `WHERE session_id IN (...)` batch query. Not required for v1.

6. **Implementation order**: Follow the spec's 28-step order strictly. Steps 1-4 (types, DB, tests) form a solid foundation that can be validated independently before touching the renderer.