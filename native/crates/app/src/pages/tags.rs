//! Tags page (`TagsPage.tsx`, `TagManager.tsx`, `TagColorPicker.tsx`): create, rename, recolor and delete tags.

use super::PageEvent;
use crate::controls::*;
use crate::css::{hex, rgba, Spec};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{CreateTagInput, Tag, UpdateTagInput};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::sync::Arc;

const MAX_NAME: usize = 32;

pub struct TagsPage {
    svc: Arc<Services>,
    tags: Vec<Tag>,
    new_name: Entity<TextField>,
    new_color: String,
    editing: Option<i64>,
    edit_name: Entity<TextField>,
    edit_color: String,
    error: Option<String>,
}

impl EventEmitter<PageEvent> for TagsPage {}

fn name_field(placeholder: &str, window: &mut Window, cx: &mut App) -> Entity<TextField> {
    let placeholder = placeholder.to_string();
    cx.new(|cx| TextField::new(true, field_style(13.0), &placeholder, window, cx).with_max_len(MAX_NAME))
}

impl TagsPage {
    pub fn new(svc: Arc<Services>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let new_name = name_field("New tag name\u{2026}", window, cx);
        cx.subscribe(&new_name, |this, _, ev: &TextFieldEvent, cx| {
            if matches!(ev, TextFieldEvent::Submit) {
                this.create(cx);
            }
        })
        .detach();
        let edit_name = name_field("", window, cx);
        cx.subscribe(&edit_name, |this, _, ev: &TextFieldEvent, cx| {
            if matches!(ev, TextFieldEvent::Submit) {
                this.update(cx);
            }
        })
        .detach();
        Self { svc, tags: vec![], new_name, new_color: TAG_COLORS[0].into(), editing: None, edit_name, edit_color: String::new(), error: None }
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        self.tags = self.svc.list_tags().unwrap_or_default();
        cx.notify();
    }

    fn changed(&mut self, cx: &mut Context<Self>) {
        self.tags = self.svc.list_tags().unwrap_or_default();
        cx.emit(PageEvent::SessionsChanged);
        cx.notify();
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let name = self.new_name.read(cx).text().trim().to_string();
        if name.is_empty() {
            return;
        }
        self.error = None;
        match self.svc.create_tag(&CreateTagInput { name, color: self.new_color.clone() }) {
            Ok(_) => self.new_name.update(cx, |n, cx| n.set_text("", cx)),
            Err(e) => self.error = Some(e.to_string()),
        }
        self.changed(cx);
    }

    fn start_edit(&mut self, tag: &Tag, window: &mut Window, cx: &mut Context<Self>) {
        self.editing = Some(tag.id);
        self.edit_color = tag.color.clone();
        self.edit_name.update(cx, |n, cx| n.set_text(&tag.name, cx));
        let focus = self.edit_name.read(cx).focus_handle().clone();
        window.focus(&focus);
        cx.notify();
    }

    fn update(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.editing else { return };
        let name = self.edit_name.read(cx).text().trim().to_string();
        if name.is_empty() {
            return;
        }
        self.error = None;
        match self.svc.update_tag(&UpdateTagInput { id, name, color: self.edit_color.clone() }) {
            Ok(_) => self.editing = None,
            Err(e) => self.error = Some(e.to_string()),
        }
        self.changed(cx);
    }

    fn delete(&mut self, id: i64, cx: &mut Context<Self>) {
        self.error = None;
        match self.svc.delete_tag(id) {
            Ok(()) => {
                if self.editing == Some(id) {
                    self.editing = None;
                }
            }
            Err(e) => self.error = Some(e.to_string()),
        }
        self.changed(cx);
    }

    fn square_button(id: impl Into<ElementId>, label: &str, bg: C, fg: C, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
        div()
            .id(id)
            .flex_shrink_0()
            .px(px(14.0))
            .py(px(7.0))
            .rounded(px(6.0))
            .bg(col(bg))
            .text_color(col(fg))
            .font_family(BTN_FONT)
            .text_size(px(13.0))
            .line_height(px(15.0))
            .font_weight(FontWeight(700.0))
            .cursor_pointer()
            .hover(|s| s.opacity(0.9))
            .on_click(move |_, w, a| on_click(w, a))
            .child(label.to_string())
    }

    fn icon_button(id: impl Into<ElementId>, glyph: &str, color: C, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
        div()
            .id(id)
            .px(px(4.0))
            .py(px(2.0))
            .rounded(px(4.0))
            .text_size(px(12.0))
            .line_height(px(12.0))
            .text_color(col(color))
            .cursor_pointer()
            .hover(|s| s.text_color(col(if color == TN_RED { TN_RED } else { TN_TEXT })))
            .on_click(move |_, w, a| on_click(w, a))
            .child(glyph.to_string())
    }
}

use crate::css::C;

impl Render for TagsPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let new_focus = self.new_name.read(cx).focus_handle().is_focused(window);
        let edit_focus = self.edit_name.read(cx).focus_handle().is_focused(window);
        let m_create = me.clone();
        let m_color = me.clone();
        let mut section = div().flex().flex_col().gap(px(8.0)).child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(6.0))
                        .child(glass_field(&self.new_name, new_focus, 10.0, 7.0).flex_1())
                        .child(Self::square_button("tag-create", "+", hex(0x7aa2f7), hex(0x1a1b26), move |_, a| m_create.update(a, |p, cx| p.create(cx)))),
                )
                .child(color_swatches("new-sw", &self.new_color, move |c, _, a| {
                    let c = c.to_string();
                    m_color.update(a, |p, cx| {
                        p.new_color = c;
                        cx.notify();
                    })
                })),
        );
        if let Some(e) = &self.error {
            section = section.child(ui_text(11.0).py(px(2.0)).text_color(col(TN_RED)).child(e.clone()));
        }
        if self.tags.is_empty() {
            section = section.child(ui_text(11.0).italic().text_color(col(TN_TEXT_DIM)).child("No tags yet"));
        }
        let tags = self.tags.clone();
        for tag in &tags {
            if self.editing == Some(tag.id) {
                let (m_ok, m_cancel, m_color) = (me.clone(), me.clone(), me.clone());
                section = section.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.0))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .gap(px(6.0))
                                .child(glass_field(&self.edit_name, edit_focus, 10.0, 7.0).flex_1())
                                .child(Self::square_button("tag-ok", "\u{2713}", hex(0x7aa2f7), hex(0x1a1b26), move |_, a| m_ok.update(a, |p, cx| p.update(cx))))
                                .child(Self::square_button("tag-cancel", "\u{2715}", hex(0x292e42), hex(0xa9b1d6), move |_, a| {
                                    m_cancel.update(a, |p, cx| {
                                        p.editing = None;
                                        cx.notify();
                                    })
                                })),
                        )
                        .child(color_swatches("edit-sw", &self.edit_color, move |c, _, a| {
                            let c = c.to_string();
                            m_color.update(a, |p, cx| {
                                p.edit_color = c;
                                cx.notify();
                            })
                        })),
                );
            } else {
                let (m_edit, m_del) = (me.clone(), me.clone());
                let (t_edit, id) = (tag.clone(), tag.id);
                section = section.child(
                    Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(12, 13, 24, 0.45)).border(1.0, rgba(41, 46, 66, 0.6)))
                        .el()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .px(px(10.0))
                        .py(px(8.0))
                        .child(div().flex_1().h(px(25.2)).flex().flex_row().items_center().child(tag_badge(tag, None).h(px(23.0))))
                        .child(Self::icon_button(SharedString::from(format!("edit-{id}")), "\u{270e}", ICON_DIM, move |w, a| m_edit.update(a, |p, cx| p.start_edit(&t_edit, w, cx))))
                        .child(Self::icon_button(SharedString::from(format!("del-{id}")), "\u{2715}", TN_RED, move |_, a| m_del.update(a, |p, cx| p.delete(id, cx)))),
                );
            }
        }
        page_shell("tags-page", 480.0, div().flex().flex_col().child(page_heading("Tags").mt(px(8.7)).mb(px(20.0))).child(section))
    }
}
