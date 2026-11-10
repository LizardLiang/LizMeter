//! History page (`HistoryPage.tsx`, `SessionHistory*`, `IssueGroupHeader`, `DateSubGroupHeader`).

use super::todo_widgets::window_layer;
use super::worklog;
use super::worklog_dialog::{WorklogConfirm, WorklogDialog, WorklogEvent};
use super::PageEvent;
use crate::controls::*;
use crate::css::rgba;
use crate::fmt::*;
use crate::rich_view::{is_html, rich_view};
use crate::tag_picker::{TagPicker, TagPickerEvent};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{AssignTagInput, CreateTagInput, IssueProviderKind, ListSessionsInput, ListTodosInput, Session, Tag, WorklogLogInput, WorklogStatus};
use lizmeter_services::Services;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const PAGE_SIZE: i64 = 50;

pub struct HistoryPage {
    svc: Arc<Services>,
    sessions: Vec<Session>,
    total: i64,
    tags: Vec<Tag>,
    tag_filter: Option<i64>,
    error: Option<String>,
    loading: bool,
    limit: i64,
    todo_titles: HashMap<i64, String>,
    expanded_issue: HashSet<String>,
    expanded_date: HashSet<String>,
    expanded_day: HashSet<String>,
    /// The filter the expand sets were seeded for.
    seeded_for: Option<Option<i64>>,
    seeded_empty: bool,
    pickers: HashMap<String, Entity<TagPicker>>,
    pub timer_active: bool,
    worklog: Option<Entity<WorklogDialog>>,
    toasts: Vec<Toast>,
    next_toast: u64,
}

/// A message in the bottom-right corner that goes after four seconds or on a click.
struct Toast {
    id: u64,
    success: bool,
    message: String,
}

impl EventEmitter<PageEvent> for HistoryPage {}

fn toggle(set: &mut HashSet<String>, key: &str) {
    if !set.remove(key) {
        set.insert(key.to_string());
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

impl HistoryPage {
    pub fn new(svc: Arc<Services>) -> Self {
        Self {
            svc,
            sessions: vec![],
            total: 0,
            tags: vec![],
            tag_filter: None,
            error: None,
            loading: true,
            limit: PAGE_SIZE,
            todo_titles: HashMap::new(),
            expanded_issue: HashSet::new(),
            expanded_date: HashSet::new(),
            expanded_day: HashSet::new(),
            seeded_for: None,
            seeded_empty: true,
            pickers: HashMap::new(),
            timer_active: false,
            worklog: None,
            toasts: vec![],
            next_toast: 0,
        }
    }

    fn load(&mut self) {
        match self.svc.list_sessions(&ListSessionsInput { limit: Some(self.limit), offset: Some(0), tag_id: self.tag_filter }) {
            Ok(r) => {
                self.sessions = r.sessions;
                self.total = r.total;
                self.error = None;
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        self.loading = false;
        self.tags = self.svc.list_tags().unwrap_or_default();
        if self.tag_filter.is_some_and(|f| !self.tags.iter().any(|t| t.id == f)) {
            self.tag_filter = None;
            self.load();
            return;
        }
        if let Ok(todos) = self.svc.list_todos(&ListTodosInput::default()) {
            self.todo_titles = todos.into_iter().map(|t| (t.id, t.title)).collect();
        }
    }

    pub fn refresh(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.load();
        if self.seeded_for != Some(self.tag_filter) || (self.seeded_empty && !self.sessions.is_empty()) {
            self.seeded_for = Some(self.tag_filter);
            self.seeded_empty = self.sessions.is_empty();
            self.expanded_issue.clear();
            self.expanded_date.clear();
            let grouped = group_by_issue(&self.sessions, chrono::Local::now());
            self.expanded_day = seed_day_group(&grouped.ungrouped).into_iter().collect();
        }
        let ids: Vec<String> = self.sessions.iter().map(|s| s.id.clone()).collect();
        for id in ids {
            if !self.pickers.contains_key(&id) {
                let pid = id.clone();
                let p = cx.new(|cx| TagPicker::new(format!("hp-{pid}"), window, cx));
                let sid = id.clone();
                cx.subscribe(&p, move |this, _, ev: &TagPickerEvent, cx| this.on_picker(&sid, ev, cx)).detach();
                self.pickers.insert(id, p);
            }
        }
        self.sync_pickers(cx);
        cx.notify();
    }

    fn sync_pickers(&mut self, cx: &mut Context<Self>) {
        for s in &self.sessions {
            let selected = s.tags.iter().map(|t| t.id).collect();
            if let Some(p) = self.pickers.get(&s.id) {
                let all = self.tags.clone();
                p.update(cx, |p, cx| p.set_tags(all, selected, cx));
            }
        }
    }

    fn on_picker(&mut self, session_id: &str, ev: &TagPickerEvent, cx: &mut Context<Self>) {
        let assign = |tag_id: i64| AssignTagInput { session_id: session_id.into(), tag_id };
        let res = match ev {
            TagPickerEvent::Add(t) => self.svc.assign_tag(&assign(*t)),
            TagPickerEvent::Remove(t) => self.svc.unassign_tag(&assign(*t)),
            TagPickerEvent::Create { name, color } => {
                self.svc.create_tag(&CreateTagInput { name: name.clone(), color: color.clone() }).and_then(|t| self.svc.assign_tag(&assign(t.id)))
            }
        };
        self.load();
        if let Err(e) = res {
            self.error = Some(e.to_string());
        }
        self.sync_pickers(cx);
        cx.notify();
        cx.emit(PageEvent::SessionsChanged);
    }

    fn delete(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let res = self.svc.delete_session(id);
        self.pickers.remove(id);
        self.refresh(window, cx);
        if let Err(e) = res {
            self.error = Some(e.to_string());
        }
        cx.emit(PageEvent::SessionsChanged);
    }

    /// The pill of a Jira-linked session: open the confirm dialog for it.
    fn open_worklog(&mut self, session_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(s) = self.sessions.iter().find(|s| s.id == session_id).cloned() else { return };
        let Some(key) = s.issue_id.clone() else { return };
        let relog = s.worklog_status == WorklogStatus::Logged;
        self.open_worklog_for(vec![s], &key, relog, window, cx);
    }

    fn open_worklog_for(&mut self, sessions: Vec<Session>, key: &str, relog: bool, window: &mut Window, cx: &mut Context<Self>) {
        let dialog = cx.new(|cx| WorklogDialog::new(sessions, key, relog, window, cx));
        cx.subscribe_in(&dialog, window, |this, _, ev: &WorklogEvent, window, cx| {
            this.worklog = None;
            this.refresh(window, cx);
            if let WorklogEvent::Confirm(c) = ev {
                this.log_work(c, window, cx);
            }
            cx.notify();
        })
        .detach();
        self.worklog = Some(dialog);
        cx.notify();
    }

    /// Shows a toast and removes it after four seconds.
    fn toast(&mut self, success: bool, message: String, cx: &mut Context<Self>) {
        self.next_toast += 1;
        let id = self.next_toast;
        self.toasts.push(Toast { id, success, message });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(std::time::Duration::from_secs(4)).await;
            let _ = this.update(cx, |p, cx| {
                p.toasts.retain(|t| t.id != id);
                cx.notify();
            });
        })
        .detach();
    }

    /// Confirm (`handleWorklogDialogConfirm`): one Jira call off the UI thread. Several ticked
    /// sessions go as one worklog anchored on the first work session; the others are then marked
    /// logged with its id.
    fn log_work(&mut self, c: &WorklogConfirm, window: &mut Window, cx: &mut Context<Self>) {
        let selected: Vec<Session> = c.selected_ids.iter().filter_map(|id| self.sessions.iter().find(|s| &s.id == id).cloned()).collect();
        let Some(first) = selected.first() else { return };
        let bulk = c.selected_ids.len() > 1;
        let summary = worklog::summarize(&selected);
        let uploadable: Vec<&Session> = selected.iter().filter(|s| summary.uploadable_ids.contains(&s.id)).collect();
        let (anchor, key, extra, success) = if bulk {
            let Some(anchor) = uploadable.first() else {
                self.toast(false, "Select at least one work or stopwatch session.".into(), cx);
                return;
            };
            let key = anchor.issue_id.clone().unwrap_or_default();
            let extra: Vec<String> = uploadable.iter().skip(1).map(|s| s.id.clone()).collect();
            let message = format!("Logged {}m to {key} ({} work sessions combined)", (summary.total_duration_seconds as f64 / 60.0).round() as i64, uploadable.len());
            (anchor.id.clone(), key, extra, message)
        } else {
            let key = first.issue_id.clone().unwrap_or_default();
            let message = format!("Logged {}m to {key}", (first.actual_duration_seconds as f64 / 60.0).round() as i64);
            (first.id.clone(), key, vec![], message)
        };
        let input = WorklogLogInput {
            session_id: anchor,
            issue_key: key.clone(),
            selected_session_ids: bulk.then(|| c.selected_ids.clone()),
            start_time_override: Some(c.start_time.clone()),
            end_time_override: Some(c.end_time.clone()),
            description_override: Some(c.description.clone()),
        };
        let svc = self.svc.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let logged = svc.worklog_log(&input)?;
                    if !extra.is_empty() {
                        svc.mark_worklog_logged(&extra, &logged.worklog_id)?;
                    }
                    Ok::<_, lizmeter_services::ServiceError>(())
                })
                .await;
            let _ = this.update_in(cx, |p, window, cx| {
                match result {
                    Ok(()) => {
                        p.toast(true, success, cx);
                        p.refresh(window, cx);
                    }
                    Err(e) if bulk => p.toast(false, e.to_string(), cx),
                    Err(e) => p.toast(false, worklog::failure_message(&e.to_string(), &key), cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn worklog_button(&self, s: &Session, label: &'static str, color: u32, small: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let (me, id) = (cx.entity(), s.id.clone());
        let c = parse_color(&format!("#{color:06x}"));
        let b = div()
            .id(SharedString::from(format!("wl-{label}-{}", s.id)))
            .flex_shrink_0()
            .rounded(px(4.0))
            .border(px(1.0))
            .font_weight(FontWeight(if small { 500.0 } else { 600.0 }))
            .cursor_pointer()
            .child(label);
        let b = if small {
            b.px(px(8.0)).py(px(2.0)).text_size(px(10.0)).border_color(col(rgba(122, 129, 148, 0.33))).text_color(col(TN_TEXT_DIM)).hover(|h| h.text_color(col(TN_BLUE)).border_color(col(rgba(122, 162, 247, 0.27))).bg(col(rgba(122, 162, 247, 0.07))))
        } else {
            b.px(px(10.0)).py(px(3.0)).text_size(px(11.0)).border_color(col(c_alpha(c, 0.27))).text_color(col(c)).hover(move |h| h.bg(col(c_alpha(c, 0.067))))
        };
        b.on_click(move |_, window, app| me.update(app, |p, cx| p.open_worklog(&id, window, cx)))
    }

    /// Capture hook: `worklog:<session id>` opens the dialog, `worklog-bulk:<issue key>` opens it over every
    /// Jira session of that issue, `worklog-confirm` presses its Confirm button.
    pub fn capture(&mut self, op: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (name, arg) = op.split_once(':').unwrap_or((op, ""));
        match name {
            "worklog" => self.open_worklog(arg, window, cx),
            "worklog-bulk" => {
                let all: Vec<Session> = self.sessions.iter().filter(|s| s.issue_id.as_deref() == Some(arg)).cloned().collect();
                let relog = all.iter().all(|s| s.worklog_status == WorklogStatus::Logged);
                let dialog = cx.new(|cx| WorklogDialog::new(all, arg, relog, window, cx));
                self.worklog = Some(dialog);
            }
            "worklog-confirm" => {
                if let Some(d) = self.worklog.clone() {
                    d.update(cx, |d, cx| d.confirm(cx));
                }
            }
            _ => {}
        }
        cx.notify();
    }

    /// `DateSubGroupHeader`'s green "Log (n)" / "Re-log (n)" button for the Jira sessions of one date.
    fn log_date_button(&self, key: &str, sessions: &[Session], cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let candidates: Vec<Session> = sessions.iter().filter(|s| s.issue_provider == Some(IssueProviderKind::Jira) && s.issue_id.is_some()).cloned().collect();
        let summary = worklog::summarize(&candidates);
        let uploadable: Vec<&Session> = candidates.iter().filter(|s| summary.uploadable_ids.contains(&s.id)).collect();
        if uploadable.is_empty() || summary.total_duration_seconds < 60 {
            return None;
        }
        let all_logged = uploadable.iter().all(|s| s.worklog_status == WorklogStatus::Logged);
        let label = format!("{} ({})", if all_logged { "Re-log" } else { "Log" }, uploadable.len());
        let issue_key = uploadable[0].issue_id.clone().unwrap_or_default();
        let me = cx.entity();
        let green = TN_GREEN;
        Some(
            div()
                .id(SharedString::from(format!("log-date-{key}")))
                .flex_shrink_0()
                .px(px(8.0))
                .py(px(2.0))
                .rounded(px(4.0))
                .border(px(1.0))
                .border_color(col(c_alpha(green, 0.27)))
                .text_color(col(green))
                .text_size(px(10.0))
                .font_weight(FontWeight(600.0))
                .cursor_pointer()
                .hover(move |h| h.bg(col(c_alpha(green, 0.067))))
                .child(label)
                .on_click(move |_, window, app| {
                    let (cands, key, relog) = (candidates.clone(), issue_key.clone(), all_logged);
                    me.update(app, |p, cx| p.open_worklog_for(cands, &key, relog, window, cx))
                }),
        )
    }

    fn set_filter(&mut self, tag: Option<i64>, window: &mut Window, cx: &mut Context<Self>) {
        self.tag_filter = tag;
        self.limit = PAGE_SIZE;
        self.refresh(window, cx);
    }

    fn card(&mut self, s: &Session, hide_date: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let color = parse_color(&format!("#{:06x}", timer_type_color(s.timer_type)));
        let label = timer_type_label(s.timer_type);
        let mut top = div().flex().flex_row().items_center().gap(px(10.0)).child(
            div()
                .flex_shrink_0()
                .px(px(8.0))
                .py(px(3.0))
                .rounded(px(4.0))
                .border(px(1.0))
                .border_color(col(c_alpha(color, 0.19)))
                .bg(col(c_alpha(color, 0.094)))
                .text_color(col(color))
                .text_size(px(11.0))
                .line_height(px(14.0))
                .font_weight(FontWeight(700.0))
                .child(spaced(label, 0.88)),
        );
        top = top.child(div().flex_1().text_size(px(16.0)).line_height(px(20.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(format_duration(s.actual_duration_seconds)));
        top = top.child(div().flex_shrink_0().text_size(px(12.0)).text_color(col(TN_TEXT_DIM)).child(if hide_date { format_local_time(&s.completed_at) } else { format!("{} \u{b7} {}", format_date(&s.completed_at), format_local_time(&s.completed_at)) }));
        if s.issue_provider == Some(IssueProviderKind::Jira) && s.issue_id.is_some() && s.actual_duration_seconds >= 60 {
            top = top.child(match s.worklog_status {
                WorklogStatus::Logged => div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.0))
                    .child(div().flex_shrink_0().text_size(px(11.0)).font_weight(FontWeight(600.0)).text_color(col(TN_GREEN)).child("Logged"))
                    .child(self.worklog_button(s, "Re-log", 0x7aa2f7, true, cx)),
                WorklogStatus::NotLogged => div().child(self.worklog_button(s, "Log Work", 0x7aa2f7, false, cx)),
                WorklogStatus::Failed => div().child(self.worklog_button(s, "Retry", 0xff9e64, false, cx)),
            });
        }
        let (resume_s, resume_me) = (s.clone(), me.clone());
        let mut resume = div()
            .id(SharedString::from(format!("resume-{}", s.id)))
            .ml(px(4.0))
            .px(px(8.0))
            .py(px(2.0))
            .rounded(px(4.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.19)))
            .bg(col(rgba(122, 162, 247, 0.07)))
            .text_color(col(TN_BLUE))
            .text_size(px(12.0))
            .font_weight(FontWeight(500.0))
            .child("\u{25b6} Resume");
        resume = if self.timer_active {
            resume.opacity(0.4).cursor_not_allowed()
        } else {
            resume.cursor_pointer().on_click(move |_, _, app| resume_me.update(app, |_, cx| cx.emit(PageEvent::Resume(resume_s.clone()))))
        };
        top = top.child(resume);
        let (del_me, del_id) = (me.clone(), s.id.clone());
        top = top.child(
            div()
                .id(SharedString::from(format!("del-{}", s.id)))
                .px(px(4.0))
                .py(px(2.0))
                .rounded(px(4.0))
                .text_size(px(16.0))
                .line_height(px(16.0))
                .text_color(col(ICON_DIM))
                .cursor_pointer()
                .hover(|st| st.text_color(col(TN_TEXT)))
                .on_click(move |_, window, app| {
                    let id = del_id.clone();
                    del_me.update(app, |p, cx| p.delete(&id, window, cx))
                })
                .child("\u{2715}"),
        );

        let mut card = hover_card().w_full().px(px(18.0)).py(px(16.0)).flex().flex_col().gap(px(10.0)).child(top);
        if !s.title.is_empty() {
            card = card.child(if is_html(&s.title) {
                rich_view(&s.title, 14.0, TN_TEXT_DIM).into_any_element()
            } else {
                div().truncate().text_size(px(14.0)).text_color(col(TN_TEXT_DIM)).child(s.title.clone()).into_any_element()
            });
        }
        let mut tags_row = div().flex().flex_row().flex_wrap().items_center().gap(px(6.0));
        let todo_id = if s.issue_provider == Some(IssueProviderKind::Todo) { s.issue_id.as_deref().and_then(|i| i.parse::<i64>().ok()) } else { None };
        let live = todo_id.and_then(|i| self.todo_titles.get(&i).cloned());
        let click: Option<Box<dyn Fn(&mut Window, &mut App)>> = if let Some(id) = todo_id {
            let m = me.clone();
            Some(Box::new(move |_, app| m.update(app, |_, cx| cx.emit(PageEvent::OpenTodo(id)))))
        } else {
            s.issue_url.clone().map(|u| {
                let svc = self.svc.clone();
                Box::new(move |_: &mut Window, _: &mut App| svc.open_external(&u)) as Box<dyn Fn(&mut Window, &mut App)>
            })
        };
        if let Some(b) = issue_badge(s, live, click) {
            tags_row = tags_row.child(b);
        }
        for t in &s.tags {
            let (m, sid, tid) = (me.clone(), s.id.clone(), t.id);
            tags_row = tags_row.child(tag_badge(t, Some(Box::new(move |_, app| m.update(app, |p, cx| p.on_picker(&sid, &TagPickerEvent::Remove(tid), cx))))));
        }
        if let Some(p) = self.pickers.get(&s.id) {
            tags_row = tags_row.child(p.clone());
        }
        card.child(tags_row)
    }
}

fn group_header(id: String, expanded: bool, pad: (f32, f32), left: Div, right: Div, on_toggle: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    div()
        .id(SharedString::from(id))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .py(px(pad.0))
        .px(px(pad.1))
        .line_height(px(15.0))
        .rounded(px(4.0))
        .border_b_1()
        .border_color(col(rgba(41, 46, 66, 0.7)))
        .cursor_pointer()
        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.04))))
        .on_click(move |_, w, a| on_toggle(w, a))
        .child(div().w(px(14.0)).flex_shrink_0().flex().justify_center().text_size(px(10.0)).text_color(col(ICON_DIM)).child(if expanded { "\u{25bc}" } else { "\u{25b6}" }))
        .child(left)
        .child(right)
}

impl Render for HistoryPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let now = chrono::Local::now();
        let grouped = group_by_issue(&self.sessions, now);
        let days = group_by_day(&grouped.ungrouped, now);
        let mut body = div().flex().flex_col().child(page_heading("History").mt(px(8.7)).mb(px(20.0)));

        if !self.tags.is_empty() {
            let mut row = div().flex().flex_row().flex_wrap().gap(px(6.0)).mb(px(16.0));
            let m = me.clone();
            row = row.child(chip("f-all", "All", self.tag_filter.is_none(), move |w, a| m.update(a, |p, cx| p.set_filter(None, w, cx))));
            for t in &self.tags {
                let (m, id, on) = (me.clone(), t.id, self.tag_filter == Some(t.id));
                row = row.child(chip(SharedString::from(format!("f-{id}")), &t.name, on, move |w, a| m.update(a, |p, cx| p.set_filter(if on { None } else { Some(id) }, w, cx))));
            }
            body = body.child(row);
        }
        if let Some(t) = self.tags.iter().find(|t| Some(t.id) == self.tag_filter) {
            let m = me.clone();
            body = body.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .mb(px(12.0))
                    .child(div().text_size(px(12.0)).text_color(col(TN_TEXT_DIM)).child("Filtered by"))
                    .child(tag_badge(t, Some(Box::new(move |w, a| m.update(a, |p, cx| p.set_filter(None, w, cx)))))),
            );
        }
        if self.loading {
            body = body.child(state_message("Loading\u{2026}", TN_TEXT_DIM, false));
        }
        if let Some(e) = &self.error {
            body = body.child(state_message(e.clone(), TN_RED, false));
        }
        if !self.loading && self.sessions.is_empty() {
            body = body.child(state_message("No sessions yet.", TN_TEXT_DIM, true));
        }

        let mut list = div().flex().flex_col().gap(px(10.0));
        for g in &grouped.issue_groups {
            let key = g.key.key.clone();
            let open = self.expanded_issue.contains(&key);
            let (m, k) = (me.clone(), key.clone());
            let live = g.key.key.strip_prefix("todo:").and_then(|i| i.parse::<i64>().ok()).and_then(|i| self.todo_titles.get(&i).cloned());
            let left = div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .text_size(px(12.0))
                .child(div().flex_shrink_0().font_weight(FontWeight(700.0)).text_color(col(TN_BLUE)).child(g.key.display_id.clone()))
                .child(div().truncate().text_color(col(TN_TEXT)).child(live.or(g.key.title.clone()).unwrap_or_default()));
            let right = div()
                .flex()
                .flex_row()
                .gap(px(4.0))
                .flex_shrink_0()
                .text_size(px(11.0))
                .text_color(col(TN_TEXT_DIM))
                .child(div().font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(format_duration(g.total_seconds)))
                .child(format!("\u{b7} {} session{}", g.session_count, plural(g.session_count)));
            let mut block = div().flex().flex_col().gap(px(8.0)).child(group_header(format!("ig-{key}"), open, (6.0, 0.0), left, right, move |_, a| {
                m.update(a, |p, cx| {
                    toggle(&mut p.expanded_issue, &k);
                    cx.notify();
                })
            }));
            if open {
                for sub in &g.date_sub_groups {
                    let dk = format!("{key}::{}", sub.date_key);
                    let dopen = self.expanded_date.contains(&dk);
                    let (m, k) = (me.clone(), dk.clone());
                    let left = div().flex_1().text_size(px(11.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT_DIM)).child(spaced(&sub.date_label.to_uppercase(), 0.44));
                    let meta = div()
                        .flex_shrink_0()
                        .text_size(px(11.0))
                        .text_color(col(TN_TEXT_DIM))
                        .child(format!("{} \u{b7} {} session{}", format_duration(sub.total_seconds), sub.sessions.len(), plural(sub.sessions.len())));
                    let right = div().flex().flex_row().items_center().gap(px(6.0)).child(meta).children(self.log_date_button(&dk, &sub.sessions, cx));
                    let mut sblock = div().pl(px(14.0)).flex().flex_col().gap(px(8.0)).child(group_header(format!("dg-{dk}"), dopen, (4.0, 2.0), left, right, move |_, a| {
                        m.update(a, |p, cx| {
                            toggle(&mut p.expanded_date, &k);
                            cx.notify();
                        })
                    }));
                    if dopen {
                        for s in &sub.sessions {
                            sblock = sblock.child(self.card(s, false, cx));
                        }
                    }
                    block = block.child(sblock);
                }
            }
            list = list.child(block);
        }
        for d in &days {
            let open = self.expanded_day.contains(&d.date_key);
            let (m, k) = (me.clone(), d.date_key.clone());
            let left = div().flex_1().text_size(px(12.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT_DIM)).child(spaced(&d.date_label.to_uppercase(), 0.48));
            let right = div().flex_shrink_0().text_size(px(11.0)).font_weight(FontWeight(500.0)).text_color(col(TN_MUTED)).child(format!("{} session{}", d.sessions.len(), plural(d.sessions.len())));
            let mut block = div().flex().flex_col().gap(px(8.0)).child(group_header(format!("day-{}", d.date_key), open, (4.0, 2.0), left, right, move |_, a| {
                m.update(a, |p, cx| {
                    toggle(&mut p.expanded_day, &k);
                    cx.notify();
                })
            }).mb(px(2.0)));
            if open {
                for s in &d.sessions {
                    block = block.child(self.card(s, true, cx));
                }
            } else {
                // The collapsed content is an empty box that still takes its 8px flex gap.
                block = block.child(div());
            }
            list = list.child(block);
        }
        body = body.child(list);
        if (self.sessions.len() as i64) < self.total {
            let m = me.clone();
            let remaining = self.total - self.sessions.len() as i64;
            body = body.child(
                soft_button("load-more", &format!("Load more ({remaining} remaining)"), false, 10.0, move |w, a| {
                    m.update(a, |p, cx| {
                        p.limit += PAGE_SIZE;
                        p.refresh(w, cx);
                    })
                })
                .mt(px(16.0))
                .w_full()
                .py(px(8.0))
                .flex()
                .justify_center()
                .text_size(px(12.0)),
            );
        }
        let mut root = div().relative().flex().flex_1().h_full().child(page_shell("history-page", 720.0, body));
        if let Some(d) = &self.worklog {
            root = root.child(window_layer(window, d.clone()));
        }
        if !self.toasts.is_empty() {
            let mut stack = div().absolute().bottom(px(24.0)).right(px(24.0)).flex().flex_col().gap(px(8.0));
            for t in &self.toasts {
                let (id, color) = (t.id, if t.success { TN_GREEN } else { TN_RED });
                let m = me.clone();
                stack = stack.child(
                    ui_text(14.0)
                        .id(SharedString::from(format!("toast-{id}")))
                        .max_w(px(320.0))
                        .px(px(16.0))
                        .py(px(10.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(c_alpha(color, 0.267)))
                        .bg(col(c_alpha(color, 0.067)))
                        .font_weight(FontWeight(500.0))
                        .text_color(col(color))
                        .cursor_pointer()
                        .on_click(move |_, _, app| {
                            m.update(app, |p, cx| {
                                p.toasts.retain(|t| t.id != id);
                                cx.notify();
                            })
                        })
                        .child(t.message.clone()),
                );
            }
            root = root.child(stack);
        }
        root
    }
}
