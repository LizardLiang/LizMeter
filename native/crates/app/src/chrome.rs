//! Window chrome: custom glass titlebar, root background and the NavSidebar.

use crate::css::{self, Fill, Spec, TRANSPARENT, linear, radial, rgba};
use crate::ui::*;
use gpui::*;

pub const NAV_ITEMS: [(&str, &str); 10] = [
    ("Timer", "icons/clock.svg"),
    ("History", "icons/list.svg"),
    ("Todos", "icons/check-square.svg"),
    ("Issues", "icons/issues.svg"),
    ("Claude", "icons/zap.svg"),
    ("Activity", "icons/activity.svg"),
    ("Music", "icons/music.svg"),
    ("Stats", "icons/chart.svg"),
    ("Tags", "icons/tag.svg"),
    ("Settings", "icons/gear.svg"),
];

/// `TomatoClock.module.scss .root` background: four radial glow blobs over a diagonal gradient.
pub fn root_background() -> Spec {
    Spec::rrect(0.0)
        .fill(radial(0.18, 0.25, &[(0.0, rgba(122, 162, 247, 0.07)), (0.48, TRANSPARENT)]))
        .fill(radial(0.82, 0.75, &[(0.0, rgba(187, 154, 247, 0.07)), (0.48, TRANSPARENT)]))
        .fill(radial(0.50, 1.05, &[(0.0, rgba(158, 206, 106, 0.04)), (0.42, TRANSPARENT)]))
        .fill(radial(0.70, 0.15, &[(0.0, rgba(125, 207, 255, 0.04)), (0.38, TRANSPARENT)]))
        .fill(linear(160.0, &[(0.0, css::hex(0x0d0e1a)), (0.55, css::hex(0x0b0c18)), (1.0, css::hex(0x080b16))]))
}

pub fn titlebar_glass() -> Glass {
    Glass::new(
        0.0,
        28.0,
        1.7,
        Spec::rrect(0.0)
            .fill(linear(180.0, &[(0.0, wh(0.05)), (1.0, TRANSPARENT)]))
            .solid(rgba(10, 11, 20, 0.84))
            .border_sides(0.0, 0.0, 1.0, 0.0, rgba(122, 162, 247, 0.07))
            .inset(0.0, 1.0, wh(0.06)),
    )
    .shadows(&[sh(0.0, 1.0, 0.0, wh(0.05)), sh(0.0, 2.0, 16.0, bk(0.35))])
}

pub fn sidebar_glass() -> Glass {
    Glass::new(
        0.0,
        28.0,
        1.7,
        Spec::rrect(0.0)
            .fill(linear(180.0, &[(0.0, wh(0.04)), (0.25, wh(0.01)), (0.5, TRANSPARENT)]))
            .fill(linear(180.0, &[(0.6, TRANSPARENT), (1.0, bk(0.08))]))
            .solid(rgba(10, 11, 20, 0.74))
            .border_sides(0.0, 1.0, 0.0, 0.0, rgba(122, 162, 247, 0.08))
            .inset(-1.0, 0.0, wh(0.02))
            .inset(0.0, 1.0, wh(0.06)),
    )
    .shadows(&[sh(1.0, 0.0, 0.0, wh(0.03))])
}

fn nav_active_spec() -> Spec {
    Spec::rrect(10.0)
        .fill(linear(135.0, &[(0.0, wh(0.10)), (0.55, TRANSPARENT)]))
        .solid(rgba(122, 162, 247, 0.10))
        .border(1.0, rgba(122, 162, 247, 0.22))
        .inset(0.0, 1.0, wh(0.14))
        .inset(0.0, -1.0, bk(0.10))
}

fn nav_active_hover_spec() -> Spec {
    Spec::rrect(10.0)
        .fill(linear(125.0, &[(0.0, wh(0.13)), (0.52, TRANSPARENT)]))
        .solid(rgba(122, 162, 247, 0.14))
        .border(1.0, rgba(122, 162, 247, 0.30))
        .inset(0.0, 1.0, wh(0.16))
        .inset(0.0, -1.0, bk(0.10))
}

fn nav_hover_spec() -> Spec {
    Spec::rrect(10.0).solid(rgba(122, 162, 247, 0.07)).border(1.0, rgba(122, 162, 247, 0.10))
}

fn nav_idle_spec() -> Spec {
    Spec::rrect(10.0).border(1.0, TRANSPARENT)
}

pub struct NavButton {
    pub index: usize,
    pub active: bool,
    pub hovered: bool,
    pub ever_hovered: bool,
    pub running_dot: Option<bool>,
    pub icon: &'static str,
    pub label: &'static str,
}

pub fn nav_button(b: NavButton, on_hover: impl Fn(bool, &mut Window, &mut App) + 'static, on_click: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let id = ElementId::Name(format!("nav-{}", b.index).into());
    let (icon_color, spec) = match (b.active, b.hovered) {
        (true, false) => (TN_BLUE, nav_active_spec()),
        (true, true) => (TN_BLUE, nav_active_hover_spec()),
        (false, true) => (TN_TEXT_DIM, nav_hover_spec()),
        (false, false) => (ICON_DIM, nav_idle_spec()),
    };
    let active_shadow = if b.active {
        let amt = if b.hovered { 0.16 } else { 0.12 };
        shadows(&[sh(0.0, 2.0, if b.hovered { 16.0 } else { 12.0 }, rgba(122, 162, 247, amt))])
    } else {
        vec![]
    };

    // Hover shifts the idle button 1px right (translateX(1px)).
    let shift = if b.hovered && !b.active { 1.0 } else { 0.0 };
    let mut btn = div()
        .id(id)
        .relative()
        .left(px(shift))
        .w(px(44.0))
        .h(px(44.0))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(10.0))
        .cursor_pointer()
        .on_hover(move |h, w, a| on_hover(*h, w, a))
        .on_click(move |_, w, a| on_click(w, a));
    if !active_shadow.is_empty() {
        btn = btn.shadow(active_shadow);
    }
    let base = if b.ever_hovered && !b.active {
        // Cross-fade between the idle and hover surfaces (transition 0.2s).
        let hovered = b.hovered;
        let overlay = div().absolute().top_0().left_0().size_full().child(layer(spec.clone()));
        let animated = animate(overlay, ElementId::Name(format!("navfade-{}-{}", b.index, hovered).into()), 200, false, ease(), 1.0, move |el, t| {
            el.opacity(if hovered { t } else { 1.0 - t })
        });
        div().absolute().top_0().left_0().size_full().child(animated)
    } else {
        div().absolute().top_0().left_0().size_full().child(layer(spec))
    };
    btn = btn.child(base).child(svg().path(b.icon).size(px(20.0)).text_color(col(icon_color)));

    if b.active {
        // Luminous active bar: left:-10px (relative to the button's padding box).
        btn = btn.child(
            div()
                .absolute()
                .left(px(-9.0))
                .top(px(11.0))
                .w(px(3.0))
                .h(px(22.0))
                .rounded_r(px(3.0))
                .bg(lin(180.0, TN_BLUE, TN_PURPLE))
                .shadow(shadows(&[sh(0.0, 0.0, 12.0, rgba(122, 162, 247, 0.6)), sh(0.0, 0.0, 20.0, rgba(122, 162, 247, 0.2))])),
        );
    }
    if let Some(running) = b.running_dot {
        let mut dot = div()
            .absolute()
            .top(px(9.0))
            .right(px(9.0))
            .size(px(6.0))
            .rounded_full()
            .border(px(1.5))
            .border_color(col(css::hex(0x0f0f1a)));
        dot = if running {
            dot.bg(col(TN_GREEN)).shadow(shadows(&[sh(0.0, 0.0, 6.0, rgba(158, 206, 106, 0.6))]))
        } else {
            dot.bg(col(TN_YELLOW))
        };
        btn = btn.child(dot);
    }
    if b.hovered {
        let label = b.label;
        let tip = Glass::new(
            7.0,
            12.0,
            1.0,
            Spec::rrect(7.0).solid(rgba(22, 24, 40, 0.88)).border(1.0, rgba(122, 162, 247, 0.14)),
        )
        .shadows(&[sh(0.0, 4.0, 20.0, bk(0.5))])
        .el()
        .absolute()
        .left(px(57.0))
        .top(px(9.0))
        .h(px(26.0))
        .px(px(11.0))
        .flex()
        .items_center()
        .text_color(col(TN_TEXT_DIM))
        .font_family(BTN_FONT)
        .text_size(px(11.0))
        .line_height(px(13.0))
        .font_weight(FontWeight(600.0))
        .child(spaced(label, 0.55));
        let tip = animate(tip, ElementId::Name(format!("tip-{}", b.index).into()), 180, false, ease(), 1.0, |el, t| {
            el.opacity(t).ml(px(-4.0 * (1.0 - t)))
        });
        btn = btn.child(deferred(div().absolute().top_0().left_0().child(tip)).with_priority(5));
    }
    btn
}

pub fn window_button(id: &'static str, icon: &'static str, area: WindowControlArea, danger: bool, hovered: bool) -> Stateful<Div> {
    let mut b = div()
        .id(id)
        .w(px(46.0))
        .h(px(31.0))
        .flex()
        .items_center()
        .justify_center()
        .window_control_area(area)
        .text_color(col(TN_TEXT_DIM));
    if hovered {
        b = if danger {
            b.bg(col(TN_RED)).text_color(col(css::hex(0xffffff)))
        } else {
            b.bg(col(TN_SURFACE)).text_color(col(TN_TEXT))
        };
    }
    b.child(svg().path(icon).size(px(10.0)).text_color(if danger && hovered { col(css::hex(0xffffff)) } else if hovered { col(TN_TEXT) } else { col(TN_TEXT_DIM) }))
}

pub fn titlebar(hover: Option<&'static str>) -> impl IntoElement {
    let glass = titlebar_glass().el();
    glass
        .absolute()
        .top_0()
        .left_0()
        .w_full()
        .h(px(32.0))
        .flex()
        .items_center()
        .justify_between()
        .window_control_area(WindowControlArea::Drag)
        .child(
            div()
                .pl(px(12.0))
                .flex()
                .flex_row()
                .font_family(UI_FONT)
                .text_size(px(12.0))
                .line_height(px(15.0))
                .font_weight(FontWeight(600.0))
                .text_color(col(TN_TEXT_DIM))
                .child(spaced("Liz", 0.5).text_color(col(TN_BLUE)))
                .child(spaced("Meter", 0.5)),
        )
        .child(
            div()
                .flex()
                .h(px(31.0))
                .child(window_button("wb-min", "icons/win-min.svg", WindowControlArea::Min, false, hover == Some("wb-min")))
                .child(window_button("wb-max", "icons/win-max.svg", WindowControlArea::Max, false, hover == Some("wb-max")))
                .child(window_button("wb-close", "icons/win-close.svg", WindowControlArea::Close, true, hover == Some("wb-close"))),
        )
}

#[allow(dead_code)]
pub fn fill_unused(_: Fill) {}
