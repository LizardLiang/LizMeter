//! Claude Code tracking around the timer and the stopwatch (`useClaudeTracker.ts` and the Claude
//! parts of `TomatoClock.tsx`): link a session, track it while the timer runs, save its numbers
//! with the session.

use crate::app::Root;
use crate::claude_ui::{Linked, PickerState, SelectEvent};
use crate::engine::Status;
use gpui::*;
use lizmeter_core::{ClaudeCodeLiveStats, ClaudeCodeSessionData, ClaudeCodeSessionPreview, SaveSessionInput, SaveSessionWithTrackingInput, Session};
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// Electron's main process pushes updates as files change; the poll runs this often.
const POLL: Duration = Duration::from_millis(500);
/// Idle time on the card moves on without new data; repaint it this often.
const IDLE_REPAINT: Duration = Duration::from_secs(10);

pub struct ClaudeState {
    pub timer_link: Option<Linked>,
    pub sw_link: Option<Linked>,
    pub picker: PickerState,
    pub discovered: Vec<ClaudeCodeSessionPreview>,
    /// Boxes ticked in the open picker.
    pub checked: Vec<String>,
    pub tracked: Vec<String>,
    /// The stopwatch started the tracking that runs now.
    pub sw_tracking: bool,
    pub live: Option<ClaudeCodeLiveStats>,
    pub new_session: Option<ClaudeCodeSessionPreview>,
    pub dismissed: HashSet<String>,
    pub idle_minutes: i64,
    poll_gen: u64,
}

impl ClaudeState {
    pub fn new(idle_minutes: i64) -> Self {
        Self {
            timer_link: None,
            sw_link: None,
            picker: PickerState::Hidden,
            discovered: vec![],
            checked: vec![],
            tracked: vec![],
            sw_tracking: false,
            live: None,
            new_session: None,
            dismissed: HashSet::new(),
            idle_minutes,
            poll_gen: 0,
        }
    }

    pub fn is_tracking(&self) -> bool {
        !self.tracked.is_empty()
    }

    fn is_watching(&self) -> bool {
        self.picker != PickerState::Hidden || self.is_tracking()
    }

    fn clear(&mut self) {
        self.picker = PickerState::Hidden;
        self.discovered.clear();
        self.checked.clear();
        self.tracked.clear();
        self.sw_tracking = false;
        self.live = None;
        self.new_session = None;
        self.dismissed.clear();
        self.poll_gen += 1;
    }
}

/// The idle limit setting: whole minutes from 1 to 60, else 5.
pub fn idle_minutes_from(value: Option<&str>) -> i64 {
    value
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|m| (lizmeter_core::IDLE_THRESHOLD_MIN..=lizmeter_core::IDLE_THRESHOLD_MAX).contains(m))
        .unwrap_or(lizmeter_core::IDLE_THRESHOLD_DEFAULT)
}

impl Root {
    pub fn on_claude_select(&mut self, stopwatch: bool, ev: &SelectEvent, cx: &mut Context<Self>) {
        let SelectEvent::Pick(link) = ev;
        self.set_claude_link(stopwatch, link.clone(), cx);
        let active = if stopwatch { self.stopwatch_active() } else { self.timer_active() };
        if !active {
            return;
        }
        if stopwatch {
            if self.cc.sw_tracking {
                self.cc_stop();
            }
            if let Some(link) = link {
                self.cc_track_link(link, cx);
                self.cc.sw_tracking = self.cc.is_tracking();
                if self.stopwatch.status == Status::Paused {
                    self.svc.claude_pause();
                }
            }
        } else if let Some(link) = link {
            self.cc_track_link(link, cx);
        } else if self.cc.is_tracking() {
            self.cc_stop();
        }
        cx.notify();
    }

    pub fn set_claude_link(&mut self, stopwatch: bool, link: Option<Linked>, cx: &mut Context<Self>) {
        let select = if stopwatch {
            self.cc.sw_link = link.clone();
            self.cc_select_sw.clone()
        } else {
            self.cc.timer_link = link.clone();
            self.cc_select_timer.clone()
        };
        select.update(cx, |s, cx| s.set_selected(link, cx));
    }

    /// Scans the linked session's project and tracks exactly that session.
    pub fn cc_track_link(&mut self, link: &Linked, cx: &mut Context<Self>) {
        if self.cc_scan(&link.project_dir, cx) {
            self.cc_track(vec![link.uuid.clone()]);
            // A scan resets the tracker's pause: a paused timer must not gather while paused.
            if self.countdown.status == Status::Paused || self.stopwatch.status == Status::Paused {
                self.svc.claude_pause();
            }
        }
    }

    /// Phase one: scan a project. Starts no tracking.
    fn cc_scan(&mut self, project_dir: &str, cx: &mut Context<Self>) -> bool {
        self.cc.tracked.clear();
        self.cc.live = None;
        self.cc.sw_tracking = false;
        let result = self.svc.claude_scan(project_dir);
        match result {
            Ok(r) if r.success => {
                self.cc.discovered = r.sessions;
                self.cc.picker = PickerState::Open;
                self.cc_start_poll(cx);
                true
            }
            _ => {
                self.cc.picker = PickerState::Hidden;
                false
            }
        }
    }

    /// Phase two: track the chosen sessions of the scanned project.
    pub fn cc_track(&mut self, uuids: Vec<String>) {
        self.svc.claude_track_selected(&uuids);
        self.cc.tracked = uuids;
        self.cc.picker = PickerState::Collapsed;
    }

    /// Stops the tracker and hands back what it gathered.
    pub fn cc_stop(&mut self) -> Vec<ClaudeCodeSessionData> {
        let sessions = self.svc.claude_stop();
        self.cc.clear();
        sessions
    }

    /// Stops tracking for a session that ends: its numbers go with the save.
    pub fn cc_collect(&mut self) -> Vec<ClaudeCodeSessionData> {
        if self.cc.is_watching() { self.cc_stop() } else { vec![] }
    }

    pub fn cc_pause(&mut self) {
        if self.cc.is_tracking() {
            self.svc.claude_pause();
        }
    }

    pub fn cc_resume(&mut self) {
        if self.cc.is_tracking() {
            self.svc.claude_resume();
        }
    }

    /// The timer was reset: forget the link and stop whatever tracks.
    pub fn cc_reset(&mut self, cx: &mut Context<Self>) {
        self.set_claude_link(false, None, cx);
        if self.cc.is_watching() {
            self.cc_stop();
        }
    }

    fn cc_start_poll(&mut self, cx: &mut Context<Self>) {
        self.cc.poll_gen += 1;
        let generation = self.cc.poll_gen;
        cx.spawn(async move |this, cx| {
            let mut repainted = Instant::now();
            loop {
                cx.background_executor().timer(POLL).await;
                let keep = this
                    .update(cx, |t, cx| {
                        if t.cc.poll_gen != generation || !t.cc.is_watching() {
                            return false;
                        }
                        t.cc_poll(&mut repainted, cx);
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    fn cc_poll(&mut self, repainted: &mut Instant, cx: &mut Context<Self>) {
        let out = self.svc.poll_claude_tracker();
        let mut changed = false;
        if let Some(stats) = out.stats {
            self.cc.live = Some(stats);
            changed = true;
        }
        // One notice at a time; a dismissed session never comes back.
        if let Some(s) = out.new_sessions.into_iter().find(|s| !self.cc.dismissed.contains(&s.cc_session_uuid)) {
            if !self.cc.discovered.iter().any(|d| d.cc_session_uuid == s.cc_session_uuid) {
                self.cc.discovered.insert(0, s.clone());
            }
            self.cc.new_session = Some(s);
            changed = true;
        }
        if repainted.elapsed() >= IDLE_REPAINT {
            *repainted = Instant::now();
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    pub fn cc_dismiss_new_session(&mut self, cx: &mut Context<Self>) {
        if let Some(s) = self.cc.new_session.take() {
            self.cc.dismissed.insert(s.cc_session_uuid);
        }
        cx.notify();
    }

    /// "Add" on the notice: open the picker over the sessions of the project.
    pub fn cc_add_new_session(&mut self, cx: &mut Context<Self>) {
        self.cc_dismiss_new_session(cx);
        self.cc_open_picker(cx);
    }

    pub fn cc_open_picker(&mut self, cx: &mut Context<Self>) {
        self.cc.checked = self.cc.tracked.clone();
        self.cc.picker = PickerState::Open;
        cx.notify();
    }

    pub fn cc_toggle_picker(&mut self, cx: &mut Context<Self>) {
        match self.cc.picker {
            PickerState::Open => self.cc.picker = PickerState::Collapsed,
            PickerState::Collapsed => {
                self.cc.checked = self.cc.tracked.clone();
                self.cc.picker = PickerState::Open;
            }
            PickerState::Hidden => {}
        }
        cx.notify();
    }

    pub fn cc_check(&mut self, uuid: String, cx: &mut Context<Self>) {
        if let Some(i) = self.cc.checked.iter().position(|u| *u == uuid) {
            self.cc.checked.remove(i);
        } else {
            self.cc.checked.push(uuid);
        }
        cx.notify();
    }

    pub fn cc_confirm(&mut self, cx: &mut Context<Self>) {
        let chosen = std::mem::take(&mut self.cc.checked);
        self.cc_track(chosen);
        cx.notify();
    }

    pub fn cc_skip(&mut self, cx: &mut Context<Self>) {
        self.cc.picker = PickerState::Hidden;
        cx.notify();
    }

    /// Capture hooks (`--do`): `bounce` leaves the page and comes back, `claude-link` links the
    /// newest session, `claude-open` opens the session select.
    pub fn capture_op(&mut self, op: &str, window: &mut Window, cx: &mut Context<Self>) {
        match op {
            "bounce" => {
                crate::ui::CAPTURE_SCROLL.store(0, std::sync::atomic::Ordering::Relaxed);
                let (here, away) = match self.page {
                    crate::app::Page::History => (1, 7),
                    crate::app::Page::Stats => (7, 8),
                    crate::app::Page::Tags => (8, 7),
                    crate::app::Page::Todos => (2, 7),
                    crate::app::Page::Claude => (4, 7),
                    crate::app::Page::Activity => (5, 7),
                    crate::app::Page::Settings => (9, 7),
                    _ => (0, 7),
                };
                self.navigate(away, window, cx);
                self.navigate(here, window, cx);
            }
            op if op.starts_with("todos-") => {
                let op = op.trim_start_matches("todos-").to_string();
                self.todos.update(cx, |t, cx| t.capture(&op, window, cx));
            }
            "claude-link" => self.capture_claude_link(!self.pomodoro, cx),
            "claude-open" => {
                let select = if self.pomodoro { self.cc_select_timer.clone() } else { self.cc_select_sw.clone() };
                select.update(cx, |s, cx| s.open(cx));
            }
            _ => {}
        }
    }

    /// Capture hook: link the newest scanned session, as if picked from the select.
    pub fn capture_claude_link(&mut self, stopwatch: bool, cx: &mut Context<Self>) {
        let Some(s) = self.svc.claude_scan_all().into_iter().max_by(|a, b| a.preview.last_activity_at.cmp(&b.preview.last_activity_at)) else { return };
        let link = Linked { uuid: s.preview.cc_session_uuid, project_dir: s.project_dir_name };
        self.on_claude_select(stopwatch, &SelectEvent::Pick(Some(link)), cx);
    }

    /// The stopwatch started: track the session linked to it.
    pub fn cc_stopwatch_started(&mut self, cx: &mut Context<Self>) {
        if let Some(link) = self.cc.sw_link.clone() {
            self.cc_track_link(&link, cx);
            self.cc.sw_tracking = self.cc.is_tracking();
        }
    }

    /// Saves a session; the tracked Claude Code numbers go with it when there are any.
    pub fn save_tracked(&self, input: &SaveSessionInput, tracked: Vec<ClaudeCodeSessionData>) -> lizmeter_services::Result<Session> {
        if tracked.is_empty() {
            return self.svc.save_session(input);
        }
        self.svc.save_session_with_tracking(&SaveSessionWithTrackingInput {
            title: input.title.clone(),
            timer_type: input.timer_type,
            planned_duration_seconds: input.planned_duration_seconds,
            actual_duration_seconds: input.actual_duration_seconds,
            issue_number: input.issue_number,
            issue_title: input.issue_title.clone(),
            issue_url: input.issue_url.clone(),
            issue_provider: input.issue_provider,
            issue_id: input.issue_id.clone(),
            claude_code_sessions: Some(tracked),
        })
    }
}
