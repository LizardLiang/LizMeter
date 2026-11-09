//! Claude Code on the Timer page: the session select (`ClaudeSessionSelect.tsx`), the live stats
//! card (`ClaudeCodeStats.tsx`), the new-session notice (`NewSessionNotification.tsx`) and the
//! session picker panel (`SessionPicker.tsx`).

use crate::css::{Spec, hex, rgba};
use crate::ui::*;
use chrono::{DateTime, Utc};
use gpui::prelude::FluentBuilder;
use gpui::*;
use lizmeter_core::{ClaudeCodeLiveStats, ClaudeCodeSessionPreview, ClaudeCodeSessionPreviewWithProject, ClaudeSessionActivity, ClaudeSessionActivityType};
use lizmeter_services::Services;
use lizmeter_ui::scrollbar::{BarStyle, Scroll};
use std::sync::Arc;
use std::time::{Duration, Instant};

const BLUE: crate::css::C = hex(0x7aa2f7);
const PURPLE: crate::css::C = hex(0xbb9af7);

/// A Claude Code session the user linked to the timer or the stopwatch (`SelectedClaudeSession`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Linked {
    pub uuid: String,
    pub project_dir: String,
}

pub enum SelectEvent {
    Pick(Option<Linked>),
}

/// `ClaudeSessionSelect.formatRelativeTime`: "just now", "1m ago", "5m ago", "1h ago", "3h ago".
pub fn relative_short(iso: &str, now: DateTime<Utc>) -> String {
    let Ok(t) = DateTime::parse_from_rfc3339(iso) else { return String::new() };
    let minutes = (now - t.with_timezone(&Utc)).num_minutes();
    match minutes {
        m if m < 1 => "just now".into(),
        1 => "1m ago".into(),
        m if m < 60 => format!("{m}m ago"),
        m if m / 60 == 1 => "1h ago".into(),
        m => format!("{}h ago", m / 60),
    }
}

/// `SessionPicker.formatRelativeTime`: "just now", "1 min ago", "5 min ago", "2 hr ago", "3d ago".
pub fn relative_long(iso: &str, now: DateTime<Utc>) -> String {
    let Ok(t) = DateTime::parse_from_rfc3339(iso) else { return String::new() };
    let seconds = (now - t.with_timezone(&Utc)).num_seconds();
    if seconds < 60 {
        return "just now".into();
    }
    let minutes = seconds / 60;
    if minutes == 1 {
        return "1 min ago".into();
    }
    if minutes < 60 {
        return format!("{minutes} min ago");
    }
    let hours = minutes / 60;
    if hours == 1 {
        return "1 hr ago".into();
    }
    if hours < 24 {
        return format!("{hours} hr ago");
    }
    format!("{}d ago", hours / 24)
}

/// The last folder of a project path, either slash style.
pub fn last_segment(path: &str) -> String {
    path.replace('\\', "/").split('/').filter(|p| !p.is_empty()).last().map(str::to_string).unwrap_or_else(|| path.to_string())
}

/// `ClaudeCodeStats.formatIdleDuration`.
pub fn idle_text(ms: i64) -> String {
    match ms / 60_000 {
        m if m < 1 => "less than 1 min".into(),
        1 => "1 min".into(),
        m => format!("{m} min"),
    }
}

/// The status next to the card title: its text and colour.
pub fn activity_display(activity: Option<&ClaudeSessionActivity>, idle_ms: Option<i64>, idle: bool) -> (String, crate::css::C) {
    if let (true, Some(ms)) = (idle, idle_ms) {
        return (format!("Idle for {}", idle_text(ms)), TN_YELLOW);
    }
    let Some(a) = activity else { return ("Active".into(), TN_GREEN) };
    match a.kind {
        ClaudeSessionActivityType::Thinking => ("Thinking".into(), BLUE),
        ClaudeSessionActivityType::ToolUse => {
            let tools = a.tool_names.clone().unwrap_or_default();
            let text = match tools.len() {
                0 => "Using tools".to_string(),
                1 | 2 => tools.join(", "),
                n => format!("{}, {} +{}", tools[0], tools[1], n - 2),
            };
            (text, PURPLE)
        }
        ClaudeSessionActivityType::Idle => ("Idle".into(), TN_YELLOW),
    }
}

/// The select's label: the linked session, found among the scanned ones when they are known.
pub fn select_label(selected: Option<&Linked>, sessions: &[ClaudeCodeSessionPreviewWithProject]) -> String {
    let Some(sel) = selected else { return "Link Claude Code session\u{2026}".into() };
    let short: String = sel.uuid.chars().take(8).collect();
    match sessions.iter().find(|s| s.preview.cc_session_uuid == sel.uuid) {
        Some(s) => {
            let what = s.preview.first_user_message.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| last_segment(&s.project_display_path));
            format!("{short} \u{2014} {what}")
        }
        None => short,
    }
}

pub struct ClaudeSessionSelect {
    svc: Arc<Services>,
    id: &'static str,
    pub selected: Option<Linked>,
    sessions: Vec<ClaudeCodeSessionPreviewWithProject>,
    loading: bool,
    open: bool,
    /// When an outside mouse-down last closed the list: the click on the trigger that follows in
    /// the same gesture must not reopen it.
    closed_by_out: Option<Instant>,
    suppress_toggle: bool,
    scan_gen: u64,
    scroll: Scroll,
}

impl EventEmitter<SelectEvent> for ClaudeSessionSelect {}

impl ClaudeSessionSelect {
    pub fn new(svc: Arc<Services>, id: &'static str) -> Self {
        Self { svc, id, selected: None, sessions: vec![], loading: false, open: false, closed_by_out: None, suppress_toggle: false, scan_gen: 0, scroll: Scroll::new(BarStyle::Global) }
    }

    pub fn set_selected(&mut self, selected: Option<Linked>, cx: &mut Context<Self>) {
        self.selected = selected;
        cx.notify();
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Opens the list and scans every project for sessions that wrote lately.
    pub fn open(&mut self, cx: &mut Context<Self>) {
        self.open = true;
        self.loading = true;
        self.scan_gen += 1;
        let generation = self.scan_gen;
        let svc = self.svc.clone();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let sessions = cx.background_executor().spawn(async move { svc.claude_scan_all() }).await;
            let _ = this.update(cx, |s, cx| {
                if s.scan_gen == generation {
                    s.sessions = sessions;
                    s.loading = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        self.scan_gen += 1;
        cx.notify();
    }

    fn pick(&mut self, link: Option<Linked>, cx: &mut Context<Self>) {
        self.selected = link.clone();
        self.close(cx);
        cx.emit(SelectEvent::Pick(link));
    }

    fn row_base(id: SharedString, selected: bool) -> Stateful<Div> {
        div()
            .id(id)
            .w_full()
            .px(px(12.0))
            .py(px(8.0))
            .flex()
            .flex_col()
            .gap(px(2.0))
            .cursor_pointer()
            .border_b_1()
            .border_color(col(rgba(86, 95, 137, 0.15)))
            .bg(col(if selected { rgba(122, 162, 247, 0.1) } else { rgba(0, 0, 0, 0.0) }))
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.08))))
    }

    fn list(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let now = Utc::now();
        let mut rows = div().flex().flex_col();
        if self.loading {
            rows = rows.child(ui_text(12.0).p(px(12.0)).flex().justify_center().text_color(col(TN_TEXT_DIM)).child("Scanning\u{2026}"));
        } else if self.sessions.is_empty() {
            rows = rows.child(ui_text(12.0).p(px(12.0)).flex().justify_center().text_color(col(TN_TEXT_DIM)).child("No active Claude Code sessions"));
        }
        if !self.loading && self.selected.is_some() {
            let m = me.clone();
            rows = rows.child(
                Self::row_base(SharedString::from(format!("{}-clear", self.id)), false)
                    .flex_row()
                    .text_color(col(TN_RED))
                    .hover(|s| s.bg(col(rgba(247, 118, 142, 0.08))))
                    .on_click(move |_, _, app| m.update(app, |s, cx| s.pick(None, cx)))
                    .child(ui_text(12.0).child("Clear selection")),
            );
        }
        if !self.loading {
            for s in &self.sessions {
                let link = Linked { uuid: s.preview.cc_session_uuid.clone(), project_dir: s.project_dir_name.clone() };
                let on = self.selected.as_ref() == Some(&link);
                let m = me.clone();
                let short: String = link.uuid.chars().take(8).collect();
                let mut row = Self::row_base(SharedString::from(format!("{}-s-{}", self.id, link.uuid)), on)
                    .on_click(move |_, _, app| {
                        let link = link.clone();
                        m.update(app, |s, cx| s.pick(Some(link), cx))
                    })
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(div().font_family(MONO).text_size(px(12.0)).line_height(px(15.0)).font_weight(FontWeight(600.0)).text_color(col(BLUE)).child(short))
                            .child(ui_text(11.0).text_color(col(TN_TEXT_DIM)).child(relative_short(&s.preview.last_activity_at, now)))
                            .child(ui_text(11.0).ml_auto().text_color(col(TN_TEXT_DIM)).child(last_segment(&s.project_display_path))),
                    );
                if let Some(msg) = s.preview.first_user_message.as_ref().filter(|m| !m.is_empty()) {
                    row = row.child(ui_text(12.0).w_full().truncate().text_color(col(TN_TEXT_DIM)).child(msg.clone()));
                }
                rows = rows.child(row);
            }
        }
        let m_out = me.clone();
        div()
            .absolute()
            .top_full()
            .left_0()
            .right_0()
            .mt(px(4.0))
            .max_h(px(280.0))
            .occlude()
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.3)))
            .bg(col(hex(0x1a1b26)))
            .shadow(shadows(&[sh(0.0, 4.0, 12.0, bk(0.4))]))
            .overflow_hidden()
            .on_mouse_down_out(move |_, _, app| {
                m_out.update(app, |s, cx| {
                    if s.open {
                        s.closed_by_out = Some(Instant::now());
                        s.close(cx);
                    }
                })
            })
            .child(div().id(SharedString::from(format!("{}-list", self.id))).track_scroll(self.scroll.handle()).max_h(px(278.0)).overflow_y_scroll().child(self.scroll.pad(rows)))
            .child(self.scroll.bar())
    }
}

impl Render for ClaudeSessionSelect {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let m_down = me.clone();
        let label = select_label(self.selected.as_ref(), &self.sessions);
        let trigger = Glass::new(8.0, 0.0, 1.0, Spec::rrect(8.0).solid(rgba(16, 17, 32, 0.6)).border(1.0, rgba(59, 66, 97, 0.7)))
            .el()
            .id(SharedString::from(format!("{}-trigger", self.id)))
            .w_full()
            .h(px(33.0))
            .px(px(13.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .cursor_pointer()
            .text_color(col(if self.selected.is_some() { TN_TEXT } else { TN_TEXT_DIM }))
            .on_mouse_down(MouseButton::Left, move |_, _, app| {
                m_down.update(app, |s, _| s.suppress_toggle = s.closed_by_out.take().is_some_and(|t| t.elapsed() < Duration::from_millis(80)))
            })
            .on_click(move |_, _, app| {
                me.update(app, |s, cx| {
                    if std::mem::take(&mut s.suppress_toggle) {
                        return;
                    }
                    if s.open { s.close(cx) } else { s.open(cx) }
                })
            })
            .child(div().flex_1().min_w_0().truncate().font_family(BTN_FONT).text_size(px(14.0)).line_height(px(16.0)).child(label))
            .child(svg().path("icons/caret.svg").size(px(12.0)).flex_shrink_0().text_color(col(TN_TEXT_DIM)));
        let mut wrap = div().relative().w_full().child(trigger);
        if self.open {
            wrap = wrap.child(deferred(self.list(cx)).with_priority(3));
        }
        wrap
    }
}

fn blue_button(id: &'static str, label: &str, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(8.0))
        .py(px(2.0))
        .rounded(px(4.0))
        .border(px(1.0))
        .border_color(col(rgba(122, 162, 247, 0.3)))
        .text_color(col(BLUE))
        .cursor_pointer()
        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
        .on_click(move |_, w, a| on_click(w, a))
        .child(ui_text(11.0).child(label.to_string()))
}

/// `NewSessionNotification`: "New CC session detected" with Add and dismiss.
pub fn new_session_notice(on_add: impl Fn(&mut Window, &mut App) + 'static, on_dismiss: impl Fn(&mut Window, &mut App) + 'static) -> Div {
    let yellow = rgba(224, 175, 104, 1.0);
    div()
        .mt(px(6.0))
        .px(px(10.0))
        .py(px(7.0))
        .rounded(px(6.0))
        .border(px(1.0))
        .border_color(col(rgba(224, 175, 104, 0.25)))
        .bg(col(rgba(224, 175, 104, 0.08)))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .child(ui_text(12.0).flex_1().text_color(col(yellow)).child("New CC session detected"))
        .child(
            div()
                .id("cc-notice-add")
                .px(px(10.0))
                .py(px(2.0))
                .flex_shrink_0()
                .rounded(px(4.0))
                .border(px(1.0))
                .border_color(col(rgba(224, 175, 104, 0.4)))
                .bg(col(rgba(224, 175, 104, 0.12)))
                .text_color(col(yellow))
                .cursor_pointer()
                .on_click(move |_, w, a| on_add(w, a))
                .child(ui_text(11.0).font_weight(FontWeight(600.0)).child("Add")),
        )
        .child(
            div()
                .id("cc-notice-dismiss")
                .px(px(6.0))
                .py(px(2.0))
                .flex_shrink_0()
                .text_color(col(TN_TEXT_DIM))
                .cursor_pointer()
                .on_click(move |_, w, a| on_dismiss(w, a))
                .child(ui_text(12.0).child("\u{00d7}")),
        )
}

/// What the stats card shows besides the live numbers.
pub struct StatsView<'a> {
    pub live: Option<&'a ClaudeCodeLiveStats>,
    pub idle_threshold_minutes: i64,
    pub now: DateTime<Utc>,
}

impl StatsView<'_> {
    fn idle_ms(&self) -> Option<i64> {
        let at = self.live?.last_activity_timestamp.as_ref()?;
        let t = DateTime::parse_from_rfc3339(at).ok()?;
        Some((self.now - t.with_timezone(&Utc)).num_milliseconds())
    }

    /// The card's status text and colour.
    pub fn status(&self) -> Option<(String, crate::css::C)> {
        let live = self.live?;
        let idle_ms = self.idle_ms();
        let idle = idle_ms.is_some_and(|ms| ms > self.idle_threshold_minutes * 60_000);
        Some(activity_display(live.session_activity.as_ref(), idle_ms, idle))
    }
}

/// `ClaudeCodeStats`: the compact live card. `manage` adds the "Manage Sessions" button and
/// `notice` the new-session strip.
pub fn stats_card(view: &StatsView, manage: Option<Box<dyn Fn(&mut Window, &mut App)>>, notice: Option<Div>) -> Div {
    let card = || {
        div()
            .mt(px(12.0))
            .px(px(14.0))
            .py(px(10.0))
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.18)))
            .bg(col(rgba(122, 162, 247, 0.06)))
            .flex()
            .flex_col()
            .gap(px(6.0))
    };
    let title = || ui_text(12.0).font_weight(FontWeight(600.0)).text_color(col(BLUE)).child(spaced("CLAUDE CODE", 0.6));
    if let Some(e) = view.live.and_then(|l| l.error.as_ref()) {
        return card().child(title()).child(ui_text(12.0).text_color(col(TN_RED)).child(e.clone()));
    }
    let mut header = div().flex().flex_row().items_center().gap(px(6.0)).child(title());
    if let Some((text, color)) = view.status() {
        header = header.child(ui_text(12.0).font_weight(FontWeight(600.0)).text_color(col(color)).child(spaced(&text.to_uppercase(), 0.6)));
    }
    if let Some(manage) = manage {
        header = header.child(div().ml_auto().child(blue_button("cc-manage", "Manage Sessions", move |w, a| manage(w, a))));
    }
    let row = |label: &str, value: String, color: crate::css::C| {
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(ui_text(12.0).text_color(col(TN_TEXT_DIM)).child(label.to_string()))
            .child(ui_text(13.0).text_color(col(color)).child(value))
    };
    let mut card = card().child(header);
    card = match view.live {
        Some(l) => {
            let mut c = card.child(row("Sessions detected", l.active_sessions.to_string(), TN_TEXT)).child(row("Files edited", l.total_files_edited.to_string(), TN_TEXT));
            if l.idle_sessions > 0 {
                c = c.child(row("Idle sessions", l.idle_sessions.to_string(), TN_YELLOW));
            }
            c
        }
        None => card.child(ui_text(12.0).text_color(col(TN_TEXT_DIM)).child("Waiting for Claude Code activity\u{2026}")),
    };
    if let Some(n) = notice {
        card = card.child(n);
    }
    card
}

/// How the picker panel looks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PickerState {
    Hidden,
    Open,
    Collapsed,
}

/// `SessionPicker`: the collapsed bar, or the checkbox list with Skip and Confirm.
pub struct PickerView<'a> {
    pub state: PickerState,
    pub sessions: &'a [ClaudeCodeSessionPreview],
    pub checked: &'a [String],
    pub tracked: usize,
    pub now: DateTime<Utc>,
}

pub fn session_picker(
    v: &PickerView,
    on_toggle_panel: impl Fn(&mut Window, &mut App) + 'static,
    on_check: impl Fn(String, &mut Window, &mut App) + Clone + 'static,
    on_skip: impl Fn(&mut Window, &mut App) + 'static,
    on_confirm: impl Fn(&mut Window, &mut App) + 'static,
) -> Div {
    let open = v.state == PickerState::Open;
    let header = div()
        .id("cc-picker-head")
        .px(px(14.0))
        .py(px(9.0))
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .bg(col(rgba(122, 162, 247, 0.06)))
        .when(open, |d| d.border_b_1().border_color(col(rgba(122, 162, 247, 0.12))))
        .cursor_pointer()
        .on_click(move |_, w, a| on_toggle_panel(w, a))
        .child(ui_text(12.0).font_weight(FontWeight(600.0)).text_color(col(BLUE)).child(spaced("CLAUDE CODE SESSIONS", 0.6)))
        .child(ui_text(11.0).text_color(col(TN_TEXT_DIM)).child(if open {
            "Collapse \u{25b2}".to_string()
        } else if v.tracked > 0 {
            format!("{} tracked \u{25bc}", v.tracked)
        } else {
            "No sessions tracked \u{25bc}".to_string()
        }));
    let mut panel = div().mt(px(12.0)).rounded(px(8.0)).border(px(1.0)).border_color(col(rgba(122, 162, 247, 0.25))).bg(col(rgba(26, 27, 38, 0.95))).overflow_hidden().flex().flex_col().child(header);
    if !open {
        return panel;
    }
    if v.sessions.is_empty() {
        panel = panel.child(ui_text(12.0).p(px(14.0)).flex().justify_center().text_color(col(TN_TEXT_DIM)).child("No active sessions found"));
    } else {
        let mut list = div().py(px(6.0)).flex().flex_col();
        for s in v.sessions {
            let on = v.checked.contains(&s.cc_session_uuid);
            let (check, uuid) = (on_check.clone(), s.cc_session_uuid.clone());
            let short: String = uuid.chars().take(8).collect();
            let preview = match s.first_user_message.as_ref().filter(|m| !m.is_empty()) {
                Some(m) => ui_text(12.0).flex_1().min_w_0().truncate().text_color(col(TN_TEXT_DIM)).child(m.clone()),
                None => ui_text(12.0).flex_1().min_w_0().truncate().italic().text_color(col(TN_TEXT_DIM)).child("(no preview available)"),
            };
            list = list.child(
                div()
                    .id(SharedString::from(format!("cc-pick-{uuid}")))
                    .px(px(14.0))
                    .py(px(7.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.0))
                    .cursor_pointer()
                    .bg(col(if on { rgba(122, 162, 247, 0.08) } else { rgba(0, 0, 0, 0.0) }))
                    .on_click(move |_, w, a| check(uuid.clone(), w, a))
                    .child(
                        div()
                            .size(px(13.0))
                            .flex_shrink_0()
                            .rounded(px(3.0))
                            .border(px(1.0))
                            .border_color(col(if on { BLUE } else { TN_MUTED }))
                            .bg(col(if on { BLUE } else { rgba(0, 0, 0, 0.0) }))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(col(hex(0x1a1b26)))
                            .text_size(px(10.0))
                            .child(if on { "\u{2713}" } else { "" }),
                    )
                    .child(div().min_w(px(68.0)).font_family(MONO).text_size(px(11.0)).text_color(col(TN_TEXT_DIM)).child(short))
                    .child(ui_text(11.0).min_w(px(64.0)).text_color(col(TN_TEXT_DIM)).child(relative_long(&s.last_activity_at, v.now)))
                    .child(preview),
            );
        }
        panel = panel.child(div().max_h(px(280.0)).overflow_hidden().child(list));
    }
    let confirm_on = !v.checked.is_empty();
    let confirm_label = if confirm_on { format!("Confirm ({})", v.checked.len()) } else { "Confirm".to_string() };
    panel.child(
        div()
            .px(px(14.0))
            .py(px(9.0))
            .border_t_1()
            .border_color(col(rgba(122, 162, 247, 0.12)))
            .flex()
            .flex_row()
            .justify_end()
            .gap(px(8.0))
            .child(
                div()
                    .id("cc-skip")
                    .px(px(14.0))
                    .py(px(5.0))
                    .rounded(px(5.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 162, 247, 0.25)))
                    .text_color(col(BLUE))
                    .cursor_pointer()
                    .on_click(move |_, w, a| on_skip(w, a))
                    .child(div().font_family(BTN_FONT).text_size(px(12.0)).child("Skip")),
            )
            .child(
                div()
                    .id("cc-confirm")
                    .px(px(14.0))
                    .py(px(5.0))
                    .rounded(px(5.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 162, 247, 0.4)))
                    .bg(col(if confirm_on { rgba(122, 162, 247, 0.15) } else { rgba(86, 95, 137, 0.1) }))
                    .text_color(col(if confirm_on { BLUE } else { TN_TEXT_DIM }))
                    .when(confirm_on, |d| d.cursor_pointer().on_click(move |_, w, a| on_confirm(w, a)))
                    .when(!confirm_on, |d| d.cursor_not_allowed())
                    .child(div().font_family(BTN_FONT).text_size(px(12.0)).font_weight(FontWeight(600.0)).child(confirm_label)),
            ),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        ClaudeCodeLiveStats, ClaudeCodeSessionPreview, ClaudeCodeSessionPreviewWithProject, ClaudeSessionActivity, ClaudeSessionActivityType, Linked, StatsView, TN_YELLOW, activity_display, idle_text, last_segment,
        relative_long, relative_short, select_label,
    };
    use chrono::{DateTime, TimeZone, Utc};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 9, 12, 0, 0).unwrap()
    }

    #[test]
    fn short_relative_times_count_whole_minutes_and_hours() {
        assert_eq!(relative_short("2026-11-09T11:59:40Z", now()), "just now");
        assert_eq!(relative_short("2026-11-09T11:59:00Z", now()), "1m ago");
        assert_eq!(relative_short("2026-11-09T11:15:00Z", now()), "45m ago");
        assert_eq!(relative_short("2026-11-09T11:00:00Z", now()), "1h ago");
        assert_eq!(relative_short("2026-11-09T08:30:00Z", now()), "3h ago");
    }

    #[test]
    fn long_relative_times_reach_days() {
        assert_eq!(relative_long("2026-11-09T11:59:30Z", now()), "just now");
        assert_eq!(relative_long("2026-11-09T11:58:30Z", now()), "1 min ago");
        assert_eq!(relative_long("2026-11-09T11:00:00Z", now()), "1 hr ago");
        assert_eq!(relative_long("2026-11-09T09:00:00Z", now()), "3 hr ago");
        assert_eq!(relative_long("2026-11-06T12:00:00Z", now()), "3d ago");
    }

    #[test]
    fn last_segment_takes_the_folder_name() {
        assert_eq!(last_segment("C:\\Users\\me\\proj"), "proj");
        assert_eq!(last_segment("/home/me/proj/"), "proj");
    }

    #[test]
    fn idle_text_has_three_shapes() {
        assert_eq!(idle_text(30_000), "less than 1 min");
        assert_eq!(idle_text(60_000), "1 min");
        assert_eq!(idle_text(7 * 60_000), "7 min");
    }

    fn tool(names: &[&str]) -> ClaudeSessionActivity {
        ClaudeSessionActivity { kind: ClaudeSessionActivityType::ToolUse, tool_names: Some(names.iter().map(|s| s.to_string()).collect()) }
    }

    #[test]
    fn the_status_names_what_claude_is_doing() {
        assert_eq!(activity_display(None, None, false).0, "Active");
        let thinking = ClaudeSessionActivity { kind: ClaudeSessionActivityType::Thinking, tool_names: None };
        assert_eq!(activity_display(Some(&thinking), None, false).0, "Thinking");
        assert_eq!(activity_display(Some(&tool(&[])), None, false).0, "Using tools");
        assert_eq!(activity_display(Some(&tool(&["Read", "Edit"])), None, false).0, "Read, Edit");
        assert_eq!(activity_display(Some(&tool(&["Read", "Edit", "Bash", "Grep"])), None, false).0, "Read, Edit +2");
    }

    #[test]
    fn a_long_silence_beats_the_activity() {
        let (text, color) = activity_display(Some(&tool(&["Read"])), Some(7 * 60_000), true);
        assert_eq!(text, "Idle for 7 min");
        assert_eq!(color, TN_YELLOW);
    }

    fn preview(uuid: &str, msg: Option<&str>) -> ClaudeCodeSessionPreviewWithProject {
        ClaudeCodeSessionPreviewWithProject {
            preview: ClaudeCodeSessionPreview { cc_session_uuid: uuid.into(), last_activity_at: "2026-11-09T11:00:00Z".into(), first_user_message: msg.map(str::to_string), file_path: String::new() },
            project_dir_name: "C--proj".into(),
            project_display_path: "C:\\work\\proj".into(),
        }
    }

    #[test]
    fn the_select_label_follows_the_selection() {
        assert_eq!(select_label(None, &[]), "Link Claude Code session\u{2026}");
        let link = Linked { uuid: "abcdef1234567".into(), project_dir: "C--proj".into() };
        assert_eq!(select_label(Some(&link), &[]), "abcdef12");
        assert_eq!(select_label(Some(&link), &[preview("abcdef1234567", Some("fix the bug"))]), "abcdef12 \u{2014} fix the bug");
        assert_eq!(select_label(Some(&link), &[preview("abcdef1234567", None)]), "abcdef12 \u{2014} proj");
    }

    #[test]
    fn the_stats_status_waits_for_a_threshold_of_silence() {
        let live = ClaudeCodeLiveStats {
            active_sessions: 1,
            total_files_edited: 0,
            files_edited_list: vec![],
            last_activity_timestamp: Some("2026-11-09T11:50:00Z".into()),
            idle_sessions: 0,
            session_activity: None,
            error: None,
        };
        let quiet = StatsView { live: Some(&live), idle_threshold_minutes: 15, now: now() };
        assert_eq!(quiet.status().unwrap().0, "Active");
        let idle = StatsView { live: Some(&live), idle_threshold_minutes: 5, now: now() };
        assert_eq!(idle.status().unwrap().0, "Idle for 10 min");
        assert!(StatsView { live: None, idle_threshold_minutes: 5, now: now() }.status().is_none());
    }
}
