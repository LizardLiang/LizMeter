//! Timer and stopwatch flows of the main window: start, pause, tick, save, restore, issue prompt.

use crate::app::{PromptPurpose, Root, TimeEdit};
use crate::engine::Status;
use crate::fmt::{issue_columns, reconstruct_issue, strip_html};
use crate::modal::{IssuePrompt, PromptEvent};
use crate::pages::PageEvent;
use crate::tag_picker::TagPickerEvent;
use crate::timer::display_field_style;
use gpui::*;
use lizmeter_core::{AssignTagInput, CreateTagInput, IssueRef, SaveSessionInput, Session, TimerType};
use lizmeter_ui::text_input::{TextField, TextFieldEvent, TextInput};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Wall-clock milliseconds, so a sleeping machine counts as time passed.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn input_for(title: &str, ty: TimerType, planned: i64, actual: i64, issue: Option<&IssueRef>) -> SaveSessionInput {
    let mut input = SaveSessionInput {
        title: title.to_string(),
        timer_type: ty,
        planned_duration_seconds: planned,
        actual_duration_seconds: actual,
        issue_number: None,
        issue_title: None,
        issue_url: None,
        issue_provider: None,
        issue_id: None,
    };
    if let Some(issue) = issue {
        let (number, title, url, provider, id) = issue_columns(issue);
        input.issue_number = number;
        input.issue_title = title;
        input.issue_url = url;
        input.issue_provider = Some(provider);
        input.issue_id = Some(id);
    }
    input
}

/// The OS notification a finished timer raises.
pub fn completion_message(ty: TimerType, title_html: &str) -> (&'static str, String) {
    let plain = strip_html(title_html);
    match ty {
        TimerType::Work => ("Pomodoro Complete!", if plain.is_empty() { "Time for a break!".into() } else { format!("\"{plain}\" is done. Time for a break!") }),
        TimerType::Stopwatch => ("Session Complete!", if plain.is_empty() { "Session ended.".into() } else { format!("\"{plain}\" is done.") }),
        _ => ("Break Complete!", "Ready to focus?".into()),
    }
}

impl Root {
    pub fn reload_tags(&mut self, cx: &mut Context<Self>) {
        self.all_tags = self.svc.list_tags().unwrap_or_default();
        let (all, sel) = (self.all_tags.clone(), self.pending_tags.clone());
        self.tag_picker.update(cx, |p, cx| p.set_tags(all, sel, cx));
    }

    pub fn on_tag_event(&mut self, _: Entity<crate::tag_picker::TagPicker>, ev: &TagPickerEvent, cx: &mut Context<Self>) {
        match ev {
            TagPickerEvent::Add(id) => {
                if !self.pending_tags.contains(id) {
                    self.pending_tags.push(*id);
                }
            }
            TagPickerEvent::Remove(id) => self.pending_tags.retain(|t| t != id),
            TagPickerEvent::Create { name, color } => match self.svc.create_tag(&CreateTagInput { name: name.clone(), color: color.clone() }) {
                Ok(t) => self.pending_tags.push(t.id),
                Err(e) => self.save_error = Some(e.to_string()),
            },
        }
        self.reload_tags(cx);
        cx.notify();
    }

    pub fn on_page_event(&mut self, _: &Entity<crate::pages::history::HistoryPage>, ev: &PageEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            PageEvent::Resume(session) => self.restore_session(session, window, cx),
            PageEvent::SessionsChanged => self.reload_tags(cx),
            _ => {}
        }
    }

    // --- Ticking ---

    /// One loop per start or resume; a loop that finds a newer generation exits, so quick
    /// pause/resume pairs never leave two loops counting.
    pub fn schedule_ticks(&mut self, cx: &mut Context<Self>) {
        self.tick_gen += 1;
        let generation = self.tick_gen;
        cx.spawn(async move |this, cx| {
            loop {
                let wait = this.update(cx, |t, _| t.next_wake(generation)).ok().flatten();
                let Some(wait) = wait else { break };
                cx.background_executor().timer(wait).await;
                let keep = this.update(cx, |t, cx| t.on_tick(generation, cx)).unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    fn next_wake(&self, generation: u64) -> Option<Duration> {
        if generation != self.tick_gen {
            return None;
        }
        let now = now_ms();
        let ms = [self.countdown.next_wake_ms(now), self.stopwatch.next_wake_ms(now)].into_iter().flatten().min()?;
        Some(Duration::from_millis(ms + 5))
    }

    fn on_tick(&mut self, generation: u64, cx: &mut Context<Self>) -> bool {
        if generation != self.tick_gen {
            return false;
        }
        let now = now_ms();
        let mut changed = false;
        if self.countdown.status == Status::Running {
            let tick = self.countdown.tick(now, self.shown_cd);
            if tick.completed {
                self.complete_countdown(cx);
                changed = true;
            }
            let secs = self.countdown.remaining_seconds(now);
            changed |= secs != self.shown_cd;
            self.shown_cd = secs;
        }
        if self.stopwatch.status == Status::Running {
            if self.stopwatch.reached_max(now, self.sw_settings.max_duration_seconds) {
                self.stop_stopwatch(cx);
                changed = true;
            } else {
                let secs = self.stopwatch.elapsed_seconds(now);
                changed |= secs != self.shown_sw;
                self.shown_sw = secs;
            }
        }
        if changed {
            cx.notify();
        }
        self.countdown.status == Status::Running || self.stopwatch.status == Status::Running
    }

    // --- Countdown ---

    pub fn title_is_blank(html: &str) -> bool {
        strip_html(html).is_empty()
    }

    pub fn start(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        self.countdown.start(now);
        self.shown_cd = self.countdown.remaining_seconds(now);
        self.save_error = None;
        self.schedule_ticks(cx);
        cx.notify();
    }

    pub fn pause(&mut self, cx: &mut Context<Self>) {
        self.countdown.pause(now_ms());
        cx.notify();
    }

    pub fn resume(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        self.countdown.resume(now);
        self.shown_cd = self.countdown.remaining_seconds(now);
        self.schedule_ticks(cx);
        cx.notify();
    }

    pub fn reset(&mut self, cx: &mut Context<Self>) {
        let restored = self.countdown.status == Status::Idle && self.countdown.restored_planned.is_some();
        self.countdown.reset();
        self.shown_cd = self.countdown.remaining_seconds(now_ms());
        self.pending_issue = None;
        if restored {
            self.title_html.clear();
            self.rich.update(cx, |r, cx| r.set_html("", cx));
        }
        cx.notify();
    }

    pub fn dismiss_completion(&mut self, cx: &mut Context<Self>) {
        self.countdown.clear_completion();
        self.shown_cd = self.countdown.remaining_seconds(now_ms());
        cx.notify();
    }

    pub fn set_type(&mut self, ty: TimerType, cx: &mut Context<Self>) {
        if self.countdown.status != Status::Idle {
            return;
        }
        self.countdown.set_type(ty);
        self.shown_cd = self.countdown.remaining_seconds(now_ms());
        cx.notify();
    }

    pub fn set_pomodoro(&mut self, pomodoro: bool, cx: &mut Context<Self>) {
        if !self.timer_active() && !self.stopwatch_active() {
            self.pomodoro = pomodoro;
            cx.notify();
        }
    }

    fn complete_countdown(&mut self, cx: &mut Context<Self>) {
        let ty = self.countdown.timer_type;
        let (title, body) = completion_message(ty, &self.title_html);
        self.svc.notify_timer_complete(title, &body);
        if self.sound_enabled {
            self.svc.host().play_notification_sound();
        }
        let input = input_for(&self.title_html, ty, self.countdown.planned_seconds(), self.countdown.actual_seconds(), self.pending_issue.as_ref());
        match self.svc.save_session(&input) {
            Ok(session) => {
                self.save_error = None;
                self.assign_pending_tags(&session);
                self.pending_tags.clear();
                self.pending_issue = None;
                self.reload_tags(cx);
                self.history_stale = true;
            }
            Err(e) => self.save_error = Some(e.to_string()),
        }
    }

    fn assign_pending_tags(&mut self, session: &Session) {
        for tag_id in &self.pending_tags {
            if let Err(e) = self.svc.assign_tag(&AssignTagInput { session_id: session.id.clone(), tag_id: *tag_id }) {
                self.save_error = Some(e.to_string());
            }
        }
    }

    // --- Click-to-edit time ---

    pub fn start_time_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.countdown.status != Status::Idle || self.edit.is_some() {
            return;
        }
        let secs = self.countdown.remaining_seconds(now_ms()).max(0);
        let mins = TextInput::new(display_field_style(), "", window, cx);
        let secs_field = TextInput::new(display_field_style(), "", window, cx);
        mins.update(cx, |f, cx| f.set_text(&format!("{:02}", secs / 60), cx));
        secs_field.update(cx, |f, cx| f.set_text(&format!("{:02}", secs % 60), cx));
        let mut subs = vec![];
        for (field, max_len) in [(mins.clone(), 3usize), (secs_field.clone(), 2usize)] {
            subs.push(cx.subscribe_in(&field, window, move |this, f, ev: &TextFieldEvent, window, cx| match ev {
                TextFieldEvent::Changed => this.filter_digits(f, max_len, cx),
                TextFieldEvent::Submit => this.commit_time_edit(cx),
                TextFieldEvent::Cancel => this.cancel_time_edit(window, cx),
            }));
            let handle = field.read(cx).focus_handle().clone();
            subs.push(cx.on_focus_out(&handle, window, |this, _, window, cx| this.focus_left_edit(window, cx)));
        }
        let focus = mins.read(cx).focus_handle().clone();
        window.focus(&focus);
        self.edit = Some(TimeEdit { mins, secs: secs_field, subs });
        cx.notify();
    }

    fn filter_digits(&mut self, field: &Entity<TextField>, max_len: usize, cx: &mut Context<Self>) {
        let text = field.read(cx).text().to_string();
        let clean: String = text.chars().filter(char::is_ascii_digit).take(max_len).collect();
        if clean != text {
            field.update(cx, |f, cx| f.set_text(&clean, cx));
        }
    }

    fn focus_left_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = &self.edit else { return };
        let inside = edit.mins.read(cx).focus_handle().contains_focused(window, cx) || edit.secs.read(cx).focus_handle().contains_focused(window, cx);
        if !inside {
            self.commit_time_edit(cx);
        }
    }

    pub fn commit_time_edit(&mut self, cx: &mut Context<Self>) {
        let Some(edit) = self.edit.take() else { return };
        let parse = |t: &str| t.trim().parse::<i64>().unwrap_or(0).max(0);
        let mins = parse(edit.mins.read(cx).text());
        let secs = parse(edit.secs.read(cx).text()).min(59);
        let total = mins * 60 + secs;
        if total > 0 {
            self.countdown.set_remaining(total);
            self.shown_cd = self.countdown.remaining_seconds(now_ms());
        }
        cx.notify();
    }

    fn cancel_time_edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.edit = None;
        window.focus(&self.focus_target(cx));
        cx.notify();
    }

    fn focus_target(&self, cx: &App) -> FocusHandle {
        self.rich.read(cx).focus_handle().clone()
    }

    // --- Stopwatch ---

    pub fn handle_stopwatch_start(&mut self, cx: &mut Context<Self>, window: &mut Window) {
        if Self::title_is_blank(&self.sw_title_html) {
            return;
        }
        if self.sw_settings.prompt_for_issue && self.sw_issue.is_none() {
            self.open_prompt(PromptPurpose::StopwatchStart, window, cx);
        } else {
            self.start_stopwatch(cx);
        }
    }

    pub fn start_stopwatch(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        self.stopwatch.start(now);
        self.shown_sw = self.stopwatch.elapsed_seconds(now);
        self.sw_save_error = None;
        self.schedule_ticks(cx);
        cx.notify();
    }

    pub fn pause_stopwatch(&mut self, cx: &mut Context<Self>) {
        self.stopwatch.pause(now_ms());
        cx.notify();
    }

    pub fn resume_stopwatch(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        self.stopwatch.resume(now);
        self.shown_sw = self.stopwatch.elapsed_seconds(now);
        self.schedule_ticks(cx);
        cx.notify();
    }

    pub fn stop_stopwatch(&mut self, cx: &mut Context<Self>) {
        let now = now_ms();
        let Some(secs) = self.stopwatch.stop(now) else { return };
        self.shown_sw = secs;
        let saved = match self.stopwatch.restored_session_id.clone() {
            Some(id) => self.svc.update_session_duration(&id, secs),
            None => self.svc.save_session(&input_for(&self.sw_title_html, TimerType::Stopwatch, 0, secs, self.sw_issue.as_ref())),
        };
        match saved {
            Ok(_) => {
                self.sw_save_error = None;
                self.stopwatch.restored_session_id = None;
                self.history_stale = true;
            }
            Err(e) => self.sw_save_error = Some(e.to_string()),
        }
        cx.notify();
    }

    pub fn cancel_stopwatch_restore(&mut self, cx: &mut Context<Self>) {
        if self.stopwatch.status == Status::Idle && self.stopwatch.restored_session_id.is_some() {
            self.stopwatch.clear();
            self.shown_sw = 0;
            self.sw_title_html.clear();
            self.sw_issue = None;
            self.sw_rich.update(cx, |r, cx| r.set_html("", cx));
            cx.notify();
        }
    }

    // --- Resume a saved session ---

    pub fn restore_session(&mut self, s: &Session, window: &mut Window, cx: &mut Context<Self>) {
        let issue = reconstruct_issue(s);
        if s.timer_type == TimerType::Stopwatch {
            if self.stopwatch.status != Status::Idle {
                return;
            }
            self.stopwatch.restore(s.actual_duration_seconds * 1000, s.id.clone());
            self.shown_sw = s.actual_duration_seconds;
            self.sw_title_html = s.title.clone();
            self.sw_issue = issue;
            self.sw_rich.update(cx, |r, cx| r.set_html(&s.title, cx));
            self.pomodoro = false;
        } else {
            if self.countdown.status != Status::Idle || self.stopwatch_active() {
                return;
            }
            self.countdown.restore(s.timer_type, s.planned_duration_seconds, s.actual_duration_seconds);
            self.shown_cd = self.countdown.remaining_seconds(now_ms());
            self.title_html = s.title.clone();
            self.rich.update(cx, |r, cx| r.set_html(&s.title, cx));
            if issue.is_some() {
                self.pending_issue = issue;
            }
            self.pomodoro = true;
        }
        self.page = crate::app::Page::Timer;
        let _ = window;
        cx.notify();
    }

    // --- Issue prompt ---

    pub fn open_prompt(&mut self, purpose: PromptPurpose, window: &mut Window, cx: &mut Context<Self>) {
        let svc = self.svc.clone();
        let prompt = cx.new(|cx| IssuePrompt::new(&svc, window, cx));
        cx.subscribe_in(&prompt, window, |this, _, ev: &PromptEvent, window, cx| this.on_prompt_event(ev, window, cx)).detach();
        self.prompt = Some((prompt, purpose));
        cx.notify();
    }

    fn on_prompt_event(&mut self, ev: &PromptEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some((_, purpose)) = self.prompt.take() else { return };
        match (purpose, ev) {
            (PromptPurpose::StopwatchStart, PromptEvent::Select(issue)) => {
                self.sw_issue = Some(issue.clone());
                self.start_stopwatch(cx);
            }
            (PromptPurpose::StopwatchStart, PromptEvent::Skip) => self.start_stopwatch(cx),
            (PromptPurpose::LinkTimer, PromptEvent::Select(issue)) => self.pending_issue = Some(issue.clone()),
            (PromptPurpose::LinkStopwatch, PromptEvent::Select(issue)) => self.sw_issue = Some(issue.clone()),
            (_, PromptEvent::Skip) => {}
        }
        let focus = self.focused_rich().read(cx).focus_handle().clone();
        window.focus(&focus);
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{completion_message, input_for};
    use lizmeter_core::{IssueRef, TimerType};

    #[test]
    fn a_session_input_carries_the_linked_issue() {
        let issue = IssueRef::Todo { id: 9, title: "Write docs".into() };
        let input = input_for("<p>x</p>", TimerType::Work, 1500, 1498, Some(&issue));
        assert_eq!(input.issue_id.as_deref(), Some("9"));
        assert_eq!(input.issue_title.as_deref(), Some("Write docs"));
        assert_eq!(input.planned_duration_seconds, 1500);
        let plain = input_for("t", TimerType::Stopwatch, 0, 61, None);
        assert!(plain.issue_provider.is_none() && plain.issue_id.is_none());
    }

    #[test]
    fn the_notification_names_the_session_or_falls_back() {
        assert_eq!(completion_message(TimerType::Work, "<p>Docs</p>"), ("Pomodoro Complete!", "\"Docs\" is done. Time for a break!".to_string()));
        assert_eq!(completion_message(TimerType::Work, "<p></p>").1, "Time for a break!");
        assert_eq!(completion_message(TimerType::ShortBreak, "").0, "Break Complete!");
        assert_eq!(completion_message(TimerType::Stopwatch, "").1, "Session ended.");
    }
}
