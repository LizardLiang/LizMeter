# Code Review — Tomato Clock

**Reviewer:** Hermes
**Date:** Thu Feb 19 2026 19:06:53 GMT+0800
**Verdict: APPROVED**

---

## Verification Results

| Check | Result |
|-------|--------|
| `bunx tsc --noEmit` | ✅ Clean |
| `bun run lint` | ✅ Clean |
| `bun run fmt:check` | ✅ Clean |
| `bun run test` | ✅ 73/73 passing (12 test files) |

---

## Apollo SA Findings — All Addressed

| Finding | Status |
|---------|--------|
| `--external better-sqlite3` in `build:main` | ✅ Present in package.json |
| Input validation in main process IPC handlers | ✅ Validation in `database.ts`, called from IPC handlers |
| `initDatabase()` try/catch with `dialog.showErrorBox` | ✅ `main/index.ts` lines 26–37 |
| Session save via `useEffect` on `status === 'completed'` | ✅ `useTimer.ts` lines 218–236 |
| `SET_TITLE` works in running and paused states | ✅ Guards on `completed` only, not running/paused |
| Title preserved on RESET | ✅ RESET action does not clear `title` field |

---

## File-by-File Review

### `src/shared/types.ts`
Clean and complete. All types match the spec. `ElectronAPI` interface correctly reflects the IPC surface. `SaveSessionInput` is correctly separated from `Session` so `id` and `completedAt` are server-generated. No issues.

### `src/main/database.ts`
Good overall.

- **SQL injection safety**: All queries use prepared statements with `?` placeholders. No string interpolation in SQL. ✅
- **Input validation**: `validateTimerType`, `validateDuration`, `sanitizeTitle` are thorough and live at the trust boundary. ✅
- **WAL mode**: Good choice for performance.
- **`getDefaultDbPath` uses `require()`**: Necessary for Electron runtime module access. The eslint suppression comment is appropriate and explains why.
- **Minor**: `saveSession` validates `plannedDurationSeconds > 0` but `validateDuration` (used for settings) enforces `>= 60`. Inconsistent lower bounds. Low risk since the renderer always derives durations from settings, but worth aligning in a follow-up.

### `src/main/ipc-handlers.ts`
Thin and correct. Delegates all logic to `database.ts`. No business logic in the transport layer. `session:list` correctly handles `null` input with `?? {}`. ✅

### `src/main/index.ts`
Exactly right. `initDatabase()` wrapped in try/catch with `dialog.showErrorBox` and `app.quit()`. `closeDatabase()` called on `will-quit`. `registerIpcHandlers()` called before `createWindow()` so all handlers are ready before the window loads. ✅

### `src/renderer/src/hooks/useTimer.ts`
The core of the feature — well implemented.

- **FSM correctness**: All illegal transitions return `state` unchanged. ✅
- **Wall-clock accuracy**: `endTime = Date.now() + remainingSeconds * 1000` computed once when the effect runs; remaining always derived from `endTime - Date.now()`. Immune to setInterval drift. ✅
- **Effect cleanup**: `clearInterval` in cleanup — no interval leak on unmount or re-run. ✅
- **ESLint suppressions**: Both justified. Tick effect intentionally depends only on `status`/`startedAtWallClock`. Save effect intentionally fires only on `status` change.
- **`accumulatedActiveMs`**: Correctly accumulated in PAUSE and COMPLETE, then converted to `actualDurationSeconds` for the DB. ✅
- **Minor**: The save `useEffect` calls `getDurationForType(state.settings, ...)` but `state.settings` is not in the dep array. Works correctly in practice (state is captured from the reducer), but is a latent stale-closure risk. Cleaner to store `plannedDurationSeconds` in state at `START`.

### `src/renderer/src/hooks/useSessionHistory.ts`
Clean. `refreshToken` pattern for triggering re-fetches is idiomatic. Error states handled. `void fetchSessions(...)` correctly acknowledges the floating promise. ✅

**Minor nit**: `loadMore` doesn't check if `offset + limit >= total` before fetching — would make an unnecessary IPC call at end of list.

### `src/renderer/src/hooks/useSettings.ts`
Simple and correct. Falls back to hardcoded defaults on load failure — good UX. `saveSettings` updates local state after IPC resolves. ✅

### `src/renderer/src/utils/format.ts`
Correct. `formatTime` clamps negatives to 0, minutes not capped at 59. `formatCompletedAt` is locale-aware. ✅

### Components

**`TomatoClock.tsx`**: Clean composition. 500ms delay before refreshing history is a reasonable pragmatic workaround for the async IPC save. `settingsLoading` guard prevents null settings reaching the timer. ✅

**`TimerView.tsx`**: Blue/green visual distinction between work and break modes (FR-023). `saveError` displayed inline. ✅

**`TimerDisplay.tsx`**: `aria-live="polite"` with `aria-label` — good accessibility. Color-coded by status (grey/amber/green). ✅

**`TimerControls.tsx`**: State-conditional rendering is correct. Completed state shows "Start New Session". Reset properly disabled and non-clickable when idle. **Nit**: `disabled={false}` on the Start button is redundant.

**`SessionTitleInput.tsx`**: Controlled input with `maxLength` at HTML and reducer level. Properly labelled with `htmlFor`/`id`. ✅

**`TimerTypeSelector.tsx`**: `aria-pressed` on toggle buttons — correct ARIA pattern. Disabled state handled via both `disabled` attribute and onClick guard. ✅

**`SessionHistory.tsx`**: All four states covered (loading/error/empty/populated). `aria-label` on section element. ✅

**`SessionHistoryItem.tsx`**: `aria-label` on delete button includes title. Fallback `(no title)` text. `title` attribute on overflow-clipped text. ✅

---

## Issues

### Minor (non-blocking)
1. **Inconsistent duration lower bound** — `saveSession` accepts `plannedDurationSeconds > 0` while settings enforces `>= 60`. Align these in a follow-up.
2. **Stale closure risk in save effect** — `getDurationForType(state.settings, ...)` inside the effect with `state.settings` not in the dep array. Works correctly today but fragile.
3. **History refresh race** — 500ms delay before refresh is pragmatic but brittle under slow IPC. Long-term, the save effect should trigger refresh after the IPC call resolves.
4. **`loadMore` no bounds check** — Fires an IPC call even when already at the end of the list.

### Nits
- `TimerControls.tsx`: `disabled={false}` on Start button is redundant.

---

## Summary

Solid, production-ready implementation. All 17 functional requirements are covered, all Apollo SA findings are resolved, the FSM is correct, timer accuracy is sound, and 73 tests pass clean across all layers. The minor issues above are appropriate for follow-up, not blockers.

**APPROVED — ready to ship.**
