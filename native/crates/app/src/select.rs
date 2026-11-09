//! `Select.tsx`: the Tokyo Night dropdown, a trigger that opens a list under (or over) it.

use crate::controls::parse_color;
use crate::css::rgba;
use crate::ui::*;
use gpui::*;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
    /// A leading dot, used for workflow states, projects and labels.
    pub color: Option<String>,
}

impl SelectOption {
    pub fn new(value: impl Into<String>, label: impl Into<String>, color: Option<String>) -> Self {
        Self { value: value.into(), label: label.into(), color }
    }
}

pub enum SelectEvent {
    Change(String),
    /// The list closed without a pick.
    Closed,
}

impl EventEmitter<SelectEvent> for SelectBox {}

const MIN_LIST_W: f32 = 160.0;
const MAX_LIST_H: f32 = 280.0;

pub struct SelectBox {
    id: SharedString,
    options: Vec<SelectOption>,
    value: String,
    placeholder: &'static str,
    min_w: f32,
    max_w: f32,
    /// The list opens above the trigger (for controls that sit at the foot of the window).
    flip_up: bool,
    open: bool,
    active: usize,
    focus: FocusHandle,
    /// When an outside mouse-down last closed the list: the click on the trigger that follows in the
    /// same gesture must not reopen it.
    closed_by_out: Option<Instant>,
    suppress_toggle: bool,
}

impl SelectBox {
    pub fn new(id: impl Into<SharedString>, placeholder: &'static str, min_w: f32, max_w: f32, flip_up: bool, cx: &mut Context<Self>) -> Self {
        Self {
            id: id.into(),
            options: vec![],
            value: String::new(),
            placeholder,
            min_w,
            max_w,
            flip_up,
            open: false,
            active: 0,
            focus: cx.focus_handle(),
            closed_by_out: None,
            suppress_toggle: false,
        }
    }

    pub fn set_options(&mut self, options: Vec<SelectOption>, value: &str, cx: &mut Context<Self>) {
        if self.options != options || self.value != value {
            self.options = options;
            self.value = value.to_string();
            cx.notify();
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    fn selected_index(&self) -> Option<usize> {
        self.options.iter().position(|o| o.value == self.value)
    }

    pub fn open_list(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.active = self.selected_index().unwrap_or(0);
        self.open = true;
        window.focus(&self.focus);
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        cx.emit(SelectEvent::Closed);
        cx.notify();
    }

    fn commit(&mut self, value: String, cx: &mut Context<Self>) {
        self.open = false;
        self.value = value.clone();
        cx.emit(SelectEvent::Change(value));
        cx.notify();
    }

    fn list(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let mut rows = div().flex().flex_col();
        for (i, o) in self.options.iter().enumerate() {
            let m = me.clone();
            let value = o.value.clone();
            let active = i == self.active;
            let mut row = div()
                .id(SharedString::from(format!("{}-o-{i}", self.id)))
                .w_full()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .px(px(10.0))
                .py(px(6.0))
                .rounded(px(6.0))
                .text_size(px(12.0))
                .line_height(px(15.2))
                .text_color(col(TN_TEXT))
                .cursor_pointer()
                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                    if *hovered && this.active != i {
                        this.active = i;
                        cx.notify();
                    }
                }))
                .on_click(move |_, _, app| {
                    let v = value.clone();
                    m.update(app, |s, cx| s.commit(v, cx))
                });
            if active {
                row = row.bg(col(rgba(122, 162, 247, 0.16)));
            }
            if let Some(c) = &o.color {
                row = row.child(div().flex_shrink_0().size(px(8.0)).rounded(px(4.0)).bg(col(parse_color(c))));
            }
            row = row.child(div().flex_1().min_w_0().truncate().child(o.label.clone()));
            if o.value == self.value {
                row = row.child(div().flex_shrink_0().text_size(px(11.0)).text_color(col(TN_BLUE)).child("\u{2713}"));
            }
            rows = rows.child(row);
        }
        let m_out = me.clone();
        let mut list = div()
            .id(SharedString::from(format!("{}-list", self.id)))
            .absolute()
            .min_w(px(MIN_LIST_W))
            .max_h(px(MAX_LIST_H))
            .p(px(4.0))
            .rounded(px(10.0))
            .border(px(1.0))
            .border_color(col(rgba(86, 95, 137, 0.35)))
            .bg(col(rgba(14, 16, 30, 0.94)))
            .shadow(shadows(&[sh(0.0, 14.0, 36.0, bk(0.55))]))
            .backdrop_filter(px(32.0), 1.6)
            .occlude()
            .overflow_y_scroll()
            .track_focus(&self.focus)
            .on_mouse_down_out(move |_, _, app| {
                m_out.update(app, |s, cx| {
                    if s.open {
                        s.closed_by_out = Some(Instant::now());
                        s.close(cx);
                    }
                })
            })
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                let n = this.options.len();
                match ev.keystroke.key.as_str() {
                    "escape" => this.close(cx),
                    "down" if n > 0 => this.active = (this.active + 1).min(n - 1),
                    "up" => this.active = this.active.saturating_sub(1),
                    "home" => this.active = 0,
                    "end" if n > 0 => this.active = n - 1,
                    "enter" | "space" => {
                        if let Some(o) = this.options.get(this.active) {
                            let v = o.value.clone();
                            this.commit(v, cx);
                        }
                    }
                    "tab" => this.close(cx),
                    _ => return,
                }
                cx.stop_propagation();
                cx.notify();
            }))
            .child(rows);
        list = if self.flip_up { list.bottom_full().mb(px(4.0)) } else { list.top_full().mt(px(4.0)) };
        list.left_0()
    }
}

impl Render for SelectBox {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let m_down = me.clone();
        let selected = self.selected_index().map(|i| self.options[i].clone());
        let open = self.open;
        let mut trigger = div()
            .id(SharedString::from(format!("{}-trigger", self.id)))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .min_w(px(self.min_w))
            .max_w(px(self.max_w))
            .min_h(px(32.0))
            .pl(px(10.0))
            .pr(px(8.0))
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(if open { rgba(122, 162, 247, 0.55) } else { rgba(41, 46, 66, 0.9) }))
            .bg(col(rgba(12, 13, 24, 0.55)))
            .backdrop_filter(px(8.0), 1.0)
            .cursor_pointer()
            .text_size(px(12.0))
            .line_height(px(16.0))
            .font_family(UI_FONT)
            .text_color(col(TN_TEXT))
            .hover(|s| s.border_color(col(rgba(122, 162, 247, 0.35))))
            .on_mouse_down(MouseButton::Left, move |_, _, app| {
                m_down.update(app, |s, _| s.suppress_toggle = s.closed_by_out.take().is_some_and(|t| t.elapsed() < Duration::from_millis(80)))
            })
            .on_click(move |_, window, app| {
                me.update(app, |s, cx| {
                    if std::mem::take(&mut s.suppress_toggle) {
                        return;
                    }
                    if s.open { s.close(cx) } else { s.open_list(window, cx) }
                })
            });
        if open {
            trigger = trigger.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 3.0, color: rgba(122, 162, 247, 0.08) }]));
        }
        if let Some(c) = selected.as_ref().and_then(|o| o.color.as_ref()) {
            trigger = trigger.child(div().flex_shrink_0().size(px(8.0)).rounded(px(4.0)).bg(col(parse_color(c))));
        }
        let (label, color) = match &selected {
            Some(o) => (o.label.clone(), TN_TEXT),
            None => (self.placeholder.to_string(), hex_muted()),
        };
        let chevron = svg().path("icons/chevron-down.svg").size(px(13.0)).flex_shrink_0().text_color(col(hex_muted()));
        let chevron = if open { chevron.with_transformation(Transformation::rotate(percentage(0.5))) } else { chevron };
        trigger = trigger.child(div().flex_1().min_w_0().truncate().text_color(col(color)).child(label)).child(chevron);
        let mut wrap = div().relative().flex_shrink_0().child(trigger);
        if self.open {
            wrap = wrap.child(deferred(self.list(cx)).with_priority(4));
        }
        wrap
    }
}

fn hex_muted() -> crate::css::C {
    crate::css::hex(0x8b93b8)
}
