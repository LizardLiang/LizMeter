//! Shared page controls: page shell, chips, buttons, tag and issue badges, glass inputs.

use crate::css::{hex, linear, rgba, Spec, C, TRANSPARENT};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{IssueProviderKind, Session, Tag};
use lizmeter_ui::text_input::{FieldStyle, TextField};

/// `styles/_mixins.scss` `page-container`: 32px 40px padding, centered, at most `max_w` wide.
pub fn page_shell(id: &'static str, max_w: f32, body: impl IntoElement) -> impl IntoElement {
    div().id(id).flex_1().h_full().overflow_y_scroll().child(div().mx_auto().w_full().max_w(px(max_w)).px(px(40.0)).py(px(32.0)).child(body))
}

/// `page-heading`: 13px / 700 / 0.14em, upper case.
pub fn page_heading(text: &str) -> Div {
    div().text_size(px(13.0)).line_height(px(17.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(spaced(&text.to_uppercase(), 1.82))
}

/// `section-label`: 11px / 700 / 0.12em, upper case.
pub fn section_heading(text: &str) -> Div {
    ui_text(11.0).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(spaced(&text.to_uppercase(), 1.32))
}

pub fn page_text(size: f32) -> Div {
    ui_text(size)
}

/// The glass card of History rows and Stats summaries (`radius` 14, blur 24, saturate 1.5).
pub fn card_glass(hover: bool) -> Glass {
    let (a, b, base, border) = if hover {
        (0.07, 0.05, rgba(18, 20, 42, 0.55), rgba(122, 162, 247, 0.2))
    } else {
        (0.05, 0.06, rgba(15, 17, 34, 0.48), rgba(41, 46, 66, 0.85))
    };
    Glass::new(
        14.0,
        24.0,
        1.5,
        Spec::rrect(14.0)
            .fill(linear(135.0, &[(0.0, wh(a)), (0.3, wh(0.01)), (0.55, TRANSPARENT)]))
            .fill(linear(315.0, &[(0.0, bk(b)), (0.35, TRANSPARENT)]))
            .solid(base)
            .border(1.0, border)
            .inset(0.0, 1.0, wh(0.08))
            .inset(1.0, 0.0, wh(0.04))
            .inset(0.0, -1.0, bk(0.12)),
    )
    .shadows(&[sh(0.0, 4.0, 16.0, bk(0.28))])
}

/// A glass card whose border brightens on hover (`.card:hover`).
pub fn hover_card() -> Div {
    card_glass(false).el().child(
        div().absolute().top_0().left_0().size_full().rounded(px(14.0)).border(px(1.0)).border_color(col(TRANSPARENT)).hover(|s| s.border_color(col(rgba(122, 162, 247, 0.2)))),
    )
}

/// Filter chip: pill with the glass look of `HistoryPage .chip`, blue when active.
pub fn chip(id: impl Into<ElementId>, label: &str, active: bool, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let (fill, border, color) = if active {
        (rgba(122, 162, 247, 0.14), rgba(122, 162, 247, 0.35), TN_BLUE)
    } else {
        (rgba(16, 18, 36, 0.4), rgba(41, 46, 66, 0.8), TN_TEXT_DIM)
    };
    Glass::new(16.0, 8.0, 1.0, Spec::rrect(16.0).solid(fill).border(1.0, border))
        .el()
        .id(id)
        .px(px(14.0))
        .h(px(32.0))
        .flex()
        .items_center()
        .cursor_pointer()
        .text_color(col(color))
        .font_weight(FontWeight(600.0))
        .text_size(px(13.0))
        .child(label.to_string())
        .hover(move |s| if active { s } else { s.text_color(col(TN_TEXT_DIM)) })
        .on_click(move |_, w, a| on_click(w, a))
}

/// Compact rounded-rect button of the Stats range chips / Load more (`radius` 8 or 10).
pub fn soft_button(id: impl Into<ElementId>, label: &str, active: bool, radius: f32, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let (fill, border, color) = if active {
        (rgba(122, 162, 247, 0.12), rgba(122, 162, 247, 0.3), TN_BLUE)
    } else {
        (rgba(16, 18, 36, 0.35), rgba(41, 46, 66, 0.8), TN_TEXT_DIM)
    };
    Glass::new(radius, 8.0, 1.0, Spec::rrect(radius).solid(fill).border(1.0, border))
        .el()
        .id(id)
        .cursor_pointer()
        .text_color(col(color))
        .on_click(move |_, w, a| on_click(w, a))
        .child(label.to_string())
}

pub fn parse_color(s: &str) -> C {
    let h = s.trim_start_matches('#');
    match h.get(..6).map(|d| u32::from_str_radix(d, 16)) {
        Some(Ok(v)) => hex(v),
        _ => TN_MUTED,
    }
}

pub const TAG_COLORS: [&str; 8] = ["#7aa2f7", "#bb9af7", "#7dcfff", "#9ece6a", "#f7768e", "#ff9e64", "#e0af68", "#c678dd"];

/// `TagBadge`: dot + name on a 15% tint, with an optional remove button.
pub fn tag_badge(tag: &Tag, on_remove: Option<Box<dyn Fn(&mut Window, &mut App)>>) -> Div {
    let color = parse_color(&tag.color);
    let mut b = div()
        .flex()
        .flex_row()
        .items_center()
        .flex_shrink_0()
        .gap(px(5.0))
        .pl(px(8.0))
        .pr(px(10.0))
        .py(px(3.0))
        .rounded(px(999.0))
        .bg(col(c_alpha(color, 0.15)))
        .text_color(col(color))
        .text_size(px(12.0))
        .line_height(px(17.0))
        .font_weight(FontWeight(600.0))
        .child(div().size(px(7.0)).rounded(px(999.0)).bg(col(color)))
        .child(tag.name.clone());
    if let Some(rm) = on_remove {
        b = b.pr(px(6.0)).child(
            div()
                .id(SharedString::from(format!("tag-rm-{}", tag.id)))
                .ml(px(2.0))
                .size(px(16.0))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(999.0))
                .text_size(px(11.0))
                .opacity(0.7)
                .cursor_pointer()
                .hover(|s| s.opacity(1.0))
                .on_click(move |_, w, a| rm(w, a))
                .child("\u{00d7}"),
        );
    }
    b
}

/// The identifier an issue badge shows, or `None` when the session has no linked issue.
pub fn issue_display_id(s: &Session) -> Option<String> {
    match (s.issue_provider, &s.issue_id, s.issue_number) {
        (Some(IssueProviderKind::Github | IssueProviderKind::Todo), Some(id), _) => Some(format!("#{id}")),
        (Some(_), Some(id), _) => Some(id.clone()),
        (None, _, Some(n)) => Some(format!("#{n}")),
        _ => None,
    }
}

/// `IssueBadge`: id + title chip; clickable when the session has a URL (opens the link) or links a todo.
pub fn issue_badge(s: &Session, live_title: Option<String>, on_click: Option<Box<dyn Fn(&mut Window, &mut App)>>) -> Option<Stateful<Div>> {
    let id = issue_display_id(s)?;
    let title = if s.issue_provider == Some(IssueProviderKind::Todo) { live_title.or_else(|| s.issue_title.clone()) } else { s.issue_title.clone() };
    let clickable = on_click.is_some();
    let mut b = div()
        .id(SharedString::from(format!("issue-{}", s.id)))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .px(px(9.0))
        .py(px(3.0))
        .max_w(px(360.0))
        .rounded(px(6.0))
        .border(px(1.0))
        .border_color(col(rgba(41, 46, 66, 0.9)))
        .bg(col(rgba(16, 18, 40, 0.4)))
        .text_size(px(12.0))
        .line_height(px(16.0))
        .child(div().flex_shrink_0().font_weight(FontWeight(700.0)).text_color(col(TN_BLUE)).child(id));
    if let Some(t) = title {
        b = b.child(div().truncate().text_color(col(TN_TEXT_DIM)).child(t));
    }
    if let Some(f) = on_click {
        b = b.cursor_pointer().hover(|s| s.border_color(col(rgba(122, 162, 247, 0.4)))).on_click(move |_, w, a| f(w, a));
    }
    let _ = clickable;
    Some(b)
}

/// Frame of a text field: the glass input look (`rgba(12,13,24,.55)` + 1px border) around a `TextField`.
pub fn input_frame(field: &Entity<TextField>, width: Option<f32>, focused: bool) -> Div {
    let border = if focused { rgba(122, 162, 247, 0.4) } else { rgba(41, 46, 66, 0.8) };
    let mut d = Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(12, 13, 24, 0.55)).border(1.0, border))
        .el()
        .px(px(12.0))
        .py(px(8.0))
        .child(field.clone());
    if let Some(w) = width {
        d = d.w(px(w)).flex_shrink_0();
    }
    d
}

/// A page text input: glass frame with the focus ring of the SCSS `.input:focus` rule
/// (`border-color` 50% blue and a 3px 8% blue ring).
pub fn glass_field(field: &Entity<TextField>, focused: bool, px_x: f32, px_y: f32) -> Div {
    let border = if focused { rgba(122, 162, 247, 0.5) } else { rgba(41, 46, 66, 0.8) };
    let mut d = Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(12, 13, 24, 0.55)).border(1.0, border)).el().px(px(px_x)).py(px(px_y)).min_w_0().child(field.clone());
    if focused {
        d = d.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 3.0, color: rgba(122, 162, 247, 0.08) }]));
    }
    d
}

pub fn field_style(size: f32) -> FieldStyle {
    FieldStyle::new(UI_FONT, size, (size * 1.3).round(), col(TN_TEXT))
}

/// Primary action button (`saveBtn`): blue fill, dark text.
pub fn primary_button(id: impl Into<ElementId>, label: &str, enabled: bool, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    let mut b = div()
        .id(id)
        .h(px(38.0))
        .px(px(24.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.0))
        .bg(col(TN_BLUE))
        .text_color(col(hex(0x1a1b26)))
        .font_family(BTN_FONT)
        .text_size(px(15.0))
        .font_weight(FontWeight(600.0))
        .child(label.to_string());
    if enabled {
        b = b.cursor_pointer().hover(|s| s.bg(col(hex(0x89b4f8)))).on_click(move |_, w, a| on_click(w, a));
    } else {
        b = b.opacity(0.5).cursor_not_allowed();
    }
    b
}

/// Outlined secondary button (`testTokenBtn`, `Skip`).
pub fn outline_button(id: impl Into<ElementId>, label: &str, on_click: impl Fn(&mut Window, &mut App) + 'static) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(30.0))
        .px(px(14.0))
        .flex()
        .items_center()
        .rounded(px(6.0))
        .border(px(1.0))
        .border_color(col(TN_MUTED))
        .text_color(col(TN_TEXT))
        .font_family(BTN_FONT)
        .text_size(px(13.0))
        .cursor_pointer()
        .hover(|s| s.border_color(col(TN_BLUE)).text_color(col(TN_BLUE)))
        .on_click(move |_, w, a| on_click(w, a))
        .child(label.to_string())
}

/// 20px color swatches (`TagColorPicker`): the chosen one gets a 2px light ring.
pub fn color_swatches(prefix: &'static str, selected: &str, on_pick: impl Fn(&str, &mut Window, &mut App) + Clone + 'static) -> Div {
    let mut row = div().flex().flex_row().flex_wrap().gap(px(6.0));
    for c in TAG_COLORS {
        let on = c.eq_ignore_ascii_case(selected);
        let pick = on_pick.clone();
        let color = parse_color(c);
        let mut swatch = div().id(SharedString::from(format!("{prefix}-{c}")));
        if on {
            swatch = swatch.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color }]));
        }
        row = row.child(
            swatch
                .size(px(20.0))
                .flex_shrink_0()
                .rounded(px(10.0))
                .bg(col(color))
                .border(px(2.0))
                .border_color(col(if on { TN_TEXT } else { TRANSPARENT }))
                .cursor_pointer()
                .hover(|s| s.opacity(0.85))
                .on_click(move |_, w, a| pick(c, w, a)),
        );
    }
    row
}

/// A line of dim body text (state messages).
pub fn state_message(text: impl Into<SharedString>, color: C, italic: bool) -> Div {
    let mut d = ui_text(13.0).text_color(col(color)).child(text.into());
    if italic {
        d = d.italic();
    }
    d
}
