//! Small form controls of the todo dialogs and the detail page: `Combobox.tsx`, `DatePicker.tsx`
//! and the shared button looks.

use crate::controls::{field_style, parse_color};
use crate::css::{hex, linear, rgba, Spec, C, TRANSPARENT};
use crate::ui::*;
use chrono::{Datelike, Duration, NaiveDate};
use gpui::prelude::FluentBuilder;
use gpui::*;
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::cell::Cell;
use std::rc::Rc;

pub const LIST_MAX_H: f32 = 220.0;
/// A form field: 12px text with 6px padding and a 1px border.
pub const FIELD_H: f32 = 29.0;
const COMBO_ROW_H: f32 = 30.0;
const PANEL_W: f32 = 248.0;
const PANEL_H: f32 = 316.0;

/// A single-line field that refuses text past `max` characters, in the 12px form look.
pub fn limited_input(size: f32, placeholder: &str, max: usize, window: &mut Window, cx: &mut App) -> Entity<TextField> {
    let style = field_style(size);
    let placeholder = placeholder.to_string();
    cx.new(|cx| TextField::new(true, style, &placeholder, window, cx).with_max_len(max))
}

pub fn dim() -> C {
    hex(0x8b93b8)
}

pub fn faint() -> C {
    hex(0x565f89)
}

/// The glass list every dropdown of the form shares (`.list` of `Select.module.scss`).
pub fn list_surface() -> Div {
    div()
        .p(px(4.0))
        .rounded(px(10.0))
        .border(px(1.0))
        .border_color(col(rgba(86, 95, 137, 0.35)))
        .bg(col(rgba(14, 16, 30, 0.94)))
        .shadow(shadows(&[sh(0.0, 14.0, 36.0, bk(0.55))]))
        .backdrop_filter(px(32.0), 1.6)
        .occlude()
}

/// The frame of a select trigger or a combobox (`.trigger`).
pub fn trigger_frame(focused: bool) -> Div {
        div()
        .h(px(FIELD_H))
        .flex()
        .flex_row()
        .items_center()
        .min_w_0()
        .rounded(px(8.0))
        .border(px(1.0))
        .border_color(col(if focused { rgba(122, 162, 247, 0.55) } else { rgba(41, 46, 66, 0.9) }))
        .bg(col(rgba(12, 13, 24, 0.55)))
        .backdrop_filter(px(8.0), 1.0)
        .when(focused, |d| d.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 3.0, color: rgba(122, 162, 247, 0.08) }])))
}

/// A small dot in a state, project or label colour.
pub fn dot(color: &str, filled: bool, size: f32, border: f32) -> Div {
    let c = col(parse_color(color));
    let d = div().flex_shrink_0().size(px(size)).rounded(px(size / 2.0)).border(px(border)).border_color(c);
    if filled { d.bg(c) } else { d }
}

/// The bold 11px label above a form field (`.label` / `.sectionLabel`).
pub fn field_label(text: &str) -> Div {
    ui_text(11.0).h(px(14.4)).flex_shrink_0().line_height(px(14.4)).font_weight(FontWeight(700.0)).text_color(col(hex(0xa3abc9))).mb(px(5.0)).child(spaced(&text.to_uppercase(), 1.1))
}

// ---- Dialog shell ----

/// The glass dialog of the app (same formula as the issue prompt): readable, not see-through.
pub fn dialog_glass(radius: f32) -> Div {
    let spec = Spec::rrect(radius)
        .fill(linear(135.0, &[(0.0, wh(0.07)), (0.32, wh(0.01)), (0.55, TRANSPARENT)]))
        .fill(linear(315.0, &[(0.0, bk(0.08)), (0.40, TRANSPARENT)]))
        .solid(rgba(20, 23, 42, 0.86))
        .border(1.0, rgba(122, 162, 247, 0.4))
        .inset(0.0, 1.0, wh(0.12))
        .inset(1.0, 0.0, wh(0.05))
        .inset(0.0, -1.0, bk(0.15))
        .inset(-1.0, 0.0, bk(0.05));
    let shd = vec![Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }, sh(0.0, 16.0, 40.0, bk(0.28))];
    Glass::new(radius, 36.0, 1.7, spec).shadows(&shd).el()
}

/// The blur scrim over the window with `dialog` entering as `modalEntrance` (0.2s, 8px rise).
/// `top` pins the dialog that far from the top (the pickers); `None` centres it.
pub fn modal_overlay(id: &'static str, top: Option<f32>, dialog: impl IntoElement, on_close: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let entrance = animate(div().relative().child(dialog), id, 200, false, overshoot(), 1.0, |el, t| el.opacity(t.clamp(0.0, 1.0)).top(px(8.0 * (1.0 - t))));
    let mut o = Glass::new(0.0, 16.0, 1.25, Spec::rrect(0.0).solid(rgba(192, 202, 245, 0.06)))
        .el()
        .id(SharedString::from(format!("{id}-overlay")))
        .absolute()
        .top_0()
        .left_0()
        .right_0()
        .bottom_0()
        .flex()
        .justify_center()
        .occlude()
        .on_click(move |_, w, a| on_close(w, a));
    o = match top {
        Some(t) => o.items_start().pt(px(t)),
        None => o.items_center(),
    };
    o.child(entrance)
}

/// A layer the size of the window under the title bar, painted in tree order over the sidebar and
/// the page. It is not deferred, because gpui cannot defer a draw inside a deferred one and the
/// dropdowns of the dialogs inside it are deferred themselves.
pub fn window_layer(window: &Window, child: impl IntoElement) -> impl IntoElement {
    let vp = window.viewport_size();
    anchored().position(point(px(0.0), px(32.0))).anchor(Corner::TopLeft).child(div().relative().w(vp.width).h(vp.height - px(32.0)).child(child))
}

/// A dialog's footer buttons look: outline `Cancel`.
pub fn cancel_button(id: &'static str, label: &str) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(29.0))
        .px(px(17.0))
        .rounded(px(6.0))
        .border(px(1.0))
        .border_color(col(TN_MUTED))
        .flex()
        .items_center()
        .cursor_pointer()
        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.07))))
        .font_family(BTN_FONT)
        .text_size(px(13.0))
        .text_color(col(TN_TEXT))
        .child(label.to_string())
}

/// The scroll position that keeps `[top, top + h)` in view.
pub fn keep_in_view(scroll: &lizmeter_ui::scrollbar::Scroll, top: f32, h: f32) {
    let vp = f32::from(scroll.bounds().size.height);
    if vp <= 0.0 {
        return;
    }
    let scrolled = -f32::from(scroll.offset().y);
    let target = super::todos_logic::scroll_nearest(scrolled, vp, top, top + h);
    if (target - scrolled).abs() > 0.5 {
        scroll.set_offset(point(px(0.0), px(-target.max(0.0))));
    }
}

// ---- Small pieces of the todo forms ----

/// The dashed `+ Set parent` / `Link existing` button.
pub fn link_button(id: impl Into<ElementId>, text: &str) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(9.0))
        .py(px(4.0))
        .rounded(px(6.0))
        .border(px(1.0))
        .border_dashed()
        .border_color(col(rgba(86, 95, 137, 0.5)))
        .text_size(px(12.0))
        .line_height(px(16.0))
        .text_color(col(hex(0xa3abc9)))
        .cursor_pointer()
        .hover(|s| s.text_color(col(TN_BLUE)).border_color(col(rgba(122, 162, 247, 0.5))))
        .child(text.to_string())
}

/// The small `x` of a chip or row that removes it.
pub fn clear_x(id: impl Into<ElementId>) -> Stateful<Div> {
    div().id(id).px(px(7.0)).py(px(3.0)).rounded(px(4.0)).text_size(px(12.0)).line_height(px(12.0)).text_color(col(hex(0xa3abc9))).cursor_pointer().hover(|s| s.text_color(col(TN_RED))).child("x")
}

/// A label on a todo: a pill in the label colour with a remove cross.
pub fn label_chip(id: impl Into<ElementId>, name: &str, color: Option<&str>, on_remove: impl Fn(&mut Window, &mut App) + 'static) -> Div {
    let (border, text) = match color {
        Some(c) => (c_alpha(parse_color(c), 0.4), parse_color(c)),
        None => (rgba(122, 134, 180, 0.5), hex(0xa3abc9)),
    };
    div()
        .flex()
        .flex_row()
        .items_center()
        .flex_shrink_0()
        .gap(px(4.0))
        .pl(px(9.0))
        .pr(px(4.0))
        .py(px(2.0))
        .rounded(px(999.0))
        .border(px(1.0))
        .border_color(col(border))
        .text_size(px(11.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(600.0))
        .text_color(col(text))
        .child(name.to_string())
        .child(
            div()
                .id(id)
                .size(px(15.0))
                .rounded(px(8.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(13.0))
                .line_height(px(13.0))
                .opacity(0.6)
                .cursor_pointer()
                .hover(|s| s.opacity(1.0).bg(col(rgba(247, 118, 142, 0.2))))
                .on_click(move |_, w, a| on_remove(w, a))
                .child("\u{d7}"),
        )
}

/// The frame around the label chips and the add-label box.
pub fn label_row() -> Div {
    div().flex().flex_row().flex_wrap().items_center().gap(px(6.0)).min_h(px(30.0)).px(px(6.0)).py(px(4.0)).rounded(px(8.0)).border(px(1.0)).border_color(col(rgba(41, 46, 66, 0.8))).bg(col(rgba(12, 13, 24, 0.5)))
}

/// The id, then the title, of a parent: `#12  Write the docs`.
pub fn id_chip_text(id: i64) -> Div {
    div().flex_shrink_0().text_size(px(11.0)).line_height(px(14.0)).text_color(col(dim())).child(format!("#{id}"))
}

/// The state colour dot plus a `Sub-issue of` chip body, shared by the dialog and the page.
pub fn parent_chip(id: &'static str, parent_id: i64, text: String, max_w: f32, on_open: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    div()
        .id(id)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .max_w(px(max_w))
        .pl(px(9.0))
        .pr(px(4.0))
        .py(px(4.0))
        .text_size(px(12.0))
        .line_height(px(16.0))
        .text_color(col(TN_BLUE))
        .cursor_pointer()
        .on_click(move |_, w, a| on_open(w, a))
        .child(id_chip_text(parent_id))
        .child(div().min_w_0().truncate().child(text))
}

/// The chip frame holding a parent chip body and its buttons.
pub fn chip_frame() -> Div {
    div().flex().flex_row().items_center().max_w_full().rounded(px(6.0)).border(px(1.0)).border_color(col(rgba(122, 162, 247, 0.28))).bg(col(rgba(122, 162, 247, 0.1)))
}

/// The text under a field or in an empty section.
pub fn hint_text(text: &str) -> Div {
    div().mt(px(8.0)).text_size(px(11.0)).line_height(px(16.5)).text_color(col(dim())).child(text.to_string())
}

/// The Create / primary action of a form (`.saveBtn`).
pub fn save_button(id: &'static str, label: &str, enabled: bool) -> Stateful<Div> {
    let b = div()
        .id(id)
        .px(px(20.0))
        .py(px(8.0))
        .rounded(px(8.0))
        .border(px(1.0))
        .border_color(col(rgba(122, 162, 247, 0.35)))
        .bg(col(rgba(122, 162, 247, 0.14)))
        .font_family(BTN_FONT)
        .text_size(px(13.0))
        .line_height(px(16.0))
        .font_weight(FontWeight(600.0))
        .text_color(col(TN_BLUE))
        .child(label.to_string());
    if enabled { b.cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.22)))) } else { b.opacity(0.4) }
}

/// The `Cancel` of a form (`.cancelBtn`).
pub fn plain_button(id: &'static str, label: &str) -> Stateful<Div> {
    div()
        .id(id)
        .px(px(16.0))
        .py(px(8.0))
        .rounded(px(8.0))
        .border(px(1.0))
        .border_color(col(hex(0x292e42)))
        .font_family(BTN_FONT)
        .text_size(px(13.0))
        .line_height(px(16.0))
        .text_color(col(TN_TEXT_DIM))
        .cursor_pointer()
        .hover(|s| s.text_color(col(TN_TEXT)).border_color(col(hex(0x3b4261))))
        .child(label.to_string())
}

// ---- Combobox ----

pub enum ComboEvent {
    /// The text changed: typed, or a suggestion was picked.
    Changed(String),
    /// Enter, or a picked suggestion: the value is settled.
    Commit(String),
    /// The field lost focus with this text, and no suggestion was being picked.
    Blur(String),
    /// Escape, with the suggestions already closed.
    Cancel,
}

impl EventEmitter<ComboEvent> for Combobox {}

/// Free text with themed suggestions: the editable sibling of the select.
pub struct Combobox {
    id: SharedString,
    field: Entity<TextField>,
    options: Vec<String>,
    open: bool,
    active: Option<usize>,
    bare: bool,
    picking: bool,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl Combobox {
    pub fn new(id: impl Into<SharedString>, placeholder: &str, max_len: usize, bare: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let field = limited_input(12.0, placeholder, max_len, window, cx);
        cx.subscribe(&field, |this, f, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Changed => {
                let text = f.read(cx).text().to_string();
                this.active = None;
                this.open = !this.options.is_empty();
                cx.emit(ComboEvent::Changed(text));
                cx.notify();
            }
            TextFieldEvent::Submit => {
                let text = f.read(cx).text().to_string();
                if let Some(o) = this.open.then(|| this.active.and_then(|i| this.matches(&text).get(i).cloned())).flatten() {
                    this.pick(o, cx);
                } else {
                    this.open = false;
                    this.active = None;
                    cx.emit(ComboEvent::Commit(text));
                    cx.notify();
                }
            }
            TextFieldEvent::Cancel => {
                if this.open {
                    this.open = false;
                    this.active = None;
                    cx.notify();
                } else {
                    cx.emit(ComboEvent::Cancel);
                }
            }
        })
        .detach();
        let focus = field.read(cx).focus_handle().clone();
        cx.on_focus(&focus, window, |this, _, cx| {
            if !this.options.is_empty() {
                this.open = true;
                cx.notify();
            }
        })
        .detach();
        cx.on_blur(&focus, window, |this, _, cx| {
            if std::mem::take(&mut this.picking) {
                return;
            }
            this.open = false;
            let text = this.field.read(cx).text().to_string();
            cx.emit(ComboEvent::Blur(text));
            cx.notify();
        })
        .detach();
        Self { id: id.into(), field, options: vec![], open: false, active: None, bare, picking: false, bounds: Rc::new(Cell::new(None)) }
    }

    pub fn text(&self, cx: &App) -> String {
        self.field.read(cx).text().to_string()
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.field.read(cx).text() != text {
            self.field.update(cx, |f, cx| f.set_text(text, cx));
        }
    }

    pub fn set_options(&mut self, options: Vec<String>, cx: &mut Context<Self>) {
        if self.options != options {
            self.options = options;
            cx.notify();
        }
    }

    pub fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.field.read(cx).focus_handle().clone()
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// The suggestions for `text`: all of them when it is empty or names one exactly, else those that contain it.
    fn matches(&self, text: &str) -> Vec<String> {
        suggestions(&self.options, text)
    }

    fn pick(&mut self, option: String, cx: &mut Context<Self>) {
        self.picking = false;
        self.field.update(cx, |f, cx| f.set_text(&option, cx));
        self.open = false;
        self.active = None;
        cx.emit(ComboEvent::Changed(option.clone()));
        cx.emit(ComboEvent::Commit(option));
        cx.notify();
    }
}

/// Which options a Combobox offers for the typed text.
pub fn suggestions(options: &[String], text: &str) -> Vec<String> {
    let q = text.trim().to_lowercase();
    if q.is_empty() || options.iter().any(|o| o.to_lowercase() == q) {
        return options.to_vec();
    }
    options.iter().filter(|o| o.to_lowercase().contains(&q)).cloned().collect()
}

impl Render for Combobox {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let text = self.field.read(cx).text().to_string();
        let focused = self.field.read(cx).focus_handle().is_focused(window);
        let matches = self.matches(&text);
        let mut frame = if self.bare {
            div().flex().flex_row().items_center().min_w_0().h(px(FIELD_H - 2.6))
        } else {
            trigger_frame(focused)
        };
        frame = frame.flex_1().child(div().flex_1().min_w_0().pl(px(10.0)).pr(px(4.0)).child(self.field.clone()));
        if !self.options.is_empty() {
            let m = me.clone();
            frame = frame.child(
                div()
                    .id(SharedString::from(format!("{}-toggle", self.id)))
                    .flex_shrink_0()
                    .pl(px(4.0))
                    .pr(px(8.0))
                    .cursor_pointer()
                    .on_click(move |_, window, app| {
                        m.update(app, |c, cx| {
                            c.open = !c.open;
                            window.focus(c.field.read(cx).focus_handle());
                            cx.notify();
                        })
                    })
                    .child(svg().path("icons/chevron-down.svg").size(px(13.0)).text_color(col(faint()))),
            );
        }
        let bounds = self.bounds.clone();
        let measure = canvas(move |b, _, _| bounds.set(Some(b)), |_, _, _, _| {}).absolute().top_0().left_0().size_full();
        let mut wrap = div().relative().flex().flex_row().min_w_0().w_full().child(measure).child(frame);
        if self.open && !matches.is_empty() {
            let height = (matches.len() as f32 * COMBO_ROW_H + 8.0).min(LIST_MAX_H);
            let flip = self.bounds.get().is_some_and(|b| f32::from(b.bottom()) + 4.0 + height > f32::from(window.viewport_size().height));
            let mut rows = div().flex().flex_col();
            for (i, option) in matches.iter().enumerate() {
                let (m_pick, m_down) = (me.clone(), me.clone());
                let value = option.clone();
                let selected = *option == text;
                rows = rows.child(
                    div()
                        .id(SharedString::from(format!("{}-opt-{i}", self.id)))
                        .h(px(COMBO_ROW_H - 2.0))
                        .px(px(10.0))
                        .rounded(px(6.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .text_size(px(12.0))
                        .text_color(col(TN_TEXT))
                        .cursor_pointer()
                        .when(self.active == Some(i), |d| d.bg(col(rgba(122, 162, 247, 0.16))))
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered && this.active != Some(i) {
                                this.active = Some(i);
                                cx.notify();
                            }
                        }))
                        .on_mouse_down(MouseButton::Left, move |_, _, app| m_down.update(app, |c, _| c.picking = true))
                        .on_click(move |_, _, app| m_pick.update(app, |c, cx| c.pick(value.clone(), cx)))
                        .child(div().flex_1().min_w_0().truncate().child(option.clone()))
                        .when(selected, |d| d.child(div().flex_shrink_0().text_size(px(11.0)).text_color(col(TN_BLUE)).child("\u{2713}"))),
                );
            }
            let m_out = me.clone();
            let mut list = list_surface()
                .id(SharedString::from(format!("{}-list", self.id)))
                .absolute()
                .left_0()
                .right_0()
                .min_w(px(160.0))
                .max_h(px(LIST_MAX_H))
                .overflow_y_scroll()
                .on_mouse_down_out(move |_, _, app| {
                    m_out.update(app, |c, cx| {
                        if c.open {
                            c.open = false;
                            cx.notify();
                        }
                    })
                })
                .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, _, cx| {
                    this.on_list_key(ev, cx);
                }))
                .child(rows);
            list = if flip { list.bottom_full().mb(px(4.0)) } else { list.top_full().mt(px(4.0)) };
            wrap = wrap.child(deferred(list).with_priority(4));
        }
        wrap.on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| this.on_list_key(ev, cx)))
    }
}

impl Combobox {
    fn on_list_key(&mut self, ev: &KeyDownEvent, cx: &mut Context<Self>) {
        let text = self.field.read(cx).text().to_string();
        let n = self.matches(&text).len();
        match ev.keystroke.key.as_str() {
            "down" if !self.open && !self.options.is_empty() => {
                self.open = true;
                self.active = Some(0);
            }
            "down" if n > 0 => self.active = Some(self.active.map_or(0, |i| (i + 1).min(n - 1))),
            "up" if self.open => self.active = Some(self.active.map_or(0, |i| i.saturating_sub(1))),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }
}

// ---- DatePicker ----

pub enum DateEvent {
    /// "YYYY-MM-DD", or "" for no date.
    Change(String),
}

impl EventEmitter<DateEvent> for DatePicker {}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS: [&str; 7] = ["S", "M", "T", "W", "T", "F", "S"];

pub fn parse_ymd(iso: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()
}

/// The same day `delta` months on, clamped to the last day of a shorter month.
pub fn add_months(d: NaiveDate, delta: i32) -> NaiveDate {
    let total = d.year() * 12 + d.month0() as i32 + delta;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    let mut day = d.day();
    loop {
        if let Some(r) = NaiveDate::from_ymd_opt(y, m, day) {
            return r;
        }
        day -= 1;
    }
}

/// The 7-wide grid of a month: leading blanks to the first weekday (Sunday first), then each day.
pub fn month_cells(cursor: NaiveDate) -> Vec<Option<NaiveDate>> {
    let first = cursor.with_day(1).unwrap_or(cursor);
    let lead = first.weekday().num_days_from_sunday() as usize;
    let days = (add_months(first, 1) - first).num_days() as u32;
    let mut cells = vec![None; lead];
    cells.extend((1..=days).filter_map(|d| first.with_day(d)).map(Some));
    cells
}

pub struct DatePicker {
    id: SharedString,
    value: String,
    placeholder: &'static str,
    open: bool,
    cursor: NaiveDate,
    focus: FocusHandle,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl DatePicker {
    pub fn new(id: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        Self { id: id.into(), value: String::new(), placeholder: "No date", open: false, cursor: super::todos_logic::today(), focus: cx.focus_handle(), bounds: Rc::new(Cell::new(None)) }
    }

    pub fn set_value(&mut self, value: &str, cx: &mut Context<Self>) {
        if self.value != value {
            self.value = value.to_string();
            cx.notify();
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn open_panel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cursor = parse_ymd(&self.value).unwrap_or_else(super::todos_logic::today);
        self.open = true;
        window.focus(&self.focus);
        cx.notify();
    }

    fn commit(&mut self, value: String, cx: &mut Context<Self>) {
        self.value = value.clone();
        self.open = false;
        cx.emit(DateEvent::Change(value));
        cx.notify();
    }

    fn on_key(&mut self, ev: &KeyDownEvent, cx: &mut Context<Self>) {
        let step = |c: NaiveDate, days: i64| c + Duration::days(days);
        match ev.keystroke.key.as_str() {
            "escape" => self.open = false,
            "left" => self.cursor = step(self.cursor, -1),
            "right" => self.cursor = step(self.cursor, 1),
            "up" => self.cursor = step(self.cursor, -7),
            "down" => self.cursor = step(self.cursor, 7),
            "pageup" => self.cursor = add_months(self.cursor, -1),
            "pagedown" => self.cursor = add_months(self.cursor, 1),
            "enter" | "space" => {
                let v = super::todos_logic::iso(self.cursor);
                return self.commit(v, cx);
            }
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn panel(&self, flip: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let today = super::todos_logic::today();
        let selected = parse_ymd(&self.value);
        let nav = |id: &'static str, label: &'static str, delta: i32, m: Entity<Self>| {
            div()
                .id(id)
                .size(px(22.0))
                .rounded(px(6.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(15.0))
                .line_height(px(15.0))
                .text_color(col(hex(0xa9b1d6)))
                .cursor_pointer()
                .hover(|s| s.bg(col(rgba(122, 162, 247, 0.14))).text_color(col(TN_TEXT)))
                .on_click(move |_, _, app| {
                    m.update(app, |p, cx| {
                        p.cursor = add_months(p.cursor, delta);
                        cx.notify();
                    })
                })
                .child(label)
        };
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(6.0))
            .mb(px(8.0))
            .child(nav("date-prev", "\u{2039}", -1, me.clone()))
            .child(div().flex_1().text_center().text_size(px(12.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(format!("{} {}", MONTHS[self.cursor.month0() as usize], self.cursor.year())))
            .child(nav("date-next", "\u{203a}", 1, me.clone()));
        let mut weekdays = div().flex().flex_row().gap(px(2.0));
        for w in WEEKDAYS {
            weekdays = weekdays.child(div().flex_1().h(px(22.0)).flex().items_center().justify_center().text_size(px(10.0)).font_weight(FontWeight(700.0)).text_color(col(faint())).child(w));
        }
        let cells = month_cells(self.cursor);
        let mut grid = div().flex().flex_col().gap(px(2.0));
        for week in cells.chunks(7) {
            let mut row = div().flex().flex_row().gap(px(2.0));
            for i in 0..7 {
                let Some(Some(day)) = week.get(i) else {
                    row = row.child(div().flex_1().h(px(28.0)));
                    continue;
                };
                let day = *day;
                let (is_sel, is_today, is_cursor) = (selected == Some(day), day == today, day == self.cursor);
                let m = me.clone();
                let mut cell = div()
                    .id(SharedString::from(format!("date-day-{}", day.day())))
                    .flex_1()
                    .h(px(28.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(0, 0, 0, 0.0)))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(12.0))
                    .text_color(col(hex(0xa9b1d6)))
                    .cursor_pointer()
                    .on_click(move |_, _, app| m.update(app, |p, cx| p.commit(super::todos_logic::iso(day), cx)))
                    .child(day.day().to_string());
                cell = if is_sel { cell.hover(|s| s.bg(col(TN_BLUE)).text_color(col(hex(0x1a1b26)))) } else { cell.hover(|s| s.bg(col(rgba(122, 162, 247, 0.14))).text_color(col(TN_TEXT))) };
                if is_cursor {
                    cell = cell.border_color(col(rgba(122, 162, 247, 0.35)));
                }
                if is_today {
                    cell = cell.border_color(col(rgba(122, 162, 247, 0.45))).text_color(col(TN_BLUE));
                }
                if is_sel {
                    cell = cell.bg(col(TN_BLUE)).border_color(col(TN_BLUE)).text_color(col(hex(0x1a1b26))).font_weight(FontWeight(700.0));
                }
                row = row.child(cell);
            }
            grid = grid.child(row);
        }
        let foot_btn = |id: &'static str, label: &'static str, color: C, hover_bg: crate::css::C, hover_text: C| {
            div()
                .id(id)
                .px(px(10.0))
                .py(px(4.0))
                .rounded(px(6.0))
                .text_size(px(11.0))
                .line_height(px(14.0))
                .font_weight(FontWeight(600.0))
                .text_color(col(color))
                .cursor_pointer()
                .hover(move |s| s.bg(col(hover_bg)).text_color(col(hover_text)))
                .child(label)
        };
        let (m_today, m_clear) = (me.clone(), me.clone());
        let footer = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .mt(px(8.0))
            .pt(px(8.0))
            .border_t_1()
            .border_color(col(rgba(86, 95, 137, 0.25)))
            .child(foot_btn("date-today", "Today", TN_BLUE, rgba(122, 162, 247, 0.14), TN_BLUE).on_click(move |_, _, app| m_today.update(app, |p, cx| p.commit(super::todos_logic::iso(super::todos_logic::today()), cx))))
            .child(foot_btn("date-clear", "Clear", faint(), rgba(86, 95, 137, 0.16), hex(0xa9b1d6)).on_click(move |_, _, app| m_clear.update(app, |p, cx| p.commit(String::new(), cx))));
        let m_out = me.clone();
        let panel = list_surface()
            .id(SharedString::from(format!("{}-panel", self.id)))
            .absolute()
            .left_0()
            .w(px(PANEL_W))
            .p(px(10.0))
            .rounded(px(12.0))
            .track_focus(&self.focus)
            .on_mouse_down_out(move |_, _, app| {
                m_out.update(app, |p, cx| {
                    if p.open {
                        p.open = false;
                        cx.notify();
                    }
                })
            })
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| this.on_key(ev, cx)))
            .child(header)
            .child(weekdays)
            .child(grid)
            .child(footer);
        if flip { panel.bottom_full().mb(px(4.0)) } else { panel.top_full().mt(px(4.0)) }
    }
}

impl Render for DatePicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let label = parse_ymd(&self.value).map(|d| crate::locale::month_day(d.year(), d.month(), d.day(), true));
        let bounds = self.bounds.clone();
        let measure = canvas(move |b, _, _| bounds.set(Some(b)), |_, _, _, _| {}).absolute().top_0().left_0().size_full();
        let trigger = trigger_frame(self.open)
            .id(SharedString::from(format!("{}-trigger", self.id)))
            .relative()
            .gap(px(6.0))
            .pl(px(10.0))
            .pr(px(8.0))
            .py(px(6.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(col(TN_TEXT))
            .cursor_pointer()
            .hover(|s| s.border_color(col(rgba(122, 162, 247, 0.35))))
            .on_click(move |_, window, app| {
                me.update(app, |p, cx| {
                    if p.open {
                        p.open = false;
                        cx.notify();
                    } else {
                        p.open_panel(window, cx);
                    }
                })
            })
            .child(measure)
            .child(div().flex_1().min_w_0().truncate().text_color(col(if label.is_some() { TN_TEXT } else { dim() })).child(label.unwrap_or_else(|| self.placeholder.to_string())))
            .child(svg().path("gen/calendar.svg").size(px(13.0)).flex_shrink_0().text_color(col(faint())));
        let mut wrap = div().relative().w_full().child(trigger);
        if self.open {
            let flip = self.bounds.get().is_some_and(|b| f32::from(b.bottom()) + 4.0 + PANEL_H > f32::from(window.viewport_size().height));
            wrap = wrap.child(deferred(self.panel(flip, cx)).with_priority(4));
        }
        wrap
    }
}

#[cfg(test)]
mod tests {
    use super::{add_months, month_cells, parse_ymd, suggestions};

    #[test]
    fn suggestions_show_everything_for_an_exact_name_and_the_substring_hits_otherwise() {
        let o = vec!["Work".to_string(), "Home".to_string(), "Homework".to_string()];
        assert_eq!(suggestions(&o, "").len(), 3);
        assert_eq!(suggestions(&o, "home"), o);
        assert_eq!(suggestions(&o, "hom"), vec!["Home".to_string(), "Homework".to_string()]);
        assert_eq!(suggestions(&o, "ork"), vec!["Work".to_string(), "Homework".to_string()]);
        assert!(suggestions(&o, "zzz").is_empty());
    }

    #[test]
    fn months_clamp_to_the_last_day_and_cross_years() {
        let d = parse_ymd("2026-01-31").unwrap();
        assert_eq!(add_months(d, 1), parse_ymd("2026-02-28").unwrap());
        assert_eq!(add_months(d, 12), parse_ymd("2027-01-31").unwrap());
        assert_eq!(add_months(parse_ymd("2026-01-15").unwrap(), -1), parse_ymd("2025-12-15").unwrap());
    }

    #[test]
    fn the_grid_starts_on_the_weekday_of_the_first() {
        // 2026-11-01 is a Sunday: no blanks, 30 days.
        let cells = month_cells(parse_ymd("2026-11-09").unwrap());
        assert_eq!(cells.len(), 30);
        assert!(cells[0].is_some());
        // 2026-02-01 is a Sunday too; 2026-04-01 is a Wednesday: three blanks.
        let april = month_cells(parse_ymd("2026-04-10").unwrap());
        assert_eq!(april.iter().take_while(|c| c.is_none()).count(), 3);
        assert_eq!(april.len(), 3 + 30);
    }
}
