//! `TodoManageDialog.tsx` and `TodoStateManager.tsx`: one dialog for the three things a todo can be
//! filed under: workflow states, projects and labels. Every control writes at once.

use super::todo_widgets::*;
use crate::css::{hex, rgba};
use crate::select::{SelectBox, SelectEvent, SelectOption};
use crate::ui::*;
use gpui::*;
use lizmeter_core::*;
use lizmeter_services::Services;
use lizmeter_ui::scrollbar::{self, BarStyle};
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::collections::HashMap;
use std::sync::Arc;

const SCROLL_ID: &str = "todo-manage";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Tab {
    States,
    Projects,
    Labels,
}

const TABS: [(Tab, &str); 3] = [(Tab::States, "States"), (Tab::Projects, "Projects"), (Tab::Labels, "Labels")];

pub enum ManageEvent {
    Close,
}

impl EventEmitter<ManageEvent> for ManageDialog {}

/// A row the user may delete: what is being removed and what happens to its todos.
#[derive(Clone)]
enum Pending {
    State { id: i64, reassign: Option<i64> },
    Project(i64),
    Label(i64),
}

pub struct ManageDialog {
    svc: Arc<Services>,
    tab: Tab,
    states: Vec<TodoState>,
    projects: Vec<TodoProject>,
    labels: Vec<TodoLabel>,
    counts_state: HashMap<i64, usize>,
    counts_project: HashMap<i64, usize>,
    counts_label: HashMap<i64, usize>,
    inputs: HashMap<(Tab, i64), Entity<TextField>>,
    add_name: HashMap<Tab, Entity<TextField>>,
    add_color: HashMap<Tab, String>,
    pending: Option<Pending>,
    reassign: Entity<SelectBox>,
    error: Option<String>,
    focus: FocusHandle,
}

/// How many todos use each state, project and label.
pub fn usage_counts(todos: &[Todo]) -> (HashMap<i64, usize>, HashMap<i64, usize>, HashMap<i64, usize>) {
    let (mut s, mut p, mut l) = (HashMap::new(), HashMap::new(), HashMap::new());
    for t in todos {
        *s.entry(t.state.id).or_insert(0) += 1;
        if let Some(pr) = &t.project {
            *p.entry(pr.id).or_insert(0) += 1;
        }
        for lb in &t.labels {
            *l.entry(lb.id).or_insert(0) += 1;
        }
    }
    (s, p, l)
}

/// `ids` with the item at `index` moved one step; `None` at either end.
pub fn moved(ids: &[i64], index: usize, direction: i32) -> Option<Vec<i64>> {
    let target = index as i32 + direction;
    if target < 0 || target as usize >= ids.len() {
        return None;
    }
    let mut out = ids.to_vec();
    let item = out.remove(index);
    out.insert(target as usize, item);
    Some(out)
}

impl ManageDialog {
    pub fn new(svc: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        scrollbar::reset(SCROLL_ID);
        let reassign = cx.new(|cx| SelectBox::new("manage-reassign", "", 128.0, 4000.0, false, cx));
        cx.subscribe(&reassign, |this, _, ev: &SelectEvent, cx| {
            if let SelectEvent::Change(v) = ev {
                if let (Some(Pending::State { id, .. }), Ok(to)) = (this.pending.clone(), v.parse::<i64>()) {
                    this.pending = Some(Pending::State { id, reassign: Some(to) });
                    cx.notify();
                }
            }
        })
        .detach();
        let mut d = Self {
            svc,
            tab: Tab::States,
            states: vec![],
            projects: vec![],
            labels: vec![],
            counts_state: HashMap::new(),
            counts_project: HashMap::new(),
            counts_label: HashMap::new(),
            inputs: HashMap::new(),
            add_name: HashMap::new(),
            add_color: HashMap::from([(Tab::States, TODO_COLORS[0].to_string()), (Tab::Projects, TODO_COLORS[0].to_string()), (Tab::Labels, TODO_COLORS[0].to_string())]),
            pending: None,
            reassign,
            error: None,
            focus: cx.focus_handle(),
        };
        for (tab, ph, max) in [(Tab::States, "New state...", 32), (Tab::Projects, "New project...", 60), (Tab::Labels, "New label...", 40)] {
            let f = limited_input(13.0, ph, max, window, cx);
            cx.subscribe_in(&f, window, move |this, _, ev: &TextFieldEvent, window, cx| match ev {
                TextFieldEvent::Submit => this.add(tab, window, cx),
                TextFieldEvent::Cancel => cx.emit(ManageEvent::Close),
                TextFieldEvent::Changed => cx.notify(),
            })
            .detach();
            d.add_name.insert(tab, f);
        }
        d.reload(window, cx);
        window.focus(&d.focus);
        d
    }

    fn fail(&mut self, e: impl std::fmt::Display) {
        self.error = Some(e.to_string());
    }

    fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let all = self.svc.list_todos(&ListTodosInput::default());
        match (self.svc.list_todo_states(), self.svc.list_todo_projects(), self.svc.list_todo_labels(), all) {
            (Ok(s), Ok(p), Ok(l), Ok(t)) => {
                self.states = s;
                self.projects = p;
                self.labels = l;
                (self.counts_state, self.counts_project, self.counts_label) = usage_counts(&t);
            }
            (Err(e), ..) | (_, Err(e), ..) | (_, _, Err(e), _) | (.., Err(e)) => self.fail(e),
        }
        let rows: Vec<(Tab, i64, String)> = self
            .states
            .iter()
            .map(|s| (Tab::States, s.id, s.label.clone()))
            .chain(self.projects.iter().map(|p| (Tab::Projects, p.id, p.name.clone())))
            .chain(self.labels.iter().map(|l| (Tab::Labels, l.id, l.name.clone())))
            .collect();
        self.inputs.retain(|(t, id), _| rows.iter().any(|(rt, rid, _)| rt == t && rid == id));
        for (tab, id, value) in rows {
            match self.inputs.get(&(tab, id)) {
                Some(f) => {
                    if f.read(cx).text() != value {
                        f.update(cx, |f, cx| f.set_text(&value, cx));
                    }
                }
                None => {
                    let f = limited_input(13.0, "", 32, window, cx);
                    cx.subscribe_in(&f, window, move |this, f, ev: &TextFieldEvent, window, cx| match ev {
                        TextFieldEvent::Submit => this.commit_row(tab, id, window, cx),
                        TextFieldEvent::Cancel => this.reset_row(tab, id, f.clone(), cx),
                        TextFieldEvent::Changed => {}
                    })
                    .detach();
                    let focus = f.read(cx).focus_handle().clone();
                    cx.on_blur(&focus, window, move |this, window, cx| this.commit_row(tab, id, window, cx)).detach();
                    f.update(cx, |f, cx| f.set_text(&value, cx));
                    self.inputs.insert((tab, id), f);
                }
            }
        }
        if let Some(Pending::State { id, reassign }) = self.pending.clone() {
            let options = self.states.iter().filter(|s| s.id != id).map(|s| SelectOption::new(s.id.to_string(), &s.label, Some(s.color.clone()))).collect();
            let value = reassign.map(|v| v.to_string()).unwrap_or_default();
            self.reassign.update(cx, |s, cx| s.set_options(options, &value, cx));
        }
        cx.notify();
    }

    /// Capture hooks (`--do todos-dialog-op:...`): switch tabs and add rows without a keyboard.
    pub fn capture(&mut self, op: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (name, arg) = op.split_once(':').unwrap_or((op, ""));
        match name {
            "tab" => {
                self.tab = match arg {
                    "projects" => Tab::Projects,
                    "labels" => Tab::Labels,
                    _ => Tab::States,
                };
                self.pending = None;
            }
            "add" => {
                let tab = self.tab;
                if let Some(f) = self.add_name.get(&tab).cloned() {
                    let t = arg.to_string();
                    f.update(cx, |f, cx| f.set_text(&t, cx));
                    self.add(tab, window, cx);
                }
            }
            "delete" => {
                if let Ok(id) = arg.parse() {
                    let tab = self.tab;
                    self.ask_delete(tab, id, cx);
                }
            }
            "confirm" => self.confirm_delete(window, cx),
            _ => {}
        }
        cx.notify();
    }

    fn server_value(&self, tab: Tab, id: i64) -> Option<String> {
        match tab {
            Tab::States => self.states.iter().find(|s| s.id == id).map(|s| s.label.clone()),
            Tab::Projects => self.projects.iter().find(|p| p.id == id).map(|p| p.name.clone()),
            Tab::Labels => self.labels.iter().find(|l| l.id == id).map(|l| l.name.clone()),
        }
    }

    fn reset_row(&mut self, tab: Tab, id: i64, f: Entity<TextField>, cx: &mut Context<Self>) {
        if let Some(v) = self.server_value(tab, id) {
            f.update(cx, |f, cx| f.set_text(&v, cx));
        }
    }

    /// Blur or Enter on a name box: an empty name restores the old one, a changed name is saved.
    fn commit_row(&mut self, tab: Tab, id: i64, window: &mut Window, cx: &mut Context<Self>) {
        let (Some(f), Some(current)) = (self.inputs.get(&(tab, id)).cloned(), self.server_value(tab, id)) else { return };
        let next = f.read(cx).text().trim().to_string();
        if next.is_empty() {
            f.update(cx, |f, cx| f.set_text(&current, cx));
            return;
        }
        if next == current {
            return;
        }
        let result = match tab {
            Tab::States => self.svc.update_todo_state(&UpdateTodoStateInput { id, label: Some(next), ..Default::default() }).map(|_| ()),
            Tab::Projects => self.svc.update_todo_project(&UpdateTodoProjectInput { id, name: Some(next), ..Default::default() }).map(|_| ()),
            Tab::Labels => self.svc.update_todo_label(&UpdateTodoLabelInput { id, name: Some(next), ..Default::default() }).map(|_| ()),
        };
        self.after_write(result, window, cx);
    }

    fn after_write(&mut self, result: lizmeter_services::Result<()>, window: &mut Window, cx: &mut Context<Self>) {
        match result {
            Ok(()) => self.error = None,
            Err(e) => self.fail(e),
        }
        self.reload(window, cx);
    }

    fn write_color(&mut self, tab: Tab, id: i64, color: &str, window: &mut Window, cx: &mut Context<Self>) {
        let color = Some(color.to_string());
        let result = match tab {
            Tab::States => self.svc.update_todo_state(&UpdateTodoStateInput { id, color, ..Default::default() }).map(|_| ()),
            Tab::Projects => self.svc.update_todo_project(&UpdateTodoProjectInput { id, color, ..Default::default() }).map(|_| ()),
            Tab::Labels => self.svc.update_todo_label(&UpdateTodoLabelInput { id, color, ..Default::default() }).map(|_| ()),
        };
        self.after_write(result, window, cx);
    }

    fn write_role(&mut self, id: i64, default: bool, window: &mut Window, cx: &mut Context<Self>) {
        let input = if default { UpdateTodoStateInput { id, is_default: Some(true), ..Default::default() } } else { UpdateTodoStateInput { id, is_completed: Some(true), ..Default::default() } };
        let r = self.svc.update_todo_state(&input).map(|_| ());
        self.after_write(r, window, cx);
    }

    fn reorder(&mut self, tab: Tab, index: usize, direction: i32, window: &mut Window, cx: &mut Context<Self>) {
        let r = match tab {
            Tab::States => moved(&self.states.iter().map(|s| s.id).collect::<Vec<_>>(), index, direction).map(|ids| self.svc.reorder_todo_states(&ids).map(|_| ())),
            Tab::Projects => moved(&self.projects.iter().map(|p| p.id).collect::<Vec<_>>(), index, direction).map(|ids| self.svc.reorder_todo_projects(&ids).map(|_| ())),
            Tab::Labels => None,
        };
        if let Some(r) = r {
            self.after_write(r, window, cx);
        }
    }

    fn add(&mut self, tab: Tab, window: &mut Window, cx: &mut Context<Self>) {
        let Some(f) = self.add_name.get(&tab).cloned() else { return };
        let name = f.read(cx).text().trim().to_string();
        if name.is_empty() {
            return;
        }
        let color = Some(self.add_color[&tab].clone());
        let r = match tab {
            Tab::States => self.svc.create_todo_state(&CreateTodoStateInput { label: name, color }).map(|_| ()),
            Tab::Projects => self.svc.create_todo_project(&CreateTodoProjectInput { name, color }).map(|_| ()),
            Tab::Labels => self.svc.create_todo_label(&CreateTodoLabelInput { name, color }).map(|_| ()),
        };
        if r.is_ok() {
            f.update(cx, |f, cx| f.set_text("", cx));
        }
        self.after_write(r, window, cx);
    }

    fn confirm_delete(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let r = match self.pending.clone() {
            Some(Pending::State { id, reassign: Some(to) }) => self.svc.delete_todo_state(id, to).map(|_| ()),
            Some(Pending::Project(id)) => self.svc.delete_todo_project(id).map(|_| ()),
            Some(Pending::Label(id)) => self.svc.delete_todo_label(id).map(|_| ()),
            _ => return,
        };
        if r.is_ok() {
            self.pending = None;
        }
        self.after_write(r, window, cx);
    }
}

// ---- Rendering ----

fn hex_a3() -> crate::css::C {
    crate::css::hex(0xa3abc9)
}

fn name_box(field: &Entity<TextField>, focused: bool) -> Div {
    div()
        .flex_1()
        .min_w(px(112.0))
        .px(px(10.0))
        .py(px(6.0))
        .rounded(px(7.0))
        .border(px(1.0))
        .border_color(col(if focused { rgba(122, 162, 247, 0.5) } else { rgba(41, 46, 66, 0.8) }))
        .bg(col(rgba(12, 13, 24, 0.55)))
        .child(field.clone())
}

fn swatches(prefix: String, selected: &str, on_pick: impl Fn(&str, &mut Window, &mut App) + Clone + 'static) -> Div {
    let mut row = div().flex().flex_row().gap(px(3.0)).flex_shrink_0();
    for (i, c) in TODO_COLORS.iter().enumerate() {
        let on = c.eq_ignore_ascii_case(selected);
        let pick = on_pick.clone();
        let color = *c;
        row = row.child(
            div()
                .id(SharedString::from(format!("{prefix}-{i}")))
                .size(px(14.0))
                .flex_shrink_0()
                .rounded(px(7.0))
                .border(px(1.0))
                .border_color(col(if on { TN_TEXT } else { crate::css::TRANSPARENT }))
                .bg(col(crate::controls::parse_color(c)))
                .opacity(if on { 1.0 } else { 0.55 })
                .cursor_pointer()
                .hover(|s| s.opacity(1.0))
                .on_click(move |_, w, a| pick(color, w, a)),
        );
    }
    row
}

fn small_button(id: impl Into<ElementId>, label: &str, pad_x: f32, color: crate::css::C, border: crate::css::C, bg: crate::css::C, hover_bg: crate::css::C) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(pad_x))
        .py(px(5.0))
        .rounded(px(7.0))
        .border(px(1.0))
        .border_color(col(border))
        .bg(col(bg))
        .text_size(px(12.0))
        .line_height(px(15.0))
        .font_weight(FontWeight(600.0))
        .text_color(col(color))
        .cursor_pointer()
        .hover(move |s| s.bg(col(hover_bg)))
        .child(label.to_string())
}

impl ManageDialog {
    fn count_of(&self, tab: Tab, id: i64) -> usize {
        let m = match tab {
            Tab::States => &self.counts_state,
            Tab::Projects => &self.counts_project,
            Tab::Labels => &self.counts_label,
        };
        m.get(&id).copied().unwrap_or(0)
    }

    fn ask_delete(&mut self, tab: Tab, id: i64, cx: &mut Context<Self>) {
        self.pending = match tab {
            Tab::States => Some(Pending::State { id, reassign: self.states.iter().find(|s| s.id != id).map(|s| s.id) }),
            Tab::Projects => Some(Pending::Project(id)),
            Tab::Labels => Some(Pending::Label(id)),
        };
        if let Some(Pending::State { id, reassign }) = self.pending.clone() {
            let options = self.states.iter().filter(|s| s.id != id).map(|s| SelectOption::new(s.id.to_string(), &s.label, Some(s.color.clone()))).collect();
            let value = reassign.map(|v| v.to_string()).unwrap_or_default();
            self.reassign.update(cx, |s, cx| s.set_options(options, &value, cx));
        }
        cx.notify();
    }

    fn arrows(&self, tab: Tab, index: usize, len: usize, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let mut stack = div().flex().flex_col().gap(px(1.0)).flex_shrink_0();
        for (dir, glyph, enabled) in [(-1, "gen/arrow-up.svg", index > 0), (1, "gen/arrow-down.svg", index + 1 < len)] {
            let m = me.clone();
            let mut b = div().id(SharedString::from(format!("move-{tab:?}-{index}-{dir}"))).px(px(2.0)).rounded(px(3.0)).child(svg().path(glyph).size(px(13.0)).text_color(col(dim())));
            b = if enabled {
                b.cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.12)))).on_click(move |_, w, a| m.update(a, |d, cx| d.reorder(tab, index, dir, w, cx)))
            } else {
                b.opacity(0.25)
            };
            stack = stack.child(b);
        }
        stack
    }

    fn delete_button(&self, tab: Tab, id: i64, enabled: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let me = cx.entity();
        let b = div()
            .id(SharedString::from(format!("del-{tab:?}-{id}")))
            .flex_shrink_0()
            .px(px(10.0))
            .py(px(4.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(col(rgba(247, 118, 142, 0.25)))
            .text_size(px(11.0))
            .line_height(px(14.0))
            .text_color(col(TN_RED))
            .child("Delete");
        if !enabled {
            return b.opacity(0.3);
        }
        b.cursor_pointer().hover(|s| s.bg(col(rgba(247, 118, 142, 0.12)))).on_click(move |_, _, a| me.update(a, |d, cx| d.ask_delete(tab, id, cx)))
    }

    #[allow(clippy::too_many_arguments)]
    fn row_el(&self, tab: Tab, index: usize, id: i64, color: &str, flags: Vec<AnyElement>, delete_enabled: bool, len: usize, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let field = self.inputs.get(&(tab, id)).cloned();
        let focused = field.as_ref().is_some_and(|f| f.read(cx).focus_handle().is_focused(window));
        let mut row = div().flex().flex_row().flex_wrap().items_center().gap(px(10.0)).px(px(10.0)).py(px(8.0)).rounded(px(10.0)).bg(col(rgba(12, 13, 24, 0.5))).border(px(1.0)).border_color(col(rgba(41, 46, 66, 0.8)));
        if tab != Tab::Labels {
            row = row.child(self.arrows(tab, index, len, cx));
        }
        if let Some(f) = &field {
            row = row.child(name_box(f, focused));
        }
        row = row.child(swatches(format!("sw-{tab:?}-{id}"), color, move |c, w, a| {
            let c = c.to_string();
            me.update(a, |d, cx| d.write_color(tab, id, &c, w, cx))
        }));
        for f in flags {
            row = row.child(f);
        }
        row.child(div().flex_shrink_0().min_w(px(24.0)).flex().justify_end().text_size(px(11.0)).text_color(col(dim())).child(self.count_of(tab, id).to_string())).child(self.delete_button(tab, id, delete_enabled, cx))
    }

    fn radio(&self, id: i64, default: bool, on: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let name = if default { "Default" } else { "Done" };
        let white = crate::css::hex(0xffffff);
        let mut mark = div().size(px(13.0)).flex_shrink_0().rounded(px(7.0)).border(px(1.0)).border_color(col(if on { TN_BLUE } else { rgba(0, 0, 0, 0.35) })).bg(col(if on { TN_BLUE } else { white })).flex().items_center().justify_center();
        if on {
            mark = mark.child(div().size(px(9.0)).rounded(px(5.0)).bg(col(white)).flex().items_center().justify_center().child(div().size(px(5.0)).rounded(px(3.0)).bg(col(TN_BLUE))));
        }
        div()
            .id(SharedString::from(format!("role-{name}-{id}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .flex_shrink_0()
            .text_size(px(11.0))
            .text_color(col(TN_TEXT_DIM))
            .cursor_pointer()
            .on_click(move |_, w, a| me.update(a, |d, cx| d.write_role(id, default, w, cx)))
            .child(mark)
            .child(name)
    }

    fn add_form(&self, tab: Tab, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let field = self.add_name[&tab].clone();
        let focused = field.read(cx).focus_handle().is_focused(window);
        let enabled = !field.read(cx).text().trim().is_empty();
        let (m_color, m_add) = (me.clone(), me);
        let mut add = small_button("add-row", "Add", 18.0, TN_BLUE, rgba(122, 162, 247, 0.35), rgba(122, 162, 247, 0.14), rgba(122, 162, 247, 0.22)).py(px(7.0)).rounded(px(8.0)).text_size(px(13.0));
        add = if enabled { add.on_click(move |_, w, a| m_add.update(a, |d, cx| d.add(tab, w, cx))) } else { add.opacity(0.4) };
        div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(10.0))
            .pt(px(14.0))
            .border_t_1()
            .border_color(col(hex(0x292e42)))
            .child(name_box(&field, focused))
            .child(swatches(format!("new-{tab:?}"), &self.add_color[&tab], move |c, _, a| {
                let c = c.to_string();
                m_color.update(a, |d, cx| {
                    d.add_color.insert(tab, c);
                    cx.notify();
                })
            }))
            .child(add)
    }

    fn confirm(&self, cx: &mut Context<Self>) -> Option<Div> {
        let me = cx.entity();
        let pending = self.pending.clone()?;
        let strong = |t: String| div().text_color(col(TN_RED)).font_weight(FontWeight(700.0)).child(t);
        let line = |parts: Vec<AnyElement>| div().flex().flex_row().flex_wrap().gap(px(4.0)).children(parts);
        let mut row = div().flex().flex_row().flex_wrap().gap(px(8.0));
        let (head, label, ok_enabled) = match &pending {
            Pending::State { id, reassign } => {
                let s = self.states.iter().find(|s| s.id == *id)?;
                row = row.child(div().flex_1().min_w(px(128.0)).child(self.reassign.clone()));
                (line(vec![format!("{} todo(s) use", self.count_of(Tab::States, *id)).into_any_element(), strong(s.label.clone()).into_any_element(), ". Move them to:".into_any_element()]), "Move and delete", reassign.is_some())
            }
            Pending::Project(id) | Pending::Label(id) => {
                let project = matches!(pending, Pending::Project(_));
                let (name, noun, tab) = if project { (self.projects.iter().find(|p| p.id == *id)?.name.clone(), "project", Tab::Projects) } else { (self.labels.iter().find(|l| l.id == *id)?.name.clone(), "label", Tab::Labels) };
                let count = self.count_of(tab, *id);
                let head = if count == 0 {
                    line(vec!["No todos use".into_any_element(), strong(name).into_any_element(), ".".into_any_element()])
                } else {
                    line(vec![format!("{count} todo(s) will lose the {noun}").into_any_element(), strong(name).into_any_element(), ". The todos themselves are kept.".into_any_element()])
                };
                (head, if project { "Delete project" } else { "Delete label" }, true)
            }
        };
        let (m_ok, m_cancel) = (me.clone(), me);
        let mut ok = small_button("confirm-ok", label, 14.0, TN_RED, rgba(247, 118, 142, 0.4), rgba(247, 118, 142, 0.15), rgba(247, 118, 142, 0.25)).py(px(6.0));
        ok = if ok_enabled { ok.on_click(move |_, w, a| m_ok.update(a, |d, cx| d.confirm_delete(w, cx))) } else { ok.opacity(0.4) };
        let cancel = small_button("confirm-cancel", "Cancel", 14.0, TN_TEXT_DIM, hex(0x292e42), crate::css::TRANSPARENT, rgba(122, 162, 247, 0.07)).font_weight(FontWeight(400.0)).on_click(move |_, _, a| {
            m_cancel.update(a, |d, cx| {
                d.pending = None;
                cx.notify();
            })
        });
        Some(
            div()
                .mt(px(16.0))
                .px(px(14.0))
                .py(px(12.0))
                .rounded(px(10.0))
                .border(px(1.0))
                .border_color(col(rgba(247, 118, 142, 0.3)))
                .bg(col(rgba(247, 118, 142, 0.08)))
                .flex()
                .flex_col()
                .gap(px(10.0))
                .child(div().text_size(px(12.0)).line_height(px(16.0)).text_color(col(TN_TEXT)).child(head))
                .child(row.child(ok).child(cancel)),
        )
    }

    fn body(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let hint = |t: &str| div().mt(px(10.0)).mb(px(16.0)).text_size(px(12.0)).line_height(px(18.0)).text_color(col(hex_a3())).child(t.to_string());
        let mut list = div().flex().flex_col().gap(px(6.0)).mb(px(14.0));
        let mut out = div();
        match self.tab {
            Tab::States => {
                out = out.child(hint("Rename, recolor, and reorder freely. One state is where new todos land, and one means finished \u{2014} those two roles survive renaming."));
                for (i, s) in self.states.iter().enumerate() {
                    let flags = vec![self.radio(s.id, true, s.is_default, cx).into_any_element(), self.radio(s.id, false, s.is_completed, cx).into_any_element()];
                    let enabled = !s.is_default && !s.is_completed && self.states.len() > 1;
                    list = list.child(self.row_el(Tab::States, i, s.id, &s.color, flags, enabled, self.states.len(), window, cx));
                }
            }
            Tab::Projects => {
                out = out.child(hint("Projects group todos. A todo can belong to one, or to none \u{2014} deleting a project only removes the grouping, never the work."));
                for (i, p) in self.projects.iter().enumerate() {
                    list = list.child(self.row_el(Tab::Projects, i, p.id, &p.color, vec![], true, self.projects.len(), window, cx));
                }
            }
            Tab::Labels => {
                out = out.child(hint("A todo can carry any number of labels. You can also make one on the spot by typing a new name into the label picker \u{2014} this tab is for renaming, recoloring, and tidying up."));
                for (i, l) in self.labels.iter().enumerate() {
                    list = list.child(self.row_el(Tab::Labels, i, l.id, &l.color, vec![], true, self.labels.len(), window, cx));
                }
            }
        }
        out = out.child(list);
        let none = match self.tab {
            Tab::States => None,
            Tab::Projects => self.projects.is_empty().then_some("No projects yet. Add one below."),
            Tab::Labels => self.labels.is_empty().then_some("No labels yet. Add one below."),
        };
        if let Some(t) = none {
            out = out.child(div().mb(px(14.0)).text_size(px(12.0)).text_color(col(hex_a3())).child(t));
        }
        out = out.child(self.add_form(self.tab, window, cx));
        if let Some(c) = self.confirm(cx) {
            out = out.child(c);
        }
        out
    }
}

impl Render for ManageDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let vp = window.viewport_size();
        let (vw, vh) = (f32::from(vp.width), f32::from(vp.height));
        let width = (vw * 0.62).clamp(480.0, 896.0).min(vw - 48.0);
        let scroll = scrollbar::keyed(SCROLL_ID, BarStyle::Global);

        let mut tabs = div().flex().flex_row().gap(px(2.0)).p(px(3.0)).rounded(px(9.0)).border(px(1.0)).border_color(col(rgba(41, 46, 66, 0.8))).bg(col(rgba(12, 13, 24, 0.5)));
        for (t, label) in TABS {
            let m = me.clone();
            let on = self.tab == t;
            let mut tab = div()
                .id(SharedString::from(format!("manage-tab-{label}")))
                .px(px(13.0))
                .py(px(5.0))
                .rounded(px(7.0))
                .border(px(1.0))
                .border_color(col(rgba(0, 0, 0, 0.0)))
                .text_size(px(11.0))
                .line_height(px(14.0))
                .font_weight(FontWeight(700.0))
                .cursor_pointer()
                .text_color(col(if on { TN_TEXT } else { dim() }))
                .hover(move |s| s.text_color(col(TN_TEXT)).bg(col(rgba(122, 162, 247, if on { 0.18 } else { 0.07 }))))
                .on_click(move |_, _, a| {
                    m.update(a, |d, cx| {
                        d.tab = t;
                        d.pending = None;
                        scrollbar::reset(SCROLL_ID);
                        cx.notify();
                    })
                })
                .child(spaced(&label.to_uppercase(), 1.1));
            if on {
                tab = tab.bg(col(rgba(122, 162, 247, 0.14))).border_color(col(rgba(122, 162, 247, 0.22)));
            }
            tabs = tabs.child(tab);
        }
        let m_close = me.clone();
        let header = div().flex().flex_row().items_center().justify_between().child(tabs).child(
            div()
                .id("manage-close")
                .px(px(6.0))
                .py(px(2.0))
                .rounded(px(4.0))
                .text_size(px(14.0))
                .line_height(px(14.0))
                .text_color(col(hex_a3()))
                .cursor_pointer()
                .hover(|s| s.text_color(col(TN_TEXT)))
                .on_click(move |_, _, a| m_close.update(a, |_, cx| cx.emit(ManageEvent::Close)))
                .child("x"),
        );
        let mut content = div().px(px(24.0)).py(px(22.0)).child(header);
        if let Some(e) = &self.error {
            content = content.child(div().mt(px(10.0)).text_size(px(12.0)).text_color(col(TN_RED)).child(e.clone()));
        }
        content = content.child(self.body(window, cx));

        let dialog = dialog_glass(18.0)
            .id("manage-dialog")
            .w(px(width))
            .max_h(px(vh * 0.88))
            .flex()
            .flex_col()
            .overflow_hidden()
            .track_focus(&self.focus)
            .on_click(|_, _, _| {})
            .on_key_down(cx.listener(|_, ev: &KeyDownEvent, _, cx| {
                if ev.keystroke.key == "escape" {
                    cx.emit(ManageEvent::Close);
                    cx.stop_propagation();
                }
            }))
            .child(div().relative().flex_1().min_h_0().child(div().id("manage-scroll").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(content))).child(scroll.bar()));
        let close = me;
        modal_overlay("manage", None, dialog, move |_, a| close.update(a, |_, cx| cx.emit(ManageEvent::Close)))
    }
}

#[cfg(test)]
mod tests {
    use super::{moved, usage_counts};
    use crate::pages::todo_tree::fixture::todo;
    use lizmeter_core::{TodoLabel, TodoProject};

    #[test]
    fn a_row_moves_one_step_and_stops_at_the_ends() {
        assert_eq!(moved(&[1, 2, 3], 1, -1), Some(vec![2, 1, 3]));
        assert_eq!(moved(&[1, 2, 3], 1, 1), Some(vec![1, 3, 2]));
        assert_eq!(moved(&[1, 2, 3], 0, -1), None);
        assert_eq!(moved(&[1, 2, 3], 2, 1), None);
    }

    #[test]
    fn usage_counts_group_by_state_project_and_label() {
        let mut a = todo(1, None);
        a.project = Some(TodoProject { id: 7, name: "P".into(), color: "#7aa2f7".into(), position: 0, created_at: String::new() });
        a.labels = vec![TodoLabel { id: 9, name: "L".into(), color: "#7aa2f7".into(), created_at: String::new() }];
        let b = todo(2, None);
        let (s, p, l) = usage_counts(&[a, b]);
        assert_eq!(s[&1], 2);
        assert_eq!(p[&7], 1);
        assert_eq!(l[&9], 1);
        assert!(!p.contains_key(&8));
    }
}
