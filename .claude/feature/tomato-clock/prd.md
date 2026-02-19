# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Tomato Clock (Pomodoro Timer) |
| **Author** | Athena (PM Agent) |
| **Status** | Draft |
| **Date** | 2026-02-19 |
| **Version** | 1.0 |

---

## 1. Executive Summary

Tomato Clock adds a Pomodoro Timer to the LizMeter desktop application. Users will be able to run timed focus sessions (defaulting to the classic 25/5/15 Pomodoro pattern), label each session with a descriptive title, and review their completed session history over time.

The feature targets individual users who want a lightweight, local-first productivity timer without relying on cloud services or browser tabs. All session data is persisted to a local SQLite database, ensuring data survives app restarts with zero account setup.

This is the first major interactive feature in LizMeter and will establish the patterns for timer-based productivity tools in the app going forward.

---

## 2. Problem Statement

### Current Situation
LizMeter is a newly scaffolded Electron + React + TypeScript desktop app with no functional features yet. Users have no reason to open the app. There is no timer, no data persistence, and no productivity tooling of any kind.

### Target Users
| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Focus Worker | Knowledge worker or student who uses the Pomodoro Technique to manage focus periods | A simple, always-available desktop timer that tracks completed sessions |
| Casual Timer User | Someone who wants a configurable countdown timer on their desktop | Quick access to start/stop a timer with customizable durations |

### Pain Points
1. Browser-based Pomodoro timers get lost among tabs and lack persistence across sessions
2. Many existing Pomodoro apps require accounts, subscriptions, or internet connectivity
3. Users who want to review their focus history have no local-first option that "just works"
4. Switching between a timer app and work tools causes context-switching friction on desktop

---

## 3. Goals & Success Metrics

### Business Goals
- Deliver the first usable feature in LizMeter, proving the Electron + React + SQLite architecture end-to-end
- Establish the IPC communication pattern between main process and renderer that future features will follow
- Provide a genuinely useful productivity tool that gives users a reason to keep the app installed

### Success Metrics
| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Feature completeness | 0% | 100% of P0 requirements implemented | Manual verification against acceptance criteria |
| Sessions persisted correctly | N/A | 100% of completed sessions saved and retrievable after app restart | Automated test + manual verification |
| Timer accuracy | N/A | Drift less than 1 second over a 25-minute session | Manual timing comparison |
| App startup to timer-ready | N/A | Under 2 seconds | Manual measurement on target hardware |

### Out of Scope
- System tray integration or background timer (timer only runs while window is visible)
- Audio/sound notifications on timer completion (may be added later)
- Desktop notifications via OS notification center
- Statistics, charts, or analytics dashboards over session history
- Keyboard shortcuts for timer controls
- Multi-window or multi-timer support
- Cloud sync or export of session data
- Drag-and-drop reordering or editing of past sessions
- Tagging or categorization of sessions beyond the title field

---

## 4. Requirements

### P0 - Must Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-001 | Configurable timer durations | As a user, I want to set the work, short break, and long break durations so that I can customize the timer to my preference | Given the timer settings, When I change the work duration to 30 minutes, Then the timer countdown reflects 30:00 when started |
| FR-002 | Default Pomodoro durations | As a user, I want sensible defaults so that I can start a session immediately without configuration | Given a fresh install, When I open the timer, Then defaults are 25 min work, 5 min short break, 15 min long break |
| FR-003 | Session title input | As a user, I want to enter a title for my focus session so that I can identify what I worked on later | Given the timer view, When I type a title and complete a session, Then the title is saved with the session record |
| FR-004 | Start timer | As a user, I want to start the countdown so that my focus session begins | Given a configured timer, When I press Start, Then the countdown begins and the display updates every second |
| FR-005 | Pause timer | As a user, I want to pause the countdown so that I can handle interruptions | Given a running timer, When I press Pause, Then the countdown stops and I can resume it |
| FR-006 | Reset timer | As a user, I want to reset the timer so that I can start over or cancel a session | Given a running or paused timer, When I press Reset, Then the timer returns to the configured duration and the session is NOT recorded |
| FR-007 | Visual countdown display | As a user, I want to see a clear countdown (MM:SS) so that I know how much time remains | Given a running timer, When I look at the screen, Then I see the remaining time in MM:SS format updating every second |
| FR-008 | Timer completion indication | As a user, I want to know when the timer reaches zero so that I know my session is done | Given a running timer, When it reaches 00:00, Then the UI clearly indicates the session is complete (visual state change) |
| FR-009 | Persist completed sessions | As a user, I want completed sessions saved automatically so that I don't lose my history | Given a timer that reaches 00:00, When the session completes, Then a record is written to the SQLite database with title, duration, timer type, and completion timestamp |
| FR-010 | Session history list | As a user, I want to see my past sessions so that I can review my focus history | Given completed sessions exist, When I view the history, Then I see a list of sessions showing title, duration, timer type, and when they were completed |
| FR-011 | Timer type selection | As a user, I want to choose between Work, Short Break, and Long Break modes so that I can manage different phases of the Pomodoro cycle | Given the timer view, When I select a timer type, Then the duration updates to match that type's configured value |

### P1 - Should Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-020 | Session history persists across restarts | As a user, I want my history available after closing and reopening the app | Given sessions were recorded, When I restart the app and open history, Then all previously recorded sessions appear |
| FR-021 | Empty state for history | As a new user, I want a helpful message when no sessions exist yet | Given no completed sessions, When I view history, Then I see a message encouraging me to start my first session |
| FR-022 | Delete a session from history | As a user, I want to remove a session I recorded by mistake | Given a session in history, When I delete it, Then it is removed from both the UI and the database |
| FR-023 | Timer state visual feedback | As a user, I want to visually distinguish between work and break sessions | Given the timer is running, When I look at the UI, Then the visual treatment differs between work and break modes |

### P2 - Nice to Have

| ID | Requirement | User Story | Acceptance Criteria |
|----|-------------|------------|---------------------|
| FR-030 | Session count for the day | As a user, I want to see how many work sessions I completed today | Given completed sessions today, When I view the timer, Then I see a count of today's completed work sessions |
| FR-031 | Persist custom duration settings | As a user, I want my custom durations remembered between app restarts | Given I changed work duration to 30 min, When I restart the app, Then the duration is still 30 min |

### Non-Functional Requirements

| Category | Requirement |
|----------|-------------|
| Performance | Timer must update the display every second with no visible jank or skipped updates |
| Performance | Loading session history of up to 1,000 records must complete in under 500ms |
| Persistence | All completed session data must be stored in the local SQLite database |
| Persistence | Database must be created automatically on first use with no user action required |
| Reliability | Timer accuracy must drift less than 1 second over a 25-minute session (use wall-clock correction, not purely interval-based counting) |
| Security | Renderer process must NOT have direct access to Node.js APIs or the filesystem; all database operations go through the preload/IPC bridge (contextIsolation is already enabled) |
| Usability | Timer controls (start, pause, reset) must be clearly distinguishable and reachable without scrolling |
| Usability | The current timer state (running, paused, idle, completed) must be unambiguous at a glance |

---

## 5. User Flows

### Primary Flow: Complete a Work Session
```
1. User opens LizMeter -- the Tomato Clock timer view is displayed
2. User sees the default timer set to "Work - 25:00"
3. User types a session title (e.g., "Write PRD for auth feature")
4. User clicks Start
5. Timer counts down, display updates every second (24:59, 24:58, ...)
6. Timer reaches 00:00
7. UI shows completion state (visual change)
8. Session is automatically saved to database (title, 25 min, "work", timestamp)
9. User can see the session appear in their history
```

### Secondary Flow: Take a Break
```
1. User selects "Short Break" timer type
2. Duration changes to 05:00
3. User clicks Start (title is optional for breaks)
4. Timer counts down to 00:00
5. Break session is recorded
```

### Flow: Pause and Resume
```
1. User starts a work session
2. Partway through, user clicks Pause
3. Timer freezes at current value (e.g., 18:32)
4. User handles interruption
5. User clicks Resume (same button position as Pause)
6. Timer continues counting down from 18:32
```

### Flow: Reset / Cancel
```
1. User starts a work session
2. User decides to cancel and clicks Reset
3. Timer returns to the configured starting duration
4. No session is recorded (session was not completed)
```

### Flow: View History
```
1. User navigates to or views the session history
2. History shows a list of completed sessions, most recent first
3. Each entry shows: title, duration, timer type (work/short break/long break), completion time
4. User can scroll through past sessions
```

### Error Flows
- **Database write fails**: The UI should indicate that the session could not be saved. The timer completion state is still shown. The user is not blocked from starting another session.
- **App closed during active timer**: The in-progress session is lost (not saved). This is expected behavior -- only completed sessions are recorded.

---

## 6. UI Requirements

### Views Needed

**Timer View (Primary)**
- Large, prominent countdown display (MM:SS format)
- Timer type selector (Work / Short Break / Long Break)
- Session title text input field
- Timer controls: Start, Pause/Resume, Reset
- Clear visual distinction between timer states: idle, running, paused, completed
- Clear visual distinction between work and break modes
- (P2) Today's completed work session count

**Session History View**
- Scrollable list of completed sessions, ordered most recent first
- Each entry displays: session title, duration, timer type, completion timestamp
- Empty state message when no sessions exist
- (P1) Delete action per session entry

**Layout Approach**
- The timer view and history view may be presented as a single scrollable page (timer on top, history below) or as separate tab/panel views. The exact layout is a design decision for the @frontend-design skill.
- The app window is 800x600 by default. The timer UI should be comfortable at this size and not require the user to resize.

### Visual Design Notes
- The UI will be designed and styled by the @frontend-design skill. This PRD intentionally does not prescribe colors, fonts, component libraries, or animation details.
- Requirements here describe WHAT the user must see and do, not HOW it should look.

---

## 7. Data Requirements

### What We Need to Store

**Completed Sessions**
- A unique identifier for each session
- The title/name the user entered (may be empty for break sessions)
- The type of timer used (work, short break, long break)
- The planned duration in seconds
- The timestamp when the session was completed

**User Settings (P2)**
- Custom duration values for each timer type (work, short break, long break)

### Data Behavior
- Sessions are write-once. Once recorded, a session's data does not change (except deletion per FR-022).
- The database must be created and schema initialized automatically on app startup if it does not exist.
- All database operations are performed in the Electron main process. The renderer communicates via IPC.

---

## 8. IPC Communication Requirements

The renderer (React) cannot access SQLite directly. All data operations must go through the Electron IPC bridge. The following operations are needed:

| Operation | Direction | Purpose |
|-----------|-----------|---------|
| Save session | Renderer -> Main | Write a completed session record to the database |
| Get session history | Renderer -> Main | Retrieve list of completed sessions for display |
| Delete session | Renderer -> Main | Remove a specific session by its identifier |
| (P2) Save settings | Renderer -> Main | Persist user's custom timer durations |
| (P2) Get settings | Renderer -> Main | Load user's custom timer durations on startup |

The exact channel names, payload shapes, and return types are technical decisions for the tech spec.

---

## 9. Dependencies & Risks

### Dependencies
| Dependency | Type | Impact |
|------------|------|--------|
| SQLite library for Electron/Bun | Internal (tech choice) | Must be compatible with Electron's main process and Bun build tooling |
| Preload bridge pattern | Internal | Already scaffolded (contextIsolation: true, preload configured), but no IPC channels exist yet |
| @frontend-design skill | Internal | UI styling depends on this; functional requirements can proceed independently |

### Risks
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Timer drift over long sessions due to setInterval inaccuracy | Medium | Medium | Require wall-clock time correction in NFRs; validate in testing |
| SQLite library compatibility issues with Bun + Electron | Low | High | Validate library choice early in tech spec; have fallback options |
| Scope creep toward full Pomodoro workflow (auto-cycling, session counting) | Medium | Low | Clearly defined Out of Scope section; defer to future iterations |
| App window minimized/hidden causes timer issues | Low | Medium | Timer logic should use wall-clock time, not rely on consistent render cycles |

---

## 10. Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Should break sessions require a title, or should title be optional for breaks? | Resolved -- Title is optional for all session types, but especially expected to be skipped for breaks |
| 2 | Should the timer auto-advance from work to break (and back)? | Resolved -- Out of scope for v1. User manually selects timer type each time |
| 3 | What SQLite library will be used (better-sqlite3, bun:sqlite, etc.)? | Open -- Technical decision for Hephaestus |
| 4 | Should completed session count show on the timer view? | Resolved -- P2 nice-to-have (today's work session count) |
| 5 | Should the app minimize to system tray while timer runs? | Resolved -- Out of scope for v1 |
