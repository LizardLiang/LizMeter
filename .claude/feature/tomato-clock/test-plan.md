# Test Plan

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Tomato Clock (Pomodoro Timer) |
| **Author** | Artemis (QA Agent) |
| **Date** | 2026-02-19 |
| **PRD Version** | 1.0 |
| **Tech Spec Version** | 1.0 |
| **Status** | Complete |

---

## 1. Test Overview

### Scope

This test plan covers all functional and non-functional requirements for the Tomato Clock feature as defined in `prd.md` v1.0 and `tech-spec.md` v1.0. It encompasses:

- Timer state machine correctness (all FSM transitions)
- Database module operations (CRUD via in-memory SQLite)
- Utility function correctness (time formatting)
- Custom React hooks behavior (mocked IPC bridge)
- UI component rendering and interaction
- Full E2E user flows in the Electron app
- IPC round-trip integration
- Input validation and error handling
- Build correctness (native module external flag)
- Timer accuracy (wall-clock approach, no drift)

### Out of Scope

| Item | Reason |
|------|--------|
| Audio/sound notifications | Explicitly out of scope in PRD. No audio implemented in v1. |
| System tray integration | Out of scope per PRD. Timer only runs while window is visible. |
| Auto-cycling work/break | Out of scope per PRD. Manual mode selection only. |
| Cloud sync | Out of scope. Local-only data. |
| Statistics/charts | Out of scope. Raw history list only. |
| Keyboard shortcuts | Out of scope for v1. |
| Multi-window timers | Out of scope for v1. |
| OS notification center | Out of scope for v1. |

### Test Approach

1. **Unit tests** use Vitest with jsdom environment. Timer reducer and utility functions are pure function tests with no mocking. Database module tests use an in-memory `:memory:` SQLite database. Custom hooks use `@testing-library/react` `renderHook` with `window.electronAPI` mocked via `vi.stubGlobal`.
2. **Component tests** use Vitest + `@testing-library/react`. All IPC calls are mocked via `vi.stubGlobal('electronAPI', ...)`. Timer advancement uses `vi.useFakeTimers()`.
3. **E2E tests** use Playwright + `electron-playwright-helpers` to launch the real Electron process. They exercise the full stack from UI interaction through IPC to SQLite. Short timer durations (3–5 seconds) are used in E2E to avoid long waits.
4. **Integration tests** verify the IPC round-trip by testing IPC handler functions and the database module together without launching the full Electron app.

---

## 2. Requirements Coverage Matrix

| Req ID | Requirement | Test Cases | Priority |
|--------|-------------|------------|----------|
| FR-001 | Configurable timer durations | TC-201, TC-401, TC-501, TC-601 | P0 |
| FR-002 | Default Pomodoro durations (25/5/15) | TC-101, TC-201, TC-601 | P0 |
| FR-003 | Session title input | TC-109, TC-110, TC-211, TC-311, TC-601 | P0 |
| FR-004 | Start timer | TC-102, TC-212, TC-501, TC-601 | P0 |
| FR-005 | Pause timer | TC-103, TC-213, TC-502, TC-602 | P0 |
| FR-006 | Reset timer (no session recorded) | TC-104, TC-214, TC-503, TC-603 | P0 |
| FR-007 | Visual countdown MM:SS display | TC-111, TC-112, TC-210, TC-601 | P0 |
| FR-008 | Timer completion visual indication | TC-106, TC-215, TC-504, TC-601 | P0 |
| FR-009 | Persist completed sessions to SQLite | TC-301, TC-302, TC-401, TC-601 | P0 |
| FR-010 | Session history list (title, duration, type, timestamp) | TC-320, TC-321, TC-402, TC-604 | P0 |
| FR-011 | Timer type selection (work/short break/long break) | TC-107, TC-108, TC-216, TC-601 | P0 |
| FR-020 | Session history persists across restarts | TC-605 | P1 |
| FR-021 | Empty state for history | TC-322, TC-606 | P1 |
| FR-022 | Delete a session from history | TC-323, TC-403, TC-607 | P1 |
| FR-023 | Timer state visual feedback (work vs break visual distinction) | TC-217, TC-608 | P1 |
| FR-030 | Today's session count (P2) | TC-324 | P2 |
| FR-031 | Persist custom duration settings (P2) | TC-404, TC-609 | P2 |
| NFR-ACC | Timer accuracy < 1s drift / 25 min | TC-113, TC-505 | P0 |
| NFR-PERF | History of 1,000 records < 500ms | TC-405 | P0 |
| NFR-SEC | Renderer has no direct DB access | TC-550, TC-551 | P0 |
| NFR-AUTO | Database created automatically on first use | TC-301, TC-601 | P0 |
| BUILD | build:main --external better-sqlite3 | TC-700 | P0 |

---

## 3. Test Cases

### 3.1 Unit Tests — Timer Reducer

**Test file:** `src/renderer/src/hooks/__tests__/timerReducer.test.ts`

**Setup:** Import the reducer function directly. No mocking needed. All tests are pure function calls.

**Teardown:** None required.

---

#### TC-101: Initial state defaults

| Field | Value |
|-------|-------|
| **Requirement** | FR-002 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- Reducer and initial state factory are importable.

**Test Steps:**
1. Call `getInitialTimerState(defaultSettings)` where `defaultSettings = { workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 }`.
2. Assert the returned state.

**Expected Result:**
- `state.status === 'idle'`
- `state.timerType === 'work'`
- `state.remainingSeconds === 1500`
- `state.title === ''`
- `state.startedAtWallClock === null`
- `state.accumulatedActiveMs === 0`

---

#### TC-102: START action transitions idle to running

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `idle` with `remainingSeconds: 1500`.

**Test Steps:**
1. Call `reducer(idleState, { type: 'START' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'running'`
- `state.startedAtWallClock` is a number (Date.now() timestamp, approximately current time)
- `state.remainingSeconds === 1500` (unchanged)
- `state.accumulatedActiveMs === 0`

---

#### TC-103: PAUSE action transitions running to paused

| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `running` with `startedAtWallClock` set to `Date.now() - 5000`, `remainingSeconds: 1495`, `accumulatedActiveMs: 0`.

**Test Steps:**
1. Call `reducer(runningState, { type: 'PAUSE' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'paused'`
- `state.startedAtWallClock === null`
- `state.accumulatedActiveMs > 0` (reflects elapsed active time since last start)
- `state.remainingSeconds` unchanged or updated to wall-clock value

---

#### TC-104: RESET action from running returns to idle, preserves title

| Field | Value |
|-------|-------|
| **Requirement** | FR-006, Title preservation (tech-spec Section 8) |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `running` with `title: 'Write PRD'`, `timerType: 'work'`, `remainingSeconds: 900`, settings `workDuration: 1500`.

**Test Steps:**
1. Call `reducer(runningState, { type: 'RESET' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'idle'`
- `state.remainingSeconds === 1500` (reset to configured duration for current type)
- `state.title === 'Write PRD'` (CRITICAL: title preserved, not cleared)
- `state.startedAtWallClock === null`
- `state.accumulatedActiveMs === 0`

---

#### TC-105: RESET action from paused returns to idle

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `paused` with `remainingSeconds: 500`, settings `workDuration: 1500`.

**Test Steps:**
1. Call `reducer(pausedState, { type: 'RESET' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'idle'`
- `state.remainingSeconds === 1500`
- `state.accumulatedActiveMs === 0`

---

#### TC-106: COMPLETE action transitions running to completed

| Field | Value |
|-------|-------|
| **Requirement** | FR-008, FR-009 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `running` with `accumulatedActiveMs: 0`, `startedAtWallClock: Date.now() - 1500000`.

**Test Steps:**
1. Call `reducer(runningState, { type: 'COMPLETE' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'completed'`
- `state.remainingSeconds === 0`
- `state.startedAtWallClock === null`
- `state.accumulatedActiveMs` reflects total active time (approximately 1500000 ms)

---

#### TC-107: CLEAR_COMPLETION returns to idle

| Field | Value |
|-------|-------|
| **Requirement** | FR-008 (dismiss completion) |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `completed`.

**Test Steps:**
1. Call `reducer(completedState, { type: 'CLEAR_COMPLETION' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'idle'`
- `state.remainingSeconds` reset to configured duration for current timer type

---

#### TC-108: SET_TIMER_TYPE when idle updates remaining seconds

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `idle`, `timerType: 'work'`, `remainingSeconds: 1500`, settings `{ workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 }`.

**Test Steps:**
1. Call `reducer(idleState, { type: 'SET_TIMER_TYPE', payload: 'short_break' })`.
2. Assert result.
3. Call `reducer(result, { type: 'SET_TIMER_TYPE', payload: 'long_break' })`.
4. Assert result.

**Expected Result (step 2):**
- `state.timerType === 'short_break'`
- `state.remainingSeconds === 300`
- `state.status === 'idle'`

**Expected Result (step 4):**
- `state.timerType === 'long_break'`
- `state.remainingSeconds === 900`

---

#### TC-109: SET_TITLE action updates title in any non-completed state

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- Three starting states: idle, running, paused.

**Test Steps:**
1. For each state, call `reducer(state, { type: 'SET_TITLE', payload: 'My Focus Task' })`.
2. Assert result.

**Expected Result:**
- `state.title === 'My Focus Task'` in all three cases
- Status unchanged in all three cases

**Notes:** SA review (minor finding 4) clarified that SET_TITLE should work in RUNNING and PAUSED states, not just IDLE.

---

#### TC-110: SET_TITLE enforces maximum length

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, Input Validation (tech-spec Section 11) |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `idle`.
- A string of 501 characters is prepared.

**Test Steps:**
1. Call `reducer(idleState, { type: 'SET_TITLE', payload: 'a'.repeat(501) })`.
2. Assert result.

**Expected Result:**
- `state.title.length <= 500` (title truncated or rejected at 500 character limit)

---

#### TC-111: TICK action updates remaining seconds

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `running` with `remainingSeconds: 1500`.

**Test Steps:**
1. Call `reducer(runningState, { type: 'TICK', payload: 1450 })`.
2. Assert result.

**Expected Result:**
- `state.remainingSeconds === 1450`
- `state.status === 'running'`

---

#### TC-112: Illegal transitions are no-ops

| Field | Value |
|-------|-------|
| **Requirement** | Timer FSM correctness |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- Multiple starting states.

**Test Steps:**
1. `reducer(idleState, { type: 'PAUSE' })` — cannot pause when idle.
2. `reducer(idleState, { type: 'RESUME' })` — cannot resume when idle.
3. `reducer(runningState, { type: 'START' })` — cannot start when already running.
4. `reducer(runningState, { type: 'RESUME' })` — cannot resume when running.
5. `reducer(pausedState, { type: 'PAUSE' })` — cannot pause when already paused.
6. `reducer(completedState, { type: 'TICK', payload: 5 })` — cannot tick after completion.

**Expected Result:**
- Each call returns the original state unchanged (no throw, no state mutation).

---

#### TC-113: RESUME action sets new startedAtWallClock

| Field | Value |
|-------|-------|
| **Requirement** | FR-005, NFR timer accuracy |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/timerReducer.test.ts` |

**Preconditions:**
- State is `paused` with `remainingSeconds: 800`, `startedAtWallClock: null`, `accumulatedActiveMs: 700000`.

**Test Steps:**
1. Call `reducer(pausedState, { type: 'RESUME' })`.
2. Assert result.

**Expected Result:**
- `state.status === 'running'`
- `state.startedAtWallClock` is a recent timestamp (within 100ms of Date.now())
- `state.accumulatedActiveMs === 700000` (unchanged — only updated on pause/complete)
- `state.remainingSeconds === 800` (unchanged)

---

### 3.2 Unit Tests — Format Utilities

**Test file:** `src/renderer/src/utils/__tests__/format.test.ts`

**Setup:** Import `formatTime` and any other utility functions. Pure functions, no mocking.

**Teardown:** None.

---

#### TC-201: formatTime converts seconds to MM:SS

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/renderer/src/utils/__tests__/format.test.ts` |

**Preconditions:** None.

**Test Steps:**
1. Assert `formatTime(1500) === '25:00'`
2. Assert `formatTime(300) === '05:00'`
3. Assert `formatTime(900) === '15:00'`
4. Assert `formatTime(0) === '00:00'`
5. Assert `formatTime(61) === '01:01'`
6. Assert `formatTime(59) === '00:59'`
7. Assert `formatTime(3600) === '60:00'`
8. Assert `formatTime(3661) === '61:01'`

**Expected Result:**
- All assertions pass. Format is always `MM:SS` with zero-padding.

**Edge Cases:**
- `formatTime(0)` — zero case: `'00:00'`
- `formatTime(3661)` — over 60 minutes: `'61:01'` (minutes can exceed 59)
- `formatTime(1)` — single second: `'00:01'`

---

#### TC-202: formatTime handles negative input gracefully

| Field | Value |
|-------|-------|
| **Requirement** | FR-007, robustness |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/renderer/src/utils/__tests__/format.test.ts` |

**Test Steps:**
1. Assert `formatTime(-1)` returns `'00:00'` (clamps to zero, no negative display).

**Expected Result:**
- Returns `'00:00'` — negative values should not produce a negative display.

---

### 3.3 Unit Tests — Database Module

**Test file:** `src/main/__tests__/database.test.ts`

**Setup:** Each test (or `beforeEach`) calls `initDatabase(':memory:')`. The database module must accept an optional path parameter for testability, defaulting to the userData path in production.

**Teardown:** `afterEach` calls `closeDatabase()`.

**Mock requirements:** None. Uses real `better-sqlite3` with `:memory:` database. This requires the test runner to have access to the compiled native module.

**Note on vitest environment:** The database module runs in Node.js (main process code). The vitest config uses `environment: 'jsdom'`. Database tests should use `// @vitest-environment node` pragma at the top of the file, or the vitest config should be extended with an `environmentMatchGlobs` entry for `src/main/**`.

---

#### TC-301: initDatabase creates schema on fresh database

| Field | Value |
|-------|-------|
| **Requirement** | FR-009, NFR-AUTO |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- Clean in-memory database (no tables).

**Test Steps:**
1. Call `initDatabase(':memory:')`.
2. Query `SELECT name FROM sqlite_master WHERE type='table'`.
3. Assert tables exist.
4. Query the index: `SELECT name FROM sqlite_master WHERE type='index'`.

**Expected Result:**
- Tables `sessions` and `settings` exist.
- Index `idx_sessions_completed_at` exists on the `sessions` table.
- No errors thrown.

---

#### TC-302: saveSession inserts a record and returns Session object

| Field | Value |
|-------|-------|
| **Requirement** | FR-009 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- Database initialized with `initDatabase(':memory:')`.

**Test Steps:**
1. Call `saveSession({ title: 'Test session', timerType: 'work', plannedDurationSeconds: 1500, actualDurationSeconds: 1498 })`.
2. Assert the returned value.
3. Query `SELECT * FROM sessions` to verify the row exists.

**Expected Result:**
- Returned object has `id` (a valid UUID v4 string matching `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`).
- Returned object has `completedAt` as a valid ISO 8601 string.
- `title === 'Test session'`
- `timerType === 'work'`
- `plannedDurationSeconds === 1500`
- `actualDurationSeconds === 1498`
- Database row count is 1.

---

#### TC-303: saveSession generates unique IDs for multiple sessions

| Field | Value |
|-------|-------|
| **Requirement** | FR-009 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `saveSession(...)` five times with different titles.
2. Collect all returned `id` values.
3. Assert uniqueness.

**Expected Result:**
- All 5 IDs are distinct strings.
- No duplicate IDs.

---

#### TC-304: listSessions returns sessions ordered by completedAt DESC

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- Database initialized. Three sessions saved with sequential `completedAt` timestamps (insert order: oldest first).

**Test Steps:**
1. Save session A with `completedAt` = 10 minutes ago.
2. Save session B with `completedAt` = 5 minutes ago.
3. Save session C with `completedAt` = now.
4. Call `listSessions({ limit: 50, offset: 0 })`.
5. Assert order.

**Expected Result:**
- `result.sessions[0]` is session C (most recent).
- `result.sessions[1]` is session B.
- `result.sessions[2]` is session A (oldest).
- `result.total === 3`.

---

#### TC-305: listSessions paginates correctly

| Field | Value |
|-------|-------|
| **Requirement** | FR-010, NFR-PERF |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- 10 sessions saved.

**Test Steps:**
1. Call `listSessions({ limit: 3, offset: 0 })`.
2. Assert first page.
3. Call `listSessions({ limit: 3, offset: 3 })`.
4. Assert second page.
5. Call `listSessions({ limit: 3, offset: 9 })`.
6. Assert last page (1 item).

**Expected Result:**
- Page 1: 3 sessions, `total === 10`.
- Page 2: 3 sessions, `total === 10`.
- Page 3 (offset 9): 1 session, `total === 10`.
- No duplicate sessions across pages.

---

#### TC-306: listSessions defaults limit to 50 when not specified

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- 60 sessions saved.

**Test Steps:**
1. Call `listSessions({})` with empty options.
2. Assert length.

**Expected Result:**
- `result.sessions.length === 50` (default limit).
- `result.total === 60`.

---

#### TC-307: deleteSession removes the row

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- One session saved. Its `id` is recorded.

**Test Steps:**
1. Call `deleteSession(session.id)`.
2. Call `listSessions({})`.
3. Assert.

**Expected Result:**
- `result.sessions.length === 0`.
- `result.total === 0`.
- No error thrown.

---

#### TC-308: deleteSession is a no-op for non-existent ID

| Field | Value |
|-------|-------|
| **Requirement** | FR-022, error handling |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `deleteSession('non-existent-id-that-does-not-exist')`.
2. Assert no error.

**Expected Result:**
- Function returns without throwing.
- Database state unchanged.

---

#### TC-309: getSettings returns hardcoded defaults when table is empty

| Field | Value |
|-------|-------|
| **Requirement** | FR-002, FR-031 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Preconditions:**
- Database initialized with empty `settings` table.

**Test Steps:**
1. Call `getSettings()`.
2. Assert result.

**Expected Result:**
- `settings.workDuration === 1500`
- `settings.shortBreakDuration === 300`
- `settings.longBreakDuration === 900`

---

#### TC-310: saveSettings persists and getSettings retrieves custom values

| Field | Value |
|-------|-------|
| **Requirement** | FR-031 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `saveSettings({ workDuration: 1800, shortBreakDuration: 600, longBreakDuration: 1200 })`.
2. Call `getSettings()`.
3. Assert result.

**Expected Result:**
- `settings.workDuration === 1800`
- `settings.shortBreakDuration === 600`
- `settings.longBreakDuration === 1200`

---

#### TC-311: saveSettings is idempotent (upsert behavior)

| Field | Value |
|-------|-------|
| **Requirement** | FR-031 |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `saveSettings({ workDuration: 1800, shortBreakDuration: 600, longBreakDuration: 1200 })`.
2. Call `saveSettings({ workDuration: 2100, shortBreakDuration: 300, longBreakDuration: 900 })`.
3. Call `getSettings()`.

**Expected Result:**
- `settings.workDuration === 2100` (second save wins).
- No duplicate rows in `settings` table.

---

#### TC-312: Input validation — saveSession rejects invalid timerType

| Field | Value |
|-------|-------|
| **Requirement** | Input Validation (tech-spec Section 11) |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `saveSession({ title: 'Test', timerType: 'invalid_type' as any, plannedDurationSeconds: 1500, actualDurationSeconds: 1500 })`.
2. Assert behavior.

**Expected Result:**
- Function throws an error (or returns an error response) — invalid timer type is rejected.

---

#### TC-313: Input validation — saveSettings rejects out-of-range durations

| Field | Value |
|-------|-------|
| **Requirement** | Input Validation (tech-spec Section 11) |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `saveSettings({ workDuration: 0, shortBreakDuration: 300, longBreakDuration: 900 })` — 0 is below minimum (60).
2. Call `saveSettings({ workDuration: 9000, shortBreakDuration: 300, longBreakDuration: 900 })` — 9000 is above maximum (7200).
3. Assert behavior for each.

**Expected Result:**
- Both calls throw an error or return an error response.
- Values below 60 seconds or above 7200 seconds are rejected.

---

#### TC-314: Input validation — session title is trimmed and length-capped

| Field | Value |
|-------|-------|
| **Requirement** | Input Validation (tech-spec Section 11) |
| **Type** | Unit |
| **Priority** | P1 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `saveSession({ title: '  padded  ', timerType: 'work', plannedDurationSeconds: 1500, actualDurationSeconds: 1500 })`.
2. Assert that `result.title === 'padded'` (trimmed).
3. Call `saveSession({ title: 'a'.repeat(501), timerType: 'work', plannedDurationSeconds: 1500, actualDurationSeconds: 1500 })`.
4. Assert that `result.title.length <= 500`.

**Expected Result:**
- Titles are trimmed of leading/trailing whitespace.
- Titles exceeding 500 characters are truncated to 500 or an error is thrown.

---

#### TC-315: listSessions returns empty array when no sessions exist

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `listSessions({})` on empty database.

**Expected Result:**
- `result.sessions === []`
- `result.total === 0`

---

#### TC-316: Database init is idempotent (safe to call twice)

| Field | Value |
|-------|-------|
| **Requirement** | NFR-AUTO |
| **Type** | Unit |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Call `initDatabase(':memory:')`.
2. Save one session.
3. Call `initDatabase(':memory:')` again (simulates app restart without closing).
4. List sessions.

**Expected Result:**
- No error thrown on second init.
- Session from step 2 still exists (schema creation does not drop existing data).

---

### 3.4 Unit Tests — Custom Hooks

**Test file:** `src/renderer/src/hooks/__tests__/useTimer.test.ts`
**Test file:** `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts`
**Test file:** `src/renderer/src/hooks/__tests__/useSettings.test.ts`

**Setup:**
```typescript
// In each test file, before tests:
vi.stubGlobal('electronAPI', {
  session: {
    save: vi.fn().mockResolvedValue({ id: 'mock-id', ...mockSession }),
    list: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
  settings: {
    get: vi.fn().mockResolvedValue({ workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 }),
    save: vi.fn().mockResolvedValue(undefined),
  },
});
```

**Teardown:** `afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); })`

---

#### TC-401: useSettings loads settings on mount

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-002 |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSettings.test.ts` |

**Mock requirements:** `window.electronAPI.settings.get` returns default settings.

**Test Steps:**
1. `renderHook(() => useSettings())`.
2. Initially `isLoading` is `true`.
3. `await waitFor(() => expect(result.current.isLoading).toBe(false))`.
4. Assert `settings`.

**Expected Result:**
- `window.electronAPI.settings.get` was called once.
- `result.current.settings.workDuration === 1500`
- `result.current.settings.shortBreakDuration === 300`
- `result.current.settings.longBreakDuration === 900`
- `result.current.isLoading === false`

---

#### TC-402: useSessionHistory fetches sessions on mount

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Mock requirements:** `window.electronAPI.session.list` returns `{ sessions: [mockSession], total: 1 }`.

**Test Steps:**
1. `renderHook(() => useSessionHistory())`.
2. `await waitFor(() => expect(result.current.isLoading).toBe(false))`.
3. Assert state.

**Expected Result:**
- `result.current.sessions.length === 1`
- `result.current.total === 1`
- `result.current.error === null`

---

#### TC-403: useSessionHistory deleteSession calls IPC and refreshes list

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Mock requirements:**
- `session.list` initially returns 1 session, then 0 sessions after delete.
- `session.delete` returns `undefined`.

**Test Steps:**
1. `renderHook(() => useSessionHistory())`.
2. `await waitFor(() => expect(result.current.sessions.length).toBe(1))`.
3. `act(() => result.current.deleteSession('mock-id'))`.
4. `await waitFor(() => expect(result.current.sessions.length).toBe(0))`.

**Expected Result:**
- `window.electronAPI.session.delete` called with `'mock-id'`.
- `window.electronAPI.session.list` called again after delete (refresh).
- `result.current.sessions` is empty.

---

#### TC-404: useSettings saveSettings calls IPC

| Field | Value |
|-------|-------|
| **Requirement** | FR-031 |
| **Type** | Unit (hook) |
| **Priority** | P1 |
| **File** | `src/renderer/src/hooks/__tests__/useSettings.test.ts` |

**Test Steps:**
1. `renderHook(() => useSettings())`.
2. `await waitFor(...)`.
3. `await act(() => result.current.saveSettings({ workDuration: 1800, shortBreakDuration: 600, longBreakDuration: 1200 }))`.

**Expected Result:**
- `window.electronAPI.settings.save` called with `{ workDuration: 1800, shortBreakDuration: 600, longBreakDuration: 1200 }`.

---

#### TC-405: useSessionHistory handles IPC error gracefully

| Field | Value |
|-------|-------|
| **Requirement** | Error handling (tech-spec Section 8) |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` |

**Mock requirements:** `session.list` rejects with `new Error('DB read failed')`.

**Test Steps:**
1. Override mock: `vi.mocked(window.electronAPI.session.list).mockRejectedValueOnce(new Error('DB read failed'))`.
2. `renderHook(() => useSessionHistory())`.
3. `await waitFor(() => expect(result.current.isLoading).toBe(false))`.

**Expected Result:**
- `result.current.error` is a non-null string (e.g., `'DB read failed'` or a user-friendly message).
- `result.current.sessions === []`
- No unhandled promise rejection.

---

### 3.5 Unit Tests — useTimer Hook (Wall-Clock Accuracy)

**Test file:** `src/renderer/src/hooks/__tests__/useTimer.test.ts`

---

#### TC-501: useTimer starts countdown and ticks correctly

| Field | Value |
|-------|-------|
| **Requirement** | FR-004, FR-007, NFR-ACC |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useTimer.test.ts` |

**Mock requirements:** `vi.useFakeTimers()`. Mock `electronAPI`.

**Test Steps:**
1. `vi.useFakeTimers()`.
2. `renderHook(() => useTimer(defaultSettings))`.
3. `act(() => result.current.start())`.
4. Assert status is `'running'`.
5. `act(() => vi.advanceTimersByTime(1000))`.
6. Assert `remainingSeconds` has decreased by approximately 1.
7. `act(() => vi.advanceTimersByTime(4000))`.
8. Assert `remainingSeconds` has decreased by approximately 5 total.

**Expected Result:**
- `state.status === 'running'` after start.
- `state.remainingSeconds` decrements by ~1 per second of fake timer advancement.
- No drift: after advancing 5 seconds, remaining is `1500 - 5 = 1495` (±1 for rounding).

---

#### TC-502: useTimer pause stops the countdown

| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useTimer.test.ts` |

**Test Steps:**
1. Start timer, advance 3 seconds.
2. Record `remainingSeconds` as `R`.
3. `act(() => result.current.pause())`.
4. Advance another 5 seconds.
5. Assert `remainingSeconds` is still `R` (frozen during pause).
6. Assert `state.status === 'paused'`.

**Expected Result:**
- `remainingSeconds` does not decrease while paused.
- Status is `'paused'`.

---

#### TC-503: useTimer reset returns to configured duration

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useTimer.test.ts` |

**Test Steps:**
1. Start timer, advance 10 seconds.
2. `act(() => result.current.reset())`.
3. Assert state.

**Expected Result:**
- `state.status === 'idle'`
- `state.remainingSeconds === 1500` (full work duration restored)
- `electronAPI.session.save` NOT called (no session recorded on reset)

---

#### TC-504: useTimer triggers session save on completion

| Field | Value |
|-------|-------|
| **Requirement** | FR-009 |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useTimer.test.ts` |

**Mock requirements:** Use short duration settings (e.g., `workDuration: 3`) to avoid advancing timers by 1500 seconds.

**Test Steps:**
1. `renderHook(() => useTimer({ workDuration: 3, shortBreakDuration: 300, longBreakDuration: 900 }))`.
2. `act(() => result.current.setTitle('Complete Me'))`.
3. `act(() => result.current.start())`.
4. `act(() => vi.advanceTimersByTime(4000))` — advance past 3-second timer.
5. `await waitFor(() => expect(result.current.state.status).toBe('completed'))`.

**Expected Result:**
- `state.status === 'completed'`
- `state.remainingSeconds === 0`
- `window.electronAPI.session.save` called once with:
  - `title: 'Complete Me'`
  - `timerType: 'work'`
  - `plannedDurationSeconds: 3`
  - `actualDurationSeconds` is a positive integer

---

#### TC-505: useTimer displays error when session save fails

| Field | Value |
|-------|-------|
| **Requirement** | Error handling (tech-spec Section 8) |
| **Type** | Unit (hook) |
| **Priority** | P0 |
| **File** | `src/renderer/src/hooks/__tests__/useTimer.test.ts` |

**Mock requirements:** `session.save` rejects with `new Error('DB write failed')`.

**Test Steps:**
1. Advance timer to completion.
2. `await waitFor(() => expect(result.current.state.status).toBe('completed'))`.
3. Assert error state is exposed.

**Expected Result:**
- `state.status === 'completed'` (timer still shows completion).
- Hook exposes an error string (e.g., `saveError: 'Session could not be saved'`).
- No unhandled promise rejection thrown to the test.

---

### 3.6 Component Tests

**Test file:** `src/renderer/src/components/__tests__/TimerDisplay.test.tsx`
**Test file:** `src/renderer/src/components/__tests__/TimerControls.test.tsx`
**Test file:** `src/renderer/src/components/__tests__/SessionTitleInput.test.tsx`
**Test file:** `src/renderer/src/components/__tests__/SessionHistory.test.tsx`
**Test file:** `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx`
**Test file:** `src/renderer/src/components/__tests__/TimerTypeSelector.test.tsx`

**Setup:** `@testing-library/react` render. `vi.stubGlobal('electronAPI', mockElectronAPI)` before each test.

---

#### TC-210: TimerDisplay renders MM:SS format

| Field | Value |
|-------|-------|
| **Requirement** | FR-007 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerDisplay.test.tsx` |

**Test Steps:**
1. `render(<TimerDisplay remainingSeconds={1500} status="idle" />)`.
2. Assert text content.
3. `render(<TimerDisplay remainingSeconds={0} status="completed" />)`.
4. Assert text content.
5. `render(<TimerDisplay remainingSeconds={61} status="running" />)`.
6. Assert text content.

**Expected Result:**
- `1500` renders as `'25:00'` visible in DOM.
- `0` renders as `'00:00'`.
- `61` renders as `'01:01'`.

---

#### TC-211: TimerDisplay shows completion visual state at 00:00

| Field | Value |
|-------|-------|
| **Requirement** | FR-008 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerDisplay.test.tsx` |

**Test Steps:**
1. `render(<TimerDisplay remainingSeconds={0} status="completed" />)`.
2. Check for a CSS class, role, or text that signals completion.

**Expected Result:**
- Component applies a completion indicator class or ARIA attribute (e.g., `data-status="completed"` or `class` containing `completed`).
- The `'00:00'` text is visible.

---

#### TC-212: TimerControls Start button is enabled when idle

| Field | Value |
|-------|-------|
| **Requirement** | FR-004 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerControls.test.tsx` |

**Test Steps:**
1. `render(<TimerControls status="idle" onStart={mockStart} onPause={mockPause} onResume={mockResume} onReset={mockReset} />)`.
2. Find Start button.
3. Assert it is not disabled.
4. Click Start button.
5. Assert `mockStart` was called.

**Expected Result:**
- Start button is enabled and clickable in `idle` state.
- Clicking calls `onStart` callback.

---

#### TC-213: TimerControls Pause button is enabled when running, disabled otherwise

| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerControls.test.tsx` |

**Test Steps:**
1. Render with `status="running"`. Assert Pause button is enabled.
2. Render with `status="idle"`. Assert Pause button is disabled.
3. Render with `status="paused"`. Assert Pause button is disabled (Resume is shown instead).
4. Click Pause when running. Assert `onPause` called.

**Expected Result:**
- Pause button only enabled in `running` state.
- Resume button shown/enabled in `paused` state.

---

#### TC-214: TimerControls Reset button is enabled when running or paused

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerControls.test.tsx` |

**Test Steps:**
1. Render with `status="running"`. Assert Reset button is enabled.
2. Render with `status="paused"`. Assert Reset button is enabled.
3. Render with `status="idle"`. Assert Reset button is disabled or not present.
4. Click Reset in running state. Assert `onReset` called.

**Expected Result:**
- Reset is enabled during `running` and `paused` states.
- Clicking calls `onReset`.

---

#### TC-215: TimerControls Start button is disabled when completed

| Field | Value |
|-------|-------|
| **Requirement** | FR-008 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerControls.test.tsx` |

**Test Steps:**
1. Render with `status="completed"`.
2. Assert Start button is disabled or replaced with a dismiss/clear button.

**Expected Result:**
- Controls reflect the completed state. User cannot start a new timer without dismissing completion first.

---

#### TC-216: TimerTypeSelector highlights selected type and calls onChange

| Field | Value |
|-------|-------|
| **Requirement** | FR-011 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/TimerTypeSelector.test.tsx` |

**Test Steps:**
1. `render(<TimerTypeSelector value="work" onChange={mockOnChange} disabled={false} />)`.
2. Assert `'Work'` button/tab has selected styling (aria-selected, aria-pressed, or active class).
3. Click `'Short Break'` button.
4. Assert `mockOnChange` called with `'short_break'`.

**Expected Result:**
- Selected type is visually indicated.
- Clicking another type calls `onChange` with the correct `TimerType` value.

---

#### TC-217: TimerTypeSelector is disabled when timer is running

| Field | Value |
|-------|-------|
| **Requirement** | FR-023 (visual distinction), usability |
| **Type** | Component |
| **Priority** | P1 |
| **File** | `src/renderer/src/components/__tests__/TimerTypeSelector.test.tsx` |

**Test Steps:**
1. `render(<TimerTypeSelector value="work" onChange={mockOnChange} disabled={true} />)`.
2. Click `'Short Break'`.
3. Assert `mockOnChange` was NOT called.

**Expected Result:**
- All selector options are non-interactive when `disabled` is true.
- `onChange` is not triggered.

---

#### TC-310: SessionTitleInput binds to value and calls onChange

| Field | Value |
|-------|-------|
| **Requirement** | FR-003 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionTitleInput.test.tsx` |

**Test Steps:**
1. `render(<SessionTitleInput value="" onChange={mockOnChange} maxLength={500} />)`.
2. Type `'Deep work'` into the input.
3. Assert `mockOnChange` called with `'Deep work'`.

**Expected Result:**
- Input is a controlled component.
- Each keystroke calls `onChange` with the current value.

---

#### TC-311: SessionTitleInput enforces maxLength

| Field | Value |
|-------|-------|
| **Requirement** | FR-003, Input Validation |
| **Type** | Component |
| **Priority** | P1 |
| **File** | `src/renderer/src/components/__tests__/SessionTitleInput.test.tsx` |

**Test Steps:**
1. `render(<SessionTitleInput value="" onChange={mockOnChange} maxLength={500} />)`.
2. Assert the input element has `maxLength="500"` HTML attribute.

**Expected Result:**
- Browser natively prevents input beyond 500 characters via `maxLength` attribute.

---

#### TC-320: SessionHistory renders list of sessions

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Preconditions:**
- Three mock sessions prepared.

**Test Steps:**
1. `render(<SessionHistory sessions={mockSessions} isLoading={false} error={null} onDelete={mockDelete} />)`.
2. Assert session items are rendered.

**Expected Result:**
- Three session items visible in the DOM.
- Each item shows title, timer type, duration, and a formatted timestamp.

---

#### TC-321: SessionHistory shows title, duration, type, timestamp per item

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Preconditions:**
- Mock session: `{ id: '1', title: 'Write PRD', timerType: 'work', plannedDurationSeconds: 1500, actualDurationSeconds: 1498, completedAt: '2026-02-19T10:00:00.000Z' }`.

**Test Steps:**
1. Render with the mock session.
2. Assert visible text includes `'Write PRD'`.
3. Assert visible text includes `'25:00'` or `'25 min'` (duration).
4. Assert visible text includes `'work'` or `'Work'` (timer type).
5. Assert a timestamp is visible (exact format TBD by implementation).

**Expected Result:**
- All four data fields are visible for each session item.

---

#### TC-322: SessionHistory shows empty state when no sessions

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistory.test.tsx` |

**Test Steps:**
1. `render(<SessionHistory sessions={[]} isLoading={false} error={null} onDelete={mockDelete} />)`.
2. Assert empty state message is visible.

**Expected Result:**
- An encouraging message is displayed (e.g., "No sessions yet" or "Start your first session!").
- No session list items are rendered.

---

#### TC-323: SessionHistoryItem shows delete button and calls onDelete

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | Component |
| **Priority** | P0 |
| **File** | `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` |

**Test Steps:**
1. `render(<SessionHistoryItem session={mockSession} onDelete={mockDelete} />)`.
2. Find delete button.
3. Click delete button.
4. Assert `mockDelete` called with `mockSession.id`.

**Expected Result:**
- Delete button is present per item.
- Clicking calls `onDelete` with the correct session ID.

---

#### TC-324: TodaySessionCount displays count of today's work sessions (P2)

| Field | Value |
|-------|-------|
| **Requirement** | FR-030 |
| **Type** | Component |
| **Priority** | P2 |
| **File** | `src/renderer/src/components/__tests__/TodaySessionCount.test.tsx` |

**Test Steps:**
1. Provide 3 sessions with `timerType: 'work'` and `completedAt` set to today's date, plus 2 sessions from yesterday.
2. Render `<TodaySessionCount sessions={allSessions} />` (or the component receives this derived count).
3. Assert the count displayed is `3`.

**Expected Result:**
- Only today's work sessions are counted.
- Yesterday's sessions do not affect today's count.

---

### 3.7 Integration Tests — IPC Layer

**Test file:** `src/main/__tests__/ipc-handlers.test.ts`

**Setup:** Initialize in-memory database. Import IPC handler functions directly (without launching Electron). Test handler functions by calling the underlying database functions they wrap.

**Teardown:** Close database.

---

#### TC-401 (Integration): session:save handler returns Session with generated fields

| Field | Value |
|-------|-------|
| **Requirement** | FR-009 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `src/main/__tests__/ipc-handlers.test.ts` |

**Components Tested:** `ipc-handlers.ts` `session:save` handler, `database.ts` `saveSession`.

**Test Steps:**
1. Call the handler function that backs `session:save` directly (not via Electron IPC).
2. Input: `{ title: 'IPC test', timerType: 'work', plannedDurationSeconds: 1500, actualDurationSeconds: 1500 }`.
3. Assert returned `Session`.

**Expected Result:**
- `session.id` matches UUID v4 regex.
- `session.completedAt` is a valid ISO 8601 timestamp.
- `session.title === 'IPC test'`.

---

#### TC-402 (Integration): session:list handler returns paginated results

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `src/main/__tests__/ipc-handlers.test.ts` |

**Test Steps:**
1. Save 5 sessions.
2. Call `session:list` handler with `{ limit: 3, offset: 0 }`.
3. Assert result.

**Expected Result:**
- `result.sessions.length === 3`.
- `result.total === 5`.
- Sessions in `completed_at` DESC order.

---

#### TC-403 (Integration): session:delete handler removes record

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | Integration |
| **Priority** | P0 |
| **File** | `src/main/__tests__/ipc-handlers.test.ts` |

**Test Steps:**
1. Save a session. Record its `id`.
2. Call `session:delete` handler with the session `id`.
3. Call `session:list` handler.
4. Assert session is gone.

**Expected Result:**
- `result.total === 0`.

---

#### TC-404 (Integration): settings:get and settings:save round-trip

| Field | Value |
|-------|-------|
| **Requirement** | FR-031 |
| **Type** | Integration |
| **Priority** | P1 |
| **File** | `src/main/__tests__/ipc-handlers.test.ts` |

**Test Steps:**
1. Call `settings:save` with `{ workDuration: 2100, shortBreakDuration: 420, longBreakDuration: 1080 }`.
2. Call `settings:get`.
3. Assert values.

**Expected Result:**
- Retrieved settings match saved values.

---

#### TC-405 (Integration): Performance — list 1000 sessions in under 500ms

| Field | Value |
|-------|-------|
| **Requirement** | NFR-PERF |
| **Type** | Integration / Performance |
| **Priority** | P0 |
| **File** | `src/main/__tests__/database.test.ts` |

**Test Steps:**
1. Insert 1000 sessions using a loop.
2. Record `startTime = performance.now()`.
3. Call `listSessions({ limit: 50, offset: 0 })`.
4. Record `elapsed = performance.now() - startTime`.
5. Assert `elapsed < 500`.

**Expected Result:**
- Query completes in under 500 milliseconds.
- Result has `sessions.length === 50`, `total === 1000`.

---

### 3.8 Security Tests

**Test file:** `src/renderer/src/__tests__/security.test.ts` (component-level)
**Test file:** `src/main/__tests__/security.test.ts` (IPC handler validation)

---

#### TC-550: Renderer has no direct access to Node.js or filesystem

| Field | Value |
|-------|-------|
| **Requirement** | NFR-SEC |
| **Type** | Security |
| **Priority** | P0 |
| **File** | `src/renderer/src/__tests__/security.test.ts` |

**Test Steps:**
1. In the renderer test environment (jsdom), assert `typeof require === 'undefined'`.
2. Assert `typeof process === 'undefined'` or that `process.versions.electron` is not accessible.
3. Assert `window.electronAPI` exists (the bridge is present).

**Expected Result:**
- `require` is undefined in renderer context.
- Direct Node.js API access is not possible.
- `window.electronAPI` is the only data bridge.

---

#### TC-551: IPC handlers validate timerType and reject unknown values

| Field | Value |
|-------|-------|
| **Requirement** | NFR-SEC, Input Validation (tech-spec Section 11) |
| **Type** | Security |
| **Priority** | P0 |
| **File** | `src/main/__tests__/security.test.ts` |

**Test Steps:**
1. Call `session:save` handler with `timerType: 'malicious_type'`.
2. Call `session:save` handler with `timerType: null`.
3. Call `session:save` handler with `timerType: '__proto__'`.
4. Assert each call throws or returns an error.

**Expected Result:**
- All three calls are rejected with an error.
- No SQL injection or prototype pollution is possible.
- Database is not corrupted.

---

#### TC-552: IPC handlers validate duration ranges

| Field | Value |
|-------|-------|
| **Requirement** | Input Validation (tech-spec Section 11) |
| **Type** | Security |
| **Priority** | P0 |
| **File** | `src/main/__tests__/security.test.ts` |

**Test Steps:**
1. Call `settings:save` with `workDuration: -1` — below minimum.
2. Call `settings:save` with `workDuration: 999999` — excessively large value.
3. Call `settings:save` with `workDuration: 'not-a-number'` — wrong type.
4. Assert each is rejected.

**Expected Result:**
- All three calls throw or return error responses.
- Settings table is not updated with invalid values.

---

### 3.9 E2E Tests (Playwright + Electron)

**Test file:** `e2e/tomato-clock.spec.ts`

**Setup:**
```typescript
import { _electron as electron } from 'playwright';
import { findLatestBuild, parseElectronApp } from 'electron-playwright-helpers';

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const latestBuild = findLatestBuild('dist');
  const appInfo = parseElectronApp(latestBuild);
  electronApp = await electron.launch({ args: [appInfo.main] });
  page = await electronApp.firstWindow();
});

test.afterAll(async () => {
  await electronApp.close();
});
```

**Teardown:** `electronApp.close()` after all tests. Clean up test database between runs.

**Note:** E2E tests use a short timer duration (3 seconds) by first setting custom durations via the settings interface or by directly modifying the settings through IPC before the test. Tests that require timer completion should advance time using `page.evaluate(() => { /* manipulate Date.now or dispatch COMPLETE */ })` or configure a 3-second work duration.

---

#### TC-601: Full work session flow — start, complete, verify session saved

| Field | Value |
|-------|-------|
| **Requirement** | FR-001, FR-002, FR-003, FR-004, FR-007, FR-008, FR-009, FR-010 |
| **Type** | E2E |
| **Priority** | P0 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Scenario:**
```gherkin
Given the app is open with default settings
And the timer type is "Work"
When I type "Write unit tests" into the title field
And I click "Start"
Then the countdown begins from 25:00 (or configured short duration for test)
When the timer reaches 00:00
Then the UI enters completion state
And the session "Write unit tests" appears in the session history
```

**Test Steps:**
1. Wait for app to load. Assert timer display shows `'25:00'`.
2. Click the title input field. Type `'Write unit tests'`.
3. Click the `'Start'` button.
4. Assert timer display is no longer `'25:00'` (countdown started).
5. (For fast test: inject a completion event or use a 3-second configured duration.)
6. Wait for `data-status="completed"` or equivalent completion indicator.
7. Assert session `'Write unit tests'` appears in the session history section.

**Expected Assertions:**
- Timer starts from the configured duration.
- Completion state is visually distinct.
- Session appears in history with correct title, timer type, and duration.

---

#### TC-602: Pause and resume flow preserves remaining time

| Field | Value |
|-------|-------|
| **Requirement** | FR-005 |
| **Type** | E2E |
| **Priority** | P0 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Scenario:**
```gherkin
Given the timer is running
When I click "Pause"
Then the countdown freezes
When I wait 3 seconds
And I click "Resume"
Then the countdown continues from the same value (not 3 seconds behind)
```

**Test Steps:**
1. Start timer. Wait 2 seconds. Record displayed time as `T1`.
2. Click `'Pause'`.
3. Assert status indicator shows paused.
4. Wait 3 seconds (real time, not fake timers).
5. Assert displayed time is still `T1` (frozen).
6. Click `'Resume'`.
7. Wait 2 seconds. Assert displayed time is approximately `T1 - 2` (resumed counting from T1).

**Expected Assertions:**
- `T1` is unchanged during pause.
- After resume, timer counts down from `T1`, not from the original start.

---

#### TC-603: Reset flow — no session recorded

| Field | Value |
|-------|-------|
| **Requirement** | FR-006 |
| **Type** | E2E |
| **Priority** | P0 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Scenario:**
```gherkin
Given the timer is running
When I click "Reset"
Then the timer returns to the configured starting duration
And no new session appears in the history
```

**Test Steps:**
1. Note current history count: `H`.
2. Start timer. Wait 2 seconds.
3. Click `'Reset'`.
4. Assert timer display shows the starting duration (e.g., `'25:00'`).
5. Assert status is `idle`.
6. Assert session history count is still `H` (no new session added).

**Expected Assertions:**
- Timer resets to full configured duration.
- History count unchanged after reset.

---

#### TC-604: Session history displays all completed sessions most-recent first

| Field | Value |
|-------|-------|
| **Requirement** | FR-010 |
| **Type** | E2E |
| **Priority** | P0 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Test Steps:**
1. Complete session titled `'First session'`.
2. Complete session titled `'Second session'`.
3. Observe the history list.
4. Assert `'Second session'` appears before `'First session'`.

**Expected Assertions:**
- Sessions are ordered most-recent first.
- Both sessions show title, duration, timer type, and a timestamp.

---

#### TC-605: Session history persists across app restarts

| Field | Value |
|-------|-------|
| **Requirement** | FR-020 |
| **Type** | E2E |
| **Priority** | P1 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Scenario:**
```gherkin
Given I have completed 2 sessions
When I close and reopen the app
Then both sessions still appear in the history
```

**Test Steps:**
1. Complete a session. Note its title `'Persistent session'`.
2. Close Electron app.
3. Re-launch Electron app.
4. Assert `'Persistent session'` is visible in the history.

**Expected Assertions:**
- Session data is durably written to SQLite.
- Data survives app restart.

---

#### TC-606: Empty history state shown for new users

| Field | Value |
|-------|-------|
| **Requirement** | FR-021 |
| **Type** | E2E |
| **Priority** | P1 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Test Steps:**
1. Launch app with empty database (fresh install or cleared userData).
2. Navigate to or scroll to session history area.
3. Assert empty state message is visible.
4. Assert no session items are rendered.

**Expected Assertions:**
- Empty state message visible (e.g., "No sessions yet. Start your first session!").
- History list contains no items.

---

#### TC-607: Delete session removes it from UI and database

| Field | Value |
|-------|-------|
| **Requirement** | FR-022 |
| **Type** | E2E |
| **Priority** | P1 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Test Steps:**
1. Complete a session titled `'To Delete'`.
2. Assert it appears in history.
3. Click the delete button on the `'To Delete'` session item.
4. Assert `'To Delete'` is no longer visible.
5. Restart app.
6. Assert `'To Delete'` does not reappear (confirms database deletion).

**Expected Assertions:**
- Session is immediately removed from UI.
- Session is deleted from database (not reappearing after restart).

---

#### TC-608: Work and break timer types have distinct visual treatment

| Field | Value |
|-------|-------|
| **Requirement** | FR-023 |
| **Type** | E2E |
| **Priority** | P1 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Test Steps:**
1. With timer type `'Work'` selected, note the CSS class or background color of the timer container.
2. Click `'Short Break'`.
3. Note the class/color of the timer container.
4. Assert they differ.

**Expected Assertions:**
- The timer container has a different visual appearance for `work` vs `short_break` modes.
- Can be verified via `getAttribute('class')` or computed style color.

---

#### TC-609: Custom duration settings persist across app restart (P2)

| Field | Value |
|-------|-------|
| **Requirement** | FR-031 |
| **Type** | E2E |
| **Priority** | P2 |
| **File** | `e2e/tomato-clock.spec.ts` |

**Test Steps:**
1. Change work duration to 30 minutes via settings UI (if available).
2. Assert timer display shows `'30:00'`.
3. Close and reopen app.
4. Assert timer display still shows `'30:00'`.

**Expected Assertions:**
- Custom settings survive app restart.
- Timer display reflects the custom duration on next launch.

---

### 3.10 Build Verification Test

**Test file:** `e2e/build.spec.ts` (or a CI shell script / npm test script)

---

#### TC-700: build:main script succeeds with --external better-sqlite3

| Field | Value |
|-------|-------|
| **Requirement** | Apollo SA major finding: native addon must be external |
| **Type** | Build |
| **Priority** | P0 |
| **File** | `e2e/build.spec.ts` |

**Setup:** Run `bun run build:main` in CI.

**Test Steps:**
1. Verify `package.json` `build:main` script contains `--external better-sqlite3`.
2. Run `bun run build:main` and assert exit code is `0`.
3. Inspect `dist/main/index.js` — assert it does NOT contain the `better-sqlite3` native addon binary inline.
4. Assert `dist/main/index.js` contains a `require('better-sqlite3')` or `import` reference (dynamically loaded, not bundled).

**Expected Result:**
- Build succeeds (exit code 0).
- `better-sqlite3` is referenced externally in the bundle, not inlined.
- Electron loads the native `.node` file at runtime from `node_modules`.

**Edge Cases:**
- If `--external better-sqlite3` is missing: build will fail or produce a broken bundle. This test catches that regression.

---

## 4. Edge Cases & Boundaries

| Category | Test Case | Input | Expected |
|----------|-----------|-------|----------|
| Boundary | Min valid duration | `60` seconds | Accepted |
| Boundary | Max valid duration | `7200` seconds | Accepted |
| Boundary | Below min duration | `59` seconds | Rejected (error) |
| Boundary | Above max duration | `7201` seconds | Rejected (error) |
| Boundary | Zero duration | `0` seconds | Rejected (error) |
| Boundary | Negative duration | `-1` seconds | Rejected (error) |
| Boundary | Empty title | `''` | Accepted (empty string stored) |
| Boundary | Max title length | `500` chars | Accepted |
| Boundary | Over max title | `501` chars | Truncated or rejected |
| Boundary | Whitespace-only title | `'   '` | Trimmed to `''` |
| Timer | Zero seconds remaining | `remainingSeconds: 0` | `formatTime(0) === '00:00'` |
| Timer | Tick fires late (drift) | Interval fires 50ms late | Remaining time computed from wall clock, not interval count |
| Timer | System time jump forward | `Date.now()` returns value 25 min ahead | Timer immediately completes on next tick |
| Timer | Pause and resume many times | 10 pause/resume cycles | Accumulated time is correct, no drift |
| Timer | Reset after many pauses | Pause 5x then reset | Returns to full duration, `accumulatedActiveMs: 0` |
| DB | Empty session list | No sessions in DB | `{ sessions: [], total: 0 }` |
| DB | Delete non-existent ID | `deleteSession('fake-id')` | No-op, no error |
| DB | Concurrent saves | Multiple saves in quick succession | All saved with unique IDs |
| IPC | Invalid timer type | `'hacked'` as timerType | Rejected at main process handler |
| IPC | SQL injection in title | `"'; DROP TABLE sessions;--"` | Title stored as plain text, schema intact |

---

## 5. Security Tests Summary

| Test | Description | Expected | TC |
|------|-------------|----------|----|
| No direct Node.js in renderer | Renderer context has no `require` | `typeof require === 'undefined'` | TC-550 |
| IPC timerType validation | Unknown values rejected at main process | Error thrown/returned | TC-551 |
| IPC duration range validation | Out-of-range values rejected | Error thrown/returned | TC-552 |
| SQL injection via title | Malicious SQL in title field | Title stored as string, DB intact | TC-551 (title variant) |
| Prototype pollution via timerType | `'__proto__'` as timerType | Rejected, no pollution | TC-551 |
| Context isolation | `window.electronAPI` is the only bridge | No Electron internals accessible | TC-550 |

---

## 6. Performance Tests

| Test | Scenario | Threshold | TC |
|------|----------|-----------|----|
| History query — 1,000 records | `listSessions({ limit: 50, offset: 0 })` with 1,000 rows in DB | < 500ms | TC-405 |
| Timer tick overhead | 4 dispatches/sec during active timer | No visible jank; CPU < 1% for tick alone | Manual |
| App startup to timer-ready | Launch Electron to first interactive frame | < 2 seconds | Manual (TC-601 observes startup) |
| Save session write | `saveSession(...)` single write | < 10ms | Assert in TC-302 |

---

## 7. Test Data Requirements

| Data Set | Purpose | Source |
|----------|---------|--------|
| Default settings object | Baseline for all timer tests | Hardcoded in test files: `{ workDuration: 1500, shortBreakDuration: 300, longBreakDuration: 900 }` |
| Mock Session object | Rendering history components | Hardcoded: `{ id: 'mock-uuid', title: 'Test', timerType: 'work', plannedDurationSeconds: 1500, actualDurationSeconds: 1498, completedAt: '2026-02-19T10:00:00.000Z' }` |
| 1,000 session batch | Performance test | Generated in `beforeAll` via loop in `TC-405` |
| Empty database | New user tests (TC-606, TC-322) | Fresh `:memory:` DB or cleared `userData` directory |
| Short-duration settings | E2E fast completion | `{ workDuration: 3, shortBreakDuration: 3, longBreakDuration: 3 }` injected before E2E session tests |

---

## 8. Test Environment

| Environment | Purpose | Config |
|-------------|---------|--------|
| Unit / Component (jsdom) | Vitest, `@testing-library/react`, hook tests | `vitest.config.ts` `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']` |
| Unit (node) | Database module tests, IPC handler tests | `// @vitest-environment node` pragma in `src/main/__tests__/*.test.ts` |
| E2E (Electron) | Full app integration tests | Playwright + `electron-playwright-helpers`. Requires `bun run build` before running. Test dir: `./e2e` |
| CI | All above | Must run `@electron/rebuild` after install to compile `better-sqlite3` native module. |

**Vitest config note:** The existing `vitest.config.ts` uses `environment: 'jsdom'` globally. Database tests in `src/main/__tests__/` require the Node.js environment. Add the `environmentMatchGlobs` option to allow per-file overrides:

```typescript
// vitest.config.ts addition (for implementer reference)
environmentMatchGlobs: [
  ['src/main/**', 'node'],
]
```

---

## 9. Acceptance Criteria Verification

| AC ID | Acceptance Criteria (from PRD) | Test Cases | Pass Criteria |
|-------|-------------------------------|------------|---------------|
| AC-001 | When work duration changed to 30 min, timer shows 30:00 on start | TC-108, TC-601, TC-609 | `remainingSeconds === 1800` in state; `'30:00'` displayed |
| AC-002 | Fresh install defaults: 25 min work, 5 min short break, 15 min long break | TC-101, TC-309, TC-601 | Default state values match spec |
| AC-003 | Typed title saved with completed session record | TC-302, TC-504, TC-601 | `session.title` matches typed title in DB and UI |
| AC-004 | Timer starts countdown on Start press, updates every second | TC-102, TC-501, TC-601 | Status transitions; `remainingSeconds` decrements |
| AC-005 | Pause stops countdown; Resume continues from same value | TC-103, TC-502, TC-602 | `remainingSeconds` frozen during pause |
| AC-006 | Reset returns to configured duration; session NOT recorded | TC-104, TC-503, TC-603 | `status === idle`, `remainingSeconds === configured`, no IPC save call |
| AC-007 | Remaining time shown in MM:SS updating every second | TC-201, TC-210, TC-501 | `formatTime` tests pass; component renders correctly |
| AC-008 | Timer completion: UI shows distinct completed state | TC-106, TC-211, TC-504, TC-601 | `status === 'completed'`, completion visual element present |
| AC-009 | Completed session written to SQLite with title, duration, type, timestamp | TC-302, TC-504, TC-601 | Database row has all four fields populated correctly |
| AC-010 | History shows sessions: title, duration, type, completion time | TC-320, TC-321, TC-604 | All fields visible in rendered list |
| AC-011 | Timer type selection updates duration to match type | TC-108, TC-216, TC-601 | `remainingSeconds` updates; display changes |
| AC-012 | History persists after app restart | TC-605 | Sessions visible after Electron relaunch |
| AC-013 | Empty state shown when no sessions exist | TC-322, TC-606 | Empty message visible; no list items |
| AC-014 | Delete removes session from UI and database | TC-307, TC-323, TC-607 | Session gone after delete; confirmed after restart |
| AC-015 | Visual distinction between work and break modes | TC-217, TC-608 | Different CSS class/style applied per timer type |
| AC-016 | Timer drift < 1 second over 25 minutes | TC-501 (wall-clock), TC-113 | Wall-clock computation verified; no interval counting |
| AC-017 | History loads 1,000 records in < 500ms | TC-405 | Query time measured under threshold |
| AC-018 | Database created automatically on first use | TC-301, TC-316 | Schema created on `initDatabase()` call; idempotent |
| AC-019 | Renderer has no direct Node.js or DB access | TC-550 | `require` undefined in renderer; `electronAPI` is sole bridge |
| AC-020 | Build completes with better-sqlite3 as external | TC-700 | `bun run build:main` succeeds; `--external` flag present |

---

## 10. Test Summary

| Type | Count | P0 | P1 | P2 |
|------|-------|----|----|----|
| Unit — Timer Reducer | 13 | 11 | 2 | 0 |
| Unit — Format Utilities | 2 | 1 | 1 | 0 |
| Unit — Database Module | 16 | 10 | 5 | 0 |
| Unit — Custom Hooks | 5 | 4 | 1 | 0 |
| Component | 15 | 11 | 3 | 1 |
| Integration — IPC Layer | 5 | 4 | 1 | 0 |
| Security | 3 | 3 | 0 | 0 |
| E2E | 9 | 5 | 3 | 1 |
| Build Verification | 1 | 1 | 0 | 0 |
| **Total** | **69** | **50** | **16** | **2** |

### Critical P0 Test Files Summary

| File | Test Count | Coverage |
|------|-----------|---------|
| `src/renderer/src/hooks/__tests__/timerReducer.test.ts` | 13 | All FSM transitions, illegal transitions, SET_TITLE, SET_TIMER_TYPE |
| `src/main/__tests__/database.test.ts` | 16 | Schema creation, CRUD, pagination, ordering, validation, defaults |
| `src/renderer/src/utils/__tests__/format.test.ts` | 2 | formatTime all cases including edge cases |
| `src/renderer/src/hooks/__tests__/useTimer.test.ts` | 5 | Start, pause, reset, complete, save error |
| `src/renderer/src/hooks/__tests__/useSessionHistory.test.ts` | 3 | Fetch, delete, error |
| `src/renderer/src/hooks/__tests__/useSettings.test.ts` | 2 | Load, save |
| `src/renderer/src/components/__tests__/TimerDisplay.test.tsx` | 2 | MM:SS render, completion state |
| `src/renderer/src/components/__tests__/TimerControls.test.tsx` | 4 | Button state per FSM status |
| `src/renderer/src/components/__tests__/SessionHistory.test.tsx` | 3 | List render, empty state, item data |
| `src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx` | 1 | Delete button interaction |
| `src/main/__tests__/ipc-handlers.test.ts` | 5 | IPC handler round-trips |
| `src/main/__tests__/security.test.ts` | 3 | Input validation at IPC boundary |
| `e2e/tomato-clock.spec.ts` | 9 | Full user flows in real Electron |
| `e2e/build.spec.ts` | 1 | Build script native addon exclusion |

---

## 11. SA Review Findings — Test Coverage

The following items from Apollo's SA review (`spec-review-sa.md`) have explicit test coverage:

| SA Finding | Test Case(s) | How Tested |
|------------|-------------|------------|
| Major: `--external better-sqlite3` in build script | TC-700 | Build verification: assert flag present, build succeeds |
| Minor 1: Input validation in main process, not renderer | TC-312, TC-313, TC-551, TC-552 | Call IPC handlers directly with invalid inputs; assert rejection at handler |
| Minor 2: DB init failure handling | TC-316 + manual | TC-316 verifies idempotency; `dialog.showErrorBox` behavior is manual E2E |
| Minor 3: Session save trigger (useEffect on `completed` status) | TC-504 | Verify `electronAPI.session.save` called when status reaches `'completed'` |
| Minor 4: SET_TITLE allowed in RUNNING and PAUSED states | TC-109 | Call SET_TITLE reducer with running and paused starting states |
