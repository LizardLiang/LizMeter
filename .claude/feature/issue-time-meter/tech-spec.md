# Technical Specification

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Issue Time Meter (Stopwatch Mode) |
| **Author** | Hephaestus (Tech Spec Agent) |
| **Status** | Draft |
| **Date** | 2026-02-24 |
| **PRD Version** | 1.0 |

---

## 1. Overview

### Summary
Add a "Time Tracking Mode" to LizMeter that provides a count-up stopwatch for open-ended time tracking, complementing the existing Pomodoro countdown timer. Users can link issues from Jira/Linear when starting a stopwatch session, and completed stopwatch sessions appear in the unified session history with a distinct "Stopwatch" badge.

### Goals
- Extend the timer system with a count-up stopwatch mode
- Reuse the existing `sessions` table with a new `timer_type = "stopwatch"` value
- Add a top-level mode toggle between "Pomodoro Mode" and "Time Tracking Mode"
- Auto-prompt for issue linkage when starting a stopwatch session
- Display stopwatch sessions in the unified session history with a badge
- Add configurable maximum stopwatch duration setting (default 8 hours, "No limit" option)

### Non-Goals
- Concurrent timers (running Pomodoro and Stopwatch simultaneously)
- Billing/invoicing features
- Time entry editing after session completion
- Reporting/analytics dashboards
- Exporting time data to Jira/Linear worklogs

---

## 2. Architecture

### System Context
The stopwatch mode integrates into the existing Electron IPC architecture:

```
React UI (StopwatchView)
    │
    ▼
useStopwatch hook (new) ←→ useTimer hook (extended)
    │
    ▼
window.electronAPI (preload) — existing channels
    │
    ▼
IPC Handlers (session:save, settings:get/save)
    │
    ▼
SQLite (sessions table — new "stopwatch" timer_type value)
```

### Component Diagram
```
┌─────────────────────────────────────────────────────┐
│  TomatoClock.tsx (extended with mode toggle)         │
│  ┌───────────────────────────────────────────────┐  │
│  │  ModeToggle (new)                             │  │
│  │  [ Pomodoro  |  Time Tracking ]               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  TimerView       │  │  StopwatchView (new)    │  │
│  │  (existing,      │  │  ┌─────────────────┐   │  │
│  │   shown when     │  │  │ Elapsed Display  │   │  │
│  │   mode=pomodoro) │  │  │ HH:MM:SS        │   │  │
│  │                  │  │  ├─────────────────┤   │  │
│  │                  │  │  │ IssuePrompt     │   │  │
│  │                  │  │  │ (modal dialog)  │   │  │
│  │                  │  │  ├─────────────────┤   │  │
│  │                  │  │  │ Controls        │   │  │
│  │                  │  │  │ Start/Pause/Stop│   │  │
│  │                  │  │  └─────────────────┘   │  │
│  └─────────────────┘  └─────────────────────────┘  │
│                                                     │
│  HistoryPage (extended — stopwatch badge)           │
│  SettingsPage (extended — max duration setting)      │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions
| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| New `timer_type = "stopwatch"` value | Fits existing TEXT column pattern. Minimal schema change. No migration. | Separate `stopwatch_sessions` table — rejected, unnecessary duplication |
| Separate `useStopwatch` hook | Keeps stopwatch-specific logic (issue prompt, max duration, count-up) isolated. Avoids coupling with Pomodoro `useTimer`. | Extend `useTimer` directly — rejected, too much complexity in one reducer |
| `planned_duration_seconds = 0` for stopwatch | Column has `NOT NULL` constraint. 0 is semantically "no planned duration". | NULL — requires schema migration to drop NOT NULL. Negative value — too hacky |
| Mode toggle in `TomatoClock.tsx` | Consistent with existing page-based navigation. Simple conditional rendering. | Separate NavSidebar page — rejected, timer should stay on timer page |
| Auto-prompt via modal dialog | Clear UX for "prompt to link issue, allow skipping". | Inline prompt — harder to dismiss cleanly |
| Max duration stored as setting key | Consistent with existing `settings` table key-value pattern. | Hardcoded — inflexible |
| Guard mode switch while timer active | Prevents data loss. Disable toggle + tooltip. | Auto-stop — could lose work unexpectedly |

---

## 3. Data Model

### Database Schema Changes

**No new tables required.** The existing schema is extended:

#### `sessions` table — no DDL change
The `timer_type` column is TEXT with no CHECK constraint. Adding `"stopwatch"` as a value is compatible without any ALTER TABLE.

For stopwatch sessions:
- `timer_type` = `"stopwatch"`
- `planned_duration_seconds` = `0` (no planned duration)
- `actual_duration_seconds` = elapsed seconds from stopwatch
- Issue fields (`issue_provider`, `issue_id`, `issue_title`, `issue_url`) populated if user linked an issue

#### `settings` table — new keys (lazy insert, no migration)
| Key | Default Value | Description |
|-----|---------------|-------------|
| `stopwatch.max_duration_seconds` | `"28800"` (8 hours) | Max stopwatch duration. `"0"` = no limit. |
| `stopwatch.prompt_for_issue` | `"true"` | Whether to show issue prompt on start. |
| `app.mode` | `"pomodoro"` | Last-used mode, persisted across restarts. |

#### Validation Changes

In `database.ts`:
- `VALID_TIMER_TYPES` array: add `"stopwatch"`
- `saveSession()`: skip `plannedDurationSeconds > 0` validation when `timerType === "stopwatch"` (allow 0)

---

## 4. Type Changes (`src/shared/types.ts`)

```typescript
// Extend TimerType
export type TimerType = "work" | "short_break" | "long_break" | "stopwatch";

// New types
export type AppMode = "pomodoro" | "time-tracking";

export interface StopwatchSettings {
  maxDurationSeconds: number; // 0 = no limit
  promptForIssue: boolean;
}
```

No changes needed to `SaveSessionInput`, `Session`, `ElectronAPI`, or other existing types. The `timerType` field already accepts the extended `TimerType` union.

---

## 5. Implementation Plan

### Phase 1: Core Stopwatch Timer

#### New Files
| File | Purpose |
|------|---------|
| `src/renderer/src/hooks/useStopwatch.ts` | Stopwatch hook — independent count-up timer using `useReducer`, wall-clock arithmetic (same pattern as `useTimer`), max duration enforcement |
| `src/renderer/src/components/StopwatchView.tsx` | Stopwatch UI — elapsed time display (HH:MM:SS), Start/Pause/Resume/Stop controls, linked issue badge |
| `src/renderer/src/components/ModeToggle.tsx` | Segmented control to switch between Pomodoro and Time Tracking modes |

#### Modified Files
| File | Changes |
|------|---------|
| `src/shared/types.ts` | Add `"stopwatch"` to `TimerType`, add `AppMode`, `StopwatchSettings` types |
| `electron/main/database.ts` | Add `"stopwatch"` to `VALID_TIMER_TYPES`, relax `plannedDurationSeconds` validation for stopwatch |
| `src/renderer/src/components/TomatoClock.tsx` | Add mode state, render `ModeToggle`, conditionally render `TimerView` or `StopwatchView`, guard mode switch when timer active |

### Phase 2: Issue Prompt & Linkage

#### New Files
| File | Purpose |
|------|---------|
| `src/renderer/src/components/IssuePromptDialog.tsx` | Modal dialog shown on stopwatch start — browse Jira/Linear issues, type custom title, or skip |

#### Modified Files
| File | Changes |
|------|---------|
| `src/renderer/src/components/StopwatchView.tsx` | Integrate `IssuePromptDialog`, wire issue selection to session save |

### Phase 3: History Badge & Settings

#### Modified Files
| File | Changes |
|------|---------|
| `src/renderer/src/components/SessionHistoryItem.tsx` | Add "Stopwatch" badge for `timerType === "stopwatch"`, show elapsed time format instead of "planned vs actual" |
| `src/renderer/src/components/SettingsPage.tsx` | Add "Time Tracking" section with max duration input and "No limit" checkbox |
| `src/renderer/src/hooks/useSettings.ts` | Load/save `stopwatch.max_duration_seconds` and `stopwatch.prompt_for_issue` via existing `settings:get`/`settings:save` or direct key-value IPC |

---

## 6. Detailed Component Specifications

### 6.1 `useStopwatch` Hook

A new independent hook (does NOT wrap `useTimer`) with its own reducer for count-up logic:

**State:**
```typescript
interface StopwatchState {
  status: "idle" | "running" | "paused";
  elapsedSeconds: number;
  title: string;
  linkedIssue: IssueRef | null;
  startedAtWallClock: number | null;
  accumulatedActiveMs: number;
}
```

**Actions:** `START`, `PAUSE`, `RESUME`, `STOP`, `TICK_UP`, `SET_TITLE`, `SET_LINKED_ISSUE`

**Tick behavior:**
- 250ms interval (same as existing timer)
- Wall-clock arithmetic: `elapsedSeconds = Math.round((accumulatedActiveMs + (Date.now() - startedAtWallClock)) / 1000)`
- Max duration check on each tick: if `maxDuration > 0 && elapsedSeconds >= maxDuration`, auto-stop

**Session save (on STOP or auto-stop):**
```typescript
window.electronAPI.session.save({
  title: state.title,
  timerType: "stopwatch",
  plannedDurationSeconds: 0,
  actualDurationSeconds: state.elapsedSeconds,
  issueProvider: state.linkedIssue?.provider,
  issueId: /* derived from linkedIssue */,
  issueTitle: state.linkedIssue?.title,
  issueUrl: state.linkedIssue?.url,
});
```

### 6.2 `StopwatchView` Component

**Layout (top to bottom):**
1. Session title input (same style as TimerView's `SessionTitleInput`)
2. Elapsed time display — large `HH:MM:SS` format, `var(--tokyoNight-blue)` color
3. Linked issue badge (if selected) — clickable to open URL
4. Control buttons: Start / Pause / Resume / Stop
5. Tag picker (when running/paused, same as Pomodoro flow)

**Styling:** Tokyo Night theme, inline `React.CSSProperties`, consistent with `TimerView`.

### 6.3 `ModeToggle` Component

Segmented control / pill toggle rendered above the timer area in `TomatoClock.tsx`:
```
[ Pomodoro  |  Time Tracking ]
```

- Active segment: `var(--tokyoNight-blue)` background with white text
- Inactive segment: transparent with `var(--tokyoNight-comment)` text
- **Disabled** when any timer (Pomodoro or Stopwatch) is running/paused — show tooltip: "Stop active timer to switch modes"
- Mode persisted to `app.mode` setting on change

### 6.4 `IssuePromptDialog` Component

Modal overlay shown when user clicks Start in Time Tracking mode (if `promptForIssue` setting is true):

- **Title:** "Link an issue (optional)"
- **Content:** Tabs for configured providers (Jira / Linear), reusing existing `useIssues` patterns
- **Actions:**
  - "Skip" — closes dialog, starts timer with no linked issue
  - "Link & Start" — closes dialog, sets linked issue, starts timer
- **If no providers configured:** Show hint to configure in settings, only "Skip" available

### 6.5 Session History Badge

In `SessionHistoryItem.tsx`, when `session.timerType === "stopwatch"`:

- Show "Stopwatch" badge with styling:
  - Background: `rgba(125, 207, 255, 0.15)` (Tokyo Night cyan, 15% opacity)
  - Text: `#7dcfff` (Tokyo Night cyan)
  - Border-radius: 4px, padding: 2px 8px, font-size: 11px
- Duration display: show `actualDurationSeconds` formatted as `Xh Ym Zs` (no "of planned" text)
- If linked issue exists: show issue key as a secondary badge

### 6.6 Settings Extension

Add to `SettingsPage` under a new "Time Tracking" section:

- **Max Duration:** Number input for hours (0-24), with "No limit" checkbox
  - When "No limit" checked, stores `0` as the setting value
  - Default: 8 hours (28800 seconds)
- **Issue Prompt:** Toggle switch for "Prompt to link issue on start"
  - Default: enabled

---

## 7. Security Considerations

- No new IPC channels — reuses existing `session:save` and `settings:get`/`settings:save`
- Input validation: `"stopwatch"` added to `VALID_TIMER_TYPES` whitelist in `database.ts`
- `plannedDurationSeconds` validation relaxed only for `timerType === "stopwatch"`
- No new external API calls or network access

---

## 8. Performance Considerations

- Stopwatch tick reuses the proven 250ms interval + wall-clock arithmetic pattern
- No additional database queries during stopwatch running — only on save
- Max duration check is a simple integer comparison in the tick handler
- Mode toggle is a simple conditional render — no unmount/remount of heavy components (use CSS display or conditional JSX)

---

## 9. Testing Strategy

### Unit Tests

#### `useStopwatch` hook
| Test | Description |
|------|-------------|
| Count-up tick | Verify `elapsedSeconds` increments correctly |
| Pause excludes time | Verify paused time is not counted |
| Max duration auto-stop | Verify timer stops at configured max |
| No limit mode | Verify timer continues past default max when set to 0 |
| Session save on stop | Verify correct `SaveSessionInput` with `timerType: "stopwatch"`, `plannedDurationSeconds: 0` |
| Issue linkage | Verify linked issue fields included in save |

#### `ModeToggle`
| Test | Description |
|------|-------------|
| Renders both options | Both "Pomodoro" and "Time Tracking" visible |
| Toggle fires callback | Clicking inactive segment fires `onModeChange` |
| Disabled when active | Toggle is disabled when `timerActive` prop is true |

#### Database
| Test | Description |
|------|-------------|
| Save stopwatch session | `saveSession` with `timerType: "stopwatch"`, `plannedDurationSeconds: 0` succeeds |
| List includes stopwatch | `listSessions` returns stopwatch sessions alongside Pomodoro sessions |
| Validation rejects invalid | `timerType: "invalid"` still rejected |

### Integration Tests
- Full stopwatch flow: start → run → pause → resume → stop → verify in history
- Issue linking flow: start → select issue → stop → verify issue fields saved
- Mode toggle with guard: attempt switch while running → verify blocked

---

## 10. Rollout Plan

Standard desktop app release. The feature is additive:
- No breaking schema changes
- Existing Pomodoro sessions are unaffected
- Stopwatch sessions with `timer_type = "stopwatch"` are simply ignored by older versions
- Rollback: standard git revert

---

## 11. Open Questions

| Question | Status | Resolution |
|----------|--------|------------|
| Should the mode toggle persist across restarts? | Resolved | Yes — store `app.mode` in settings table |
| Default max duration? | Resolved | 8 hours (28800s), with "No limit" option |
| Discard option (stop without saving)? | Open | Low priority, can add later. For now, user can just reset. |
| App crash recovery for running stopwatch? | Deferred to P1 | Would require persisting in-progress state to SQLite |