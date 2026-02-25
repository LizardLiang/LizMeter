# Product Requirements Document (PRD)

## Document Info
| Field | Value |
|-------|-------|
| **Feature** | Issue Time Meter |
| **Author** | Athena (PM Agent) |
| **Status** | Approved |
| **Date** | 2026-02-24 |
| **Version** | 1.0 |

---

## 1. Executive Summary

LizMeter currently operates exclusively as a Pomodoro timer with three countdown modes: Work (25 min), Short Break (5 min), and Long Break (15 min). Users who want to track how much time they spend on a specific issue or task have no way to do so within the app.

This feature introduces a **Time Tracking Mode** — a count-up stopwatch that lets users meter time spent on tasks and issues. It integrates with the existing Jira Cloud and Linear issue integrations, prompting users to link an issue when starting (but not requiring it). A top-level mode toggle will let users switch between the familiar Pomodoro workflow and the new Time Tracking workflow, each with its own dedicated UI.

---

## 2. Problem Statement

LizMeter supports only countdown timers. Users who work in a flow state or on tasks with unpredictable duration are forced to either use the Pomodoro timer as a rough proxy, use a separate time-tracking tool, or not track time at all.

The app already has Jira Cloud and Linear integrations for browsing and linking issues to sessions, but these only work with Pomodoro sessions. There is no way to answer: "How much time did I spend on PROJ-123 today?"

---

## 3. Goals & Success Metrics

- Expand LizMeter from a single-purpose Pomodoro app to a dual-purpose productivity tool
- Increase utilization of existing Jira/Linear issue integrations

### Out of Scope
- Reporting/analytics dashboard for time per issue
- Automatic time tracking (detecting active app/window)
- Time entry editing after session completion
- Concurrent timers (running Pomodoro and Stopwatch simultaneously)
- Exporting time data to Jira/Linear worklogs

---

## 4. Requirements

### P0 — Must Have
| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-001 | Mode toggle between Pomodoro and Time Tracking | Top-level toggle switches UI between Pomodoro (countdown) and Time Tracking (stopwatch) without losing state of the other mode |
| FR-002 | Count-up stopwatch timer | Timer counts up from 00:00:00 displaying HH:MM:SS, updating every second |
| FR-003 | Start / Pause / Resume / Stop controls | Full control set: Start begins counting, Pause stops counting (Resume/Stop shown), Resume continues from pause, Stop saves session and resets |
| FR-004 | Auto-prompt to link issue on start | When starting stopwatch, modal prompts to select Jira/Linear issue, type custom title, or skip. Timer starts after choice. |
| FR-005 | Save stopwatch sessions to history | Stopped sessions saved with: title, timerType "stopwatch", actualDurationSeconds, completedAt, and linked issue if selected |
| FR-006 | Stopwatch sessions in unified history | Stopwatch sessions appear in same history list with distinct "Stopwatch" badge, elapsed-only display (no planned duration) |
| FR-007 | Configurable maximum duration | Settings allow configuring max stopwatch duration. Options include "No limit". Default: 8 hours. Auto-stop with notification at limit. |

### P1 — Should Have
| ID | Requirement |
|----|-------------|
| FR-010 | Elapsed time persists across mode switches (stopwatch keeps running if user switches to Pomodoro view) |
| FR-011 | Session title defaults to linked issue (e.g., "PROJ-123: Fix login bug") |
| FR-012 | Visual indicator of running stopwatch when in Pomodoro mode |
| FR-013 | Skip prompt preference in settings (disable issue prompt permanently) |

### P2 — Nice to Have
| ID | Requirement |
|----|-------------|
| FR-020 | Filter session history by type (Pomodoro vs Stopwatch) |
| FR-021 | Total time per issue across multiple stopwatch sessions |

---

## 5. User Flows

### Primary Flow: Start and Complete a Stopwatch Session
1. User sees mode toggle at top of timer area (default: Pomodoro)
2. User toggles to "Time Tracking" mode
3. UI transitions to stopwatch view showing 00:00:00 and Start button
4. User presses Start
5. Issue prompt appears: "Link an issue?" with options to browse Jira/Linear, type custom title, or skip
6. User selects an issue (or skips)
7. Stopwatch begins counting up
8. User works on their task
9. User presses Pause (optional) — Resume/Stop buttons shown
10. User presses Stop
11. Session saved with timerType="stopwatch", actual duration, linked issue
12. Stopwatch resets to 00:00:00

### Error Flows
- **No issue integrations configured**: Prompt shows only "Type custom title" and "Skip"
- **App closed with running stopwatch**: Deferred to P1 (crash recovery)
- **User tries to switch mode while timer running**: Mode toggle disabled with tooltip

---

## 6. User Interview Summary

| Question | Answer |
|----------|--------|
| Issue linkage | Auto-prompt (prompt to link, allow skipping) |
| Session history display | Same list with distinct "Stopwatch" badge |
| UI placement | Top-level mode toggle (Pomodoro Mode / Time Tracking Mode) |
| Maximum duration | Configurable in settings with "No limit" option |