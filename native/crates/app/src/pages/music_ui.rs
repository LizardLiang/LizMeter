//! Pieces shared by the Music page and its bar: glyph, popup and dialog looks, the bounds probe
//! that turns a mouse position into a bar fraction, and the glass buttons of the music CSS.

use crate::css::{linear, rgba, Spec, C, TRANSPARENT};
use crate::ui::*;
use gpui::*;
use lizmeter_ui::text_input::TextField;
use std::cell::Cell;
use std::rc::Rc;

pub type Probe = Rc<Cell<Option<Bounds<Pixels>>>>;

pub fn probe() -> Probe {
    Rc::new(Cell::new(None))
}

/// An invisible child that records the box of its parent while painting.
pub fn measure(p: &Probe) -> impl IntoElement {
    let p = p.clone();
    canvas(move |b, _, _| p.set(Some(b)), |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

/// Listens for the Escape key while it is painted (gpui allows window listeners only during paint).
pub fn on_escape(f: impl Fn(&mut App) + 'static) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            window.on_key_event(move |e: &KeyDownEvent, phase, _, app| {
                if phase == DispatchPhase::Bubble && e.keystroke.key == "escape" {
                    f(app);
                }
            });
        },
    )
    .absolute()
    .size_0()
}

/// Follows the left mouse button across the window while it is painted: `moved` on every move and
/// `released` on the button going up (the bars drag past their own edges).
pub fn on_drag_over_window(moved: impl Fn(Pixels, &mut App) + 'static, released: impl Fn(Pixels, &mut App) + 'static) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |_, _, window, _| {
            window.on_mouse_event(move |e: &MouseMoveEvent, phase, _, app| {
                if phase == DispatchPhase::Capture {
                    moved(e.position.x, app);
                }
            });
            window.on_mouse_event(move |e: &MouseUpEvent, phase, _, app| {
                if phase == DispatchPhase::Capture && e.button == MouseButton::Left {
                    released(e.position.x, app);
                }
            });
        },
    )
    .absolute()
    .size_0()
}

/// Where the mouse is along a bar, 0..=1.
pub fn fraction_in(bounds: Option<Bounds<Pixels>>, x: Pixels) -> f64 {
    let Some(b) = bounds else { return 0.0 };
    let w = f32::from(b.size.width);
    if w <= 0.0 {
        return 0.0;
    }
    (f64::from(f32::from(x - b.origin.x)) / f64::from(w)).clamp(0.0, 1.0)
}

pub fn ico(name: &str, w: f32, h: f32, color: C) -> Svg {
    svg().path(SharedString::from(format!("music/{name}.svg"))).w(px(w)).h(px(h)).flex_shrink_0().text_color(col(color))
}

/// The dark popup of the track menu and the speed list (`rgba(14,16,30,.95)`, blur 24, radius 10).
pub fn popup_glass() -> Div {
    let spec = Spec::rrect(10.0).solid(rgba(14, 16, 30, 0.95)).border(1.0, rgba(86, 95, 137, 0.35)).inset(0.0, 1.0, wh(0.05));
    Glass::new(10.0, 24.0, 1.6, spec).shadows(&[sh(0.0, 8.0, 32.0, bk(0.5)), sh(0.0, 2.0, 8.0, bk(0.3))]).el().p(px(4.0))
}

/// A row of the popup: 12px / 500, 7px 10px padding, radius 7.
pub fn menu_row(id: impl Into<ElementId>, label: &str, danger: bool) -> Stateful<Div> {
    let (color, hover_bg, hover_color) = if danger {
        (TN_RED, rgba(247, 118, 142, 0.1), TN_RED)
    } else {
        (TN_TEXT_DIM, rgba(122, 162, 247, 0.1), TN_TEXT)
    };
    div()
        .id(id)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .w_full()
        .px(px(10.0))
        .py(px(7.0))
        .rounded(px(7.0))
        .font_family(BTN_FONT)
        .text_size(px(12.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(500.0))
        .text_color(col(color))
        .cursor_pointer()
        .hover(move |s| s.bg(col(hover_bg)).text_color(col(hover_color)))
        .child(label.to_string())
}

pub fn menu_divider() -> Div {
    div().h(px(1.0)).mx(px(6.0)).my(px(4.0)).bg(col(rgba(86, 95, 137, 0.25)))
}

/// The confirm dialog of the music CSS (`clearDialog`, `deleteDialog`): 16px radius, 24x28 padding.
pub fn confirm_dialog(title: &str, text: String, actions: Div) -> Div {
    let spec = Spec::rrect(16.0)
        .fill(linear(135.0, &[(0.0, wh(0.07)), (0.32, wh(0.02)), (0.58, TRANSPARENT)]))
        .solid(rgba(20, 23, 42, 0.86))
        .border(1.0, rgba(122, 162, 247, 0.4))
        .inset(0.0, 1.0, wh(0.12));
    Glass::new(16.0, 36.0, 1.7, spec)
        .shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 1.0, color: bk(0.3) }, sh(0.0, 16.0, 40.0, bk(0.28))])
        .el()
        .min_w(px(320.0))
        .max_w(px(420.0))
        .px(px(28.0))
        .py(px(24.0))
        .flex()
        .flex_col()
        .font_family(UI_FONT)
        .child(div().text_size(px(15.0)).line_height(px(19.5)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).mb(px(8.0)).child(title.to_string()))
        .child(div().text_size(px(13.0)).line_height(px(19.5)).text_color(col(TN_TEXT_DIM)).mb(px(20.0)).child(text))
        .child(actions.flex().flex_row().justify_end().gap(px(10.0)))
}

/// `clearCancelBtn` / `deleteCancelBtn`.
pub fn dialog_cancel(id: &'static str, label: &str, enabled: bool) -> Stateful<Div> {
    let b = div()
        .id(id)
        .px(px(18.0))
        .py(px(8.0))
        .rounded(px(8.0))
        .border(px(1.0))
        .border_color(col(rgba(86, 95, 137, 0.3)))
        .font_family(BTN_FONT)
        .text_size(px(13.0))
        .line_height(px(15.0))
        .font_weight(FontWeight(500.0))
        .text_color(col(TN_TEXT_DIM))
        .child(label.to_string());
    if enabled { b.cursor_pointer().hover(|s| s.bg(col(wh(0.04)))) } else { b.opacity(0.7) }
}

/// `clearConfirmBtn` / `deleteConfirmBtn`.
pub fn dialog_danger(id: &'static str, label: &str, enabled: bool) -> Stateful<Div> {
    let b = div()
        .id(id)
        .px(px(18.0))
        .py(px(8.0))
        .rounded(px(8.0))
        .border(px(1.0))
        .border_color(col(rgba(247, 118, 142, 0.3)))
        .bg(col(rgba(247, 118, 142, 0.12)))
        .font_family(BTN_FONT)
        .text_size(px(13.0))
        .line_height(px(15.0))
        .font_weight(FontWeight(600.0))
        .text_color(col(TN_RED))
        .child(label.to_string());
    if enabled { b.cursor_pointer().hover(|s| s.bg(col(rgba(247, 118, 142, 0.2))).border_color(col(rgba(247, 118, 142, 0.5)))) } else { b.opacity(0.7) }
}

/// The small blue pill button of the page (`saveQueueConfirmBtn`, `addUrlBtn` and friends).
pub fn tint_button(id: impl Into<ElementId>, label: &str, size: f32, enabled: bool, radius: f32, pad: (f32, f32)) -> Stateful<Div> {
    let b = div()
        .id(id)
        .flex_shrink_0()
        .px(px(pad.0))
        .py(px(pad.1))
        .rounded(px(radius))
        .border(px(1.0))
        .border_color(col(rgba(122, 162, 247, 0.3)))
        .bg(col(rgba(122, 162, 247, 0.1)))
        .font_family(BTN_FONT)
        .text_size(px(size))
        .line_height(px((size * 1.15).round()))
        .font_weight(FontWeight(600.0))
        .text_color(col(TN_BLUE))
        .whitespace_nowrap()
        .child(label.to_string());
    if enabled { b.cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.18)))) } else { b.opacity(0.4).cursor_not_allowed() }
}

/// A ghost text button (`saveQueueCancelBtn`, `renameCancelBtn`).
pub fn ghost_button(id: impl Into<ElementId>, label: &str, size: f32, pad: (f32, f32)) -> Stateful<Div> {
    div()
        .id(id)
        .flex_shrink_0()
        .px(px(pad.0))
        .py(px(pad.1))
        .rounded(px(6.0))
        .border(px(1.0))
        .border_color(col(TRANSPARENT))
        .font_family(BTN_FONT)
        .text_size(px(size))
        .line_height(px((size * 1.15).round()))
        .text_color(col(TN_TEXT_DIM))
        .cursor_pointer()
        .hover(|s| s.text_color(col(TN_TEXT)))
        .child(label.to_string())
}

/// A text input in its own frame (`saveQueueInput`, `newPlaylistInput`, `addUrlInput`): `border` is
/// the resting colour, the focus ring is the same blue for all of them.
pub fn inline_input(field: &Entity<TextField>, focused: bool, radius: f32, pad: (f32, f32), border: C, blur: bool) -> Div {
    let border = if focused { rgba(122, 162, 247, 0.5) } else { border };
    Glass::new(radius, if blur { 8.0 } else { 0.0 }, 1.0, Spec::rrect(radius).solid(rgba(12, 13, 24, 0.5)).border(1.0, border)).el().px(px(pad.0)).py(px(pad.1)).min_w_0().flex_1().child(field.clone())
}

pub fn url_frame(focused: bool) -> Div {
    let border = if focused { rgba(122, 162, 247, 0.4) } else { rgba(41, 46, 66, 0.8) };
    let mut d = Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(12, 13, 24, 0.5)).border(1.0, border)).el();
    if focused {
        d = d.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 2.0, color: rgba(122, 162, 247, 0.08) }]));
    }
    d
}

#[cfg(test)]
mod tests {
    use super::fraction_in;
    use gpui::{point, px, size, Bounds};

    #[test]
    fn a_click_maps_to_a_fraction_of_the_bar() {
        let b = Bounds { origin: point(px(100.0), px(10.0)), size: size(px(200.0), px(4.0)) };
        assert_eq!(fraction_in(Some(b), px(100.0)), 0.0);
        assert_eq!(fraction_in(Some(b), px(200.0)), 0.5);
        assert_eq!(fraction_in(Some(b), px(400.0)), 1.0);
        assert_eq!(fraction_in(Some(b), px(0.0)), 0.0);
        assert_eq!(fraction_in(None, px(150.0)), 0.0);
    }
}
