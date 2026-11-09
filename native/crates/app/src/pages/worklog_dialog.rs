//! `WorklogConfirmDialog.tsx`: confirm the time span and description before logging work to Jira.
//! One session is logged on its own; several (a date group) are merged by `worklog.rs` and can be
//! ticked on and off.

use super::todo_widgets::{cancel_button, dialog_glass, modal_overlay};
use super::worklog::{self, Summary};
use crate::controls::field_style;
use crate::css::{hex, rgba, Spec};
use crate::fmt::format_local_time;
use crate::ui::*;
use gpui::prelude::FluentBuilder;
use gpui::*;
use lizmeter_core::{Session, WorklogStatus};
use lizmeter_ui::text_input::{TextArea, TextField, TextFieldEvent, TextInput};
use std::collections::HashSet;

/// What Confirm hands back: the span in UTC ISO, the description and the ticked sessions.
pub struct WorklogConfirm {
    pub start_time: String,
    pub end_time: String,
    pub description: String,
    pub selected_ids: Vec<String>,
}

pub enum WorklogEvent {
    Confirm(WorklogConfirm),
    Cancel,
}

impl EventEmitter<WorklogEvent> for WorklogDialog {}

pub struct WorklogDialog {
    sessions: Vec<Session>,
    issue_key: String,
    is_relog: bool,
    selected: HashSet<String>,
    selection_key: String,
    start: Entity<TextField>,
    end: Entity<TextField>,
    description: Entity<TextField>,
    focus: FocusHandle,
}

impl WorklogDialog {
    pub fn new(sessions: Vec<Session>, issue_key: &str, is_relog: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let selected: HashSet<String> = sessions.iter().map(|s| s.id.clone()).collect();
        let bulk = sessions.len() > 1;
        let style = field_style(13.0);
        let start = TextInput::new(style.clone(), "YYYY-MM-DD HH:MM", window, cx);
        let end = TextInput::new(style.clone(), "YYYY-MM-DD HH:MM", window, cx);
        let description = if bulk { TextArea::new(style, "Work session", window, cx) } else { TextInput::new(style, "Work session", window, cx) };
        for f in [&start, &end, &description] {
            cx.subscribe(f, |this, _, ev: &TextFieldEvent, cx| match ev {
                TextFieldEvent::Changed => cx.notify(),
                TextFieldEvent::Submit => this.confirm(cx),
                TextFieldEvent::Cancel => cx.emit(WorklogEvent::Cancel),
            })
            .detach();
        }
        let focus = cx.focus_handle();
        let mut this = Self { sessions, issue_key: issue_key.to_string(), is_relog, selection_key: String::new(), selected, start, end, description, focus };
        this.apply_defaults(cx);
        this
    }

    fn selected_sessions(&self) -> Vec<Session> {
        self.sessions.iter().filter(|s| self.selected.contains(&s.id)).cloned().collect()
    }

    fn key_of(&self) -> String {
        let mut ids: Vec<&String> = self.selected.iter().collect();
        ids.sort();
        ids.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",")
    }

    fn summary(&self) -> (Summary, Vec<Session>) {
        let selected = self.selected_sessions();
        let summary = worklog::summarize(&selected);
        let uploadable = selected.into_iter().filter(|s| summary.uploadable_ids.contains(&s.id)).collect();
        (summary, uploadable)
    }

    /// The times and description follow the ticked sessions, as Electron resets them when the selection changes.
    fn apply_defaults(&mut self, cx: &mut Context<Self>) {
        let (summary, uploadable) = self.summary();
        let refs: Vec<&Session> = uploadable.iter().collect();
        let (start, end, desc) = worklog::defaults(&summary, &refs);
        self.start.update(cx, |f, cx| f.set_text(&worklog::to_local_value(start).replace('T', " "), cx));
        self.end.update(cx, |f, cx| f.set_text(&worklog::to_local_value(end).replace('T', " "), cx));
        self.description.update(cx, |f, cx| f.set_text(&desc, cx));
        self.selection_key = self.key_of();
    }

    fn toggle(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.selected.remove(id) {
            self.selected.insert(id.to_string());
        }
        self.apply_defaults(cx);
        cx.notify();
    }

    fn toggle_all(&mut self, cx: &mut Context<Self>) {
        if self.selected.len() == self.sessions.len() {
            self.selected.clear();
        } else {
            self.selected = self.sessions.iter().map(|s| s.id.clone()).collect();
        }
        self.apply_defaults(cx);
        cx.notify();
    }

    fn checked(&self, cx: &App) -> worklog::Checked {
        let (summary, uploadable) = self.summary();
        worklog::check(uploadable.len(), self.start.read(cx).text(), self.end.read(cx).text(), &summary)
    }

    pub fn confirm(&mut self, cx: &mut Context<Self>) {
        if self.checked(cx).error.is_some() {
            return;
        }
        let (Some(s), Some(e)) = (worklog::from_local_value(self.start.read(cx).text()), worklog::from_local_value(self.end.read(cx).text())) else { return };
        let mut ids: Vec<String> = self.selected.iter().cloned().collect();
        ids.sort();
        cx.emit(WorklogEvent::Confirm(WorklogConfirm {
            start_time: worklog::iso_from_ms(s),
            end_time: worklog::iso_from_ms(e),
            description: self.description.read(cx).text().to_string(),
            selected_ids: ids,
        }));
    }

    fn label(text: &str) -> Div {
        ui_text(12.0).line_height(px(15.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT_DIM)).child(spaced(&text.to_uppercase(), 0.72))
    }

    fn input(field: &Entity<TextField>, error: bool, focused: bool) -> Div {
        let border = if error {
            TN_RED_RGBA
        } else if focused {
            rgba(122, 162, 247, 0.5)
        } else {
            rgba(86, 95, 137, 0.35)
        };
        Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(12, 13, 26, 0.55)).border(1.0, border))
            .el()
            .w_full()
            .px(px(12.0))
            .py(px(8.0))
            .when(focused && !error, |d| d.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 3.0, color: rgba(122, 162, 247, 0.08) }])))
            .child(field.clone())
    }

    fn check_box(on: bool) -> Div {
        let b = div().size(px(13.0)).flex_shrink_0().rounded(px(2.0)).flex().items_center().justify_center();
        if on {
            b.bg(col(TN_BLUE)).text_color(col(hex(0xffffff))).text_size(px(10.0)).line_height(px(10.0)).font_weight(FontWeight(700.0)).child("\u{2713}")
        } else {
            b.bg(col(hex(0xffffff))).border(px(1.0)).border_color(col(hex(0x767676)))
        }
    }
}

const TN_RED_RGBA: crate::css::C = rgba(247, 118, 142, 1.0);

impl Render for WorklogDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = |f: &Entity<TextField>| f.read(cx).focus_handle().is_focused(window);
        let (start_on, end_on, desc_on) = (focused(&self.start), focused(&self.end), focused(&self.description));
        let me = cx.entity();
        let bulk = self.sessions.len() > 1;
        let (summary, uploadable) = self.summary();
        let checked = self.checked(cx);
        let error = checked.error;
        let title = format!(
            "{} Work to {}{}",
            if self.is_relog { "Re-log" } else { "Log" },
            self.issue_key,
            if bulk { format!(" ({}/{} sessions)", self.selected.len(), self.sessions.len()) } else { String::new() }
        );

        let header = div()
            .relative()
            .px(px(20.0))
            .py(px(16.0))
            .flex()
            .items_center()
            .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(86, 95, 137, 0.3))))
            .child(ui_text(15.0).line_height(px(19.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(title));

        let mut body = div().p(px(20.0)).flex().flex_col().gap(px(16.0));
        if self.is_relog {
            let text = if bulk {
                "Some sessions have already been logged. Confirming will create duplicate worklog entries for those."
            } else {
                "This session has already been logged to Jira. Confirming will create a duplicate worklog entry."
            };
            body = body.child(
                ui_text(12.0)
                    .px(px(14.0))
                    .py(px(10.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(224, 175, 104, 0.4)))
                    .bg(col(rgba(224, 175, 104, 0.08)))
                    .text_color(col(TN_YELLOW))
                    .line_height(px(18.0))
                    .child(text),
            );
        }
        if bulk {
            let all_on = self.selected.len() == self.sessions.len();
            let m = me.clone();
            let mut list = div().rounded(px(6.0)).border(px(1.0)).border_color(col(rgba(86, 95, 137, 0.3))).overflow_hidden().flex().flex_col().child(
                div()
                    .id("wl-all")
                    .px(px(10.0))
                    .py(px(6.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .cursor_pointer()
                    .bg(col(rgba(86, 95, 137, 0.1)))
                    .border_b_1()
                    .border_color(col(rgba(86, 95, 137, 0.2)))
                    .on_click(move |_, _, app| m.update(app, |d, cx| d.toggle_all(cx)))
                    .child(Self::check_box(all_on))
                    .child(ui_text(12.0).line_height(px(15.0)).text_color(col(TN_TEXT)).child("Select all")),
            );
            for (i, s) in self.sessions.iter().enumerate() {
                let (m, id) = (me.clone(), s.id.clone());
                let mut row = div()
                    .id(SharedString::from(format!("wl-{i}")))
                    .px(px(10.0))
                    .py(px(6.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .cursor_pointer()
                    .hover(|r| r.bg(col(rgba(86, 95, 137, 0.08))))
                    .on_click(move |_, _, app| m.update(app, |d, cx| d.toggle(&id, cx)))
                    .child(Self::check_box(self.selected.contains(&s.id)))
                    .child(
                        ui_text(12.0)
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .line_height(px(15.0))
                            .text_color(col(TN_TEXT))
                            .child(if s.title.is_empty() { "(no title)".to_string() } else { s.title.clone() }),
                    )
                    .child(
                        ui_text(11.0)
                            .flex_shrink_0()
                            .line_height(px(14.0))
                            .text_color(col(TN_TEXT_DIM))
                            .child(format!("{} \u{b7} {}", worklog::format_duration(s.actual_duration_seconds), format_local_time(&s.completed_at))),
                    );
                if i > 0 {
                    row = row.border_t_1().border_color(col(rgba(86, 95, 137, 0.1)));
                }
                if !summary.uploadable_ids.contains(&s.id) {
                    row = row.child(badge("Break"));
                }
                if s.worklog_status == WorklogStatus::Logged {
                    row = row.child(badge("Logged"));
                }
                list = list.child(row);
            }
            body = body.child(list.max_h(px(200.0)));
            body = body.child(
                ui_text(13.0)
                    .line_height(px(16.0))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(TN_CYAN))
                    .child(format!("Uploadable sessions: {} \u{b7} Included break time: {}", uploadable.len(), worklog::format_duration(checked.break_seconds))),
            );
        }
        let err = error.is_some();
        body = body.child(
            div()
                .flex()
                .flex_row()
                .gap(px(12.0))
                .child(div().flex_1().flex().flex_col().gap(px(6.0)).child(Self::label("Start Time")).child(Self::input(&self.start, err, start_on)))
                .child(div().flex_1().flex().flex_col().gap(px(6.0)).child(Self::label("End Time")).child(Self::input(&self.end, err, end_on))),
        );
        body = body.child(match error {
            Some(e) => ui_text(12.0).line_height(px(15.0)).text_color(col(TN_RED)).child(e),
            None => ui_text(13.0).line_height(px(16.0)).font_weight(FontWeight(600.0)).text_color(col(TN_CYAN)).child(format!("Uploaded work time: {}", worklog::format_duration(checked.duration_seconds))),
        });
        body = body.child(div().flex().flex_col().gap(px(6.0)).child(Self::label("Description")).child(Self::input(&self.description, false, desc_on).when(bulk, |d| d.min_h(px(76.5)))));

        let (m_cancel, m_ok) = (me.clone(), me.clone());
        let confirm = {
            let b = div()
                .id("wl-confirm")
                .px(px(18.0))
                .py(px(8.0))
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(col(rgba(122, 162, 247, 0.4)))
                .bg(col(rgba(122, 162, 247, 0.12)))
                .font_family(BTN_FONT)
                .text_size(px(13.0))
                .line_height(px(16.0))
                .font_weight(FontWeight(600.0))
                .text_color(col(TN_BLUE))
                .child(if self.is_relog { "Re-log Work" } else { "Log Work" });
            if err {
                b.opacity(0.5).cursor_not_allowed()
            } else {
                b.cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.2)))).on_click(move |_, _, app| m_ok.update(app, |d, cx| d.confirm(cx)))
            }
        };
        let footer = div()
            .relative()
            .px(px(20.0))
            .py(px(16.0))
            .flex()
            .flex_row()
            .justify_end()
            .gap(px(10.0))
            .child(layer(Spec::rrect(0.0).border_sides(1.0, 0.0, 0.0, 0.0, rgba(86, 95, 137, 0.3))))
            .child(cancel_button("wl-cancel", "Cancel").px(px(18.0)).py(px(8.0)).h_auto().on_click(move |_, _, app| m_cancel.update(app, |_, cx| cx.emit(WorklogEvent::Cancel))))
            .child(confirm);

        let dialog = dialog_glass(18.0)
            .id("worklog-dialog")
            .w(px(540.0))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .overflow_hidden()
            .track_focus(&self.focus)
            .on_click(|_, _, _| {})
            .on_key_down(cx.listener(|_, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" {
                    cx.emit(WorklogEvent::Cancel);
                }
            }))
            .child(header)
            .child(body)
            .child(footer);
        let close = me.clone();
        modal_overlay("worklog", None, dialog, move |_, app| close.update(app, |_, cx| cx.emit(WorklogEvent::Cancel)))
    }
}

fn badge(text: &str) -> Div {
    ui_text(10.0)
        .flex_shrink_0()
        .line_height(px(13.0))
        .px(px(6.0))
        .py(px(1.0))
        .rounded(px(3.0))
        .border(px(1.0))
        .border_color(col(rgba(158, 206, 106, 0.3)))
        .bg(col(rgba(158, 206, 106, 0.1)))
        .text_color(col(TN_GREEN))
        .child(text.to_string())
}
