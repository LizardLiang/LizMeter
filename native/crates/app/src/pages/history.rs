//! History page (`HistoryPage.tsx`, `SessionHistory*`, `IssueGroupHeader`, `DateSubGroupHeader`).

use super::PageEvent;
use crate::controls::*;
use crate::css::rgba;
use crate::fmt::*;
use crate::rich_view::{is_html, rich_view};
use crate::tag_picker::{TagPicker, TagPickerEvent};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{AssignTagInput, CreateTagInput, IssueProviderKind, ListSessionsInput, ListTodosInput, Session, Tag, WorklogStatus};
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
                WorklogStatus::Logged => div().flex_shrink_0().text_size(px(11.0)).font_weight(FontWeight(600.0)).text_color(col(TN_GREEN)).child("Logged"),
                WorklogStatus::NotLogged => worklog_pill("Log Work", 0x7aa2f7),
                WorklogStatus::Failed => worklog_pill("Retry", 0xff9e64),
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

fn worklog_pill(label: &str, color: u32) -> Div {
    let c = parse_color(&format!("#{color:06x}"));
    div().flex_shrink_0().px(px(10.0)).py(px(3.0)).rounded(px(4.0)).border(px(1.0)).border_color(col(c_alpha(c, 0.27))).text_color(col(c)).text_size(px(11.0)).font_weight(FontWeight(600.0)).child(label.to_string())
}

impl Render for HistoryPage {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
                    let right = div()
                        .flex_shrink_0()
                        .text_size(px(11.0))
                        .text_color(col(TN_TEXT_DIM))
                        .child(format!("{} \u{b7} {} session{}", format_duration(sub.total_seconds), sub.sessions.len(), plural(sub.sessions.len())));
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
        page_shell("history-page", 720.0, body)
    }
}
