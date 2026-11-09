//! IssuePromptDialog: blur overlay + glass dialog with the `modalEntrance` animation, over the real todos.

use crate::controls::field_style;
use crate::css::{Spec, TRANSPARENT, linear, rgba};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{IssueRef, ListTodosInput, Todo, TodoLabel, TodoProject, TodoState};
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

pub struct IssuePrompt {
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
}

impl IssuePrompt {
    pub fn new(svc: &Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        lizmeter_ui::scrollbar::reset("prompt-list");
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
        Self { todos, states, projects, labels, chips: TodoChips::default(), search, query: String::new(), active: 0, error, focus }
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
        .h(px(18.0))
        .px(px(9.0))
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
            .h(px(196.0))
            .flex_shrink_0()
            .child(div().id("prompt-list").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(rows)))
            .child(scroll.bar());

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
            .child(section("Issue trackers", false))
            .child(
                ui_text(13.0)
                    .py(px(24.0))
                    .px(px(20.0))
                    .text_center()
                    .text_color(col(TN_MUTED))
                    .child("No issue providers configured. Set up Linear or Jira in Settings."),
            );

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
