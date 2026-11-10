//! Keeps the desktop widget in step with the main window (`useWidgetBridge.ts` plus the widget
//! handlers of `ipc-handlers.ts`): creates or closes it with the Settings switch, pushes the timer
//! state, relays the two buttons back, applies "when active" visibility, avatars and position reset.

use crate::app::Root;
use crate::engine::Status;
use crate::widget::{self, Widget, WidgetEvent, WidgetInit};
use gpui::*;
use lizmeter_core::{AppMode, ClaudeSessionActivityType, TimerStatus, TimerType, WidgetControlAction, WidgetTimerSnapshot};
use lizmeter_services::Services;
use std::sync::Arc;

pub fn timer_status(s: Status) -> TimerStatus {
    match s {
        Status::Idle => TimerStatus::Idle,
        Status::Running => TimerStatus::Running,
        Status::Paused => TimerStatus::Paused,
        Status::Completed => TimerStatus::Completed,
    }
}

/// What `buildSnapshot` reads from the main window.
pub struct Sources<'a> {
    pub pomodoro: bool,
    pub countdown_status: Status,
    pub timer_type: TimerType,
    pub remaining: i64,
    pub planned: i64,
    pub title_html: &'a str,
    pub stopwatch_status: Status,
    pub elapsed: i64,
    pub sw_title_html: &'a str,
    pub activity: Option<ClaudeSessionActivityType>,
}

/// `buildSnapshot`: the countdown in Pomodoro mode, the stopwatch in Time Tracking mode.
pub fn build_snapshot(s: &Sources) -> WidgetTimerSnapshot {
    if s.pomodoro {
        WidgetTimerSnapshot {
            mode: AppMode::Pomodoro,
            status: timer_status(s.countdown_status),
            timer_type: s.timer_type,
            display_seconds: s.remaining,
            title: s.title_html.to_string(),
            planned_duration_seconds: Some(s.planned),
            claude_activity: s.activity,
        }
    } else {
        WidgetTimerSnapshot {
            mode: AppMode::TimeTracking,
            status: timer_status(s.stopwatch_status),
            timer_type: TimerType::Stopwatch,
            display_seconds: s.elapsed,
            title: s.sw_title_html.to_string(),
            planned_duration_seconds: None,
            claude_activity: s.activity,
        }
    }
}

/// What a widget button does to the main window's timer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    Pause,
    Resume,
    Reset,
    StopwatchPause,
    StopwatchResume,
    StopwatchStop,
}

/// The `widget:control-relay` handler of `useWidgetBridge`: play/pause toggles a running or paused
/// timer, stop ends one. On any other status a button does nothing.
pub fn command_for(pomodoro: bool, status: Status, action: WidgetControlAction) -> Option<Command> {
    let active = matches!(status, Status::Running | Status::Paused);
    match (action, pomodoro) {
        (WidgetControlAction::PlayPause, true) => match status {
            Status::Running => Some(Command::Pause),
            Status::Paused => Some(Command::Resume),
            _ => None,
        },
        (WidgetControlAction::PlayPause, false) => match status {
            Status::Running => Some(Command::StopwatchPause),
            Status::Paused => Some(Command::StopwatchResume),
            _ => None,
        },
        (WidgetControlAction::Stop, true) => active.then_some(Command::Reset),
        (WidgetControlAction::Stop, false) => active.then_some(Command::StopwatchStop),
    }
}

/// "always" shows the widget; "when-active" only while a timer runs or is paused.
pub fn should_show(visibility: &str, status: TimerStatus) -> bool {
    visibility != "when-active" || widget::is_active(status)
}

impl Root {
    /// The snapshot the widget shows right now.
    pub fn widget_snapshot(&self) -> WidgetTimerSnapshot {
        let now = crate::flow::now_ms();
        let activity = self.cc.live.as_ref().and_then(|l| l.session_activity.as_ref()).map(|a| a.kind);
        build_snapshot(&Sources {
            pomodoro: self.pomodoro,
            countdown_status: self.countdown.status,
            timer_type: self.countdown.timer_type,
            remaining: self.countdown.remaining_seconds(now),
            planned: self.countdown.planned_seconds(),
            title_html: &self.title_html,
            stopwatch_status: self.stopwatch.status,
            elapsed: self.stopwatch.elapsed_seconds(now),
            sw_title_html: &self.sw_title_html,
            activity,
        })
    }

    /// A widget button was pressed.
    pub fn on_widget_control(&mut self, action: WidgetControlAction, cx: &mut Context<Self>) {
        let status = if self.pomodoro { self.countdown.status } else { self.stopwatch.status };
        match command_for(self.pomodoro, status, action) {
            Some(Command::Pause) => self.pause(cx),
            Some(Command::Resume) => self.resume(cx),
            Some(Command::Reset) => self.reset(cx),
            Some(Command::StopwatchPause) => self.pause_stopwatch(cx),
            Some(Command::StopwatchResume) => self.resume_stopwatch(cx),
            Some(Command::StopwatchStop) => self.stop_stopwatch(cx),
            None => {}
        }
    }
}

struct WidgetWin {
    handle: WindowHandle<Widget>,
    entity: Entity<Widget>,
    tall: bool,
    shown: bool,
    _events: Subscription,
}

pub struct WidgetHost {
    root: Entity<Root>,
    main: AnyWindowHandle,
    svc: Arc<Services>,
    win: Option<WidgetWin>,
    visibility: String,
    seen_rev: u64,
    _subs: Vec<Subscription>,
}

struct Holder(#[allow(dead_code)] Entity<WidgetHost>);
impl Global for Holder {}

fn saved_position(svc: &Services) -> Option<(f32, f32)> {
    let get = |k: &str| svc.get_setting_value(k).ok().flatten().filter(|v| !v.is_empty()).and_then(|v| v.trim().parse::<f32>().ok());
    Some((get("widget_pos_x")?, get("widget_pos_y")?))
}

impl WidgetHost {
    /// Starts the widget side of a live main window. The widget opens when Settings has it enabled.
    pub fn start(root: Entity<Root>, main: AnyWindowHandle, cx: &mut App) {
        let svc = root.read(cx).svc.clone();
        let settings = root.read(cx).settings.clone();
        let host = cx.new(|cx: &mut Context<WidgetHost>| {
            let subs = vec![
                cx.observe(&root, |h: &mut WidgetHost, _, cx| h.push(cx)),
                cx.observe(&settings, |h: &mut WidgetHost, _, cx| h.sync(false, cx)),
                // The widget must not keep the app alive once the main window is gone.
                cx.observe_release(&root, |h: &mut WidgetHost, _, cx| {
                    h.close(cx);
                    cx.quit();
                }),
            ];
            WidgetHost { root, main, svc, win: None, visibility: "always".into(), seen_rev: u64::MAX, _subs: subs }
        });
        host.update(cx, |h: &mut WidgetHost, cx| h.sync(true, cx));
        cx.set_global(Holder(host));
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if let Some(win) = self.win.take() {
            let _ = win.handle.update(cx, |_, window, _| window.remove_window());
        }
    }

    /// Applies the Settings switch, visibility, avatars and a position reset.
    fn sync(&mut self, force: bool, cx: &mut Context<Self>) {
        let rev = self.root.read(cx).settings.read(cx).widget_rev;
        if !force && rev == self.seen_rev {
            return;
        }
        self.seen_rev = rev;
        let get = |k: &str| self.svc.get_setting_value(k).ok().flatten();
        let enabled = get("widget_enabled").as_deref() == Some("true");
        self.visibility = if get("widget_visibility").as_deref() == Some("when-active") { "when-active".into() } else { "always".into() };
        match (enabled, self.win.is_some()) {
            (true, false) => self.open(cx),
            (false, true) => self.close(cx),
            _ => {}
        }
        if let Some(win) = &mut self.win {
            let tall = self.svc.has_any_avatar();
            if tall != win.tall {
                win.tall = tall;
                let _ = win.handle.update(cx, |_, window, _| widget::set_tall(window, tall));
            }
            let files = self.svc.avatar_files();
            win.entity.update(cx, |w, cx| w.set_avatars(&files, cx));
            if saved_position(&self.svc).is_none() {
                let (x, y) = widget::default_position(cx);
                win.entity.update(cx, |w, _| w.note_reset(x, y));
                let _ = win.handle.update(cx, |_, window, _| widget::move_to(window, x, y));
            }
        }
        self.apply_visibility(cx);
    }

    fn open(&mut self, cx: &mut Context<Self>) {
        let tall = self.svc.has_any_avatar();
        let pos = widget::start_position(cx, saved_position(&self.svc));
        let snap = self.root.read(cx).widget_snapshot();
        let show = should_show(&self.visibility, snap.status);
        let init = WidgetInit { snap: Some(snap), avatars: self.svc.avatar_files(), services: Some(self.svc.clone()), origin: pos };
        let opened = cx.open_window(widget::window_options(pos, tall, show), |window, cx| {
            widget::make_topmost(window);
            cx.new(|cx| Widget::new(window, cx, init))
        });
        match opened {
            Ok(handle) => {
                let Ok(entity) = handle.entity(cx) else { return };
                let events = cx.subscribe(&entity, |h, _, ev: &WidgetEvent, cx| h.on_event(ev, cx));
                self.win = Some(WidgetWin { handle, entity, tall, shown: show, _events: events });
            }
            Err(e) => eprintln!("[widget] could not open: {e}"),
        }
    }

    fn on_event(&mut self, ev: &WidgetEvent, cx: &mut Context<Self>) {
        let WidgetEvent::Control(action) = ev;
        let action = *action;
        self.root.update(cx, |r, cx| r.on_widget_control(action, cx));
        if action == WidgetControlAction::Stop {
            let _ = self.main.update(cx, |_, window, _| widget::raise(window));
        }
    }

    /// The main window's state changed: send the widget a new snapshot.
    fn push(&mut self, cx: &mut Context<Self>) {
        let Some(win) = &self.win else { return };
        let snap = self.root.read(cx).widget_snapshot();
        win.entity.update(cx, |w, cx| w.set_snapshot(snap, cx));
        self.apply_visibility(cx);
    }

    fn apply_visibility(&mut self, cx: &mut Context<Self>) {
        let Some(win) = &mut self.win else { return };
        let status = self.root.read(cx).widget_snapshot().status;
        let show = should_show(&self.visibility, status);
        if show != win.shown {
            win.shown = show;
            let _ = win.handle.update(cx, |_, window, _| widget::set_visible(window, show));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_snapshot, command_for, should_show, AppMode, ClaudeSessionActivityType, Command, Sources, Status, TimerStatus, TimerType, WidgetControlAction};

    fn sources<'a>(pomodoro: bool) -> Sources<'a> {
        Sources {
            pomodoro,
            countdown_status: Status::Running,
            timer_type: TimerType::ShortBreak,
            remaining: 250,
            planned: 300,
            title_html: "<p>a</p>",
            stopwatch_status: Status::Paused,
            elapsed: 61,
            sw_title_html: "<p>b</p>",
            activity: Some(ClaudeSessionActivityType::Thinking),
        }
    }

    #[test]
    fn the_pomodoro_snapshot_carries_the_countdown() {
        let s = build_snapshot(&sources(true));
        assert_eq!((s.mode, s.status, s.timer_type, s.display_seconds), (AppMode::Pomodoro, TimerStatus::Running, TimerType::ShortBreak, 250));
        assert_eq!((s.title.as_str(), s.planned_duration_seconds, s.claude_activity), ("<p>a</p>", Some(300), Some(ClaudeSessionActivityType::Thinking)));
    }

    #[test]
    fn the_time_tracking_snapshot_carries_the_stopwatch() {
        let s = build_snapshot(&sources(false));
        assert_eq!((s.mode, s.status, s.timer_type, s.display_seconds), (AppMode::TimeTracking, TimerStatus::Paused, TimerType::Stopwatch, 61));
        assert_eq!((s.title.as_str(), s.planned_duration_seconds), ("<p>b</p>", None));
    }

    #[test]
    fn the_buttons_map_to_the_timer_the_window_is_showing() {
        use WidgetControlAction::*;
        assert_eq!(command_for(true, Status::Running, PlayPause), Some(Command::Pause));
        assert_eq!(command_for(true, Status::Paused, PlayPause), Some(Command::Resume));
        assert_eq!(command_for(true, Status::Running, Stop), Some(Command::Reset));
        assert_eq!(command_for(true, Status::Paused, Stop), Some(Command::Reset));
        assert_eq!(command_for(false, Status::Running, PlayPause), Some(Command::StopwatchPause));
        assert_eq!(command_for(false, Status::Paused, PlayPause), Some(Command::StopwatchResume));
        assert_eq!(command_for(false, Status::Paused, Stop), Some(Command::StopwatchStop));
    }

    #[test]
    fn a_button_on_an_idle_or_finished_timer_does_nothing() {
        use WidgetControlAction::*;
        for status in [Status::Idle, Status::Completed] {
            for pomodoro in [true, false] {
                assert_eq!(command_for(pomodoro, status, PlayPause), None);
                assert_eq!(command_for(pomodoro, status, Stop), None);
            }
        }
    }

    #[test]
    fn when_active_hides_an_idle_widget() {
        assert!(should_show("always", TimerStatus::Idle));
        assert!(should_show("when-active", TimerStatus::Running));
        assert!(should_show("when-active", TimerStatus::Paused));
        assert!(!should_show("when-active", TimerStatus::Idle));
        assert!(!should_show("when-active", TimerStatus::Completed));
    }
}
