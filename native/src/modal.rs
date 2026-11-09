//! IssuePromptDialog: blur overlay + glass dialog with the `modalEntrance` animation.

use crate::css::{Spec, TRANSPARENT, hex, linear, rgba};
use crate::ui::*;
use gpui::*;

fn mock_row(key: &str, title: &str, highlighted: bool) -> Div {
    let mut row = div()
        .w_full()
        .h(px(30.0))
        .px(px(12.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .font_family("Arial")
        .text_size(px(12.0))
        .text_color(col(TN_TEXT))
        .child(div().font_weight(FontWeight(600.0)).text_color(col(TN_BLUE)).child(key.to_string()))
        .child(div().text_size(px(12.0)).child(title.to_string()));
    if highlighted {
        row = row.bg(col(rgba(122, 162, 247, 0.07)));
    }
    row
}

fn chip(label: &str) -> Div {
    div()
        .h(px(18.0))
        .px(px(9.0))
        .rounded(px(9.0))
        .border(px(1.0))
        .border_color(col(rgba(41, 46, 66, 0.8)))
        .bg(col(rgba(16, 18, 40, 0.4)))
        .flex()
        .items_center()
        .font_family("Arial")
        .text_size(px(10.5))
        .font_weight(FontWeight(600.0))
        .text_color(col(TN_TEXT_DIM))
        .child(label.to_string())
}

fn section(label: &str, first: bool) -> Div {
    let mut d = ui_text(11.0)
        .px(px(4.0))
        .pt(px(4.0))
        .mb(px(8.0))
        .flex_shrink_0()
        .h(px(18.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(700.0))
        .text_color(col(TN_TEXT))
        .child(spaced(&label.to_uppercase(), 1.32));
    if !first {
        d = d.mt(px(12.0)).pt(px(12.0)).h(px(27.0)).border_t_1().border_color(col(rgba(86, 95, 137, 0.25)));
    }
    d
}

pub fn dialog() -> Div {
    let spec = Spec::rrect(18.0)
        .fill(linear(135.0, &[(0.0, wh(0.07)), (0.32, wh(0.01)), (0.55, TRANSPARENT)]))
        .fill(linear(315.0, &[(0.0, bk(0.08)), (0.40, TRANSPARENT)]))
        .solid(rgba(20, 23, 42, 0.55))
        .border(1.0, rgba(122, 162, 247, 0.4))
        .inset(0.0, 1.0, wh(0.12))
        .inset(1.0, 0.0, wh(0.05))
        .inset(0.0, -1.0, bk(0.15))
        .inset(-1.0, 0.0, bk(0.05));
    let mut shd = vec![Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }];
    shd.push(sh(0.0, 16.0, 40.0, bk(0.28)));
    Glass::new(18.0, 36.0, 1.7, spec)
        .shadows(&shd)
        .el()
        .w(px(420.0))
        .h(px(480.0))
        .flex_shrink_0()
        .flex()
        .flex_col()
        .overflow_hidden()
        .child(
            div()
                .relative()
                .h(px(62.0))
                .flex_shrink_0()
                .px(px(21.0))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(86, 95, 137, 0.3))))
                .child(
                    ui_text(15.0)
                        .line_height(px(19.0))
                        .font_weight(FontWeight(600.0))
                        .text_color(col(TN_TEXT))
                        .child("Link an issue (optional)"),
                )
                .child(
                    div()
                        .h(px(29.0))
                        .px(px(17.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(TN_MUTED))
                        .flex()
                        .items_center()
                        .font_family("Arial")
                        .text_size(px(13.0))
                        .text_color(col(TN_TEXT))
                        .child("Skip"),
                ),
        )
        .child(
            div()
                .flex_1()
                .p(px(8.0))
                .flex()
                .flex_col()
                .overflow_hidden()
                .child(section("Todos", true))
                .child(
                    div()
                        .relative()
                        .h(px(37.0))
                        .flex_shrink_0()
                        .px(px(12.0))
                        .flex()
                        .items_center()
                        .font_family("Arial")
                        .text_size(px(13.0))
                        .text_color(col(ICON_DIM))
                        .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(41, 46, 66, 0.8))))
                        .child("Search by title or #id\u{2026}"),
                )
                .child(
                    div()
                        .px(px(8.0))
                        .py(px(6.0))
                        .flex()
                        .flex_row()
                        .gap(px(4.0))
                        .children(["Backlog", "Todo", "Processing", "Testing", "Done", "Deprecated"].map(chip)),
                )
                .child(
                    div()
                        .h(px(220.0))
                        .flex_shrink_0()
                        .overflow_hidden()
                        .child(mock_row("#10", "Demo: created by me", true))
                        .child(mock_row("#9", "Demo: unknown agent (fallback)", false))
                        .child(mock_row("#8", "Demo: added by Codex", false))
                        .child(mock_row("#7", "Demo: added by Claude", false))
                        .child(mock_row("#6", "Demo: added by claude-code", false))
                        .child(mock_row("#5", "Demo: added by Codex", false))
                        .child(mock_row("#4", "Demo: added by Claude", false))
                        .child(mock_row("#3", "Demo: added by Claude", false)),
                )
                .child(section("Issue trackers", false))
                .child(
                    ui_text(13.0)
                        .py(px(24.0))
                        .px(px(20.0))
                        .text_center()
                        .text_color(col(TN_MUTED))
                        .child("No issue providers configured. Set up Linear or Jira in Settings."),
                ),
        )
}

/// Overlay (rgba(192,202,245,.06) + blur 16 / saturate 1.25) and the animated dialog, centered
/// in the overlay. In the Electron app the overlay's containing block is the glass card (a
/// `backdrop-filter` ancestor), so the overlay covers the card rather than the window.
pub fn overlay_and_dialog(_on_close: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let overlay = Glass::new(0.0, 16.0, 1.25, Spec::rrect(0.0).solid(rgba(192, 202, 245, 0.06)))
        .el()
        .absolute()
        .top(px(1.0))
        .left(px(1.0))
        .right(px(1.0))
        .bottom(px(1.0))
        .flex()
        .items_center()
        .justify_center();
    // modalEntrance 0.2s cubic-bezier(0.34, 1.56, 0.64, 1): opacity, translateY(8 -> 0), scale(.94 -> 1)
    let entrance = animate(div().relative().child(dialog()), "modal-entrance", 200, false, overshoot(), 1.0, |el, t| {
        el.opacity(t.clamp(0.0, 1.0)).top(px(8.0 * (1.0 - t)))
    });
    overlay.child(entrance)
}

#[allow(dead_code)]
fn unused() -> crate::css::C {
    hex(0)
}
