# Test Plan

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | issue-time-meter (Time Tracking Mode) |
| **Author** | Artemis (QA Agent) |
| **Date** | 2026-02-24 |
| **PRD Version** | 1.0 |
| **Tech Spec Version** | 1.0 |

---

## 1. Test Overview

### Scope
All testable behavior for the Time Tracking Mode feature:
- `useStopwatch` hook FSM (idle, running, paused, max-duration enforcement)
- `ModeToggle` component rendering and mode switching
- `StopwatchView` component interactions
- `IssuePromptDialog` display logic and skip behavior
- Database validation changes for `timerType: "stopwatch"`
- Settings persistence for stopwatch config keys
- Session history display with "Stopwatch" badge

### Test Approach
- **Unit tests**: Vitest with jsdom; better-sqlite3 shimmed via `src/test/better-sqlite3-shim.ts`; `window.electronAPI` mocked via `vi.stubGlobal`
- **Integration tests**: Database tests using `initDatabase(":memory:")`
- **E2E tests**: Playwright (requires `bun run build` first)

---

## 2. Requirements Coverage Matrix

| Req ID | Requirement | Test Cases | Priority |
|--------|-------------|------------|----------|
| FR-001 | Mode toggle | TC-001, TC-002, TC-003 | P0 |
| FR-002 | Count-up stopwatch | TC-010, TC-011, TC-012 | P0 |
| FR-003 | Start/Pause/Resume/Stop FSM | TC-010, TC-013, TC-014, TC-015 | P0 |
| FR-004 | Auto-prompt issue dialog | TC-020, TC-021, TC-022 | P0 |
| FR-005 | Save stopwatch sessions | TC-040, TC-041 | P0 |
| FR-006 | Unified history with badge | TC-050, TC-051 | P1 |
| FR-007 | Configurable max duration | TC-016, TC-017, TC-018 | P0 |
| FR-013 | Skip prompt setting | TC-023, TC-060 | P1 |

---

## 3. Test Cases

### useStopwatch Hook (`src/renderer/src/hooks/__tests__/useStopwatch.test.ts`)

#### TC-010: Initial state is idle
- Render hook with `maxDurationSeconds: 28800`
- Assert: `status === "idle"`, `elapsedSeconds === 0`

#### TC-011: start() transitions to running, elapsed increments
- `vi.useFakeTimers()`, call `start()`
- Advance 1000ms
- Assert: `status === "running"`, `elapsedSeconds === 1`

#### TC-012: Wall-clock arithmetic correctness
- Start, advance 5050ms (simulating jitter)
- Assert: `elapsedSeconds === 5` (uses wall-clock, not tick count)

#### TC-013: pause() stops elapsed increment
- Running with 10s elapsed, call `pause()`
- Advance 5000ms
- Assert: `status === "paused"`, `elapsedSeconds === 10` (unchanged)

#### TC-014: resume() continues from correct elapsed
- Paused with 10s elapsed, call `resume()`
- Advance 5000ms
- Assert: `elapsedSeconds === 15` (10 pre-pause + 5 post-resume)

#### TC-015: stop() saves session and resets
- Running state, call `stop()`
- Assert: `session.save` called with `timerType: "stopwatch"`, `plannedDurationSeconds: 0`
- Assert: state resets to idle, `elapsedSeconds === 0`

#### TC-016: Max duration auto-completes
- `maxDurationSeconds: 10`, start, advance 10001ms
- Assert: auto-completed, `onComplete` fired

#### TC-017: No limit mode (maxDurationSeconds = 0)
- `maxDurationSeconds: 0`, start, advance 100 hours
- Assert: still running, no auto-complete

#### TC-018: Max duration boundary
- `maxDurationSeconds: 60`, advance 59750ms → still running
- Advance 250ms more → completed

---

### ModeToggle Component (`src/renderer/src/components/__tests__/ModeToggle.test.tsx`)

#### TC-001: Renders both mode options
- Render with `mode="pomodoro"`
- Assert: "Pomodoro" and "Time Tracking" labels visible

#### TC-002: Toggle fires onChange with correct mode
- Click "Time Tracking" → `onChange("time-tracking")`
- Click "Pomodoro" → `onChange("pomodoro")`

#### TC-003: Disabled when timer active
- Render with `disabled={true}`
- Click "Time Tracking" → `onChange` NOT called

---

### StopwatchView Component (`src/renderer/src/components/__tests__/StopwatchView.test.tsx`)

#### TC-031: Displays elapsed as HH:MM:SS
- Render with `elapsedSeconds: 3661`
- Assert: displays `"01:01:01"`
- Edge: `elapsedSeconds: 0` → `"00:00:00"`

#### TC-032: Start button shows issue dialog when prompt enabled
- Setting `stopwatch.prompt_for_issue = true`
- Click Start → `IssuePromptDialog` appears in DOM

#### TC-033: Start skips dialog when prompt disabled
- Setting `stopwatch.prompt_for_issue = false`
- Click Start → no dialog, stopwatch starts immediately

#### TC-034: Control buttons match state
- Running: Pause visible, Start hidden
- Paused: Resume + Stop visible
- Idle: Start visible

#### TC-035: Stop saves session via IPC
- Running with 120s elapsed, click Stop
- Assert: `session.save` called with `{ timerType: "stopwatch", plannedDurationSeconds: 0, actualDurationSeconds: 120 }`

---

### IssuePromptDialog (`src/renderer/src/components/__tests__/IssuePromptDialog.test.tsx`)

#### TC-020: Renders issue list from providers
- Mock issues returned
- Assert: issue titles visible in dialog

#### TC-021: Selecting issue calls onSelect
- Click issue → `onSelect` called with issue data

#### TC-022: Dialog closes after selection, timer starts
- Select issue → dialog unmounted → stopwatch running

#### TC-023: Skip button starts without issue
- Click "Skip" → `onSkip` called → stopwatch running, no linked issue

---

### Database Integration (`electron/main/__tests__/database.test.ts`)

#### TC-040: saveSession accepts timerType "stopwatch" with plannedDurationSeconds 0
- `initDatabase(":memory:")`
- Call `saveSession({ timerType: "stopwatch", plannedDurationSeconds: 0, actualDurationSeconds: 300, ... })`
- Assert: row inserted with correct values

#### TC-041: saveSession rejects invalid timerType
- Call `saveSession({ timerType: "invalid" })` → throws validation error

#### TC-042: listSessions returns mixed types
- Insert 1 pomodoro + 1 stopwatch session
- Call `listSessions()`
- Assert: both sessions returned with correct `timerType`

---

### Session History (`src/renderer/src/components/__tests__/SessionHistoryItem.test.tsx`)

#### TC-050: Stopwatch badge shown for stopwatch sessions
- Render item with `timerType: "stopwatch"`
- Assert: "Stopwatch" badge with cyan styling visible

#### TC-051: Elapsed-only display for stopwatch
- `actualDurationSeconds: 3661, timerType: "stopwatch"`
- Assert: shows `"1h 1m 1s"`, no "of planned" text

---

### Settings (`src/renderer/src/components/__tests__/SettingsPage.test.tsx`)

#### TC-060: Settings page shows stopwatch section
- Render SettingsPage
- Assert: "Max Duration" input and "Prompt for issue" toggle visible

#### TC-061: Toggle prompt_for_issue saves setting
- Click toggle → `settings.save` called with updated value

#### TC-062: Change max duration saves setting
- Select "No limit" → saves `stopwatch.max_duration_seconds: "0"`
- Select "4 hours" → saves `"14400"`

#### TC-063: app.mode persists across restarts
- Save `app.mode: "time-tracking"`, re-init, read back → `"time-tracking"`

---

### Regression (`src/renderer/src/hooks/__tests__/useTimer.test.ts`)

#### TC-070: Existing useTimer countdown unaffected
- Verify all existing useTimer tests still pass
- Focus on: `getDurationForType` handles new `TimerType` union without breaking

---

### E2E (`e2e/time-tracking.spec.ts`)

#### TC-E01: Full stopwatch flow
1. Toggle to Time Tracking mode
2. Click Start → skip issue prompt
3. Wait 5 seconds → verify display shows ~00:00:05
4. Pause → Resume → Stop
5. Verify session in history with "Stopwatch" badge

---

## 4. Edge Cases

| Case | Input | Expected |
|------|-------|----------|
| Complete immediately | Stop right after start | Session saved with ~0 seconds |
| Max duration exactly 8h | Run for 28800s | Auto-completes at boundary |
| Rapid start/pause/resume | <100ms between actions | FSM stays consistent |
| Issue prompt with no providers configured | No Jira/Linear | Dialog shows "Skip" only |
| Issue prompt API failure | Network error | Error shown, "Skip" still available |
| Very long display | 100h elapsed | Shows `100:00:00` without overflow |
| Mode switch while running | Toggle disabled | Toggle does not respond |

---

## 5. Test Summary

| Type | Count | P0 | P1 |
|------|-------|----|-----|
| Unit (hooks) | 9 | 7 | 2 |
| Unit (components) | 10 | 6 | 4 |
| Integration (DB) | 3 | 3 | 0 |
| Regression | 1 | 1 | 0 |
| E2E | 1 | 1 | 0 |
| **Total** | **24** | **18** | **6** |