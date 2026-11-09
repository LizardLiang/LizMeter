//! Building blocks of the Settings page: the SCSS classes of `SettingsPage.module.scss` as functions.

use crate::controls::*;
use crate::css::{hex, rgba, Spec, C};
use crate::ui::*;
use gpui::*;
use lizmeter_ui::text_input::{FieldStyle, TextField};

pub const CODE_FONT: &str = "Consolas";

/// `.label`: 13px / 600 / 0.04em.
pub fn label(text: &str) -> Div {
    ui_text(13.0).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT_DIM)).child(spaced(text, 0.52))
}

/// A label that wraps inside a `.field` row: each word group of the browser's wrap is a line.
pub fn label_lines(lines: &[&str]) -> Div {
    let mut d = div().flex().flex_col().flex_shrink_0();
    for l in lines {
        d = d.child(label(l));
    }
    d
}

/// A long path under `word-break: break-all`: `width` characters per line.
pub fn break_all(text: &str, width: usize) -> Div {
    let chars: Vec<char> = text.chars().collect();
    let mut d = hint().flex().flex_col();
    for chunk in chars.chunks(width) {
        d = d.child(chunk.iter().collect::<String>());
    }
    d
}

/// `.tokenHint`: 11px, dim.
pub fn hint() -> Div {
    ui_text(11.0).text_color(col(TN_TEXT_DIM))
}

/// `<code>` inside a hint.
pub fn code(text: &str) -> AnyElement {
    div().px(px(4.0)).py(px(1.0)).rounded(px(3.0)).bg(col(TN_SURFACE)).text_color(col(TN_BLUE)).font_family(CODE_FONT).text_size(px(11.0)).line_height(px(12.0)).child(text.to_string()).into_any_element()
}

pub fn error_text(text: impl Into<SharedString>) -> Div {
    ui_text(12.0).mb(px(12.0)).text_color(col(TN_RED)).child(text.into())
}

pub fn success_text(text: impl Into<SharedString>) -> Div {
    ui_text(12.0).text_color(col(TN_GREEN)).child(text.into())
}

/// `.sectionDivider` + `.sectionHeading` (the first section has no divider above it).
pub fn section(title: &str, divider: bool) -> Div {
    let mut s = div().flex().flex_col();
    if divider {
        s = s.child(div().h(px(1.0)).mt(px(28.0)).mb(px(24.0)).bg(col(rgba(122, 162, 247, 0.07))));
    }
    s.child(ui_text(11.0).mb(px(16.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT_DIM)).child(spaced(&title.to_uppercase(), 1.76)))
}

/// `.saveBtn`: solid blue, 14px / 700, the browser's button font.
pub fn save_button(id: impl Into<ElementId>, text: &str, enabled: bool, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let b = div()
        .id(id)
        .mt(px(8.0))
        .px(px(24.0))
        .py(px(10.0))
        .flex()
        .flex_row()
        .justify_center()
        .rounded(px(6.0))
        .bg(col(TN_BLUE))
        .text_color(col(hex(0x1a1b26)))
        .font_family(BTN_FONT)
        .text_size(px(14.0))
        .line_height(px(16.0))
        .font_weight(FontWeight(700.0))
        .child(text.to_string());
    if enabled {
        b.cursor_pointer().on_click(move |_, w, a| on_click(w, a))
    } else {
        b.opacity(0.7)
    }
}

/// `.testTokenBtn` / `.removeTokenBtn`: outlined, tinted text, 12px.
pub fn ghost_button(id: impl Into<ElementId>, text: &str, color: C, enabled: bool, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let b = div()
        .id(id)
        .px(px(12.0))
        .py(px(5.0))
        .rounded(px(6.0))
        .border(px(1.0))
        .border_color(col(c_alpha(color, 0.25)))
        .flex()
        .items_center()
        .text_color(col(color))
        .font_family(BTN_FONT)
        .text_size(px(12.0))
        .line_height(px(14.0))
        .child(text.to_string());
    if enabled {
        b.cursor_pointer().hover(move |s| s.bg(col(c_alpha(color, 0.063)))).on_click(move |_, w, a| on_click(w, a))
    } else {
        b.opacity(0.7)
    }
}

/// A 16px checkbox with the page accent, and its 13px label.
pub fn checkbox(id: impl Into<ElementId>, checked: bool, text: &str, on_toggle: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let mut boxed = div().size(px(16.0)).flex_shrink_0().rounded(px(3.0)).flex().items_center().justify_center();
    boxed = if checked {
        boxed.bg(col(TN_BLUE)).text_color(col(hex(0x202020))).text_size(px(13.0)).line_height(px(13.0)).font_weight(FontWeight(700.0)).child("\u{2713}")
    } else {
        boxed.bg(col(hex(0xffffff))).border(px(1.0)).border_color(col(hex(0x767676)))
    };
    div()
        .id(id)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .mb(px(4.0))
        .py(px(1.0))
        .cursor_pointer()
        .on_click(move |_, w, a| on_toggle(w, a))
        .child(div().ml(px(4.0)).mr(px(3.0)).child(boxed))
        .child(ui_text(13.0).text_color(col(TN_TEXT_DIM)).child(text.to_string()))
}

/// `.segmentedControl`: a glass strip of equal buttons, the chosen one tinted blue.
pub fn segmented(prefix: &'static str, items: &[(String, bool)], on_pick: impl Fn(usize, &mut Window, &mut App) + Clone + 'static) -> Div {
    let mut row = Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(12, 13, 24, 0.45)).border(1.0, rgba(41, 46, 66, 0.8))).el().flex().flex_row().overflow_hidden().mb(px(4.0));
    for (i, (text, on)) in items.iter().enumerate() {
        let pick = on_pick.clone();
        let mut b = div()
            .id(SharedString::from(format!("{prefix}-{i}")))
            .flex_1()
            .min_w_0()
            .px(px(12.0))
            .py(px(7.0))
            .flex()
            .items_center()
            .justify_center()
            .text_center()
            .font_family(BTN_FONT)
            .text_size(px(12.0))
            .line_height(px(14.0))
            .font_weight(FontWeight(600.0))
            .cursor_pointer()
            .on_click(move |_, w, a| pick(i, w, a))
            .child(text.clone());
        b = if *on { b.bg(col(rgba(122, 162, 247, 0.125))).text_color(col(TN_BLUE)) } else { b.text_color(col(TN_TEXT_DIM)) };
        row = row.child(b);
    }
    row
}

/// `.tokenInput`: a full-width glass input (14px, 9px 12px padding).
pub fn token_frame(field: &Entity<TextField>, focused: bool) -> Div {
    glass_field(field, focused, 12.0, 10.0).w_full()
}

/// The text style of a token input: 14px with the `#7a8194` placeholder.
pub fn token_style() -> FieldStyle {
    let mut s = FieldStyle::new(BTN_FONT, 14.0, 16.0, col(TN_TEXT));
    s.placeholder_color = col(ICON_DIM);
    s
}

/// `.input`: the 15px / 600 right-aligned number box.
pub fn number_style() -> FieldStyle {
    let mut s = FieldStyle::new(BTN_FONT, 15.0, 17.0, col(TN_TEXT));
    s.weight = FontWeight(600.0);
    s
}

/// A `.field` row: the label on the left, the control on the right.
pub fn field_row(left: impl IntoElement, right: impl IntoElement) -> Div {
    div().flex().flex_row().items_center().justify_between().mb(px(16.0)).child(left).child(right)
}

/// A label with its value stacked under it (`.field` holding a label and a hint).
pub fn field_stack(title: &str, body: impl IntoElement) -> Div {
    div().flex().flex_col().mb(px(16.0)).child(label(title)).child(div().mt(px(6.0)).child(body))
}
