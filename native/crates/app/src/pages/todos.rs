//! Todos page (`TodosPage.tsx`): the grouped list, the filters, the bulk bar and the keyboard cursor.
//! The list is windowed: only the rows near the viewport are built, whatever the length.

use super::todos_icons as icons;
use super::todos_logic::*;
use super::todos_menus::*;
use super::PageEvent;
use crate::controls::parse_color;
use crate::css::{hex, rgba, C};
use crate::select::{SelectBox, SelectEvent, SelectOption};
use crate::ui::*;
use gpui::*;
use lizmeter_core::*;
use lizmeter_services::Services;
use lizmeter_ui::scrollbar::{self, BarStyle};
use std::cell::Cell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

const OVERSCAN: usize = 8;
const FLASH_MS: u64 = 2000;
const COPY_FEEDBACK_MS: u64 = 1200;
const BULK_BAR_H: f32 = 50.0;
const SCROLL_ID: &str = "todos-page";

const FILTERS: [(TodoFilter, &str); 4] = [(TodoFilter::All, "All"), (TodoFilter::Active, "Active"), (TodoFilter::Done, "Done"), (TodoFilter::Ai, "From AI")];

/// Where the list sits in the scroller, measured while painting.
#[derive(Clone, Copy)]
struct Geo {
    panel_x: f32,
    /// The panel's top edge, in scroller content coordinates.
    panel_y: f32,
    panel_h: f32,
    /// The scroller's top edge in the window, and its height.
    vp_top: f32,
    vp_h: f32,
}

/// Dialogs and pages that belong to part 7B of the port. A row action that reaches one of these has
/// nothing to open yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pending7b {
    DetailPage(i64),
    CreateDialog,
    ManageDialog,
    ParentPicker(i64),
    ChildPicker(i64),
}

enum Overlay {
    None,
    Action { todo_id: i64, anchor: (f32, f32, f32) },
    Quick(Entity<QuickMenu>),
    Shortcuts,
}

#[derive(Clone, Copy)]
struct CopyState {
    action: CopyAction,
    failed: bool,
    from_menu: bool,
}

pub struct TodosPage {
    svc: Arc<Services>,
    groups: Vec<Group>,
    layout: FlatLayout,
    todo_count: usize,
    states: Vec<TodoState>,
    projects: Vec<TodoProject>,
    labels: Vec<TodoLabel>,
    filter: TodoFilter,
    project_filter: Option<i64>,
    label_filter: Option<i64>,
    loading: bool,
    error: Option<String>,
    collapsed: HashSet<i64>,
    focused: Option<i64>,
    selected: HashSet<i64>,
    anchor: Option<i64>,
    overlay: Overlay,
    copy: Option<CopyState>,
    copy_gen: u64,
    flash: Option<(i64, Instant)>,
    focus: FocusHandle,
    project_select: Entity<SelectBox>,
    label_select: Entity<SelectBox>,
    bulk_select: Entity<SelectBox>,
    geo: Rc<Cell<Option<Geo>>>,
    /// Row actions that wait for part 7B, newest last.
    pub pending: Vec<Pending7b>,
}

impl EventEmitter<PageEvent> for TodosPage {}

impl TodosPage {
    pub fn new(svc: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let project_select = cx.new(|cx| SelectBox::new("todo-project-filter", "", 136.0, 192.0, false, cx));
        cx.subscribe_in(&project_select, window, |this, _, ev: &SelectEvent, window, cx| {
            let SelectEvent::Change(v) = ev;
            this.project_filter = v.parse().ok();
            this.reload(cx);
            window.focus(&this.focus);
        })
        .detach();
        let label_select = cx.new(|cx| SelectBox::new("todo-label-filter", "", 136.0, 192.0, false, cx));
        cx.subscribe_in(&label_select, window, |this, _, ev: &SelectEvent, window, cx| {
            let SelectEvent::Change(v) = ev;
            this.label_filter = v.parse().ok();
            this.reload(cx);
            window.focus(&this.focus);
        })
        .detach();
        let bulk_select = cx.new(|cx| SelectBox::new("todo-bulk-state", "Move to...", 136.0, 4000.0, true, cx));
        cx.subscribe_in(&bulk_select, window, |this, _, ev: &SelectEvent, window, cx| {
            let SelectEvent::Change(v) = ev;
            if let Ok(state_id) = v.parse::<i64>() {
                let ids: Vec<i64> = this.selected.iter().copied().collect();
                this.set_state_of(&ids, state_id);
                this.selected.clear();
                this.reload(cx);
            }
            window.focus(&this.focus);
        })
        .detach();
        let collapsed = svc.get_setting_value(COLLAPSED_KEY).ok().flatten().map(|v| parse_collapsed(&v)).unwrap_or_default();
        Self {
            svc,
            groups: vec![],
            layout: FlatLayout::new(&[], &HashSet::new()),
            todo_count: 0,
            states: vec![],
            projects: vec![],
            labels: vec![],
            filter: TodoFilter::All,
            project_filter: None,
            label_filter: None,
            loading: true,
            error: None,
            collapsed,
            focused: None,
            selected: HashSet::new(),
            anchor: None,
            overlay: Overlay::None,
            copy: None,
            copy_gen: 0,
            flash: None,
            focus: cx.focus_handle(),
            project_select,
            label_select,
            bulk_select,
            geo: Rc::new(Cell::new(None)),
            pending: vec![],
        }
    }

    /// The page is shown: load, and take the keyboard.
    pub fn show(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.reload(cx);
        window.focus(&self.focus);
    }

    /// A Todo-linked badge elsewhere asked for this row: open its group, scroll to it, flash it.
    pub fn highlight(&mut self, id: i64, window: &mut Window, cx: &mut Context<Self>) {
        self.reload(cx);
        window.focus(&self.focus);
        let Some(state_id) = self.todo(id).map(|t| t.state.id) else { return };
        if self.collapsed.remove(&state_id) {
            self.save_collapsed();
            self.rebuild();
        }
        self.scroll_to(id, true);
        self.flash = Some((id, Instant::now()));
        cx.spawn(async move |this, cx| {
            let frames = FLASH_MS / 50 + 1;
            for _ in 0..frames {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
            let _ = this.update(cx, |p, cx| {
                p.flash = None;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn todo(&self, id: i64) -> Option<&Todo> {
        self.groups.iter().flat_map(|g| g.items.iter()).find(|t| t.id == id)
    }

    fn rebuild(&mut self) {
        self.layout = FlatLayout::new(&self.groups, &self.collapsed);
        let visible = visible_ids(&self.groups, &self.collapsed);
        self.focused = cursor_on_screen(self.focused, &visible);
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let input = ListTodosInput { filter: Some(self.filter), project_id: self.project_filter, label_id: self.label_filter, ..Default::default() };
        match (self.svc.list_todos(&input), self.svc.list_todo_states(), self.svc.list_todo_projects(), self.svc.list_todo_labels()) {
            (Ok(todos), Ok(states), Ok(projects), Ok(labels)) => {
                self.selected = prune_selection(&self.selected, &todos);
                self.groups = group_todos(&todos, &states);
                self.todo_count = todos.len();
                self.states = states;
                self.projects = projects;
                self.labels = labels;
                self.error = None;
            }
            (Err(e), ..) | (_, Err(e), ..) | (_, _, Err(e), _) | (.., Err(e)) => self.error = Some(e.to_string()),
        }
        self.loading = false;
        self.rebuild();
        self.sync_selects(cx);
        cx.notify();
    }

    fn sync_selects(&mut self, cx: &mut Context<Self>) {
        let mut projects = vec![SelectOption::new("", "Any project", None)];
        projects.extend(self.projects.iter().map(|p| SelectOption::new(p.id.to_string(), &p.name, Some(p.color.clone()))));
        let value = self.project_filter.map(|v| v.to_string()).unwrap_or_default();
        self.project_select.update(cx, |s, cx| s.set_options(projects, &value, cx));
        let mut labels = vec![SelectOption::new("", "Any label", None)];
        labels.extend(self.labels.iter().map(|l| SelectOption::new(l.id.to_string(), &l.name, Some(l.color.clone()))));
        let value = self.label_filter.map(|v| v.to_string()).unwrap_or_default();
        self.label_select.update(cx, |s, cx| s.set_options(labels, &value, cx));
        let states = self.states.iter().map(|s| SelectOption::new(s.id.to_string(), &s.label, Some(s.color.clone()))).collect();
        self.bulk_select.update(cx, |s, cx| s.set_options(states, "", cx));
    }

    fn save_collapsed(&self) {
        let mut ids: Vec<i64> = self.collapsed.iter().copied().collect();
        ids.sort_unstable();
        let json = format!("[{}]", ids.iter().map(i64::to_string).collect::<Vec<_>>().join(","));
        let _ = self.svc.set_setting_value(COLLAPSED_KEY, Some(&json));
    }

    fn toggle_collapsed(&mut self, state_id: i64, cx: &mut Context<Self>) {
        if !self.collapsed.remove(&state_id) {
            self.collapsed.insert(state_id);
        }
        self.save_collapsed();
        self.rebuild();
        cx.notify();
    }

    fn fail(&mut self, e: impl std::fmt::Display) {
        self.error = Some(e.to_string());
    }

    fn update(&mut self, input: UpdateTodoInput, cx: &mut Context<Self>) {
        if let Err(e) = self.svc.update_todo(&input) {
            self.fail(e);
        }
        self.reload(cx);
    }

    fn set_state_of(&mut self, ids: &[i64], state_id: i64) {
        for &id in ids {
            if let Err(e) = self.svc.update_todo(&UpdateTodoInput { id, state_id: Some(state_id), ..Default::default() }) {
                self.fail(e);
                return;
            }
        }
    }

    // ---- Scrolling ----

    fn scroll(&self) -> scrollbar::Scroll {
        scrollbar::keyed(SCROLL_ID, BarStyle::Global)
    }

    /// Brings a row into view, moving no further than needed (or to the middle when `center`).
    fn scroll_to(&self, id: i64, center: bool) {
        let (Some(g), Some(idx)) = (self.geo.get(), self.layout.index_of_row(&self.groups, id)) else { return };
        let top = g.panel_y + 1.0 + self.layout.top_of(idx);
        let scroll = self.scroll();
        let scrolled = -f32::from(scroll.offset().y);
        let max = f32::from(scroll.max_offset().height);
        let target = if center { top - (g.vp_h - ROW_H) / 2.0 } else { scroll_nearest(scrolled, g.vp_h, top, top + ROW_H) };
        scroll.set_offset(point(px(0.0), px(-target.clamp(0.0, max.max(0.0)))));
    }

    /// Where a quick menu hangs for a row: under it, indented past the checkbox. Window coordinates.
    fn row_anchor(&self, id: i64) -> (f32, f32, f32) {
        let (Some(g), Some(idx)) = (self.geo.get(), self.layout.index_of_row(&self.groups, id)) else { return (120.0, 148.0, 160.0) };
        let off = f32::from(self.scroll().offset().y);
        let top = g.vp_top + g.panel_y + 1.0 + self.layout.top_of(idx) + off;
        (top, top + ROW_H, g.panel_x + 1.0 + 56.0)
    }

    // ---- Keyboard ----

    fn dialog_open(&self, cx: &App) -> bool {
        !matches!(self.overlay, Overlay::None) || self.project_select.read(cx).is_open() || self.label_select.read(cx).is_open() || self.bulk_select.read(cx).is_open()
    }

    fn visible(&self) -> Vec<i64> {
        visible_ids(&self.groups, &self.collapsed)
    }

    fn move_focus(&mut self, delta: i32, cx: &mut Context<Self>) {
        let visible = self.visible();
        if let Some(next) = move_focus(&visible, self.focused, delta) {
            self.focused = Some(next);
            self.scroll_to(next, false);
            cx.notify();
        }
    }

    fn open_quick(&mut self, kind: QuickKind, todo_id: i64, window: &mut Window, cx: &mut Context<Self>) {
        let Some(todo) = self.todo(todo_id).cloned() else { return };
        let cfg = quick_config(kind, &todo, &self.states, &self.projects, &self.labels, today());
        let anchor = self.row_anchor(todo_id);
        let menu = cx.new(|cx| QuickMenu::new(kind, todo_id, cfg, anchor, window, cx));
        cx.subscribe_in(&menu, window, Self::on_quick_event).detach();
        self.overlay = Overlay::Quick(menu);
        cx.notify();
    }

    fn close_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.overlay = Overlay::None;
        self.copy = None;
        window.focus(&self.focus);
        cx.notify();
    }

    fn on_quick_event(&mut self, menu: &Entity<QuickMenu>, ev: &QuickEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            QuickEvent::Close => self.close_overlay(window, cx),
            QuickEvent::Pick(value) => {
                let (kind, id) = {
                    let m = menu.read(cx);
                    (m.kind, m.todo_id)
                };
                self.apply_quick(kind, id, value, cx);
                if kind == QuickKind::Label {
                    if let Some(todo) = self.todo(id).cloned() {
                        let cfg = quick_config(kind, &todo, &self.states, &self.projects, &self.labels, today());
                        menu.update(cx, |m, cx| m.set_items(cfg.items, cx));
                    }
                }
            }
        }
    }

    fn apply_quick(&mut self, kind: QuickKind, id: i64, value: &str, cx: &mut Context<Self>) {
        let Some(pick) = resolve_pick(kind, value) else { return };
        let Some(todo) = self.todo(id).cloned() else { return };
        let patch = UpdateTodoInput { id, ..Default::default() };
        match pick {
            QuickPick::State(s) => self.update(UpdateTodoInput { state_id: Some(s), ..patch }, cx),
            QuickPick::Priority(p) => self.update(UpdateTodoInput { priority: Some(p), ..patch }, cx),
            QuickPick::Due(d) => self.update(UpdateTodoInput { due_date: Some(d), ..patch }, cx),
            QuickPick::Project(p) => self.update(UpdateTodoInput { project_id: Some(p), ..patch }, cx),
            QuickPick::NewProject(name) => match self.svc.create_todo_project(&CreateTodoProjectInput { name, color: None }) {
                Ok(p) => self.update(UpdateTodoInput { project_id: Some(Some(p.id)), ..patch }, cx),
                Err(e) => {
                    self.fail(e);
                    self.reload(cx);
                }
            },
            QuickPick::ToggleLabel(l) => self.update(UpdateTodoInput { label_ids: Some(toggled_labels(&todo, l)), ..patch }, cx),
            QuickPick::NewLabel(name) => match self.svc.create_todo_label(&CreateTodoLabelInput { name, color: None }) {
                Ok(l) => self.update(UpdateTodoInput { label_ids: Some(toggled_labels(&todo, l.id)), ..patch }, cx),
                Err(e) => {
                    self.fail(e);
                    self.reload(cx);
                }
            },
        }
    }

    fn pending(&mut self, what: Pending7b) {
        self.pending.push(what);
    }

    fn arm_copy(&mut self, state: CopyState, cx: &mut Context<Self>) {
        self.copy_gen += 1;
        let generation = self.copy_gen;
        self.copy = Some(state);
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(COPY_FEEDBACK_MS)).await;
            let _ = this.update(cx, |p, cx| {
                if p.copy_gen != generation {
                    return;
                }
                let from_menu = p.copy.is_some_and(|c| c.from_menu);
                p.copy = None;
                if from_menu {
                    p.overlay = Overlay::None;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn copy_id(&mut self, id: i64, from_menu: bool, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(format_todo_id(id)));
        self.arm_copy(CopyState { action: CopyAction::Id, failed: false, from_menu }, cx);
    }

    fn copy_prompt(&mut self, todo: &Todo, from_menu: bool, cx: &mut Context<Self>) {
        let parent = todo.parent_id.map(|id| (id, todo.parent_title.clone().unwrap_or_else(|| format_todo_id(id))));
        let children = self.svc.list_todos(&ListTodosInput { parent_id: Some(todo.id), ..Default::default() });
        let state = match children {
            Ok(rows) => {
                let refs: Vec<ChildRef> = rows.iter().map(|r| ChildRef { id: r.id, title: r.title.clone(), state_label: r.state.label.clone(), is_completed: r.state.is_completed }).collect();
                cx.write_to_clipboard(ClipboardItem::new_string(format_agent_prompt(todo, parent, &refs)));
                CopyState { action: CopyAction::Prompt, failed: false, from_menu }
            }
            Err(_) => CopyState { action: CopyAction::Prompt, failed: true, from_menu },
        };
        self.arm_copy(state, cx);
    }

    fn on_key(&mut self, ev: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let k = &ev.keystroke;
        if self.dialog_open(cx) {
            if k.key == "escape" && matches!(self.overlay, Overlay::Action { .. } | Overlay::Shortcuts) {
                self.close_overlay(window, cx);
            } else if matches!(self.overlay, Overlay::Shortcuts) && k.key_char.as_deref() == Some("?") {
                self.close_overlay(window, cx);
            }
            return;
        }
        let m = k.modifiers;
        let cmd = m.control || m.platform;
        let focused = self.focused.and_then(|id| self.todo(id).cloned());

        if cmd && m.shift && k.key == "o" {
            if focused.is_some() {
                self.pending(Pending7b::CreateDialog);
            }
            return;
        }
        if cmd && !m.shift && !m.alt && k.key == "c" {
            if ev.is_held {
                return;
            }
            if let Some(t) = &focused {
                self.copy_id(t.id, false, cx);
            }
            return;
        }
        if cmd || m.alt {
            return;
        }
        match k.key.as_str() {
            "down" => return self.move_focus(1, cx),
            "up" => return self.move_focus(-1, cx),
            "escape" => {
                if !self.selected.is_empty() {
                    self.selected.clear();
                } else {
                    self.focused = None;
                }
                return cx.notify();
            }
            _ => {}
        }
        match k.key_char.as_deref() {
            Some("c") => return self.pending(Pending7b::CreateDialog),
            Some("?") => {
                self.overlay = Overlay::Shortcuts;
                return cx.notify();
            }
            _ => {}
        }
        let Some(todo) = focused else { return };
        match (k.key.as_str(), k.key_char.as_deref()) {
            (_, Some("s")) => self.open_quick(QuickKind::State, todo.id, window, cx),
            (_, Some("p")) => self.open_quick(QuickKind::Priority, todo.id, window, cx),
            (_, Some("d")) => self.open_quick(QuickKind::Due, todo.id, window, cx),
            (_, Some("P")) => self.open_quick(QuickKind::Project, todo.id, window, cx),
            (_, Some("t")) => self.open_quick(QuickKind::Label, todo.id, window, cx),
            (_, Some("l")) => self.pending(Pending7b::ChildPicker(todo.id)),
            (_, Some("L")) => self.pending(Pending7b::ParentPicker(todo.id)),
            (_, Some("C")) if !ev.is_held => self.copy_prompt(&todo, false, cx),
            ("enter", _) => self.pending(Pending7b::DetailPage(todo.id)),
            _ => {}
        }
    }

    fn on_action(&mut self, todo_id: i64, choice: ActionChoice, window: &mut Window, cx: &mut Context<Self>) {
        let Some(todo) = self.todo(todo_id).cloned() else { return self.close_overlay(window, cx) };
        match choice {
            ActionChoice::Close => self.close_overlay(window, cx),
            ActionChoice::Edit => self.pending(Pending7b::DetailPage(todo_id)),
            ActionChoice::CopyId => self.copy_id(todo_id, true, cx),
            ActionChoice::CopyPrompt => self.copy_prompt(&todo, true, cx),
            ActionChoice::Quick(kind) => self.open_quick(kind, todo_id, window, cx),
            ActionChoice::AddSubIssue => self.pending(Pending7b::CreateDialog),
            ActionChoice::LinkChild => self.pending(Pending7b::ChildPicker(todo_id)),
            ActionChoice::SetParent => self.pending(Pending7b::ParentPicker(todo_id)),
            ActionChoice::ClearParent => self.update(UpdateTodoInput { id: todo_id, parent_id: Some(None), ..Default::default() }, cx),
            ActionChoice::SetState(s) => self.update(UpdateTodoInput { id: todo_id, state_id: Some(s), ..Default::default() }, cx),
            ActionChoice::Delete => {
                if let Err(e) = self.svc.delete_todo(todo_id) {
                    self.fail(e);
                }
                self.reload(cx);
            }
        }
    }

    fn toggle_select(&mut self, id: i64, shift: bool, cx: &mut Context<Self>) {
        if shift {
            if let Some(run) = self.anchor.and_then(|a| select_range(&self.visible(), a, id)) {
                self.selected.extend(run);
                self.anchor = Some(id);
                return cx.notify();
            }
        }
        if !self.selected.remove(&id) {
            self.selected.insert(id);
        }
        self.anchor = Some(id);
        cx.notify();
    }

    fn open_row_menu(&mut self, id: i64, at: Point<Pixels>, cx: &mut Context<Self>) {
        self.focused = Some(id);
        let y = f32::from(at.y);
        self.overlay = Overlay::Action { todo_id: id, anchor: (y, y, f32::from(at.x)) };
        cx.notify();
    }

    /// Capture hooks (`--do todos-...`): put the page in a state a screenshot can show.
    pub fn capture(&mut self, op: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (name, arg) = op.split_once(':').unwrap_or((op, ""));
        let nth = |p: &Self, n: &str| n.parse::<usize>().ok().and_then(|i| p.visible().get(i).copied());
        match name {
            "focus" => {
                self.focused = nth(self, arg);
                if let Some(id) = self.focused {
                    self.scroll_to(id, false);
                }
            }
            "menu" => {
                if let Some(id) = nth(self, arg) {
                    let a = self.row_anchor(id);
                    self.focused = Some(id);
                    self.overlay = Overlay::Action { todo_id: id, anchor: (a.0 + 18.0, a.0 + 18.0, a.2 + 240.0) };
                }
            }
            "quick" => {
                let (kind, n) = arg.split_once('@').unwrap_or((arg, "0"));
                let kind = match kind {
                    "state" => QuickKind::State,
                    "priority" => QuickKind::Priority,
                    "due" => QuickKind::Due,
                    "project" => QuickKind::Project,
                    _ => QuickKind::Label,
                };
                if let Some(id) = nth(self, n) {
                    self.focused = Some(id);
                    self.open_quick(kind, id, window, cx);
                }
            }
            "shortcuts" => self.overlay = Overlay::Shortcuts,
            "filter" => {
                self.filter = match arg {
                    "active" => TodoFilter::Active,
                    "done" => TodoFilter::Done,
                    "ai" => TodoFilter::Ai,
                    _ => TodoFilter::All,
                };
                self.reload(cx);
            }
            "project" => {
                self.project_filter = self.projects.first().map(|p| p.id);
                self.reload(cx);
            }
            "select" => {
                for id in self.visible().into_iter().take(arg.parse().unwrap_or(2)) {
                    self.selected.insert(id);
                }
            }
            "collapse" => {
                if let Some(g) = arg.parse::<usize>().ok().and_then(|i| self.groups.get(i)) {
                    let id = g.state.id;
                    self.collapsed.insert(id);
                    self.rebuild();
                }
            }
            "copy" => self.copy_id(self.focused.unwrap_or(0), false, cx),
            _ => {}
        }
        cx.notify();
    }
}

const COLLAPSED_KEY: &str = "ui.todos.collapsedStates";

fn parse_collapsed(json: &str) -> HashSet<i64> {
    json.trim().trim_start_matches('[').trim_end_matches(']').split(',').filter_map(|v| v.trim().parse().ok()).collect()
}

// ---- Rendering ----

fn text_btn_font(d: Div) -> Div {
    d.font_family(UI_FONT).text_size(px(12.0)).line_height(px(16.0))
}

fn dim() -> C {
    hex(0x8b93b8)
}

fn state_dot(color: &str, filled: bool, size: f32, border: f32) -> Div {
    let c = col(parse_color(color));
    let d = div().flex_shrink_0().size(px(size)).rounded(px(size / 2.0)).border(px(border)).border_color(c);
    if filled { d.bg(c) } else { d }
}

fn icon(path: String, w: f32, h: f32, color: C) -> Svg {
    svg().path(SharedString::from(path)).w(px(w)).h(px(h)).flex_shrink_0().text_color(col(color))
}

fn source_icon(todo: &Todo) -> Svg {
    match todo.source {
        TodoSource::User => icon("gen/src-user.svg".into(), 12.0, 12.0, hex(0x565f89)),
        TodoSource::Ai => {
            let (path, color) = icons::ai_glyph(todo.source_label.as_deref());
            let w = if path.ends_with("claude.svg") { 14.84 } else { 12.0 };
            icon(path.into(), w, 12.0, hex(color))
        }
    }
}

impl TodosPage {
    fn row_el(&self, todo: &Todo, last: bool, me: &Entity<Self>, today_iso: &str) -> impl IntoElement {
        let id = todo.id;
        let selected = self.selected.contains(&id);
        let focused = self.focused == Some(id);
        let group = SharedString::from(format!("todo-row-{id}"));
        let overdue = is_overdue(todo, today_iso);

        let mut bg = rgba(0, 0, 0, 0.0);
        let mut hover_bg = rgba(122, 162, 247, 0.06);
        if selected {
            bg = rgba(122, 162, 247, 0.12);
            hover_bg = rgba(122, 162, 247, 0.16);
        }
        if focused {
            bg = rgba(122, 162, 247, 0.14);
            hover_bg = rgba(122, 162, 247, 0.18);
        }
        if let Some((fid, at)) = self.flash {
            if fid == id {
                let t = at.elapsed().as_millis() as f32 / FLASH_MS as f32;
                let alpha = if t < 0.3 { 0.28 } else { 0.28 * (1.0 - (t - 0.3) / 0.7).max(0.0) };
                bg = rgba(122, 162, 247, alpha);
            }
        }

        let (m_check, m_open, m_menu) = (me.clone(), me.clone(), me.clone());
        let check = div()
            .id(SharedString::from(format!("todo-chk-{id}")))
            .flex_shrink_0()
            .size(px(13.0))
            .rounded(px(3.0))
            .border(px(1.0))
            .border_color(col(if selected { TN_BLUE } else { TN_MUTED }))
            .bg(col(if selected { TN_BLUE } else { rgba(12, 13, 24, 0.6) }))
            .cursor_pointer()
            .opacity(if selected || focused { 1.0 } else { 0.0 })
            .group_hover(group.clone(), |s| s.opacity(1.0))
            .hover(|s| s.border_color(col(TN_BLUE)))
            .on_click(move |ev, _, app| {
                let shift = ev.modifiers().shift;
                m_check.update(app, |p, cx| p.toggle_select(id, shift, cx));
                app.stop_propagation();
            })
            .children(selected.then(|| icon("gen/check.svg".into(), 11.0, 11.0, hex(0x1a1b26)).m(px(0.0))));

        let mut body = div()
            .id(SharedString::from(format!("todo-body-{id}")))
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .cursor_pointer()
            .on_click(move |_, _, app| m_open.update(app, |p, _| p.pending(Pending7b::DetailPage(id))))
            .child(icon(icons::priority_path(todo.priority), 13.0, 13.0, priority_color(todo.priority)))
            .child(div().flex_shrink_0().min_w(px(52.0)).text_size(px(11.0)).line_height(px(14.0)).text_color(col(dim())).child(format!("#{id}")))
            .child(state_dot(&todo.state.color, todo.state.is_completed, 11.0, 1.5));
        if let Some(parent) = &todo.parent_title {
            body = body.child(div().flex_shrink().min_w_0().max_w(px(192.0)).truncate().text_size(px(12.0)).line_height(px(16.0)).text_color(col(dim())).child(format!("{parent} \u{203a}")));
        }
        let mut title = div().min_w_0().truncate().text_size(px(12.5)).line_height(px(16.0)).font_weight(FontWeight(500.0));
        title = if todo.state.is_completed { title.text_color(col(dim())).line_through() } else { title.text_color(col(TN_TEXT)) };
        body = body.child(title.child(todo.title.clone()));
        if todo.child_count > 0 {
            let all = todo.completed_child_count >= todo.child_count;
            body = body.child(
                div()
                    .flex_shrink_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(3.0))
                    .pl(px(5.0))
                    .pr(px(7.0))
                    .py(px(1.0))
                    .rounded(px(999.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 134, 180, 0.55)))
                    .text_size(px(10.0))
                    .line_height(px(14.0))
                    .text_color(col(hex(0xa3abc9)))
                    .child(icon(icons::ring_path(todo.completed_child_count, todo.child_count), 12.0, 12.0, if all { TN_GREEN } else { TN_BLUE }))
                    .child(format!("{}/{}", todo.completed_child_count, todo.child_count)),
            );
        }
        if let Some(ms) = &todo.milestone {
            body = body.child(div().flex_shrink().min_w_0().truncate().text_size(px(12.0)).line_height(px(16.0)).text_color(col(dim())).child(format!("\u{203a} {ms}")));
        }
        body = body.child(div().flex_1().min_w(px(8.0)));
        for l in &todo.labels {
            let c = parse_color(&l.color);
            body = body.child(
                div()
                    .flex_shrink_0()
                    .max_w(px(128.0))
                    .truncate()
                    .px(px(8.0))
                    .py(px(2.0))
                    .rounded(px(999.0))
                    .border(px(1.0))
                    .border_color(col(c_alpha(c, 0x55 as f32 / 255.0)))
                    .bg(col(c_alpha(c, 0x1a as f32 / 255.0)))
                    .text_color(col(c))
                    .text_size(px(10.0))
                    .line_height(px(13.0))
                    .font_weight(FontWeight(600.0))
                    .child(l.name.clone()),
            );
        }
        if let Some(p) = &todo.project {
            body = body.child(
                div()
                    .flex_shrink_0()
                    .max_w(px(160.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .pl(px(7.0))
                    .pr(px(9.0))
                    .py(px(2.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 134, 180, 0.55)))
                    .text_color(col(parse_color(&p.color)))
                    .text_size(px(11.0))
                    .line_height(px(14.0))
                    .child(icon("gen/project.svg".into(), 11.0, 11.0, TN_BLUE))
                    .child(div().min_w_0().truncate().child(p.name.clone())),
            );
        }
        body = body.child(source_icon(todo));
        let date = div().flex_shrink_0().min_w(px(56.0)).flex().justify_end().text_size(px(11.5)).line_height(px(15.0));
        body = body.child(if overdue { date.text_color(col(TN_RED)).font_weight(FontWeight(600.0)) } else { date.text_color(col(TN_TEXT_DIM)) }.child(format_day(row_date(todo))));

        let mut row = div()
            .id(SharedString::from(format!("todo-row-el-{id}")))
            .group(group)
            .relative()
            .flex_shrink_0()
            .w_full()
            .h(px(ROW_H))
            .px(px(12.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .bg(col(bg))
            .hover(move |s| s.bg(col(hover_bg)))
            .on_mouse_down(MouseButton::Right, move |ev, _, app| {
                let at = ev.position;
                m_menu.update(app, |p, cx| p.open_row_menu(id, at, cx));
            })
            .child(check)
            .child(body);
        if !last {
            row = row.border_b_1().border_color(col(rgba(41, 46, 66, 0.4)));
        }
        if focused || self.flash.is_some_and(|(f, _)| f == id) {
            row = row.child(div().absolute().top_0().left_0().w(px(2.0)).h_full().bg(col(TN_BLUE)));
        }
        row
    }

    fn band_el(&self, gi: usize, me: &Entity<Self>) -> impl IntoElement {
        let g = &self.groups[gi];
        let collapsed = self.collapsed.contains(&g.state.id);
        let sid = g.state.id;
        let (m_chev, m_add) = (me.clone(), me.clone());
        let mut tri = icon("gen/tri.svg".into(), 8.0, 8.0, dim());
        if !collapsed {
            tri = tri.with_transformation(Transformation::rotate(percentage(0.25)));
        }
        div()
            .id(SharedString::from(format!("todo-band-{sid}")))
            .w_full()
            .h(px(BAND_H))
            .flex_shrink_0()
            .px(px(12.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .bg(col(rgba(26, 29, 51, 0.55)))
            .border_b_1()
            .border_color(col(rgba(41, 46, 66, 0.5)))
            .child(
                div()
                    .id(SharedString::from(format!("todo-chev-{sid}")))
                    .size(px(16.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .on_click(move |_, _, app| m_chev.update(app, |p, cx| p.toggle_collapsed(sid, cx)))
                    .child(tri),
            )
            .child(state_dot(&g.state.color, g.state.is_completed, 11.0, 1.5))
            .child(div().text_size(px(12.0)).line_height(px(16.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(g.state.label.clone()))
            .child(div().text_size(px(11.0)).line_height(px(14.0)).text_color(col(dim())).child(g.items.len().to_string()))
            .child(div().flex_1())
            .child(
                div()
                    .id(SharedString::from(format!("todo-add-{sid}")))
                    .size(px(20.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(4.0))
                    .text_size(px(15.0))
                    .line_height(px(15.0))
                    .text_color(col(dim()))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.12))).text_color(col(TN_TEXT)))
                    .on_click(move |_, _, app| m_add.update(app, |p, _| p.pending(Pending7b::CreateDialog)))
                    .child("+"),
            )
    }

    fn toolbar(&self, me: &Entity<Self>) -> Div {
        let mut tabs = div().flex().flex_row().items_center().gap(px(4.0));
        for (f, label) in FILTERS {
            let on = self.filter == f;
            let m = me.clone();
            let mut t = text_btn_font(div())
                .id(SharedString::from(format!("todo-tab-{label}")))
                .px(px(12.0))
                .py(px(4.0))
                .rounded(px(999.0))
                .border(px(1.0))
                .font_weight(FontWeight(600.0))
                .cursor_pointer()
                .child(label);
            t = if on {
                t.border_color(col(rgba(122, 162, 247, 0.3))).bg(col(rgba(122, 162, 247, 0.14))).text_color(col(TN_TEXT)).hover(|s| s.bg(col(rgba(122, 162, 247, 0.2))))
            } else {
                t.border_color(col(rgba(0, 0, 0, 0.0))).text_color(col(dim())).hover(|s| s.text_color(col(TN_TEXT)).bg(col(rgba(122, 162, 247, 0.07))))
            };
            tabs = tabs.child(t.on_click(move |_, _, app| {
                m.update(app, |p, cx| {
                    p.filter = f;
                    p.reload(cx);
                })
            }));
        }
        let done = self.groups.iter().filter(|g| g.state.is_completed).map(|g| g.items.len()).sum::<usize>();
        let ghost = |id: &'static str, label: String| {
            text_btn_font(div()).id(id).px(px(10.0)).py(px(5.0)).rounded(px(6.0)).border(px(1.0)).border_color(col(hex(0x292e42))).text_color(col(TN_TEXT_DIM)).cursor_pointer().hover(|s| s.text_color(col(TN_TEXT)).border_color(col(hex(0x3b4261)))).child(label)
        };
        let (m_help, m_manage, m_clear, m_new) = (me.clone(), me.clone(), me.clone(), me.clone());
        let mut right = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .child(self.project_select.clone())
            .child(self.label_select.clone())
            .child(ghost("todo-help", "?".into()).w(px(27.0)).px(px(0.0)).flex().justify_center().font_weight(FontWeight(600.0)).on_click(move |_, _, app| {
                m_help.update(app, |p, cx| {
                    p.overlay = Overlay::Shortcuts;
                    cx.notify();
                })
            }))
            .child(ghost("todo-manage", "Manage".into()).on_click(move |_, _, app| m_manage.update(app, |p, _| p.pending(Pending7b::ManageDialog))));
        if done > 0 {
            right = right.child(ghost("todo-clear", format!("Clear {done} done")).on_click(move |_, _, app| {
                m_clear.update(app, |p, cx| {
                    if let Err(e) = p.svc.clear_completed_todos() {
                        p.fail(e);
                    }
                    p.reload(cx);
                })
            }));
        }
        right = right.child(
            text_btn_font(div())
                .id("todo-new")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(7.0))
                .pl(px(12.0))
                .pr(px(10.0))
                .py(px(5.0))
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(col(rgba(122, 162, 247, 0.35)))
                .bg(col(rgba(122, 162, 247, 0.14)))
                .text_color(col(TN_BLUE))
                .font_weight(FontWeight(600.0))
                .cursor_pointer()
                .hover(|s| s.bg(col(rgba(122, 162, 247, 0.22))))
                .on_click(move |_, _, app| m_new.update(app, |p, _| p.pending(Pending7b::CreateDialog)))
                .child("New")
                .child(kbd_cap("c", 10.0, 5.0).text_color(col(TN_TEXT_DIM)).border_color(col(rgba(122, 162, 247, 0.3)))),
        );
        div().flex().flex_row().flex_wrap().items_center().justify_between().gap(px(12.0)).mb(px(14.0)).child(tabs).child(right)
    }

    fn bulk_bar(&self, me: &Entity<Self>, top: f32) -> impl IntoElement {
        let (m_del, m_clear) = (me.clone(), me.clone());
        let bar = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .px(px(12.0))
            .py(px(8.0))
            .rounded(px(10.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.4)))
            .bg(col(rgba(20, 23, 42, 0.9)))
            .backdrop_filter(px(36.0), 1.7)
            .shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }, sh(0.0, 12.0, 32.0, bk(0.35))]))
            .child(text_btn_font(div()).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(format!("{} selected", self.selected.len())))
            .child(self.bulk_select.clone())
            .child(
                text_btn_font(div())
                    .id("todo-bulk-delete")
                    .px(px(10.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(247, 118, 142, 0.3)))
                    .bg(col(rgba(247, 118, 142, 0.12)))
                    .text_color(col(TN_RED))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(247, 118, 142, 0.2))))
                    .on_click(move |_, _, app| {
                        m_del.update(app, |p, cx| {
                            let ids: Vec<i64> = p.selected.iter().copied().collect();
                            for id in ids {
                                if let Err(e) = p.svc.delete_todo(id) {
                                    p.fail(e);
                                    break;
                                }
                            }
                            p.selected.clear();
                            p.reload(cx);
                        })
                    })
                    .child("Delete"),
            )
            .child(
                text_btn_font(div())
                    .id("todo-bulk-clear")
                    .px(px(8.0))
                    .py(px(4.0))
                    .text_color(col(dim()))
                    .cursor_pointer()
                    .hover(|s| s.text_color(col(TN_TEXT)))
                    .on_click(move |_, _, app| {
                        m_clear.update(app, |p, cx| {
                            p.selected.clear();
                            cx.notify();
                        })
                    })
                    .child("Clear"),
            );
        div().absolute().left_0().right_0().top(px(top)).flex().justify_center().child(bar)
    }
}

fn priority_color(priority: i64) -> C {
    match priority {
        1 => hex(0xf7768e),
        2 => hex(0xff9e64),
        3 => hex(0xe0af68),
        4 => hex(0xa3abc9),
        _ => hex(0x8b93b8),
    }
}

impl Render for TodosPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let vp = window.viewport_size();
        let scroll = self.scroll();
        let scrolled_by_capture = CAPTURE_SCROLL.load(std::sync::atomic::Ordering::Relaxed);
        if scrolled_by_capture > 0 {
            scroll.set_offset(point(px(0.0), px(-(scrolled_by_capture as f32))));
        }
        let geo = self.geo.get();
        let fallback = Geo { panel_x: 64.0 + 160.0, panel_y: 100.0, panel_h: 0.0, vp_top: 32.0, vp_h: f32::from(vp.height) - 32.0 };
        let g = geo.unwrap_or(fallback);
        let scrolled = -f32::from(scroll.offset().y);
        let range = self.layout.range(scrolled - g.panel_y, scrolled - g.panel_y + g.vp_h, OVERSCAN);
        let today_iso = iso(today());

        let mut rows = div().flex().flex_col().w_full().child(div().h(px(self.layout.top_of(range.start))).flex_shrink_0());
        for idx in range.clone() {
            match self.layout.items[idx] {
                Flat::Band(gi) => rows = rows.child(self.band_el(gi, &me)),
                Flat::Row(gi, ri) => {
                    let last = ri + 1 == self.groups[gi].items.len();
                    rows = rows.child(self.row_el(&self.groups[gi].items[ri], last, &me, &today_iso));
                }
            }
        }
        let below = (self.layout.height() - self.layout.top_of(range.end)).max(0.0);
        rows = rows.child(div().h(px(below)).flex_shrink_0());

        let measure_scroll = scroll.clone();
        let measured = self.geo.clone();
        let panel_h = self.layout.height() + 2.0;
        let measure = canvas(
            move |bounds, window, _| {
                let vp_b = measure_scroll.bounds();
                let fresh = Geo {
                    panel_x: f32::from(bounds.origin.x),
                    panel_y: f32::from(bounds.origin.y - vp_b.origin.y - measure_scroll.offset().y),
                    panel_h: f32::from(bounds.size.height),
                    vp_top: f32::from(vp_b.origin.y),
                    vp_h: f32::from(vp_b.size.height),
                };
                let moved = measured.get().is_none_or(|o| (o.panel_y - fresh.panel_y).abs() > 0.5 || (o.vp_h - fresh.vp_h).abs() > 0.5 || (o.panel_x - fresh.panel_x).abs() > 0.5);
                measured.set(Some(fresh));
                if moved {
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let panel = div()
            .relative()
            .w_full()
            .h(px(panel_h))
            .rounded(px(12.0))
            .overflow_hidden()
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.1)))
            .bg(col(rgba(15, 17, 34, 0.48)))
            .backdrop_filter(px(24.0), 1.5)
            .shadow(shadows(&[sh(0.0, 4.0, 16.0, bk(0.28))]))
            .child(div().absolute().top_0().left_0().size_full().bg(lin(135.0, wh(0.03), crate::css::TRANSPARENT)))
            .child(div().absolute().top_0().left_0().right_0().h(px(1.0)).bg(col(wh(0.06))))
            .child(measure)
            .child(rows);

        let body: AnyElement = if self.loading {
            div().py(px(24.0)).flex().justify_center().text_size(px(13.0)).text_color(col(TN_TEXT_DIM)).child("Loading...").into_any_element()
        } else if self.groups.is_empty() {
            div().py(px(24.0)).flex().justify_center().text_size(px(13.0)).text_color(col(TN_TEXT_DIM)).child("Nothing here yet.").into_any_element()
        } else {
            panel.into_any_element()
        };

        let mut content = div()
            .mx_auto()
            .w_full()
            .max_w(px(page_max_width(f32::from(vp.width))))
            .px(px(40.0))
            .py(px(32.0))
            .font_family(UI_FONT)
            .child(self.toolbar(&me));
        if let Some(e) = &self.error {
            content = content.child(div().mb(px(12.0)).text_size(px(13.0)).text_color(col(TN_RED)).child(e.clone()));
        }
        content = content.child(body);
        if !self.selected.is_empty() {
            content = content.child(div().h(px(16.0 + BULK_BAR_H)));
        }

        let mut root = div()
            .id("todos-root")
            .relative()
            .flex_1()
            .h_full()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| this.on_key(ev, window, cx)))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    if !this.dialog_open(cx) {
                        window.focus(&this.focus);
                    }
                }),
            )
            .child(div().id(SCROLL_ID).track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(content)))
            .child(scroll.bar());

        if !self.selected.is_empty() {
            // Sticks to the foot of the viewport; under a short list it sits right below it.
            let in_flow = g.panel_y + g.panel_h + 16.0 - scrolled;
            let top = in_flow.min(g.vp_h - 16.0 - BULK_BAR_H);
            root = root.child(self.bulk_bar(&me, top));
        }
        if let Some(c) = self.copy.filter(|c| !c.from_menu) {
            let (text, color) = if c.failed { ("Copy failed", TN_RED) } else if c.action == CopyAction::Id { ("Copied id", TN_TEXT) } else { ("Copied prompt", TN_TEXT) };
            root = root.child(
                div().absolute().right(px(24.0)).bottom(px(24.0)).child(
                    div()
                        .px(px(16.0))
                        .py(px(8.0))
                        .rounded(px(10.0))
                        .border(px(1.0))
                        .border_color(col(rgba(122, 162, 247, 0.15)))
                        .bg(col(rgba(16, 18, 36, 0.5)))
                        .backdrop_filter(px(24.0), 1.5)
                        .shadow(shadows(&[sh(0.0, 12.0, 28.0, bk(0.4))]))
                        .text_size(px(12.5))
                        .line_height(px(16.0))
                        .font_weight(FontWeight(500.0))
                        .text_color(col(color))
                        .child(text),
                ),
            );
        }
        match &self.overlay {
            Overlay::None => {}
            Overlay::Shortcuts => {
                let m = me.clone();
                root = root.child(shortcuts_overlay(window, Rc::new(move |w, a| m.update(a, |p, cx| p.close_overlay(w, cx)))));
            }
            Overlay::Quick(menu) => root = root.child(menu.clone()),
            Overlay::Action { todo_id, anchor } => {
                if let Some(todo) = self.todo(*todo_id) {
                    let id = *todo_id;
                    let m = me.clone();
                    let props = ActionMenuProps { todo, states: &self.states, copy: self.copy.filter(|c| c.from_menu).map(|c| (c.action, c.failed)), prompt_pending: false, anchor: *anchor };
                    root = root.child(action_menu(window, props, Rc::new(move |choice, w, a| m.update(a, |p, cx| p.on_action(id, choice, w, cx)))));
                }
            }
        }
        root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapsed_groups_round_trip_through_the_setting() {
        assert_eq!(parse_collapsed("[3,5, 9]"), HashSet::from([3, 5, 9]));
        assert!(parse_collapsed("[]").is_empty());
        assert!(parse_collapsed("garbage").is_empty());
    }
}
