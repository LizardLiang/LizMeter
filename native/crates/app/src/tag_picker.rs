//! `TagPicker`: selected tag badges, an "Add tags…" prompt, and an upward dropdown with the free
//! tags and a "New tag" form.

use crate::controls::*;
use crate::css::{linear, rgba, Spec, TRANSPARENT};
use crate::ui::*;
use gpui::*;
use lizmeter_core::Tag;
use lizmeter_ui::text_input::{TextField, TextFieldEvent, TextInput};

pub enum TagPickerEvent {
    Add(i64),
    Remove(i64),
    Create { name: String, color: String },
}

impl EventEmitter<TagPickerEvent> for TagPicker {}

pub struct TagPicker {
    id: SharedString,
    all_tags: Vec<Tag>,
    selected: Vec<i64>,
    open: bool,
    creating: bool,
    color: String,
    error: Option<String>,
    name: Entity<TextField>,
}

impl TagPicker {
    pub fn new(id: impl Into<SharedString>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let name = TextInput::new(field_style(12.0), "Tag name", window, cx);
        cx.subscribe(&name, |this, _, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Submit => this.submit(cx),
            TextFieldEvent::Cancel => this.reset(cx),
            TextFieldEvent::Changed => {}
        })
        .detach();
        Self { id: id.into(), all_tags: vec![], selected: vec![], open: false, creating: false, color: TAG_COLORS[0].to_string(), error: None, name }
    }

    pub fn set_tags(&mut self, all: Vec<Tag>, selected: Vec<i64>, cx: &mut Context<Self>) {
        self.all_tags = all;
        self.selected = selected;
        cx.notify();
    }

    fn reset(&mut self, cx: &mut Context<Self>) {
        self.creating = false;
        self.error = None;
        self.color = TAG_COLORS[0].to_string();
        self.name.update(cx, |n, cx| n.set_text("", cx));
        cx.notify();
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let name = self.name.read(cx).text().trim().to_string();
        if name.is_empty() {
            self.error = Some("Name is required.".into());
            cx.notify();
            return;
        }
        cx.emit(TagPickerEvent::Create { name, color: self.color.clone() });
        self.open = false;
        self.reset(cx);
    }

    fn dropdown(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let mut list = div().flex().flex_col().py(px(4.0));
        let available: Vec<Tag> = self.all_tags.iter().filter(|t| !self.selected.contains(&t.id)).cloned().collect();
        if available.is_empty() {
            list = list.child(div().px(px(10.0)).py(px(8.0)).text_size(px(11.0)).italic().text_color(col(TN_TEXT_DIM)).child(if self.all_tags.is_empty() { "No tags yet" } else { "All tags selected" }));
        }
        for t in available {
            let m = me.clone();
            let id = t.id;
            list = list.child(
                div()
                    .id(SharedString::from(format!("{}-pick-{id}", self.id)))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .text_size(px(12.0))
                    .text_color(col(TN_TEXT))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(41, 46, 66, 0.7))))
                    .on_click(move |_, _, app| {
                        m.update(app, |p, cx| {
                            p.open = false;
                            cx.emit(TagPickerEvent::Add(id));
                            cx.notify();
                        })
                    })
                    .child(div().size(px(8.0)).rounded(px(4.0)).bg(col(parse_color(&t.color))))
                    .child(t.name.clone()),
            );
        }
        list = list.child(div().h(px(1.0)).my(px(3.0)).bg(col(rgba(41, 46, 66, 0.8))));
        if !self.creating {
            let m = me.clone();
            list = list.child(
                div()
                    .id(SharedString::from(format!("{}-new", self.id)))
                    .px(px(10.0))
                    .py(px(6.0))
                    .text_size(px(11.0))
                    .text_color(col(TN_TEXT_DIM))
                    .cursor_pointer()
                    .hover(|s| s.text_color(col(TN_TEXT)))
                    .on_click(move |_, window, app| {
                        m.update(app, |p, cx| {
                            p.creating = true;
                            let f = p.name.read(cx).focus_handle().clone();
                            window.focus(&f);
                            cx.notify();
                        })
                    })
                    .child(spaced("+ New tag", 0.33)),
            );
        } else {
            let (m_cancel, m_color, m_create) = (me.clone(), me.clone(), me.clone());
            let mut form = div()
                .flex()
                .flex_col()
                .gap(px(7.0))
                .px(px(10.0))
                .py(px(8.0))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .justify_between()
                        .items_center()
                        .child(ui_text(9.0).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT_DIM)).child(spaced("NEW TAG", 0.9)))
                        .child(
                            div()
                                .id(SharedString::from(format!("{}-cancel", self.id)))
                                .text_size(px(15.0))
                                .text_color(col(TN_TEXT_DIM))
                                .cursor_pointer()
                                .on_click(move |_, _, app| m_cancel.update(app, |p, cx| p.reset(cx)))
                                .child("\u{00d7}"),
                        ),
                )
                .child(
                    div()
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(rgba(41, 46, 66, 0.9)))
                        .bg(col(rgba(12, 13, 24, 0.6)))
                        .px(px(8.0))
                        .py(px(5.0))
                        .child(self.name.clone()),
                )
                .child(color_swatches("tp-sw", &self.color, move |c, _, app| {
                    let c = c.to_string();
                    m_color.update(app, |p, cx| {
                        p.color = c;
                        cx.notify();
                    })
                }));
            if let Some(e) = &self.error {
                form = form.child(div().text_size(px(11.0)).text_color(col(TN_RED)).child(e.clone()));
            }
            form = form.child(
                div()
                    .id(SharedString::from(format!("{}-create", self.id)))
                    .h(px(28.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.0))
                    .bg(col(rgba(122, 162, 247, 0.18)))
                    .text_color(col(TN_BLUE))
                    .text_size(px(12.0))
                    .font_weight(FontWeight(600.0))
                    .cursor_pointer()
                    .on_click(move |_, _, app| m_create.update(app, |p, cx| p.submit(cx)))
                    .child("Create"),
            );
            list = list.child(form);
        }
        let spec = Spec::rrect(14.0)
            .fill(linear(135.0, &[(0.0, wh(0.07)), (0.3, wh(0.01)), (0.52, TRANSPARENT)]))
            .solid(rgba(13, 15, 28, 0.9))
            .border(1.0, rgba(41, 46, 66, 0.9))
            .inset(0.0, 1.0, wh(0.10))
            .inset(1.0, 0.0, wh(0.05))
            .inset(0.0, -1.0, bk(0.12));
        let m_out = me.clone();
        Glass::new(14.0, 24.0, 1.6, spec)
            .shadows(&[sh(0.0, 12.0, 40.0, bk(0.55)), sh(0.0, 2.0, 8.0, bk(0.3))])
            .el()
            .absolute()
            .bottom(px(28.0))
            .left_0()
            .min_w(px(160.0))
            .max_h(px(280.0))
            .occlude()
            .on_mouse_down_out(move |_, _, app| {
                m_out.update(app, |p, cx| {
                    if p.open {
                        p.open = false;
                        p.reset(cx);
                    }
                })
            })
            .child(list)
    }
}

impl Render for TagPicker {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let mut row = div().flex().flex_row().flex_wrap().items_center().gap(px(4.0)).min_h(px(24.0));
        let selected: Vec<Tag> = self.all_tags.iter().filter(|t| self.selected.contains(&t.id)).cloned().collect();
        if selected.is_empty() {
            row = row.child(div().text_size(px(11.0)).italic().text_color(col(ICON_DIM)).child("Add tags\u{2026}"));
        }
        for t in selected {
            let m = me.clone();
            let id = t.id;
            row = row.child(tag_badge(&t, Some(Box::new(move |_, app| m.update(app, |_, cx| cx.emit(TagPickerEvent::Remove(id)))))));
        }
        let m = me.clone();
        let toggle = row.id(SharedString::from(format!("{}-row", self.id))).cursor_pointer().on_click(move |_, _, app| {
            m.update(app, |p, cx| {
                p.open = !p.open;
                if !p.open {
                    p.reset(cx);
                }
                cx.notify();
            })
        });
        let mut wrap = div().relative().child(toggle);
        if self.open {
            wrap = wrap.child(deferred(self.dropdown(cx)).with_priority(3));
        }
        wrap
    }
}
