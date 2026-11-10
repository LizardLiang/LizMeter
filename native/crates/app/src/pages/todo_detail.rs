//! `TodoDetailPage.tsx`: the full-page view of one todo. Every field saves as it changes, so there
//! is no Save button. The title and the notes save 600 ms after the last keystroke and on blur.

use super::todo_attachments::{store_upload, AttachmentsEvent, TodoAttachments};
use super::todo_fields::*;
use super::todos_menus::{backdrop, CopyAction};
use super::todo_picker::{PickerEvent, PickerMode, TodoPicker};
use super::todo_widgets::*;
use super::todos_icons as icons;
use super::todos_logic::*;
use crate::css::{hex, rgba};
use crate::select::SelectEvent;
use crate::ui::*;
use gpui::*;
use lizmeter_core::*;
use lizmeter_services::Services;
use lizmeter_ui::md_editor::{MarkdownEditor, MdEvent, MdMode, MdVariant};
use lizmeter_ui::scrollbar::{self, BarStyle};
use lizmeter_ui::text_input::{FieldStyle, TextArea, TextField, TextFieldEvent, TextInput};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

const SCROLL_ID: &str = "todo-detail";
const DEBOUNCE_MS: u64 = 600;
const COPY_FEEDBACK_MS: u64 = 1200;
const RAIL_W: f32 = 272.0;
const NARROW_AT: f32 = 768.0;

pub enum DetailEvent {
    /// Breadcrumb, Escape, delete, or the todo is gone: back to the list (with the id that was open).
    Back(i64),
    /// Prev/next or a parent or child link: open another todo.
    Navigate(i64),
}

impl EventEmitter<DetailEvent> for TodoDetailPage {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Draft {
    Title,
    Notes,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Picking {
    Parent,
    Child,
}

pub struct TodoDetailPage {
    svc: Arc<Services>,
    todo_id: i64,
    todo: Option<Todo>,
    visible: Vec<i64>,
    states: Vec<TodoState>,
    projects: Vec<TodoProject>,
    labels: Vec<TodoLabel>,
    children: Vec<Todo>,
    title: Entity<TextField>,
    title_prev: String,
    title_committed: String,
    title_gen: u64,
    title_focused: bool,
    notes: Entity<MarkdownEditor>,
    notes_committed: String,
    notes_gen: u64,
    notes_focused: bool,
    attachments: Entity<TodoAttachments>,
    fields: FormFields,
    new_child: Entity<TextField>,
    picker: Option<(Entity<TodoPicker>, Picking)>,
    overflow: bool,
    copy: Option<(CopyAction, bool)>,
    copy_gen: u64,
    error: Option<String>,
    width: Rc<Cell<f32>>,
    focus: FocusHandle,
}

/// Whether `next` is `prev` plus exactly one typed line break: Enter in the title.
pub fn is_enter_press(prev: &str, next: &str) -> bool {
    let breaks = |s: &str| s.chars().filter(|c| *c == '\n' || *c == '\r').count();
    next.len() == prev.len() + 1 && breaks(next) == breaks(prev) + 1
}

/// The notes with an embed appended after a blank line.
pub fn append_embed(notes: &str, markdown: &str) -> String {
    let body = notes.trim_end();
    if body.is_empty() { markdown.to_string() } else { format!("{body}\n\n{markdown}") }
}

/// The stored notes: the trimmed text, or none when it is blank.
pub fn notes_value(text: &str) -> Option<String> {
    let t = text.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// The position text of the step counter: `3 / 12`, or just the count when the todo is not in the list.
pub fn step_label(index: Option<usize>, total: usize) -> String {
    match index {
        Some(i) => format!("{} / {total}", i + 1),
        None => total.to_string(),
    }
}

fn title_style() -> FieldStyle {
    let mut s = crate::controls::field_style(24.0);
    s.line_height = px(31.2);
    s.weight = FontWeight(700.0);
    s
}

impl TodoDetailPage {
    pub fn new(svc: Arc<Services>, todo_id: i64, visible: Vec<i64>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        scrollbar::reset(SCROLL_ID);
        let title = TextArea::new(title_style(), "", window, cx);
        cx.subscribe_in(&title, window, |this, f, ev: &TextFieldEvent, window, cx| match ev {
            TextFieldEvent::Changed => this.on_title_changed(f, window, cx),
            TextFieldEvent::Cancel => this.leave(window, cx),
            TextFieldEvent::Submit => {}
        })
        .detach();
        let title_focus = title.read(cx).focus_handle().clone();
        cx.on_focus(&title_focus, window, |this, _, _| this.title_focused = true).detach();
        cx.on_blur(&title_focus, window, |this, _, cx| {
            this.title_focused = false;
            this.commit(Draft::Title, cx);
        })
        .detach();

        let notes = cx.new(|cx| {
            let mut e = MarkdownEditor::new("", "Add notes\u{2026}", MdVariant::Bare, MdMode::Inline, window, cx);
            e.set_todo_id(Some(todo_id));
            let resolver = svc.image_resolver();
            e.set_image_resolver(Rc::new(move |u| resolver(u)));
            e
        });
        cx.subscribe_in(&notes, window, Self::on_notes_event).detach();
        let notes_focus = notes.read(cx).focus_handle().clone();
        cx.on_focus(&notes_focus, window, |this, _, _| this.notes_focused = true).detach();
        cx.on_blur(&notes_focus, window, |this, _, cx| {
            this.notes_focused = false;
            this.commit(Draft::Notes, cx);
        })
        .detach();

        let attachments = cx.new(|_| TodoAttachments::new(svc.clone(), Some(todo_id)));
        cx.subscribe_in(&attachments, window, |this, _, ev: &AttachmentsEvent, window, cx| {
            let AttachmentsEvent::Insert(md) = ev;
            let next = append_embed(this.notes.read(cx).text(), md);
            this.notes.update(cx, |n, cx| n.set_text(&next, cx));
            this.schedule(Draft::Notes, window, cx);
        })
        .detach();

        let fields = FormFields::new("detail", window, cx);
        let new_child = TextInput::new(crate::controls::field_style(13.0), "Add a sub-issue and press Enter", window, cx);
        cx.subscribe_in(&new_child, window, |this, _, ev: &TextFieldEvent, window, cx| match ev {
            TextFieldEvent::Submit => this.add_child(cx),
            TextFieldEvent::Cancel => this.leave(window, cx),
            TextFieldEvent::Changed => cx.notify(),
        })
        .detach();
        let mut page = Self {
            svc,
            todo_id,
            todo: None,
            visible,
            states: vec![],
            projects: vec![],
            labels: vec![],
            children: vec![],
            title,
            title_prev: String::new(),
            title_committed: String::new(),
            title_gen: 0,
            title_focused: false,
            notes,
            notes_committed: String::new(),
            notes_gen: 0,
            notes_focused: false,
            attachments,
            fields,
            new_child,
            picker: None,
            overflow: false,
            copy: None,
            copy_gen: 0,
            error: None,
            width: Rc::new(Cell::new(0.0)),
            focus: cx.focus_handle(),
        };
        page.wire_fields(window, cx);
        page.reload(cx);
        window.focus(&page.focus);
        page
    }

    /// False when the todo was gone (or unreadable) at the first load.
    pub fn is_loaded(&self) -> bool {
        self.todo.is_some()
    }

    pub fn todo_id(&self) -> i64 {
        self.todo_id
    }

    pub fn set_visible(&mut self, ids: Vec<i64>, cx: &mut Context<Self>) {
        self.visible = ids;
        cx.notify();
    }

    /// True while a picker or a dropdown owns Escape.
    pub fn dialog_open(&self, cx: &App) -> bool {
        self.picker.is_some() || self.overflow || self.fields.any_open(cx)
    }

    // ---- Loading ----

    /// An outside writer changed the todos: show the stored values again.
    pub fn reload_after_outside_write(&mut self, cx: &mut Context<Self>) {
        self.reload(cx);
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let found = self.svc.list_todos(&ListTodosInput { id: Some(self.todo_id), ..Default::default() });
        match (found, self.svc.list_todo_states(), self.svc.list_todo_projects(), self.svc.list_todo_labels()) {
            (Ok(rows), Ok(states), Ok(projects), Ok(labels)) => {
                self.states = states;
                self.projects = projects;
                self.labels = labels;
                match rows.into_iter().find(|t| t.id == self.todo_id) {
                    Some(t) => self.apply(t, cx),
                    None => {
                        self.todo = None;
                        cx.emit(DetailEvent::Back(self.todo_id));
                        return;
                    }
                }
            }
            (Err(e), ..) | (_, Err(e), ..) | (_, _, Err(e), _) | (.., Err(e)) => self.error = Some(e.to_string()),
        }
        self.children = self.svc.list_todos(&ListTodosInput { parent_id: Some(self.todo_id), ..Default::default() }).unwrap_or_default();
        self.attachments.update(cx, |a, _| a.reload());
        cx.notify();
    }

    /// Shows `todo` in every field. A field being edited, or holding an unsaved edit, keeps its draft.
    fn apply(&mut self, todo: Todo, cx: &mut Context<Self>) {
        let title_dirty = self.title.read(cx).text() != self.title_committed;
        if !self.title_focused && !title_dirty {
            self.title.update(cx, |f, cx| f.set_text(&todo.title, cx));
            self.title_prev = todo.title.clone();
            self.title_committed = todo.title.clone();
        }
        let notes_text = todo.notes.clone().unwrap_or_default();
        let notes_dirty = self.notes.read(cx).text() != self.notes_committed;
        if !self.notes_focused && !notes_dirty {
            self.notes.update(cx, |n, cx| n.set_text(&notes_text, cx));
            self.notes_committed = notes_text;
        }
        self.fields.set_states(&self.states, todo.state.id, cx);
        self.fields.set_priority(todo.priority, cx);
        let project = todo.project.as_ref().map(|p| p.name.clone()).unwrap_or_default();
        self.fields.project.update(cx, |c, cx| c.set_text(&project, cx));
        self.fields.milestone.update(cx, |c, cx| c.set_text(todo.milestone.as_deref().unwrap_or(""), cx));
        self.fields.start.update(cx, |d, cx| d.set_value(todo.start_date.as_deref().unwrap_or(""), cx));
        self.fields.due.update(cx, |d, cx| d.set_value(todo.due_date.as_deref().unwrap_or(""), cx));
        let milestones = self.svc.list_todo_milestones().unwrap_or_default();
        let free_labels: Vec<String> = self.labels.iter().map(|l| l.name.clone()).filter(|n| !todo.labels.iter().any(|p| p.name.eq_ignore_ascii_case(n))).collect();
        self.fields.set_suggestions(&self.projects, &free_labels, &milestones, cx);
        self.todo = Some(todo);
    }

    fn wire_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.subscribe_in(&self.fields.state, window, |this, _, ev: &SelectEvent, _, cx| {
            if let SelectEvent::Change(v) = ev {
                if let Ok(id) = v.parse() {
                    this.write(UpdateTodoInput { id: this.todo_id, state_id: Some(id), ..Default::default() }, cx);
                }
            }
        })
        .detach();
        cx.subscribe_in(&self.fields.priority, window, |this, _, ev: &SelectEvent, _, cx| {
            if let SelectEvent::Change(v) = ev {
                if let Ok(p) = v.parse() {
                    this.write(UpdateTodoInput { id: this.todo_id, priority: Some(p), ..Default::default() }, cx);
                }
            }
        })
        .detach();
        cx.subscribe_in(&self.fields.project, window, |this, _, ev: &ComboEvent, window, cx| match ev {
            ComboEvent::Commit(t) | ComboEvent::Blur(t) => this.commit_project(t, cx),
            ComboEvent::Cancel => this.leave(window, cx),
            ComboEvent::Changed(_) => {}
        })
        .detach();
        cx.subscribe_in(&self.fields.label, window, |this, _, ev: &ComboEvent, window, cx| match ev {
            ComboEvent::Commit(t) | ComboEvent::Blur(t) => this.commit_label(t, cx),
            ComboEvent::Cancel => this.leave(window, cx),
            ComboEvent::Changed(_) => {}
        })
        .detach();
        cx.subscribe_in(&self.fields.milestone, window, |this, _, ev: &ComboEvent, window, cx| match ev {
            ComboEvent::Commit(t) | ComboEvent::Blur(t) => this.commit_milestone(t, cx),
            ComboEvent::Cancel => this.leave(window, cx),
            ComboEvent::Changed(_) => {}
        })
        .detach();
        cx.subscribe_in(&self.fields.start, window, |this, _, ev: &DateEvent, _, cx| {
            let DateEvent::Change(v) = ev;
            this.write(UpdateTodoInput { id: this.todo_id, start_date: Some(non_blank(v)), ..Default::default() }, cx);
        })
        .detach();
        cx.subscribe_in(&self.fields.due, window, |this, _, ev: &DateEvent, _, cx| {
            let DateEvent::Change(v) = ev;
            this.write(UpdateTodoInput { id: this.todo_id, due_date: Some(non_blank(v)), ..Default::default() }, cx);
        })
        .detach();
    }

    // ---- Writes ----

    /// Saves `patch` and shows what came back; a failure stays on the page.
    fn write(&mut self, patch: UpdateTodoInput, cx: &mut Context<Self>) -> bool {
        match self.svc.update_todo(&patch) {
            Ok(_) => {
                self.error = None;
                self.reload(cx);
                true
            }
            Err(e) => {
                self.error = Some(e.to_string());
                self.reload(cx);
                false
            }
        }
    }

    fn on_title_changed(&mut self, f: &Entity<TextField>, window: &mut Window, cx: &mut Context<Self>) {
        let text = f.read(cx).text().to_string();
        let enter = is_enter_press(&self.title_prev, &text);
        let cleaned = collapse_line_breaks(&text);
        if cleaned != text {
            f.update(cx, |f, cx| f.set_text(&cleaned, cx));
        }
        self.title_prev = cleaned;
        if enter {
            self.commit(Draft::Title, cx);
            let notes = self.notes.clone();
            notes.update(cx, |n, cx| n.focus_start(window, cx));
            return;
        }
        self.schedule(Draft::Title, window, cx);
        cx.notify();
    }

    fn on_notes_event(&mut self, _: &Entity<MarkdownEditor>, ev: &MdEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            MdEvent::Changed(_) => self.schedule(Draft::Notes, window, cx),
            MdEvent::Escape => self.leave(window, cx),
            MdEvent::Attach(req) => {
                let result = store_upload(&self.svc, self.todo_id, req);
                let (insert, failed) = match result {
                    Ok(md) => (md, None),
                    Err(e) => (String::new(), Some(e)),
                };
                self.notes.update(cx, |n, cx| n.settle_upload(req.upload, &insert, cx));
                self.error = failed;
                self.attachments.update(cx, |a, _| a.reload());
                cx.notify();
            }
            _ => {}
        }
    }

    /// Writes a draft 600 ms after the last change to it.
    fn schedule(&mut self, which: Draft, window: &mut Window, cx: &mut Context<Self>) {
        let gen = match which {
            Draft::Title => &mut self.title_gen,
            Draft::Notes => &mut self.notes_gen,
        };
        *gen += 1;
        let mine = *gen;
        cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(DEBOUNCE_MS)).await;
            let _ = this.update(cx, |t, cx| {
                let current = match which {
                    Draft::Title => t.title_gen,
                    Draft::Notes => t.notes_gen,
                };
                if current == mine {
                    t.commit(which, cx);
                }
            });
        })
        .detach();
    }

    /// Writes a draft now, when it differs from what is saved.
    fn commit(&mut self, which: Draft, cx: &mut Context<Self>) {
        match which {
            Draft::Title => {
                let value = self.title.read(cx).text().to_string();
                let trimmed = value.trim().to_string();
                if value == self.title_committed {
                    return;
                }
                if trimmed.is_empty() {
                    let saved = self.title_committed.clone();
                    self.title.update(cx, |f, cx| f.set_text(&saved, cx));
                    self.title_prev = saved;
                    return;
                }
                let previous = std::mem::replace(&mut self.title_committed, value);
                if !self.write_quiet(UpdateTodoInput { id: self.todo_id, title: Some(trimmed), ..Default::default() }) {
                    self.title_committed = previous;
                }
            }
            Draft::Notes => {
                let value = self.notes.read(cx).text().to_string();
                if value == self.notes_committed {
                    return;
                }
                let previous = std::mem::replace(&mut self.notes_committed, value.clone());
                if !self.write_quiet(UpdateTodoInput { id: self.todo_id, notes: Some(notes_value(&value)), ..Default::default() }) {
                    self.notes_committed = previous;
                }
            }
        }
        cx.notify();
    }

    /// A write that leaves the other fields alone (they may hold a draft).
    fn write_quiet(&mut self, patch: UpdateTodoInput) -> bool {
        match self.svc.update_todo(&patch) {
            Ok(t) => {
                self.error = None;
                self.todo = Some(t);
                true
            }
            Err(e) => {
                self.error = Some(e.to_string());
                false
            }
        }
    }

    /// Saves anything typed but not yet written.
    pub fn flush(&mut self, cx: &mut Context<Self>) {
        self.commit(Draft::Title, cx);
        self.commit(Draft::Notes, cx);
    }

    fn leave(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        self.flush(cx);
        cx.emit(DetailEvent::Back(self.todo_id));
    }

    fn go(&mut self, id: i64, cx: &mut Context<Self>) {
        self.flush(cx);
        cx.emit(DetailEvent::Navigate(id));
    }

    fn commit_project(&mut self, value: &str, cx: &mut Context<Self>) {
        let Some(todo) = self.todo.clone() else { return };
        let name = value.trim();
        if name == todo.project.as_ref().map(|p| p.name.as_str()).unwrap_or("") {
            return;
        }
        if name.is_empty() {
            self.write(UpdateTodoInput { id: todo.id, project_id: Some(None), ..Default::default() }, cx);
            return;
        }
        let id = match self.projects.iter().find(|p| p.name.eq_ignore_ascii_case(name)) {
            Some(p) => p.id,
            None => match self.svc.create_todo_project(&CreateTodoProjectInput { name: name.to_string(), color: None }) {
                Ok(p) => p.id,
                Err(e) => {
                    self.error = Some(e.to_string());
                    return self.reload(cx);
                }
            },
        };
        self.write(UpdateTodoInput { id: todo.id, project_id: Some(Some(id)), ..Default::default() }, cx);
    }

    fn commit_milestone(&mut self, value: &str, cx: &mut Context<Self>) {
        let Some(todo) = self.todo.clone() else { return };
        let name = value.trim();
        if name == todo.milestone.as_deref().unwrap_or("") {
            return;
        }
        self.write(UpdateTodoInput { id: todo.id, milestone: Some(non_blank(name)), ..Default::default() }, cx);
    }

    fn commit_label(&mut self, value: &str, cx: &mut Context<Self>) {
        let Some(todo) = self.todo.clone() else { return };
        let name = value.trim();
        if name.is_empty() {
            return;
        }
        let id = match self.labels.iter().find(|l| l.name.eq_ignore_ascii_case(name)) {
            Some(l) => l.id,
            None => match self.svc.create_todo_label(&CreateTodoLabelInput { name: name.to_string(), color: None }) {
                Ok(l) => l.id,
                Err(e) => {
                    self.error = Some(e.to_string());
                    return self.reload(cx);
                }
            },
        };
        if !todo.labels.iter().any(|l| l.id == id) {
            self.write(UpdateTodoInput { id: todo.id, label_ids: Some(toggled_labels(&todo, id)), ..Default::default() }, cx);
        }
        self.fields.label.update(cx, |c, cx| c.set_text("", cx));
    }

    fn remove_label(&mut self, label_id: i64, cx: &mut Context<Self>) {
        if let Some(todo) = self.todo.clone() {
            self.write(UpdateTodoInput { id: todo.id, label_ids: Some(toggled_labels(&todo, label_id)), ..Default::default() }, cx);
        }
    }

    fn add_child(&mut self, cx: &mut Context<Self>) {
        let title = self.new_child.read(cx).text().trim().to_string();
        if title.is_empty() {
            return;
        }
        match self.svc.create_todo(&CreateTodoInput { title, parent_id: Some(self.todo_id), source: Some(TodoSource::User), ..Default::default() }) {
            Ok(_) => {
                self.error = None;
                self.new_child.update(cx, |f, cx| f.set_text("", cx));
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        self.reload(cx);
    }

    fn unlink_child(&mut self, child: i64, cx: &mut Context<Self>) {
        self.write(UpdateTodoInput { id: child, parent_id: Some(None), ..Default::default() }, cx);
    }

    fn delete(&mut self, cx: &mut Context<Self>) {
        match self.svc.delete_todo(self.todo_id) {
            Ok(()) => cx.emit(DetailEvent::Back(self.todo_id)),
            Err(e) => {
                self.error = Some(e.to_string());
                self.overflow = false;
                cx.notify();
            }
        }
    }

    fn open_picker(&mut self, what: Picking, window: &mut Window, cx: &mut Context<Self>) {
        let Some(todo) = self.todo.clone() else { return };
        let (heading, mode) = match what {
            Picking::Parent => ("Nest this todo under".to_string(), PickerMode::Parent { todo: Some(todo.id), current_parent: todo.parent_id }),
            Picking::Child => (format!("Add an existing todo as a sub-issue of #{} {}", todo.id, todo.title), PickerMode::Child { todo: todo.id }),
        };
        let picker = cx.new(|cx| TodoPicker::new(&self.svc, heading, mode, window, cx));
        cx.subscribe_in(&picker, window, move |this, _, ev: &PickerEvent, window, cx| {
            if let PickerEvent::Pick(t) = ev {
                let patch = match what {
                    Picking::Parent => UpdateTodoInput { id: this.todo_id, parent_id: Some(Some(t.id)), ..Default::default() },
                    Picking::Child => UpdateTodoInput { id: t.id, parent_id: Some(Some(this.todo_id)), ..Default::default() },
                };
                this.write(patch, cx);
            }
            this.picker = None;
            window.focus(&this.focus);
            cx.notify();
        })
        .detach();
        self.picker = Some((picker, what));
        cx.notify();
    }

    fn copy_feedback(&mut self, action: CopyAction, failed: bool, cx: &mut Context<Self>) {
        self.copy = Some((action, failed));
        self.copy_gen += 1;
        let mine = self.copy_gen;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(COPY_FEEDBACK_MS)).await;
            let _ = this.update(cx, |t, cx| {
                if t.copy_gen == mine {
                    t.copy = None;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn copy_id(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(format_todo_id(self.todo_id)));
        self.copy_feedback(CopyAction::Id, false, cx);
    }

    fn copy_prompt(&mut self, cx: &mut Context<Self>) {
        let Some(todo) = self.todo.clone() else { return };
        let parent = todo.parent_id.map(|id| (id, todo.parent_title.clone().unwrap_or_else(|| format_todo_id(id))));
        match self.svc.list_todos(&ListTodosInput { parent_id: Some(todo.id), ..Default::default() }) {
            Ok(rows) => {
                let refs: Vec<ChildRef> = rows.iter().map(|r| ChildRef { id: r.id, title: r.title.clone(), state_label: r.state.label.clone(), is_completed: r.state.is_completed }).collect();
                cx.write_to_clipboard(ClipboardItem::new_string(format_agent_prompt(&todo, parent, &refs)));
                self.copy_feedback(CopyAction::Prompt, false, cx);
            }
            Err(_) => self.copy_feedback(CopyAction::Prompt, true, cx),
        }
    }

    fn step(&mut self, delta: i32, cx: &mut Context<Self>) {
        let Some(at) = self.visible.iter().position(|id| *id == self.todo_id) else { return };
        let next = at as i32 + delta;
        if next >= 0 {
            if let Some(id) = self.visible.get(next as usize).copied() {
                self.go(id, cx);
            }
        }
    }

    /// Capture hooks (`--do todo-detail-...`): put the page in a state a screenshot can show.
    pub fn capture(&mut self, op: &str, window: &mut Window, cx: &mut Context<Self>) {
        let (name, arg) = op.split_once(':').unwrap_or((op, ""));
        match name {
            "overflow" => self.overflow = true,
            "parent-picker" => self.open_picker(Picking::Parent, window, cx),
            "child-picker" => self.open_picker(Picking::Child, window, cx),
            "start" => self.fields.start.update(cx, |d, cx| d.open_panel(window, cx)),
            "state" => self.fields.state.update(cx, |s, cx| s.open_list(window, cx)),
            "title" => {
                let t = arg.to_string();
                self.title.update(cx, |f, cx| f.set_text(&t, cx));
                self.commit(Draft::Title, cx);
            }
            "notes" => {
                let t = arg.replace("\\n", "\n");
                self.notes.update(cx, |n, cx| n.set_text(&t, cx));
                self.commit(Draft::Notes, cx);
            }
            "child" => {
                let t = arg.to_string();
                self.new_child.update(cx, |f, cx| f.set_text(&t, cx));
                self.add_child(cx);
            }
            "link-child" => {
                if let Ok(id) = arg.parse() {
                    self.write(UpdateTodoInput { id, parent_id: Some(Some(self.todo_id)), ..Default::default() }, cx);
                }
            }
            "set-parent" => {
                if let Ok(id) = arg.parse() {
                    self.write(UpdateTodoInput { id: self.todo_id, parent_id: Some(Some(id)), ..Default::default() }, cx);
                }
            }
            "unparent" => drop(self.write(UpdateTodoInput { id: self.todo_id, parent_id: Some(None), ..Default::default() }, cx)),
            "state-id" => {
                if let Ok(id) = arg.parse() {
                    self.write(UpdateTodoInput { id: self.todo_id, state_id: Some(id), ..Default::default() }, cx);
                }
            }
            "label" => self.commit_label(arg, cx),
            "project-set" => self.commit_project(arg, cx),
            "milestone-set" => self.commit_milestone(arg, cx),
            "due" => drop(self.write(UpdateTodoInput { id: self.todo_id, due_date: Some(non_blank(arg)), ..Default::default() }, cx)),
            "attach" => {
                let req = lizmeter_ui::md_editor::AttachRequest { upload: 0, name: arg.rsplit(['\\', '/']).next().unwrap_or(arg).to_string(), source: lizmeter_ui::md_editor::FileSource::Path(arg.into()) };
                self.error = store_upload(&self.svc, self.todo_id, &req).err();
                self.reload(cx);
            }
            _ => {}
        }
        cx.notify();
    }
}

fn non_blank(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

// ---- Rendering ----

fn section_label(text: &str) -> Div {
    ui_text(11.0).h(px(14.4)).flex_shrink_0().line_height(px(14.4)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(spaced(&text.to_uppercase(), 1.32))
}

/// The column of a rail field: its label, then the control.
fn rail_field(label: &str, child: impl IntoElement) -> Div {
    div().flex().flex_col().min_w_0().child(div().h(px(20.0)).flex_shrink_0().pt(px(4.4)).child(section_label(label))).child(child)
}

fn icon_text_button(id: &'static str, glyph: &'static str, enabled: bool) -> Stateful<Div> {
    let b = div().id(id).px(px(8.0)).py(px(2.0)).rounded(px(4.0)).text_size(px(16.0)).line_height(px(16.0)).text_color(col(hex(0x7a8194))).child(glyph);
    if enabled { b.cursor_pointer().hover(|s| s.text_color(col(TN_TEXT))) } else { b.opacity(0.35) }
}

impl TodoDetailPage {
    fn breadcrumb(&self, todo: &Todo, me: &Entity<Self>, window: &Window) -> Div {
        let index = self.visible.iter().position(|id| *id == todo.id);
        let (m_back, m_prev, m_next, m_more) = (me.clone(), me.clone(), me.clone(), me.clone());
        let can_prev = index.is_some_and(|i| i > 0);
        let can_next = index.is_some_and(|i| i + 1 < self.visible.len());
        let mut prev = icon_text_button("detail-prev", "\u{2039}", can_prev);
        if can_prev {
            prev = prev.on_click(move |_, _, a| m_prev.update(a, |p, cx| p.step(-1, cx)));
        }
        let mut next = icon_text_button("detail-next", "\u{203a}", can_next);
        if can_next {
            next = next.on_click(move |_, _, a| m_next.update(a, |p, cx| p.step(1, cx)));
        }
        let more = icon_text_button("detail-more", "\u{2026}", true).on_click(move |_, _, a| {
            m_more.update(a, |p, cx| {
                p.overflow = !p.overflow;
                cx.notify();
            })
        });
        let mut more_wrap = div().relative().child(more);
        if self.overflow {
            more_wrap = more_wrap.child(deferred(self.overflow_menu(todo, me, window)).with_priority(7));
        }
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .mb(px(20.0))
            .pb(px(14.0))
            .border_b_1()
            .border_color(col(rgba(86, 95, 137, 0.22)))
            .child(
                div()
                    .id("detail-crumb-todos")
                    .px(px(4.0))
                    .py(px(2.0))
                    .rounded(px(4.0))
                    .text_size(px(13.0))
                    .line_height(px(17.0))
                    .text_color(col(dim()))
                    .cursor_pointer()
                    .hover(|s| s.text_color(col(TN_TEXT)))
                    .on_click(move |_, w, a| m_back.update(a, |p, cx| p.leave(w, cx)))
                    .child("Todos"),
            )
            .child(div().text_size(px(13.0)).text_color(col(faint())).child("/"))
            .child(div().flex_1().min_w_0().truncate().text_size(px(13.0)).line_height(px(17.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(format!("#{} {}", todo.id, todo.title)))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .flex_shrink_0()
                    .child(div().mr(px(4.0)).text_size(px(11.0)).text_color(col(dim())).child(step_label(index, self.visible.len())))
                    .child(prev)
                    .child(next)
                    .child(more_wrap),
            )
    }

    fn overflow_menu(&self, todo: &Todo, me: &Entity<Self>, window: &Window) -> impl IntoElement {
        let item = |id: &'static str, label: String, color: crate::css::C, hover: crate::css::C| {
            div()
                .id(id)
                .w_full()
                .px(px(10.0))
                .py(px(7.0))
                .rounded(px(6.0))
                .text_size(px(12.0))
                .line_height(px(16.0))
                .text_color(col(color))
                .cursor_pointer()
                .hover(move |s| s.bg(col(hover)))
                .child(label)
        };
        let label = |action: CopyAction, base: &str, copy: Option<(CopyAction, bool)>| match copy {
            Some((a, failed)) if a == action => (if failed { "Copy failed" } else { "Copied \u{2713}" }.to_string(), failed),
            _ => (base.to_string(), false),
        };
        let neutral = rgba(122, 162, 247, 0.12);
        let red_bg = rgba(247, 118, 142, 0.12);
        let (id_text, id_failed) = label(CopyAction::Id, "Copy id", self.copy);
        let (pr_text, pr_failed) = label(CopyAction::Prompt, "Copy agent prompt", self.copy);
        let (m_id, m_pr, m_del, m_close) = (me.clone(), me.clone(), me.clone(), me.clone());
        let menu = div()
            .id("detail-overflow-menu")
            .absolute()
            .top_full()
            .mt(px(4.0))
            .right_0()
            .min_w(px(144.0))
            .p(px(4.0))
            .rounded(px(10.0))
            .border(px(1.0))
            .border_color(col(rgba(86, 95, 137, 0.3)))
            .bg(col(rgba(14, 16, 30, 0.92)))
            .backdrop_filter(px(28.0), 1.6)
            .shadow(shadows(&[sh(0.0, 12.0, 28.0, bk(0.35))]))
            .occlude()
            .flex()
            .flex_col()
            .child(item("detail-copy-id", id_text, if id_failed { TN_RED } else { TN_TEXT }, if id_failed { red_bg } else { neutral }).on_click(move |_, _, a| m_id.update(a, |p, cx| p.copy_id(cx))))
            .child(item("detail-copy-prompt", pr_text, if pr_failed { TN_RED } else { TN_TEXT }, if pr_failed { red_bg } else { neutral }).on_click(move |_, _, a| m_pr.update(a, |p, cx| p.copy_prompt(cx))))
            .child(div().h(px(1.0)).mx(px(2.0)).my(px(4.0)).bg(col(rgba(86, 95, 137, 0.25))))
            .child(item("detail-delete", "Delete".into(), TN_RED, red_bg).on_click(move |_, _, a| m_del.update(a, |p, cx| p.delete(cx))));
        let _ = (todo, window, m_close);
        menu
    }

    fn main_header(&self, todo: &Todo, me: &Entity<Self>) -> Div {
        let focused = self.title_focused;
        let _ = focused;
        let mut meta = div().flex().flex_row().items_center().gap(px(10.0)).mb(px(18.0)).min_h(px(26.0));
        let m_pick = me.clone();
        meta = match todo.parent_id {
            None => meta.child(link_button("detail-set-parent", "+ Set parent").on_click(move |_, w, a| m_pick.update(a, |p, cx| p.open_picker(Picking::Parent, w, cx)))),
            Some(pid) => {
                let (m_go, m_change, m_clear) = (me.clone(), me.clone(), me.clone());
                let text = format!("Sub-issue of {}", todo.parent_title.clone().unwrap_or_else(|| format_todo_id(pid)));
                meta.child(
                    chip_frame()
                        .child(parent_chip("detail-parent", pid, text, 384.0, move |_, a| m_go.update(a, |p, cx| p.go(pid, cx))))
                        .child(
                            div()
                                .id("detail-change-parent")
                                .px(px(7.0))
                                .py(px(3.0))
                                .border_l_1()
                                .border_color(col(rgba(122, 162, 247, 0.28)))
                                .text_size(px(12.0))
                                .line_height(px(12.0))
                                .text_color(col(hex(0xa3abc9)))
                                .cursor_pointer()
                                .hover(|s| s.text_color(col(TN_BLUE)))
                                .on_click(move |_, w, a| m_change.update(a, |p, cx| p.open_picker(Picking::Parent, w, cx)))
                                .child("\u{21c6}"),
                        )
                        .child(clear_x("detail-clear-parent").on_click(move |_, _, a| m_clear.update(a, |p, cx| drop(p.write(UpdateTodoInput { id: p.todo_id, parent_id: Some(None), ..Default::default() }, cx))))),
                )
            }
        };
        if todo.child_count > 0 {
            let all = todo.completed_child_count >= todo.child_count;
            meta = meta.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .text_size(px(11.0))
                    .text_color(col(dim()))
                    .child(svg().path(SharedString::from(icons::ring_path(todo.completed_child_count, todo.child_count))).w(px(14.0)).h(px(14.0)).flex_shrink_0().text_color(col(if all { TN_GREEN } else { TN_BLUE })))
                    .child(format!("{}/{}", todo.completed_child_count, todo.child_count)),
            );
        }
        div().min_w_0().child(div().w_full().mb(px(10.0)).py(px(4.0)).child(self.title.clone())).child(meta)
    }

    fn rail(&self, todo: &Todo, me: &Entity<Self>, inner: f32, narrow: bool) -> Div {
        let mut chips = label_row();
        for l in &todo.labels {
            let (m, id) = (me.clone(), l.id);
            chips = chips.child(label_chip(SharedString::from(format!("detail-label-x-{id}")), &l.name, Some(&l.color), move |_, a| m.update(a, |p, cx| p.remove_label(id, cx))));
        }
        chips = chips.child(div().flex_1().min_w(px(90.0)).child(self.fields.label.clone()));
        let items = vec![
            (false, rail_field("State", self.fields.state.clone()).into_any_element()),
            (false, rail_field("Priority", self.fields.priority.clone()).into_any_element()),
            (false, rail_field("Project", self.fields.project.clone()).into_any_element()),
            (true, rail_field("Labels", chips).into_any_element()),
            (false, rail_field("Milestone", self.fields.milestone.clone()).into_any_element()),
            (false, rail_field("Start", self.fields.start.clone()).into_any_element()),
            (false, rail_field("Due", self.fields.due.clone()).into_any_element()),
        ];
        let body = if narrow {
            grid_of(items, inner, 160.0, 14.0)
        } else {
            div().flex().flex_col().gap(px(14.0)).children(items.into_iter().map(|(_, el)| el))
        };
        let _ = (todo, me);
        div()
            .relative()
            .rounded(px(14.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.12)))
            .bg(col(rgba(16, 18, 36, 0.5)))
            .backdrop_filter(px(24.0), 1.5)
            .shadow(shadows(&[sh(0.0, 8.0, 24.0, bk(0.22))]))
            .p(px(16.0))
            .child(body)
    }

    fn sub_issues(&self, todo: &Todo, me: &Entity<Self>, window: &Window, cx: &App) -> Div {
        let (m_link, m_add) = (me.clone(), me.clone());
        let count = if self.children.is_empty() { String::new() } else { format!(" ({})", self.children.len()) };
        let header = div().flex().flex_row().items_center().justify_between().mb(px(8.0)).child(section_label(&format!("Sub-issues{count}"))).child(link_button("detail-link-child", "Link existing").on_click(move |_, w, a| m_link.update(a, |p, cx| p.open_picker(Picking::Child, w, cx))));
        let mut section = div().mt(px(20.0)).pt(px(16.0)).border_t_1().border_color(col(rgba(86, 95, 137, 0.22))).child(header);
        if !self.children.is_empty() {
            let mut list = div().flex().flex_col().mb(px(8.0));
            for c in &self.children {
                let (m_go, m_x) = (me.clone(), me.clone());
                let (cid, done) = (c.id, c.state.is_completed);
                let title = div().flex_1().min_w_0().truncate().text_color(col(if done { dim() } else { TN_TEXT_DIM })).child(c.title.clone());
                let title = if done { title.line_through() } else { title };
                list = list.child(
                    div()
                        .id(SharedString::from(format!("detail-child-{cid}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .pl(px(8.0))
                        .pr(px(4.0))
                        .py(px(6.0))
                        .rounded(px(7.0))
                        .text_size(px(13.0))
                        .line_height(px(17.0))
                        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.07))))
                        .child(
                            div()
                                .id(SharedString::from(format!("detail-child-go-{cid}")))
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.0))
                                .cursor_pointer()
                                .on_click(move |_, _, a| m_go.update(a, |p, cx| p.go(cid, cx)))
                                .child(id_chip_text(cid))
                                .child(dot(&c.state.color, done, 9.0, 1.5))
                                .child(title)
                                .child(div().flex_shrink_0().text_size(px(11.0)).text_color(col(dim())).child(c.state.label.clone())),
                        )
                        .child(clear_x(SharedString::from(format!("detail-child-x-{cid}"))).on_click(move |_, _, a| m_x.update(a, |p, cx| p.unlink_child(cid, cx)))),
                );
            }
            section = section.child(list);
        }
        let focused = self.new_child.read(cx).focus_handle().is_focused(window);
        let enabled = !self.new_child.read(cx).text().trim().is_empty();
        let mut add = div().id("detail-add-child").flex_shrink_0().px(px(14.0)).py(px(8.0)).rounded(px(8.0)).border(px(1.0)).border_color(col(hex(0x292e42))).font_family(BTN_FONT).text_size(px(13.0)).line_height(px(16.0)).text_color(col(TN_TEXT_DIM)).child("Add");
        add = if enabled { add.cursor_pointer().hover(|s| s.text_color(col(TN_TEXT)).border_color(col(hex(0x3b4261)))).on_click(move |_, _, a| m_add.update(a, |p, cx| p.add_child(cx))) } else { add.opacity(0.4) };
        let _ = todo;
        section.child(div().flex().flex_row().items_center().gap(px(8.0)).child(div().flex_1().child(crate::controls::glass_field(&self.new_child, focused, 12.0, 9.0))).child(add))
    }

    fn main_body(&self, todo: &Todo, me: &Entity<Self>, window: &Window, cx: &App) -> Div {
        let mut footer = format!("Created {}", crate::fmt::format_date(&todo.created_at));
        if let Some(done) = &todo.completed_at {
            footer.push_str(&format!(" \u{b7} Completed {}", crate::fmt::format_date(done)));
        }
        let by = match todo.source {
            TodoSource::User => "you".to_string(),
            TodoSource::Ai => todo.source_label.clone().unwrap_or_else(|| "AI".into()),
        };
        footer.push_str(&format!(" \u{b7} added by {by}"));
        div()
            .min_w_0()
            .child(div().mb(px(14.0)).child(self.notes.clone()))
            .child(self.attachments.clone())
            .child(self.sub_issues(todo, me, window, cx))
            .child(div().mt(px(24.0)).pt(px(14.0)).border_t_1().border_color(col(rgba(86, 95, 137, 0.22))).text_size(px(11.0)).line_height(px(16.0)).text_color(col(dim())).child(footer))
    }
}

impl Render for TodoDetailPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let vp = window.viewport_size();
        let scroll = scrollbar::keyed(SCROLL_ID, BarStyle::Global);
        let captured = CAPTURE_SCROLL.load(std::sync::atomic::Ordering::Relaxed);
        if captured > 0 {
            scroll.set_offset(point(px(0.0), px(-(captured as f32))));
        }
        let max_w = page_max_width(f32::from(vp.width));
        let measured = self.width.get();
        let page_w = if measured > 0.0 { measured } else { max_w.min(f32::from(vp.width) - 64.0) };
        let narrow = page_w <= NARROW_AT;
        let pad_x = if narrow { 20.0 } else { 40.0 };
        let inner = page_w - 2.0 * pad_x;

        let Some(todo) = self.todo.clone() else {
            return div().id("todo-detail-root").relative().flex_1().h_full().track_focus(&self.focus).child(div().px(px(40.0)).py(px(32.0)).text_size(px(13.0)).text_color(col(dim())).child("Loading...")).into_any_element();
        };

        let measure_w = self.width.clone();
        let measure = canvas(
            move |b, window, _| {
                let w = f32::from(b.size.width);
                if (measure_w.get() - w).abs() > 0.5 {
                    measure_w.set(w);
                    window.refresh();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();

        let header = self.main_header(&todo, &me);
        let body = self.main_body(&todo, &me, window, cx);
        let layout = if narrow {
            div().flex().flex_col().gap(px(20.0)).child(header).child(self.rail(&todo, &me, inner, true)).child(body)
        } else {
            let left_w = inner - RAIL_W - 32.0;
            div()
                .flex()
                .flex_row()
                .items_start()
                .gap(px(32.0))
                .child(div().w(px(left_w)).flex_shrink_0().flex().flex_col().child(header).child(body))
                .child(div().w(px(RAIL_W)).flex_shrink_0().child(self.rail(&todo, &me, inner, false)))
        };

        let mut content = div().relative().mx_auto().w_full().max_w(px(max_w)).px(px(pad_x)).py(px(32.0)).font_family(UI_FONT).child(measure).child(self.breadcrumb(&todo, &me, window));
        if let Some(e) = &self.error {
            content = content.child(div().mb(px(14.0)).text_size(px(13.0)).text_color(col(TN_RED)).child(e.clone()));
        }
        content = content.child(layout);

        let mut root = div()
            .id("todo-detail-root")
            .relative()
            .flex_1()
            .h_full()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                if ev.keystroke.key == "escape" {
                    if this.overflow {
                        this.overflow = false;
                        cx.notify();
                    } else if !this.dialog_open(cx) {
                        this.leave(window, cx);
                    }
                }
            }))
            .child(div().id("todo-detail-scroll").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(content)))
            .child(scroll.bar());
        if self.overflow {
            let m = me.clone();
            root = root.child(backdrop(window, None, move |_, a| {
                m.update(a, |p, cx| {
                    p.overflow = false;
                    cx.notify();
                })
            }));
        }
        if let Some((picker, _)) = &self.picker {
            root = root.child(window_layer(window, div().size_full().child(picker.clone())));
        }
        root.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{append_embed, is_enter_press, notes_value, step_label};

    #[test]
    fn enter_is_exactly_one_typed_line_break() {
        assert!(is_enter_press("Hello", "Hello\n"));
        assert!(is_enter_press("Hel", "Hel\nlo".replace("lo", "").as_str()));
        assert!(!is_enter_press("Hello", "Hello world"));
        assert!(!is_enter_press("Hello", "Hello\n\n"));
        assert!(!is_enter_press("a\nb", "a\nb"));
    }

    #[test]
    fn an_embed_goes_after_a_blank_line_and_alone_when_the_notes_are_empty() {
        assert_eq!(append_embed("", "![a](u)"), "![a](u)");
        assert_eq!(append_embed("text  \n", "![a](u)"), "text\n\n![a](u)");
    }

    #[test]
    fn blank_notes_are_stored_as_none() {
        assert_eq!(notes_value("  \n"), None);
        assert_eq!(notes_value(" a "), Some("a".into()));
    }

    #[test]
    fn the_step_counter_shows_the_position_or_just_the_count() {
        assert_eq!(step_label(Some(2), 12), "3 / 12");
        assert_eq!(step_label(None, 12), "12");
    }
}
