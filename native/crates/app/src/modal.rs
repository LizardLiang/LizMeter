//! IssuePromptDialog: blur overlay + glass dialog with the `modalEntrance` animation, over the real todos.

use crate::controls::field_style;
use crate::css::{Spec, TRANSPARENT, linear, rgba};
use crate::ui::*;
use gpui::*;
use crate::pages::issues_logic::{available_tabs, Tab};
use lizmeter_core::{Issue, IssueProviderStatus, IssueRef, IssuesListInput, JiraIssue, LinearIssue, ListTodosInput, Todo, TodoLabel, TodoProject, TodoState};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent, TextInput};
use std::sync::Arc;

pub enum PromptEvent {
    Select(IssueRef),
    Skip,
}

impl EventEmitter<PromptEvent> for IssuePrompt {}

/// A subsequence match of `needle` in `hay`: `None` when it does not match, a higher score for
/// earlier and more contiguous hits.
pub fn fuzzy_score(needle: &str, hay: &str) -> Option<i64> {
    let hay: Vec<char> = hay.to_lowercase().chars().collect();
    let mut score = 0i64;
    let mut at = 0usize;
    let mut prev: Option<usize> = None;
    for n in needle.to_lowercase().chars() {
        let found = (at..hay.len()).find(|&i| hay[i] == n)?;
        score += 10 - (found as i64).min(9);
        if prev.is_some_and(|p| p + 1 == found) {
            score += 15;
        }
        prev = Some(found);
        at = found + 1;
    }
    Some(score)
}

/// The state, project and label chips that narrow the todo list (`TodoIssuePicker.tsx`).
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct TodoChips {
    pub state: Option<i64>,
    pub project: Option<i64>,
    pub label: Option<i64>,
}

impl TodoChips {
    pub fn any(&self) -> bool {
        self.state.is_some() || self.project.is_some() || self.label.is_some()
    }

    fn admits(&self, t: &Todo) -> bool {
        self.state.is_none_or(|s| t.state.id == s) && self.project.is_none_or(|p| t.project.as_ref().is_some_and(|tp| tp.id == p)) && self.label.is_none_or(|l| t.labels.iter().any(|tl| tl.id == l))
    }
}

/// The todos that match the search text and chips, best match first.
pub fn matching_todos<'a>(todos: &'a [Todo], query: &str, chips: &TodoChips) -> Vec<&'a Todo> {
    let q = query.trim();
    let by_id = q.trim_start_matches('#');
    let id_query = !by_id.is_empty() && by_id.chars().all(|c| c.is_ascii_digit());
    let mut scored: Vec<(i64, &Todo)> = vec![];
    for t in todos.iter().filter(|t| chips.admits(t)) {
        if q.is_empty() {
            scored.push((0, t));
            continue;
        }
        let fuzzy = fuzzy_score(q, &t.title);
        let id_hit = id_query && t.id.to_string().starts_with(by_id);
        if fuzzy.is_none() && !id_hit {
            continue;
        }
        scored.push((fuzzy.unwrap_or(0) + if id_hit { 1000 } else { 0 }, t));
    }
    if !q.is_empty() {
        scored.sort_by(|a, b| b.0.cmp(&a.0));
    }
    scored.into_iter().map(|(_, t)| t).collect()
}

/// The prompt is the Start dialog; the dropdown is the "Link issue" popover under the Timer's button.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PromptMode {
    Dialog,
    Dropdown,
}

pub struct IssuePrompt {
    mode: PromptMode,
    todos: Vec<Todo>,
    states: Vec<TodoState>,
    projects: Vec<TodoProject>,
    labels: Vec<TodoLabel>,
    chips: TodoChips,
    search: Entity<TextField>,
    query: String,
    active: usize,
    error: Option<String>,
    focus: FocusHandle,
    /// Whether Linear / Jira answer, and the issues they sent back (`IssuePromptDialog`'s tracker section).
    has_linear: bool,
    has_jira: bool,
    loading: bool,
    linear: Vec<LinearIssue>,
    jira: Vec<JiraIssue>,
    tracker_error: Option<String>,
    /// The popover's provider tabs: which trackers answer, the tab chosen, the issues each sent
    /// (`None` while loading; a failed fetch is an empty list, as in `useIssues`), and the
    /// popover's own search over them.
    status: Option<IssueProviderStatus>,
    dd_active: DdTab,
    gh_list: Option<Vec<Issue>>,
    lin_list: Option<Vec<LinearIssue>>,
    jira_list: Option<Vec<JiraIssue>>,
    issue_search: Option<Entity<TextField>>,
    issue_query: String,
    ext_focus: Option<usize>,
}

/// A tab of the popover: a tracker, or the todo list that is always there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum DdTab {
    Github,
    Linear,
    Jira,
    Todo,
}

impl DdTab {
    fn label(self) -> &'static str {
        match self {
            DdTab::Github => "GitHub",
            DdTab::Linear => "Linear",
            DdTab::Jira => "Jira",
            DdTab::Todo => "Todo",
        }
    }
}

impl From<Tab> for DdTab {
    fn from(t: Tab) -> Self {
        match t {
            Tab::Github => DdTab::Github,
            Tab::Linear => DdTab::Linear,
            Tab::Jira => DdTab::Jira,
        }
    }
}

/// One row of a tracker tab: number or key, title, and the repo or state on the right.
struct ExtRow {
    num: String,
    title: String,
    tail: String,
    issue: IssueRef,
}

impl IssuePrompt {
    pub fn new(svc: &Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::with_mode(PromptMode::Dialog, svc, window, cx)
    }

    /// `IssuePickerDropdown`'s popover: the same todo picker, no tracker section.
    pub fn dropdown(svc: &Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::with_mode(PromptMode::Dropdown, svc, window, cx)
    }

    fn with_mode(mode: PromptMode, svc: &Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        lizmeter_ui::scrollbar::reset("prompt-list");
        lizmeter_ui::scrollbar::reset("prompt-trackers");
        lizmeter_ui::scrollbar::reset("prompt-chips");
        let search = TextInput::new(field_style(13.0), "Search by title or #id\u{2026}", window, cx);
        cx.subscribe(&search, |this, s, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Changed => {
                this.query = s.read(cx).text().to_string();
                this.active = 0;
                cx.notify();
            }
            TextFieldEvent::Submit => this.pick_active(cx),
            TextFieldEvent::Cancel => cx.emit(PromptEvent::Skip),
        })
        .detach();
        let (todos, error) = match svc.list_todos(&ListTodosInput::default()) {
            Ok(t) => (t, None),
            Err(e) => (vec![], Some(e.to_string())),
        };
        let states = svc.list_todo_states().unwrap_or_default();
        let projects = svc.list_todo_projects().unwrap_or_default();
        let labels = svc.list_todo_labels().unwrap_or_default();
        let focus = search.read(cx).focus_handle().clone();
        window.focus(&focus);
        let mut this = Self { mode, todos, states, projects, labels, chips: TodoChips::default(), search, query: String::new(), active: 0, error, focus, has_linear: false, has_jira: false, loading: false, linear: vec![], jira: vec![], tracker_error: None, status: None, dd_active: DdTab::Github, gh_list: None, lin_list: None, jira_list: None, issue_search: None, issue_query: String::new(), ext_focus: None };
        if mode == PromptMode::Dialog {
            this.load_trackers(svc, cx);
        } else {
            this.load_externals(svc, window, cx);
        }
        this
    }

    /// The tracker section: ask which providers are set up, then fetch their issues off the UI thread.
    fn load_trackers(&mut self, svc: &Arc<Services>, cx: &mut Context<Self>) {
        let status = svc.linear_provider_status().and_then(|l| svc.jira_provider_status().map(|j| (l, j)));
        let (linear, jira) = match status {
            Ok((l, j)) => (l.configured && l.team_selected, j.configured),
            Err(e) => {
                self.tracker_error = Some(e.to_string());
                return;
            }
        };
        self.has_linear = linear;
        self.has_jira = jira;
        if !linear && !jira {
            return;
        }
        self.loading = true;
        let svc = svc.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    let l = if linear { svc.linear_issues(false)? } else { vec![] };
                    let j = if jira { svc.jira_issues(false)? } else { vec![] };
                    Ok::<_, lizmeter_services::ServiceError>((l, j))
                })
                .await;
            let _ = this.update(cx, |p, cx| {
                match result {
                    Ok((l, j)) => {
                        p.linear = l;
                        p.jira = j;
                    }
                    Err(e) => p.tracker_error = Some(e.to_string()),
                }
                p.loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// The popover opens: ask which trackers are set up and fetch each one's issues off the UI thread.
    fn load_externals(&mut self, svc: &Arc<Services>, window: &mut Window, cx: &mut Context<Self>) {
        let search = TextInput::new(field_style(13.0), "Search issues\u{2026}", window, cx);
        cx.subscribe(&search, |this, s, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Changed => {
                this.issue_query = s.read(cx).text().to_string();
                this.ext_focus = None;
                cx.notify();
            }
            TextFieldEvent::Submit => this.pick_ext(cx),
            TextFieldEvent::Cancel => cx.emit(PromptEvent::Skip),
        })
        .detach();
        self.issue_search = Some(search);
        let status = svc.issue_provider_status().ok();
        let tabs = status.as_ref().map(available_tabs).unwrap_or_default();
        self.status = status;
        if self.effective_tab() != DdTab::Todo {
            self.focus_search(window, cx);
        }
        for tab in tabs {
            let svc = svc.clone();
            cx.spawn(async move |this, cx| {
                let result = cx
                    .background_executor()
                    .spawn(async move {
                        match tab {
                            Tab::Github => svc.github_issues(&IssuesListInput::default()).map(|v| (Some(v), None, None)),
                            Tab::Linear => svc.linear_issues(false).map(|v| (None, Some(v), None)),
                            Tab::Jira => svc.jira_issues(false).map(|v| (None, None, Some(v))),
                        }
                    })
                    .await;
                let (g, l, j) = result.unwrap_or((Some(vec![]), Some(vec![]), Some(vec![])));
                let _ = this.update(cx, |p, cx| {
                    match tab {
                        Tab::Github => p.gh_list = Some(g.unwrap_or_default()),
                        Tab::Linear => p.lin_list = Some(l.unwrap_or_default()),
                        Tab::Jira => p.jira_list = Some(j.unwrap_or_default()),
                    }
                    cx.notify();
                });
            })
            .detach();
        }
    }

    /// The tabs of the popover: the configured trackers, then Todo.
    fn dd_tabs(&self) -> Vec<DdTab> {
        let mut tabs: Vec<DdTab> = self.status.as_ref().map(available_tabs).unwrap_or_default().into_iter().map(DdTab::from).collect();
        tabs.push(DdTab::Todo);
        tabs
    }

    /// The tab shown: the chosen one when it exists, else the first tracker.
    fn effective_tab(&self) -> DdTab {
        let tabs = self.dd_tabs();
        if tabs.len() == 1 {
            tabs[0]
        } else if tabs.contains(&self.dd_active) {
            self.dd_active
        } else {
            tabs[0]
        }
    }

    fn focus_search(&self, window: &mut Window, cx: &App) {
        let field = if self.effective_tab() == DdTab::Todo { Some(&self.search) } else { self.issue_search.as_ref() };
        if let Some(f) = field {
            let handle = f.read(cx).focus_handle().clone();
            window.focus(&handle);
        }
    }

    /// The rows of a tracker tab after the popover's search (title, or number / key).
    fn ext_rows(&self, tab: DdTab) -> Vec<ExtRow> {
        let q = self.issue_query.trim().to_lowercase();
        let keep = |title: &str, num: &str| q.is_empty() || title.to_lowercase().contains(&q) || num.to_lowercase().contains(&q);
        match tab {
            DdTab::Github => self
                .gh_list
                .iter()
                .flatten()
                .filter(|i| keep(&i.title, &i.number.to_string()))
                .map(|i| ExtRow { num: format!("#{}", i.number), title: i.title.clone(), tail: i.repo.clone(), issue: IssueRef::Github { number: i.number, title: i.title.clone(), url: i.url.clone() } })
                .collect(),
            DdTab::Linear => self
                .lin_list
                .iter()
                .flatten()
                .filter(|i| keep(&i.title, &i.identifier))
                .map(|i| ExtRow { num: i.identifier.clone(), title: i.title.clone(), tail: i.state.name.clone(), issue: IssueRef::Linear { identifier: i.identifier.clone(), title: i.title.clone(), url: i.url.clone() } })
                .collect(),
            DdTab::Jira => self
                .jira_list
                .iter()
                .flatten()
                .filter(|i| keep(&i.title, &i.key))
                .map(|i| ExtRow { num: i.key.clone(), title: i.title.clone(), tail: i.status.clone(), issue: IssueRef::Jira { key: i.key.clone(), title: i.title.clone(), url: i.url.clone() } })
                .collect(),
            DdTab::Todo => vec![],
        }
    }

    fn pick_ext(&mut self, cx: &mut Context<Self>) {
        let rows = self.ext_rows(self.effective_tab());
        if let Some(r) = self.ext_focus.and_then(|i| rows.into_iter().nth(i)) {
            cx.emit(PromptEvent::Select(r.issue));
        }
    }

    fn ext_loading(&self, tab: DdTab) -> bool {
        match tab {
            DdTab::Github => self.gh_list.is_none(),
            DdTab::Linear => self.lin_list.is_none(),
            DdTab::Jira => self.jira_list.is_none(),
            DdTab::Todo => false,
        }
    }

    /// `ProviderTabs` inside the popover: 4 px 8 px 0 padding, a rule under the row.
    fn dd_tab_row(&self, tabs: &[DdTab], active: DdTab, cx: &mut Context<Self>) -> Div {
        let mut row = div().flex().flex_row();
        for tab in tabs {
            let (me, tab, on) = (cx.entity(), *tab, *tab == active);
            row = row.child(
                div()
                    .id(SharedString::from(format!("dd-tab-{}", tab.label())))
                    .px(px(16.0))
                    .py(px(7.0))
                    .border_b_2()
                    .border_color(col(if on { TN_BLUE } else { TRANSPARENT }))
                    .font_family(BTN_FONT)
                    .text_size(px(12.0))
                    .line_height(px(15.0))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(if on { TN_BLUE } else { TN_TEXT_DIM }))
                    .cursor_pointer()
                    .on_click(move |_, window, app| {
                        me.update(app, |p, cx| {
                            p.dd_active = tab;
                            p.ext_focus = None;
                            p.focus_search(window, cx);
                            cx.notify();
                        })
                    })
                    .child(spaced(tab.label(), 0.36)),
            );
        }
        div().relative().px(px(8.0)).pt(px(4.0)).child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(41, 46, 66, 0.8)))).child(row)
    }

    /// A row of a tracker tab (`.item`): number in blue, title, repo or state on the right.
    fn ext_row(&self, i: usize, r: ExtRow, cx: &mut Context<Self>) -> Stateful<Div> {
        let (me, hover) = (cx.entity(), cx.entity());
        let issue = r.issue.clone();
        let mut row = div()
            .id(SharedString::from(format!("ext-{i}")))
            .w_full()
            .px(px(12.0))
            .py(px(8.0))
            .flex()
            .flex_row()
            .items_baseline()
            .gap(px(6.0))
            .font_family("Arial")
            .cursor_pointer()
            .on_hover(move |on, _, app| {
                if *on {
                    hover.update(app, |p, cx| {
                        if p.ext_focus != Some(i) {
                            p.ext_focus = Some(i);
                            cx.notify();
                        }
                    });
                }
            })
            .on_click(move |_, _, app| me.update(app, |_, cx| cx.emit(PromptEvent::Select(issue.clone()))))
            .child(div().flex_shrink_0().text_size(px(11.0)).font_weight(FontWeight(600.0)).text_color(col(TN_BLUE)).child(r.num))
            .child(div().flex_1().min_w_0().truncate().text_size(px(12.0)).text_color(col(TN_TEXT)).child(r.title))
            .child(div().flex_shrink_0().text_size(px(11.0)).text_color(col(TN_TEXT_DIM)).child(r.tail));
        if self.ext_focus == Some(i) {
            row = row.bg(col(rgba(41, 46, 66, 0.65)));
        }
        row
    }

    /// A row of the tracker section: key in cyan, then the title (`.issueRow`).
    fn tracker_row(&self, id: String, key: String, title: String, issue: IssueRef, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        div()
            .id(SharedString::from(format!("tracker-{id}")))
            .w_full()
            .px(px(12.0))
            .py(px(10.0))
            .rounded(px(6.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .font_family("Arial")
            .text_size(px(13.0))
            .text_color(col(TN_TEXT))
            .cursor_pointer()
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
            .on_click(move |_, _, app| me.update(app, |_, cx| cx.emit(PromptEvent::Select(issue.clone()))))
            .child(div().flex_shrink_0().font_weight(FontWeight(600.0)).text_color(col(TN_CYAN)).child(key))
            .child(div().min_w_0().truncate().child(title))
    }

    fn pick_active(&mut self, cx: &mut Context<Self>) {
        let todo = matching_todos(&self.todos, &self.query, &self.chips).get(self.active).map(|t| (*t).clone());
        if let Some(t) = todo {
            cx.emit(PromptEvent::Select(IssueRef::Todo { id: t.id, title: t.title }));
        }
    }

    fn row(&self, t: &Todo, active: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let (id, title) = (t.id, t.title.clone());
        let mut row = div()
            .id(SharedString::from(format!("todo-{id}")))
            .w_full()
            .h(px(30.0))
            .flex_shrink_0()
            .px(px(12.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .font_family("Arial")
            .text_size(px(12.0))
            .text_color(col(TN_TEXT))
            .cursor_pointer()
            .child(div().flex_shrink_0().font_weight(FontWeight(600.0)).text_color(col(TN_BLUE)).child(format!("#{id}")))
            .child(div().flex_1().min_w_0().truncate().child(t.title.clone()))
            .on_click(move |_, _, app| me.update(app, |_, cx| cx.emit(PromptEvent::Select(IssueRef::Todo { id, title: title.clone() }))));
        if let Some(p) = &t.project {
            row = row.child(div().flex_shrink_0().text_size(px(10.5)).text_color(col(TN_MUTED)).child(p.name.clone()));
        }
        if active {
            row = row.bg(col(rgba(122, 162, 247, 0.07)));
        }
        row
    }
}

fn chip(label: &str, on: bool, color: Option<crate::css::C>) -> Div {
    let accent = color.unwrap_or(TN_BLUE);
    let mut c = div()
        .h(px(17.6))
        .px(px(8.0))
        .rounded(px(9.0))
        .border(px(1.0))
        .border_color(col(rgba(41, 46, 66, 0.8)))
        .bg(col(rgba(16, 18, 40, 0.4)))
        .flex()
        .flex_shrink_0()
        .items_center()
        .cursor_pointer()
        .font_family("Arial")
        .text_size(px(10.5))
        .font_weight(FontWeight(600.0))
        .text_color(col(TN_TEXT_DIM))
        .child(label.to_string());
    if on {
        c = c.border_color(col(c_alpha(accent, 0.33))).text_color(col(accent));
    }
    c
}

fn section(label: &str, first: bool) -> Div {
    let mut d = ui_text(11.0)
        .px(px(4.0))
        .pt(px(4.0))
        .mb(px(8.0))
        .flex_shrink_0()
        .h(px(18.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(700.0))
        .text_color(col(TN_TEXT))
        .child(spaced(&label.to_uppercase(), 1.32));
    if !first {
        d = d.mt(px(12.0)).pt(px(12.0)).h(px(27.0)).border_t_1().border_color(col(rgba(86, 95, 137, 0.25)));
    }
    d
}

impl IssuePrompt {
    /// The popover: 320 px glass card under the button, search, chips, then the list at 220 px at most.
    fn dropdown_el(&self, matches: &[Todo], chips: Stateful<Div>, cx: &mut Context<Self>) -> impl IntoElement {
        let tab = self.effective_tab();
        let tabs = self.dd_tabs();
        let scroll = lizmeter_ui::scrollbar::keyed("prompt-list", lizmeter_ui::scrollbar::BarStyle::Global);
        let mut rows = div().flex().flex_col();
        if tab != DdTab::Todo {
            let hint = |text: &'static str| ui_text(12.0).p(px(12.0)).text_color(col(TN_TEXT_DIM)).flex().justify_center().child(text);
            if self.ext_loading(tab) {
                rows = rows.child(hint("Loading\u{2026}"));
            } else {
                let found = self.ext_rows(tab);
                if found.is_empty() {
                    let none = if !self.issue_query.trim().is_empty() {
                        "No matching issues"
                    } else if tab == DdTab::Jira {
                        "No issues found"
                    } else {
                        "No open issues"
                    };
                    rows = rows.child(hint(none));
                }
                for (i, r) in found.into_iter().enumerate() {
                    rows = rows.child(self.ext_row(i, r, cx));
                }
            }
        } else if let Some(e) = &self.error {
            rows = rows.child(crate::controls::state_message(e.clone(), TN_RED, false));
        } else if matches.is_empty() {
            let filtered = !self.query.trim().is_empty() || self.chips.any();
            rows = rows.child(crate::controls::state_message(if filtered { "No matching todos" } else { "No todos yet" }, TN_TEXT_DIM, false).py(px(12.0)).text_size(px(12.0)).flex().justify_center());
        }
        if tab == DdTab::Todo {
            for (i, t) in matches.iter().enumerate() {
                rows = rows.child(self.row(t, i == self.active, cx));
            }
        }
        let list = div()
            .relative()
            .flex_shrink_0()
            .max_h(px(220.0))
            .child(div().id("prompt-list").track_scroll(scroll.handle()).max_h(px(220.0)).overflow_y_scroll().child(scroll.pad(rows)))
            .child(scroll.bar());
        let search_of = |field: Entity<TextField>| {
            div()
                .relative()
                .h(px(37.0))
                .flex_shrink_0()
                .px(px(12.0))
                .flex()
                .items_center()
                .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(41, 46, 66, 0.8))))
                .child(div().w_full().child(field))
        };
        let spec = Spec::rrect(14.0)
            .fill(linear(135.0, &[(0.0, wh(0.07)), (0.30, wh(0.01)), (0.52, TRANSPARENT)]))
            .solid(rgba(13, 15, 28, 0.92))
            .border(1.0, rgba(41, 46, 66, 0.9))
            .inset(0.0, 1.0, wh(0.10))
            .inset(1.0, 0.0, wh(0.05))
            .inset(0.0, -1.0, bk(0.12));
        Glass::new(14.0, 28.0, 1.6, spec)
            .shadows(&[sh(0.0, 16.0, 50.0, bk(0.6)), sh(0.0, 4.0, 12.0, bk(0.3))])
            .el()
            .id("issue-dropdown")
            .w(px(320.0))
            .flex()
            .flex_col()
            .overflow_hidden()
            .occlude()
            .track_focus(&self.focus)
            .on_mouse_down_out(cx.listener(|_, _, _, cx| cx.emit(PromptEvent::Skip)))
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                if this.effective_tab() != DdTab::Todo {
                    let n = this.ext_rows(this.effective_tab()).len();
                    match ev.keystroke.key.as_str() {
                        "down" if n > 0 => this.ext_focus = Some(this.ext_focus.map_or(0, |i| (i + 1).min(n - 1))),
                        "up" if n > 0 => this.ext_focus = Some(this.ext_focus.map_or(0, |i| i.saturating_sub(1))),
                        "escape" => cx.emit(PromptEvent::Skip),
                        _ => return,
                    }
                    cx.notify();
                    return;
                }
                let n = matching_todos(&this.todos, &this.query, &this.chips).len();
                match ev.keystroke.key.as_str() {
                    "down" if n > 0 => this.active = (this.active + 1).min(n - 1),
                    "up" => this.active = this.active.saturating_sub(1),
                    "escape" => cx.emit(PromptEvent::Skip),
                    _ => return,
                }
                cx.notify();
            }))
            .children((tab != DdTab::Todo).then(|| self.issue_search.clone().map(search_of)).flatten())
            .children((tabs.len() > 1).then(|| self.dd_tab_row(&tabs, tab, cx)))
            .children((tab == DdTab::Todo).then(|| search_of(self.search.clone())))
            .children((tab == DdTab::Todo).then(|| {
                let cs = lizmeter_ui::scrollbar::keyed("prompt-chips", lizmeter_ui::scrollbar::BarStyle::Global);
                div().relative().flex_shrink_0().max_h(px(72.0)).child(div().id("dd-chips").track_scroll(cs.handle()).max_h(px(72.0)).overflow_y_scroll().child(cs.pad(chips))).child(cs.bar())
            }))
            .child(list)
    }

    /// Capture hook: the tracker section as it looks in one state (`rows`, `loading`, `error`, `none-found`).
    /// The issues are made up here; no provider answers before phase 8.
    pub fn capture(&mut self, state: &str, cx: &mut Context<Self>) {
        self.has_linear = true;
        self.has_jira = true;
        self.loading = state == "loading";
        self.tracker_error = (state == "error").then(|| "Request failed: 401 Unauthorized".to_string());
        if state == "rows" {
            self.linear = vec![LinearIssue { id: "a".into(), identifier: "LIZ-14".into(), title: "Sync the oplog on resume".into(), url: "u".into(), priority: 2, state: lizmeter_core::LinearIssueState { name: "In Progress".into(), kind: "started".into() }, updated_at: String::new() }];
            self.jira = vec![JiraIssue { id: "1".into(), key: "PROJ-12".into(), title: "Wire the worklog dialog".into(), url: "u".into(), status: "In Progress".into(), priority: None, assignee: None, issue_type: None, labels: vec![] }];
        }
        cx.notify();
    }

    /// "Loading issues...", then the "Issue trackers" heading with the providers' rows or the reason there are none.
    fn tracker_section(&self, cx: &mut Context<Self>) -> Div {
        let status = |text: String| ui_text(13.0).py(px(24.0)).px(px(20.0)).text_center().text_color(col(TN_MUTED)).child(text);
        let mut out = div().flex().flex_col();
        if self.loading {
            return out.child(status("Loading issues...".into()));
        }
        out = out.child(section("Issue trackers", false));
        if !self.has_linear && !self.has_jira {
            return out.child(status("No issue providers configured. Set up Linear or Jira in Settings.".into()));
        }
        let mut rows = div().flex().flex_col();
        for i in self.linear.clone() {
            let issue = IssueRef::Linear { identifier: i.identifier.clone(), title: i.title.clone(), url: i.url.clone() };
            rows = rows.child(self.tracker_row(i.id.clone(), i.identifier, i.title, issue, cx));
        }
        for i in self.jira.clone() {
            let issue = IssueRef::Jira { key: i.key.clone(), title: i.title.clone(), url: i.url.clone() };
            rows = rows.child(self.tracker_row(i.id.clone(), i.key, i.title, issue, cx));
        }
        if self.linear.is_empty() && self.jira.is_empty() {
            return out.child(status("No issues found.".into()));
        }
        // The rows scroll in their own box, so a long list never pushes past the dialog's fixed height.
        let scroll = lizmeter_ui::scrollbar::keyed("prompt-trackers", lizmeter_ui::scrollbar::BarStyle::Global);
        out = out.child(
            div()
                .relative()
                .flex_shrink_0()
                .max_h(px(150.0))
                .child(div().id("prompt-trackers").track_scroll(scroll.handle()).max_h(px(150.0)).overflow_y_scroll().child(scroll.pad(rows)))
                .child(scroll.bar()),
        );
        out
    }
}

impl Render for IssuePrompt {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let matches: Vec<Todo> = matching_todos(&self.todos, &self.query, &self.chips).into_iter().cloned().collect();
        let skip_me = me.clone();
        let skip = div()
            .id("prompt-skip")
            .h(px(29.0))
            .px(px(17.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(col(TN_MUTED))
            .flex()
            .items_center()
            .cursor_pointer()
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.07))))
            .font_family("Arial")
            .text_size(px(13.0))
            .text_color(col(TN_TEXT))
            .on_click(move |_, _, app| skip_me.update(app, |_, cx| cx.emit(PromptEvent::Skip)))
            .child("Skip");

        let mut chips = div().id("prompt-chips").px(px(8.0)).py(px(6.0)).flex().flex_row().flex_wrap().gap(px(4.0));
        let groups: Vec<(&'static str, i64, String, String, bool)> = self
            .states
            .iter()
            .map(|s| ("state", s.id, s.label.clone(), s.color.clone(), self.chips.state == Some(s.id)))
            .chain(self.projects.iter().map(|p| ("project", p.id, p.name.clone(), p.color.clone(), self.chips.project == Some(p.id))))
            .chain(self.labels.iter().map(|l| ("label", l.id, l.name.clone(), l.color.clone(), self.chips.label == Some(l.id))))
            .collect();
        for (kind, id, label, color, on) in groups {
            let m = me.clone();
            chips = chips.child(chip(&label, on, Some(crate::controls::parse_color(&color))).id(SharedString::from(format!("{kind}-{id}"))).on_click(move |_, _, app| {
                m.update(app, |p, cx| {
                    let slot = match kind {
                        "state" => &mut p.chips.state,
                        "project" => &mut p.chips.project,
                        _ => &mut p.chips.label,
                    };
                    *slot = if on { None } else { Some(id) };
                    p.active = 0;
                    cx.notify();
                })
            }));
        }

        let scroll = lizmeter_ui::scrollbar::keyed("prompt-list", lizmeter_ui::scrollbar::BarStyle::Global);
        let mut rows = div().flex().flex_col();
        if let Some(e) = &self.error {
            rows = rows.child(crate::controls::state_message(e.clone(), TN_RED, false));
        } else if matches.is_empty() {
            let filtered = !self.query.trim().is_empty() || self.chips.any();
            rows = rows.child(crate::controls::state_message(if filtered { "No matching todos" } else { "No todos yet" }, TN_TEXT_DIM, false));
        }
        for (i, t) in matches.iter().enumerate() {
            rows = rows.child(self.row(t, i == self.active, cx));
        }
        let list = div()
            .relative()
            .flex_1()
            .min_h(px(60.0))
            .child(div().id("prompt-list").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(rows)))
            .child(scroll.bar());

        if self.mode == PromptMode::Dropdown {
            return self.dropdown_el(&matches, chips, cx).into_any_element();
        }

        let search = div()
            .relative()
            .h(px(37.0))
            .flex_shrink_0()
            .px(px(12.0))
            .flex()
            .items_center()
            .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(41, 46, 66, 0.8))))
            .child(div().w_full().child(self.search.clone()));

        let header = div()
            .relative()
            .h(px(62.0))
            .flex_shrink_0()
            .px(px(21.0))
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(86, 95, 137, 0.3))))
            .child(ui_text(15.0).line_height(px(19.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child("Link an issue (optional)"))
            .child(skip);

        let body = div()
            .flex_1()
            .p(px(8.0))
            .flex()
            .flex_col()
            .overflow_hidden()
            .child(section("Todos", true))
            .child(search)
            .child(chips)
            .child(list)
            .child(self.tracker_section(cx));

        let spec = Spec::rrect(18.0)
            .fill(linear(135.0, &[(0.0, wh(0.07)), (0.32, wh(0.01)), (0.55, TRANSPARENT)]))
            .fill(linear(315.0, &[(0.0, bk(0.08)), (0.40, TRANSPARENT)]))
            .solid(rgba(20, 23, 42, 0.86))
            .border(1.0, rgba(122, 162, 247, 0.4))
            .inset(0.0, 1.0, wh(0.12))
            .inset(1.0, 0.0, wh(0.05))
            .inset(0.0, -1.0, bk(0.15))
            .inset(-1.0, 0.0, bk(0.05));
        let shd = vec![Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }, sh(0.0, 16.0, 40.0, bk(0.28))];
        let dialog = Glass::new(18.0, 36.0, 1.7, spec)
            .shadows(&shd)
            .el()
            .id("prompt-dialog")
            .w(px(420.0))
            .h(px(480.0))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .overflow_hidden()
            .track_focus(&self.focus)
            .on_click(|_, _, _| {})
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                let n = matching_todos(&this.todos, &this.query, &this.chips).len();
                match ev.keystroke.key.as_str() {
                    "down" if n > 0 => this.active = (this.active + 1).min(n - 1),
                    "up" => this.active = this.active.saturating_sub(1),
                    "escape" => cx.emit(PromptEvent::Skip),
                    _ => return,
                }
                cx.notify();
            }))
            .child(header)
            .children(self.tracker_error.clone().map(|e| ui_text(13.0).flex_shrink_0().py(px(12.0)).px(px(20.0)).text_center().text_color(col(TN_RED)).child(e)))
            .child(body);

        // modalEntrance 0.2s cubic-bezier(0.34, 1.56, 0.64, 1): opacity, translateY(8 -> 0)
        let entrance = animate(div().relative().child(dialog), "modal-entrance", 200, false, overshoot(), 1.0, |el, t| {
            el.opacity(t.clamp(0.0, 1.0)).top(px(8.0 * (1.0 - t)))
        });
        let skip_overlay = me.clone();
        Glass::new(0.0, 28.0, 1.25, Spec::rrect(0.0).solid(rgba(192, 202, 245, 0.10)))
            .el()
            .id("prompt-overlay")
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .bottom_0()
            .flex()
            .items_center()
            .justify_center()
            .on_click(move |_, _, app| skip_overlay.update(app, |_, cx| cx.emit(PromptEvent::Skip)))
            .child(entrance)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{fuzzy_score, matching_todos, TodoChips};
    use crate::pages::todo_tree::fixture::todo;
    use lizmeter_core::{TodoLabel, TodoProject};

    #[test]
    fn the_chips_narrow_the_list_by_project_and_label_as_well_as_state() {
        let mut a = todo(1, None);
        a.project = Some(TodoProject { id: 7, name: "P".into(), color: "#7aa2f7".into(), position: 0, created_at: String::new() });
        let mut b = todo(2, None);
        b.labels = vec![TodoLabel { id: 9, name: "L".into(), color: "#7aa2f7".into(), created_at: String::new() }];
        let all = vec![a, b];
        let ids = |c: TodoChips| matching_todos(&all, "", &c).iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(TodoChips::default()), vec![1, 2]);
        assert_eq!(ids(TodoChips { project: Some(7), ..Default::default() }), vec![1]);
        assert_eq!(ids(TodoChips { label: Some(9), ..Default::default() }), vec![2]);
        assert_eq!(ids(TodoChips { state: Some(1), project: Some(7), label: None }), vec![1]);
        assert!(ids(TodoChips { state: Some(99), ..Default::default() }).is_empty());
    }

    #[test]
    fn fuzzy_needs_the_letters_in_order_and_prefers_tight_hits() {
        assert!(fuzzy_score("wdc", "Write docs").is_some());
        assert!(fuzzy_score("cdw", "Write docs").is_none());
        assert!(fuzzy_score("doc", "Write docs") > fuzzy_score("dcs", "Write docs"));
    }
}
