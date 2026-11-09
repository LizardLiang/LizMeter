//! The Timer page: mode toggle, the Pomodoro card and the Stopwatch card.

use crate::app::{PromptPurpose, Root};
use crate::css::{Spec, TRANSPARENT, hex, linear, rgba};
use crate::engine::Status;
use crate::flow::now_ms;
use crate::fmt::{format_elapsed, issue_ref_id, issue_ref_title};
use crate::timer::{self, ControlState, DisplayEdit};
use crate::ui::*;
use gpui::*;

const ORANGE: crate::css::C = hex(0xff9e64);

fn btn_like_w(text: &str, size: f32, weight: f32) -> Div {
    div().font_family(BTN_FONT).text_size(px(size)).line_height(px((size * 1.15).round())).font_weight(FontWeight(weight)).child(text.to_string())
}

fn error_line(text: &str) -> Div {
    ui_text(12.0).text_color(col(TN_RED)).flex().justify_center().child(text.to_string())
}

impl Root {
    pub fn timer_page(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let disabled = self.timer_active() || self.stopwatch_active();
        let toggle = timer::mode_toggle(self.pomodoro, disabled, move |pomodoro, _, app| me.update(app, |t, cx| t.set_pomodoro(pomodoro, cx)));
        let card = if self.pomodoro { self.pomodoro_card(cx).into_any_element() } else { self.stopwatch_card(cx).into_any_element() };
        let mut page = div().id("timer-page").w(px(480.0)).h_full().pt(px(32.0)).px(px(24.0)).pb(px(24.0)).flex().flex_col().overflow_y_scroll();
        page = page.child(div().mb(px(16.0)).child(toggle)).child(card);
        if self.pomodoro && self.timer_active() {
            page = page.child(
                div()
                    .pt(px(16.0))
                    .pb(px(6.0))
                    .border_t_1()
                    .border_color(col(rgba(122, 162, 247, 0.08)))
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .child(timer::section_label("Session Tags"))
                    .child(self.tag_picker.clone()),
            );
        }
        page
    }

    fn link_button(&self, issue: Option<(String, String)>, purpose: PromptPurpose, cx: &mut Context<Self>) -> AnyElement {
        let (open, clear) = (cx.entity(), cx.entity());
        timer::link_issue_button(
            issue,
            move |window, app| open.update(app, |t, cx| t.open_prompt(purpose, window, cx)),
            move |_, app| {
                clear.update(app, |t, cx| {
                    if purpose == PromptPurpose::LinkStopwatch {
                        t.sw_issue = None;
                    } else {
                        t.pending_issue = None;
                    }
                    cx.notify();
                })
            },
        )
    }

    fn pomodoro_card(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let status = self.countdown.status;
        let idle = status == Status::Idle;
        let ttype = self.countdown.timer_type;
        let now = now_ms();
        let remaining = self.countdown.remaining_seconds(now);
        let (m_type, m_start, m_pause, m_resume, m_reset, m_dismiss, m_edit) = (me.clone(), me.clone(), me.clone(), me.clone(), me.clone(), me.clone(), me.clone());

        let edit = self.edit.as_ref().map(|e| DisplayEdit { mins: e.mins.clone(), secs: e.secs.clone() });
        let issue = self.pending_issue.as_ref().map(|i| (issue_ref_id(i), issue_ref_title(i).to_string()));
        let controls = timer::controls(
            ControlState { status, start_disabled: Self::title_is_blank(&self.title_html), restored: self.countdown.restored_planned.is_some() },
            move |_, app| m_start.update(app, |t, cx| t.start(cx)),
            move |_, app| m_pause.update(app, |t, cx| t.pause(cx)),
            move |_, app| m_resume.update(app, |t, cx| t.resume(cx)),
            move |_, app| m_reset.update(app, |t, cx| t.reset(cx)),
            move |_, app| m_dismiss.update(app, |t, cx| t.dismiss_completion(cx)),
        );
        let mut card = timer::card_glass(ttype, 0.12)
            .el()
            .w_full()
            .flex_shrink_0()
            .pt(px(25.0))
            .px(px(23.0))
            .pb(px(23.0))
            .flex()
            .flex_col()
            .child(timer::section_label("Timer"))
            .child(div().mt(px(8.0)).child(timer::type_selector(ttype, idle, move |ty, _, app| m_type.update(app, |t, cx| t.set_type(ty, cx)))))
            .child(timer::timer_display(status, remaining, idle, edit, move |window, app| m_edit.update(app, |t, cx| t.start_time_edit(window, cx))))
            .child(
                div()
                    .py(px(6.0))
                    .flex()
                    .flex_col()
                    .child(
                        ui_text(11.0)
                            .h(px(14.0))
                            .line_height(px(14.0))
                            .mb(px(8.0))
                            .font_weight(FontWeight(700.0))
                            .text_color(col(TN_TEXT_DIM))
                            .child(spaced("SESSION DESCRIPTION", 1.32)),
                    )
                    .child(self.rich.clone()),
            );
        if status != Status::Completed {
            card = card.child(div().mt(px(10.0)).flex().flex_row().child(self.link_button(issue, PromptPurpose::LinkTimer, cx)));
        }
        card = card.child(controls);
        if let Some(e) = &self.save_error {
            card = card.child(error_line(e));
        }
        self.rich.update(cx, |r, cx| r.set_disabled(status == Status::Completed, cx));
        card
    }

    fn stopwatch_card(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let status = self.stopwatch.status;
        let active = matches!(status, Status::Running | Status::Paused);
        let now = now_ms();
        let elapsed = self.stopwatch.elapsed_seconds(now);
        let glass = Glass::new(
            18.0,
            32.0,
            1.6,
            Spec::rrect(18.0)
                .fill(linear(135.0, &[(0.0, wh(0.08)), (0.35, wh(0.02)), (0.58, TRANSPARENT)]))
                .fill(linear(315.0, &[(0.0, bk(0.08)), (0.38, TRANSPARENT)]))
                .solid(rgba(16, 18, 36, 0.52))
                .border(1.0, rgba(122, 162, 247, 0.14))
                .inset(0.0, 1.0, wh(0.12))
                .inset(1.0, 0.0, wh(0.06))
                .inset(0.0, -1.0, bk(0.18))
                .inset(-1.0, 0.0, bk(0.06)),
        )
        .shadows(&[sh(0.0, 12.0, 40.0, bk(0.40)), sh(0.0, 4.0, 12.0, bk(0.25))]);
        let select = Glass::new(8.0, 0.0, 1.0, Spec::rrect(8.0).solid(rgba(16, 17, 32, 0.6)).border(1.0, rgba(59, 66, 97, 0.7)))
            .el()
            .w_full()
            .h(px(33.0))
            .px(px(13.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .text_color(col(TN_TEXT_DIM))
            .child(btn_like_w("Link Claude Code session\u{2026}", 14.0, 400.0))
            .child(svg().path("icons/caret.svg").size(px(12.0)).text_color(col(TN_TEXT_DIM)));
        self.sw_rich.update(cx, |r, cx| r.set_disabled(active, cx));

        let mut el = glass.el().w_full().flex_shrink_0().p(px(25.0)).flex().flex_col().gap(px(16.0));
        el = el
            .child(ui_text(11.0).h(px(14.0)).line_height(px(14.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(spaced("STOPWATCH", 1.5)))
            .child(self.sw_rich.clone())
            .child(select);
        if status == Status::Idle {
            let issue = self.sw_issue.as_ref().map(|i| (issue_ref_id(i), issue_ref_title(i).to_string()));
            el = el.child(div().w_full().flex().flex_row().child(self.link_button(issue, PromptPurpose::LinkStopwatch, cx)));
        }
        el = el.child(
            ui_text(56.0)
                .py(px(16.0))
                .h(px(88.0))
                .line_height(px(56.0))
                .flex()
                .justify_center()
                .font_weight(FontWeight(700.0))
                .text_color(col(TN_BLUE))
                .child(spaced(&format_elapsed(elapsed), 2.0)),
        );
        if active {
            if let Some(i) = &self.sw_issue {
                el = el.child(
                    div().flex().flex_row().justify_center().child(
                        div()
                            .px(px(12.0))
                            .py(px(6.0))
                            .rounded(px(6.0))
                            .border(px(1.0))
                            .border_color(col(rgba(125, 207, 255, 0.25)))
                            .bg(col(rgba(125, 207, 255, 0.10)))
                            .flex()
                            .flex_row()
                            .gap(px(8.0))
                            .text_size(px(12.0))
                            .child(div().font_weight(FontWeight(600.0)).text_color(col(TN_CYAN)).child(issue_ref_id(i)))
                            .child(div().max_w(px(200.0)).truncate().child(issue_ref_title(i).to_string())),
                    ),
                );
            }
        }
        let button = |id: &'static str, label: &'static str, bg: Option<crate::css::C>, fg: crate::css::C, border: bool, on: Box<dyn Fn(&mut Window, &mut App)>| {
            let mut b = div().id(id).h(px(36.0)).px(px(28.0)).flex().items_center().rounded(px(8.0)).text_color(col(fg)).cursor_pointer().on_click(move |_, w, a| on(w, a)).child(btn_like_w(label, 14.0, 600.0));
            if let Some(bg) = bg {
                b = b.bg(col(bg)).hover(|s| s.opacity(0.85));
            }
            if border {
                b = b.border(px(1.0)).border_color(col(rgba(169, 177, 214, 0.4))).hover(|s| s.text_color(col(TN_RED)).border_color(col(TN_RED)));
            }
            b
        };
        let ink = hex(0x1a1b26);
        let mut controls = div().flex().flex_row().justify_center().gap(px(12.0));
        match status {
            Status::Idle => {
                let m = me.clone();
                let start = button("sw-start", "Start", Some(TN_BLUE), ink, false, Box::new(move |window, app| m.update(app, |t, cx| t.handle_stopwatch_start(cx, window))));
                controls = controls.child(start);
                if self.stopwatch.restored_session_id.is_some() {
                    let m = me.clone();
                    controls = controls.child(button("sw-cancel", "Cancel", None, TN_TEXT_DIM, true, Box::new(move |_, app| m.update(app, |t, cx| t.cancel_stopwatch_restore(cx)))));
                }
            }
            Status::Running => {
                let (p, s) = (me.clone(), me.clone());
                controls = controls
                    .child(button("sw-pause", "Pause", Some(ORANGE), ink, false, Box::new(move |_, app| p.update(app, |t, cx| t.pause_stopwatch(cx)))))
                    .child(button("sw-stop", "Stop", Some(TN_RED), ink, false, Box::new(move |_, app| s.update(app, |t, cx| t.stop_stopwatch(cx)))));
            }
            Status::Paused => {
                let (r, s) = (me.clone(), me.clone());
                controls = controls
                    .child(button("sw-resume", "Resume", Some(TN_GREEN), ink, false, Box::new(move |_, app| r.update(app, |t, cx| t.resume_stopwatch(cx)))))
                    .child(button("sw-stop", "Stop", Some(TN_RED), ink, false, Box::new(move |_, app| s.update(app, |t, cx| t.stop_stopwatch(cx)))));
            }
            Status::Completed => {}
        }
        el = el.child(controls);
        if let Some(e) = &self.sw_save_error {
            el = el.child(error_line(e));
        }
        el
    }
}
