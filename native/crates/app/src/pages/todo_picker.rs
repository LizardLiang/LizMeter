//! `TodoPicker.tsx`: a searchable list of the todos that may legally be linked as a parent or as a
//! sub-issue. It loads the whole, unfiltered list itself, so a candidate never vanishes behind the
//! page's filter.

use super::todo_tree::{linkable_children, linkable_parents};
use super::todo_widgets::*;
use crate::css::rgba;
use crate::ui::*;
use gpui::*;
use lizmeter_core::{ListTodosInput, Todo};
use lizmeter_services::Services;
use lizmeter_ui::scrollbar::{self, BarStyle};
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::sync::Arc;

const ROW_H: f32 = 31.0;
const SCROLL_ID: &str = "todo-picker-list";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickerMode {
    /// Choosing a parent for the todo (`None` while it is still being created).
    Parent { todo: Option<i64>, current_parent: Option<i64> },
    /// Choosing an existing todo to file under the given one.
    Child { todo: i64 },
}

pub enum PickerEvent {
    Pick(Todo),
    Close,
}

impl EventEmitter<PickerEvent> for TodoPicker {}

pub struct TodoPicker {
    heading: String,
    all: Option<Vec<Todo>>,
    error: Option<String>,
    mode: PickerMode,
    query: String,
    active: usize,
    search: Entity<TextField>,
}

/// The candidates for `query`: the title contains it, or `#12` / `12` is the start of the id.
pub fn filter_candidates(candidates: &[Todo], query: &str) -> Vec<Todo> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return candidates.to_vec();
    }
    let by_id = needle.trim_start_matches('#').to_string();
    candidates.iter().filter(|t| t.title.to_lowercase().contains(&needle) || (!by_id.is_empty() && t.id.to_string().starts_with(&by_id))).cloned().collect()
}

impl TodoPicker {
    pub fn new(svc: &Arc<Services>, heading: String, mode: PickerMode, window: &mut Window, cx: &mut Context<Self>) -> Self {
        scrollbar::reset(SCROLL_ID);
        let search = limited_input(13.0, "Search by title or #id", 500, window, cx);
        cx.subscribe(&search, |this, s, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Changed => {
                this.query = s.read(cx).text().to_string();
                this.active = 0;
                cx.notify();
            }
            TextFieldEvent::Submit => this.pick_active(cx),
            TextFieldEvent::Cancel => cx.emit(PickerEvent::Close),
        })
        .detach();
        let (all, error) = match svc.list_todos(&ListTodosInput::default()) {
            Ok(t) => (Some(t), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let focus = search.read(cx).focus_handle().clone();
        window.focus(&focus);
        Self { heading, all, error, mode, query: String::new(), active: 0, search }
    }

    fn candidates(&self) -> Vec<Todo> {
        let Some(all) = &self.all else { return vec![] };
        match self.mode {
            PickerMode::Parent { todo, current_parent } => linkable_parents(all, todo, current_parent),
            PickerMode::Child { todo } => linkable_children(all, todo),
        }
    }

    fn matches(&self) -> Vec<Todo> {
        filter_candidates(&self.candidates(), &self.query)
    }

    fn pick_active(&mut self, cx: &mut Context<Self>) {
        if let Some(t) = self.matches().get(self.active).cloned() {
            cx.emit(PickerEvent::Pick(t));
        }
    }

    fn move_active(&mut self, delta: i32, cx: &mut Context<Self>) {
        let n = self.matches().len();
        if n == 0 {
            return;
        }
        self.active = (self.active as i32 + delta).clamp(0, n as i32 - 1) as usize;
        keep_in_view(&scrollbar::keyed(SCROLL_ID, BarStyle::Global), self.active as f32 * ROW_H, ROW_H);
        cx.notify();
    }
}

impl Render for TodoPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let vp = window.viewport_size();
        let (vw, vh) = (f32::from(vp.width), f32::from(vp.height));
        let width = (vw * 0.40).clamp(352.0, 544.0).min(vw - 48.0);
        let matches = self.matches();
        let scroll = scrollbar::keyed(SCROLL_ID, BarStyle::Global);

        let mut rows = div().flex().flex_col();
        for (i, t) in matches.iter().enumerate() {
            let (m_pick, m_hover) = (me.clone(), me.clone());
            let todo = t.clone();
            let active = i == self.active;
            let mut row = div()
                .id(SharedString::from(format!("picker-row-{}", t.id)))
                .w_full()
                .h(px(ROW_H))
                .flex_shrink_0()
                .px(px(9.0))
                .rounded(px(7.0))
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .text_size(px(13.0))
                .text_color(col(if active { TN_TEXT } else { TN_TEXT_DIM }))
                .cursor_pointer()
                .on_mouse_move(move |_, _, app| {
                    m_hover.update(app, |p, cx| {
                        if p.active != i {
                            p.active = i;
                            cx.notify();
                        }
                    })
                })
                .on_click(move |_, _, app| m_pick.update(app, |_, cx| cx.emit(PickerEvent::Pick(todo.clone()))))
                .child(div().flex_shrink_0().text_size(px(11.0)).text_color(col(dim())).child(format!("#{}", t.id)))
                .child(dot(&t.state.color, t.state.is_completed, 9.0, 1.5))
                .child(div().flex_1().min_w_0().truncate().child(t.title.clone()));
            if active {
                row = row.bg(col(rgba(122, 162, 247, 0.12)));
            }
            if let Some(parent) = &t.parent_title {
                row = row.child(div().flex_shrink_0().max_w(relative(0.4)).truncate().text_size(px(11.0)).text_color(col(dim())).child(format!("in {parent}")));
            }
            rows = rows.child(row);
        }

        let empty = |text: String| div().mt(px(14.0)).mb(px(4.0)).text_center().text_size(px(12.0)).text_color(col(dim())).child(text);
        let status = if let Some(e) = &self.error {
            Some(empty(e.clone()))
        } else if self.all.is_none() {
            Some(empty("Loading...".into()))
        } else if matches.is_empty() {
            Some(empty(if self.candidates().is_empty() { "No todo can be linked here." } else { "Nothing matches that search." }.into()))
        } else {
            None
        };

        let list_h = (matches.len() as f32 * ROW_H).min(vh * 0.46);
        let dialog = dialog_glass(18.0)
            .id("picker-dialog")
            .w(px(width))
            .px(px(18.0))
            .py(px(16.0))
            .flex()
            .flex_col()
            .on_click(|_, _, _| {})
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                match ev.keystroke.key.as_str() {
                    "down" => this.move_active(1, cx),
                    "up" => this.move_active(-1, cx),
                    "escape" => cx.emit(PickerEvent::Close),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(ui_text(11.0).line_height(px(14.0)).mb(px(10.0)).font_weight(FontWeight(700.0)).text_color(col(hex_a3())).child(spaced(&self.heading.to_uppercase(), 1.32)))
            .child(crate::controls::glass_field(&self.search, true, 12.0, 9.0))
            .children(status)
            .children((!matches.is_empty()).then(|| {
                div()
                    .relative()
                    .mt(px(10.0))
                    .h(px(list_h))
                    .child(div().id("picker-list").track_scroll(scroll.handle()).size_full().overflow_y_scroll().child(scroll.pad(rows)))
                    .child(scroll.bar())
            }));
        let close = me.clone();
        modal_overlay("picker", Some((vh * 0.12).max(12.0)), dialog, move |_, app| close.update(app, |_, cx| cx.emit(PickerEvent::Close)))
    }
}

fn hex_a3() -> crate::css::C {
    crate::css::hex(0xa3abc9)
}

#[cfg(test)]
mod tests {
    use super::filter_candidates;
    use crate::pages::todo_tree::fixture::todo;

    #[test]
    fn the_query_matches_a_title_substring_or_an_id_prefix() {
        let mut a = todo(12, None);
        a.title = "Write the Docs".into();
        let mut b = todo(120, None);
        b.title = "Other".into();
        let all = vec![a, b];
        assert_eq!(filter_candidates(&all, "docs").len(), 1);
        assert_eq!(filter_candidates(&all, "#12").len(), 2);
        assert_eq!(filter_candidates(&all, "120").len(), 1);
        assert_eq!(filter_candidates(&all, "  ").len(), 2);
        assert!(filter_candidates(&all, "zzz").is_empty());
    }
}
