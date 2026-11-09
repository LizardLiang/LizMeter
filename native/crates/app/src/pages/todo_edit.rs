//! `TodoEditDialog.tsx`: the create dialog for a new todo. Editing an existing one happens on the
//! detail page.

use super::todo_attachments::TodoAttachments;
use super::todo_fields::*;
use super::todo_picker::{PickerEvent, PickerMode, TodoPicker};
use super::todo_widgets::*;
use crate::select::SelectEvent;
use crate::ui::*;
use gpui::*;
use lizmeter_core::*;
use lizmeter_services::Services;
use lizmeter_ui::md_editor::{MarkdownEditor, MdEvent, MdMode, MdVariant};
use lizmeter_ui::scrollbar::{self, BarStyle};
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::rc::Rc;
use std::sync::Arc;

const SCROLL_ID: &str = "todo-edit";

pub enum EditEvent {
    /// The todo was created.
    Created(i64),
    Close,
}

impl EventEmitter<EditEvent> for TodoEditDialog {}

pub struct TodoEditDialog {
    svc: Arc<Services>,
    states: Vec<TodoState>,
    projects: Vec<TodoProject>,
    labels: Vec<TodoLabel>,
    title: Entity<TextField>,
    notes: Entity<MarkdownEditor>,
    notes_modal: Option<Entity<MarkdownEditor>>,
    attachments: Entity<TodoAttachments>,
    fields: FormFields,
    state_id: i64,
    priority: i64,
    start_date: String,
    due_date: String,
    label_names: Vec<String>,
    parent: Option<(i64, String)>,
    picker: Option<Entity<TodoPicker>>,
    error: Option<String>,
    focus: FocusHandle,
}

/// The state a new todo starts in: the group it was added from, else the workflow default.
pub fn initial_state_id(default_state: Option<i64>, states: &[TodoState]) -> i64 {
    default_state.or_else(|| states.iter().find(|s| s.is_default).map(|s| s.id)).or_else(|| states.first().map(|s| s.id)).unwrap_or(0)
}

/// Start date after the due date.
pub fn dates_invalid(start: &str, due: &str) -> bool {
    !start.is_empty() && !due.is_empty() && start > due
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

impl TodoEditDialog {
    pub fn new(svc: Arc<Services>, default_state: Option<i64>, default_parent: Option<(i64, String)>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        scrollbar::reset(SCROLL_ID);
        let states = svc.list_todo_states().unwrap_or_default();
        let projects = svc.list_todo_projects().unwrap_or_default();
        let labels = svc.list_todo_labels().unwrap_or_default();
        let milestones = svc.list_todo_milestones().unwrap_or_default();

        let title = limited_input(13.0, "", 500, window, cx);
        cx.subscribe_in(&title, window, |this, _, ev: &TextFieldEvent, window, cx| match ev {
            TextFieldEvent::Submit => this.submit(window, cx),
            TextFieldEvent::Cancel => cx.emit(EditEvent::Close),
            TextFieldEvent::Changed => cx.notify(),
        })
        .detach();

        let notes = cx.new(|cx| {
            let mut e = MarkdownEditor::new("", "Markdown supported", MdVariant::Framed, MdMode::Inline, window, cx);
            e.set_expandable(true, cx);
            e.set_title("Edit Notes", cx);
            e.set_todo_id(None);
            let resolver = svc.image_resolver();
            e.set_image_resolver(Rc::new(move |u| resolver(u)));
            e
        });
        cx.subscribe_in(&notes, window, Self::on_notes_event).detach();

        let attachments = cx.new(|_| TodoAttachments::new(svc.clone(), None));
        let fields = FormFields::new("edit", window, cx);
        let state_id = initial_state_id(default_state, &states);

        cx.subscribe_in(&fields.state, window, |this, _, ev: &SelectEvent, _, cx| {
            if let SelectEvent::Change(v) = ev {
                this.state_id = v.parse().unwrap_or(this.state_id);
                cx.notify();
            }
        })
        .detach();
        cx.subscribe_in(&fields.priority, window, |this, _, ev: &SelectEvent, _, cx| {
            if let SelectEvent::Change(v) = ev {
                this.priority = v.parse().unwrap_or(0);
                cx.notify();
            }
        })
        .detach();
        cx.subscribe_in(&fields.label, window, |this, _, ev: &ComboEvent, _, cx| match ev {
            ComboEvent::Commit(text) => this.add_label(text, cx),
            ComboEvent::Cancel => cx.emit(EditEvent::Close),
            _ => {}
        })
        .detach();
        for combo in [&fields.project, &fields.milestone] {
            cx.subscribe_in(combo, window, |_, _, ev: &ComboEvent, _, cx| match ev {
                ComboEvent::Cancel => cx.emit(EditEvent::Close),
                ComboEvent::Changed(_) => cx.notify(),
                _ => {}
            })
            .detach();
        }
        cx.subscribe_in(&fields.start, window, |this, _, ev: &DateEvent, _, cx| {
            let DateEvent::Change(v) = ev;
            this.start_date = v.clone();
            cx.notify();
        })
        .detach();
        cx.subscribe_in(&fields.due, window, |this, _, ev: &DateEvent, _, cx| {
            let DateEvent::Change(v) = ev;
            this.due_date = v.clone();
            cx.notify();
        })
        .detach();

        fields.set_states(&states, state_id, cx);
        fields.set_priority(0, cx);
        fields.set_suggestions(&projects, &labels.iter().map(|l| l.name.clone()).collect::<Vec<_>>(), &milestones, cx);
        let focus = title.read(cx).focus_handle().clone();
        window.focus(&focus);
        Self {
            svc,
            states,
            projects,
            labels,
            title,
            notes,
            notes_modal: None,
            attachments,
            fields,
            state_id,
            priority: 0,
            start_date: String::new(),
            due_date: String::new(),
            label_names: vec![],
            parent: default_parent,
            picker: None,
            error: None,
            focus,
        }
    }

    pub fn is_picker_open(&self) -> bool {
        self.picker.is_some() || self.notes_modal.is_some()
    }

    fn on_notes_event(&mut self, _: &Entity<MarkdownEditor>, ev: &MdEvent, window: &mut Window, cx: &mut Context<Self>) {
        match ev {
            MdEvent::Submit => self.submit(window, cx),
            MdEvent::Escape => cx.emit(EditEvent::Close),
            MdEvent::Expand => {
                let text = self.notes.read(cx).text().to_string();
                let resolver = self.svc.image_resolver();
                let modal = cx.new(|cx| {
                    let mut e = MarkdownEditor::new(&text, "Markdown supported", MdVariant::Fill, MdMode::Modal, window, cx);
                    e.set_title("Edit Notes", cx);
                    e.set_image_resolver(Rc::new(move |u| resolver(u)));
                    e
                });
                cx.subscribe_in(&modal, window, Self::on_notes_event).detach();
                let focus = modal.read(cx).focus_handle().clone();
                window.focus(&focus);
                self.notes_modal = Some(modal);
                cx.notify();
            }
            MdEvent::ModalDone(text) => {
                self.notes.update(cx, |n, cx| n.set_text(text, cx));
                self.close_modal(window, cx);
            }
            MdEvent::ModalCancel => self.close_modal(window, cx),
            _ => {}
        }
    }

    fn close_modal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.notes_modal = None;
        let focus = self.notes.read(cx).focus_handle().clone();
        window.focus(&focus);
        cx.notify();
    }

    fn open_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mode = PickerMode::Parent { todo: None, current_parent: self.parent.as_ref().map(|p| p.0) };
        let picker = cx.new(|cx| TodoPicker::new(&self.svc, "Nest this todo under".into(), mode, window, cx));
        cx.subscribe_in(&picker, window, |this, _, ev: &PickerEvent, window, cx| {
            if let PickerEvent::Pick(t) = ev {
                this.parent = Some((t.id, t.title.clone()));
            }
            this.picker = None;
            window.focus(&this.focus);
            cx.notify();
        })
        .detach();
        self.picker = Some(picker);
        cx.notify();
    }

    fn add_label(&mut self, name: &str, cx: &mut Context<Self>) {
        let trimmed = name.trim();
        if trimmed.is_empty() || self.label_names.iter().any(|n| n.eq_ignore_ascii_case(trimmed)) {
            return;
        }
        self.label_names.push(trimmed.to_string());
        self.fields.label.update(cx, |c, cx| c.set_text("", cx));
        self.sync_label_options(cx);
        cx.notify();
    }

    fn sync_label_options(&mut self, cx: &mut Context<Self>) {
        let names: Vec<String> = self.labels.iter().map(|l| l.name.clone()).filter(|n| !self.label_names.iter().any(|p| p.eq_ignore_ascii_case(n))).collect();
        self.fields.label.update(cx, |c, cx| c.set_options(names, cx));
    }

    fn can_submit(&self, cx: &App) -> bool {
        !self.title.read(cx).text().trim().is_empty() && !dates_invalid(&self.start_date, &self.due_date)
    }

    /// Resolves the typed project name to an id, creating the project when it is a new name.
    fn resolve_project(&self, cx: &App) -> Result<Option<i64>, String> {
        let name = self.fields.project.read(cx).text(cx);
        let name = name.trim();
        if name.is_empty() {
            return Ok(None);
        }
        if let Some(p) = self.projects.iter().find(|p| p.name.eq_ignore_ascii_case(name)) {
            return Ok(Some(p.id));
        }
        self.svc.create_todo_project(&CreateTodoProjectInput { name: name.to_string(), color: None }).map(|p| Some(p.id)).map_err(|e| e.to_string())
    }

    fn resolve_labels(&self) -> Result<Vec<i64>, String> {
        let mut ids = vec![];
        for name in &self.label_names {
            match self.labels.iter().find(|l| l.name.eq_ignore_ascii_case(name)) {
                Some(l) => ids.push(l.id),
                None => ids.push(self.svc.create_todo_label(&CreateTodoLabelInput { name: name.clone(), color: None }).map_err(|e| e.to_string())?.id),
            }
        }
        Ok(ids)
    }

    fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_submit(cx) {
            return;
        }
        let result = (|| {
            let input = CreateTodoInput {
                title: self.title.read(cx).text().trim().to_string(),
                notes: non_empty(self.notes.read(cx).text()),
                state_id: Some(self.state_id),
                project_id: self.resolve_project(cx)?,
                label_ids: Some(self.resolve_labels()?),
                milestone: non_empty(&self.fields.milestone.read(cx).text(cx)),
                priority: Some(self.priority),
                start_date: non_empty(&self.start_date),
                due_date: non_empty(&self.due_date),
                source: Some(TodoSource::User),
                source_label: None,
                parent_id: self.parent.as_ref().map(|p| p.0),
            };
            self.svc.create_todo(&input).map_err(|e| e.to_string())
        })();
        match result {
            Ok(todo) => {
                cx.emit(EditEvent::Created(todo.id));
                cx.emit(EditEvent::Close);
            }
            Err(e) => {
                self.error = Some(e);
                cx.notify();
            }
        }
    }
}

impl Render for TodoEditDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let vp = window.viewport_size();
        let (vw, vh) = (f32::from(vp.width), f32::from(vp.height));
        let width = (vw * 0.46).clamp(384.0, 640.0).min(vw - 48.0);
        let inner = width - 48.0;
        let scroll = scrollbar::keyed(SCROLL_ID, BarStyle::Global);
        let enabled = self.can_submit(cx);
        let invalid = dates_invalid(&self.start_date, &self.due_date);

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .mb(px(16.0))
            .child(ui_text(13.0).line_height(px(17.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(spaced("NEW TODO", 1.82)))
            .child({
                let m = me.clone();
                div().id("edit-close").px(px(6.0)).py(px(2.0)).rounded(px(4.0)).text_size(px(14.0)).line_height(px(14.0)).text_color(col(crate::css::hex(0xa3abc9))).cursor_pointer().hover(|s| s.text_color(col(TN_TEXT))).on_click(move |_, _, a| m.update(a, |_, cx| cx.emit(EditEvent::Close))).child("x")
            });

        let m_set = me.clone();
        let parent_row = div().flex().flex_row().items_center().gap(px(10.0)).mb(px(12.0)).min_h(px(26.0)).child(field_label("Parent").mb(px(0.0)).flex_shrink_0()).child(match &self.parent {
            None => link_button("edit-set-parent", "+ Set parent").on_click(move |_, w, a| m_set.update(a, |d, cx| d.open_picker(w, cx))).into_any_element(),
            Some((id, title)) => {
                let (m_change, m_clear) = (me.clone(), me.clone());
                chip_frame()
                    .child(parent_chip("edit-parent", *id, title.clone(), 352.0, move |w, a| m_change.update(a, |d, cx| d.open_picker(w, cx))))
                    .child(clear_x("edit-parent-clear").on_click(move |_, _, a| {
                        m_clear.update(a, |d, cx| {
                            d.parent = None;
                            cx.notify();
                        })
                    }))
                    .into_any_element()
            }
        });

        let title_focused = self.title.read(cx).focus_handle().is_focused(window);
        let title_field = field("Title", crate::controls::glass_field(&self.title, title_focused, 12.0, 9.0)).w_full();
        let notes_field = field("Notes", self.notes.clone());

        let mut chips = label_row();
        for name in self.label_names.clone() {
            let known = self.labels.iter().find(|l| l.name.eq_ignore_ascii_case(&name)).map(|l| l.color.clone());
            let m = me.clone();
            let n = name.clone();
            chips = chips.child(label_chip(SharedString::from(format!("edit-label-x-{name}")), &name, known.as_deref(), move |_, a| {
                m.update(a, |d, cx| {
                    d.label_names.retain(|x| *x != n);
                    d.sync_label_options(cx);
                    cx.notify();
                })
            }));
        }
        chips = chips.child(div().flex_1().min_w(px(110.0)).child(self.fields.label.clone()));

        let items = vec![
            (false, field("State", self.fields.state.clone()).into_any_element()),
            (false, field("Priority", self.fields.priority.clone()).into_any_element()),
            (false, field("Project", self.fields.project.clone()).into_any_element()),
            (true, field("Labels", chips).into_any_element()),
            (false, field("Milestone", self.fields.milestone.clone()).into_any_element()),
            (false, field("Start", self.fields.start.clone()).into_any_element()),
            (false, field("Due", self.fields.due.clone()).into_any_element()),
        ];

        let (m_cancel, m_create) = (me.clone(), me.clone());
        let mut create = save_button("edit-create", "Create", enabled);
        if enabled {
            create = create.on_click(move |_, w, a| m_create.update(a, |d, cx| d.submit(w, cx)));
        }
        let actions = div().flex().flex_row().items_center().justify_between().mt(px(18.0)).child(div()).child(
            div().flex().flex_row().gap(px(8.0)).child(plain_button("edit-cancel", "Cancel").on_click(move |_, _, a| m_cancel.update(a, |_, cx| cx.emit(EditEvent::Close)))).child(create),
        );

        let sub = div()
            .mt(px(18.0))
            .pt(px(14.0))
            .border_t_1()
            .border_color(col(crate::css::rgba(86, 95, 137, 0.22)))
            .child(div().flex().flex_row().items_center().justify_between().mb(px(8.0)).child(field_label("Sub-issues").mb(px(0.0))))
            .child(hint_text("Create this todo first, then add sub-issues to it.").mt(px(0.0)));

        let mut content = div().px(px(24.0)).py(px(22.0)).flex().flex_col().child(header).child(parent_row).child(title_field).child(notes_field).child(self.attachments.clone()).child(div().h(px(12.0))).child(grid(items, inner));
        if invalid {
            content = content.child(div().mt(px(8.0)).text_size(px(12.0)).text_color(col(TN_RED)).child("Start date must not be after the due date."));
        }
        if let Some(e) = &self.error {
            content = content.child(div().mt(px(8.0)).text_size(px(12.0)).text_color(col(TN_RED)).child(e.clone()));
        }
        content = content.child(sub).child(actions);

        let dialog = dialog_glass(18.0)
            .id("edit-dialog")
            .w(px(width))
            .max_h(px(vh * 0.88))
            .flex()
            .flex_col()
            .overflow_hidden()
            .track_focus(&self.focus)
            .on_click(|_, _, _| {})
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                let k = &ev.keystroke;
                if k.key == "escape" && !this.is_picker_open() {
                    cx.emit(EditEvent::Close);
                    cx.stop_propagation();
                } else if k.key == "enter" && (k.modifiers.control || k.modifiers.platform) {
                    this.submit(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(div().relative().flex_1().min_h_0().child(div().id("edit-scroll").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(content))).child(scroll.bar()));
        let close = me;
        let overlay = modal_overlay("edit", None, dialog, move |_, a| close.update(a, |_, cx| cx.emit(EditEvent::Close)));
        window_layer(window, 6, div().size_full().child(overlay).children(self.picker.clone()).children(self.notes_modal.clone().map(|m| notes_modal_layer(m))))
    }
}

/// The expanded notes editor over the dialog.
pub fn notes_modal_layer(modal: Entity<MarkdownEditor>) -> impl IntoElement {
    div().absolute().top_0().left_0().right_0().bottom_0().child(modal)
}

#[cfg(test)]
mod tests {
    use super::{dates_invalid, initial_state_id};
    use lizmeter_core::TodoState;

    fn state(id: i64, default: bool) -> TodoState {
        TodoState { id, label: format!("s{id}"), color: "#7aa2f7".into(), position: id, is_completed: false, is_default: default, created_at: String::new() }
    }

    #[test]
    fn a_new_todo_starts_in_the_group_it_came_from_else_the_default_state() {
        let states = [state(1, false), state(2, true), state(3, false)];
        assert_eq!(initial_state_id(Some(3), &states), 3);
        assert_eq!(initial_state_id(None, &states), 2);
        assert_eq!(initial_state_id(None, &[state(5, false)]), 5);
        assert_eq!(initial_state_id(None, &[]), 0);
    }

    #[test]
    fn dates_clash_only_when_both_are_set_and_the_start_is_later() {
        assert!(dates_invalid("2026-05-02", "2026-05-01"));
        assert!(!dates_invalid("2026-05-01", "2026-05-01"));
        assert!(!dates_invalid("", "2026-05-01"));
        assert!(!dates_invalid("2026-05-02", ""));
    }
}
