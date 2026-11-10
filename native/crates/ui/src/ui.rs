//! Shared UI building blocks: palette, fonts, glass surfaces, spaced text, animation helpers.

use crate::css::{self, C, Spec, hex, rgba};
use gpui::*;
use std::time::Duration;

pub const UI_FONT: &str = "Microsoft JhengHei UI";
pub const BTN_FONT: &str = "Arial";
pub const MONO: &str = "Cascadia Code";

// Tokyo Night palette (index.html :root)
pub const TN_BG: C = hex(0x1a1b2e);
pub const TN_SURFACE: C = hex(0x1f2335);
pub const TN_TEXT: C = hex(0xc0caf5);
pub const TN_TEXT_DIM: C = hex(0xa9b1d6);
pub const TN_MUTED: C = hex(0x565f89);
pub const TN_BLUE: C = hex(0x7aa2f7);
pub const TN_PURPLE: C = hex(0xbb9af7);
pub const TN_GREEN: C = hex(0x9ece6a);
pub const TN_YELLOW: C = hex(0xe0af68);
pub const TN_RED: C = hex(0xf7768e);
pub const TN_CYAN: C = hex(0x7dcfff);
pub const ICON_DIM: C = hex(0x7a8194);

pub fn col(c: C) -> Hsla {
    Hsla::from(c.to_gpui())
}

/// Set once from `--freeze`: animations render a fixed frame so screenshots are deterministic.
pub static FREEZE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub const FREEZE_T: f32 = 0.55;

/// `--anim-time <ms>`: every animation renders the state it has `ms` after it started (u32::MAX = unset).
pub static ANIM_TIME: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(u32::MAX);

pub fn anim_time() -> Option<f32> {
    match ANIM_TIME.load(std::sync::atomic::Ordering::Relaxed) {
        u32::MAX => None,
        ms => Some(ms as f32),
    }
}

/// `--scroll <px>`: page bodies render scrolled by this much, so a screenshot reaches a long page's lower parts.
pub static CAPTURE_SCROLL: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

pub fn frozen() -> bool {
    FREEZE.load(std::sync::atomic::Ordering::Relaxed)
}

#[derive(Clone, Copy)]
pub struct Sh {
    pub dx: f32,
    pub dy: f32,
    pub blur: f32,
    pub spread: f32,
    pub color: C,
}

pub fn sh(dx: f32, dy: f32, blur: f32, color: C) -> Sh {
    Sh { dx, dy, blur, spread: 0.0, color }
}

/// CSS box-shadow list -> gpui shadows. CSS blur radius B has a Gaussian sigma of B / 2.
pub fn shadows(list: &[Sh]) -> Vec<BoxShadow> {
    list.iter()
        .map(|s| BoxShadow {
            color: col(s.color),
            offset: point(px(s.dx), px(s.dy)),
            blur_radius: px(s.blur / 2.0),
            spread_radius: px(s.spread),
        })
        .collect()
}

/// Absolutely positioned rasterized background (see `css.rs`).
pub fn layer(spec: Spec) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let scale = window.scale_factor();
            let img = css::image_for(&spec, f32::from(bounds.size.width), f32::from(bounds.size.height), scale);
            let _ = window.paint_image(bounds, Corners::default(), img, 0, false);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

/// A glass element: outer shadows, backdrop blur+saturate, rasterized translucent fill, content.
pub struct Glass {
    pub radius: f32,
    pub blur: f32,
    pub saturate: f32,
    pub spec: Spec,
    pub shadows: Vec<Sh>,
    pub chamfer: f32,
}

impl Glass {
    pub fn new(radius: f32, blur: f32, saturate: f32, spec: Spec) -> Self {
        Self { radius, blur, saturate, spec, shadows: vec![], chamfer: 0.0 }
    }
    pub fn shadows(mut self, s: &[Sh]) -> Self {
        self.shadows = s.to_vec();
        self
    }
    pub fn chamfer(mut self, c: f32) -> Self {
        self.chamfer = c;
        self
    }
    pub fn el(self) -> Div {
        let mut d = div().relative().rounded(px(self.radius));
        if self.blur > 0.0 {
            d = if self.chamfer > 0.0 {
                d.backdrop_filter_chamfered(px(self.blur), self.saturate, px(self.chamfer))
            } else {
                d.backdrop_filter(px(self.blur), self.saturate)
            };
        }
        if !self.shadows.is_empty() {
            d = d.shadow(shadows(&self.shadows));
        }
        d.child(layer(self.spec))
    }
}

pub fn ui_text(size: f32) -> Div {
    div().font_family(UI_FONT).text_size(px(size)).line_height(px((size * 1.3).round()))
}

pub fn text_weight(d: Div, w: f32) -> Div {
    d.font_weight(FontWeight(w))
}

/// Text with CSS `letter-spacing` (gpui has none): glyphs are shaped one by one and painted at
/// fractional offsets with `spacing` added after every glyph, like Chromium does.
pub struct SpacedText {
    text: SharedString,
    spacing: f32,
}

impl IntoElement for SpacedText {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

fn shape_each(text: &str, window: &mut Window) -> (Vec<ShapedLine>, Pixels) {
    let style = window.text_style();
    let size = style.font_size.to_pixels(window.rem_size());
    let line_h = style.line_height_in_pixels(window.rem_size());
    let lines = text
        .chars()
        .map(|ch| {
            let s = ch.to_string();
            let run = style.to_run(s.len());
            window.text_system().shape_line(SharedString::from(s), size, &[run], None)
        })
        .collect();
    (lines, line_h)
}

impl Element for SpacedText {
    type RequestLayoutState = (Vec<ShapedLine>, Pixels);
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let (lines, line_h) = shape_each(&self.text, window);
        let width: f32 = lines.iter().map(|l| f32::from(l.width) + self.spacing).sum();
        let mut style = Style::default();
        style.size.width = px(width).into();
        style.size.height = line_h.into();
        style.flex_shrink = 0.0;
        let id = window.request_layout(style, [], cx);
        (id, (lines, line_h))
    }
    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _state: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) {
    }
    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        _prepaint: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let mut x = bounds.origin.x;
        for line in &state.0 {
            let _ = line.paint(point(x, bounds.origin.y), state.1, window, cx);
            x += line.width + px(self.spacing);
        }
    }
}

pub fn spaced(text: &str, spacing: f32) -> Div {
    div().flex_shrink_0().child(SpacedText { text: SharedString::from(text.to_string()), spacing })
}

/// Linear gpui gradient helper from CSS-like angle.
pub fn lin(deg: f32, a: C, b: C) -> Background {
    // gpui's angle is measured from the vertical axis like CSS `deg`.
    linear_gradient(deg, linear_color_stop(col(a), 0.0), linear_color_stop(col(b), 1.0))
}

/// Run `f` with an animation progress. In freeze mode, applies `f(frozen_t)` with no animation.
pub fn animate<E: IntoElement + 'static + Styled>(
    el: E,
    id: impl Into<ElementId>,
    duration_ms: u64,
    repeat: bool,
    easing: impl Fn(f32) -> f32 + 'static,
    freeze_t: f32,
    f: impl Fn(E, f32) -> E + 'static,
) -> AnyElement {
    if let Some(ms) = anim_time() {
        let d = duration_ms as f32;
        let t = if repeat { (ms % d) / d } else { (ms / d).min(1.0) };
        return f(el, easing(t)).into_any_element();
    }
    if frozen() {
        return f(el, easing(freeze_t)).into_any_element();
    }
    el.with_animation(id, gpui_animation(duration_ms, repeat), move |e, delta| f(e, easing(delta))).into_any_element()
}

/// The animation gpui runs: linear, so the progress it hands over stays inside 0..1. gpui asserts
/// that an easing returns 0..1 in debug builds, and `overshoot` (cubic-bezier y1 = 1.56) rises
/// above 1 on purpose, so the easing is applied by `animate` to the linear progress instead.
pub fn gpui_animation(duration_ms: u64, repeat: bool) -> Animation {
    let anim = Animation::new(Duration::from_millis(duration_ms));
    if repeat { anim.repeat() } else { anim }
}

/// Cubic-bezier easing (CSS `cubic-bezier(x1, y1, x2, y2)`).
pub fn bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 + Clone {
    move |t: f32| {
        // Solve x(s) = t for s with Newton + bisection, then return y(s).
        let cx = 3.0 * x1;
        let bx = 3.0 * (x2 - x1) - cx;
        let ax = 1.0 - cx - bx;
        let cy = 3.0 * y1;
        let by = 3.0 * (y2 - y1) - cy;
        let ay = 1.0 - cy - by;
        let sx = |s: f32| ((ax * s + bx) * s + cx) * s;
        let sy = |s: f32| ((ay * s + by) * s + cy) * s;
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        let mut s = t;
        for _ in 0..24 {
            let x = sx(s);
            if (x - t).abs() < 1e-5 {
                break;
            }
            if x < t {
                lo = s;
            } else {
                hi = s;
            }
            s = (lo + hi) * 0.5;
        }
        sy(s)
    }
}

pub fn ease() -> impl Fn(f32) -> f32 + Clone {
    bezier(0.25, 0.1, 0.25, 1.0)
}
pub fn ease_out() -> impl Fn(f32) -> f32 + Clone {
    bezier(0.0, 0.0, 0.58, 1.0)
}
pub fn ease_in_out_css() -> impl Fn(f32) -> f32 + Clone {
    bezier(0.42, 0.0, 0.58, 1.0)
}
pub fn overshoot() -> impl Fn(f32) -> f32 + Clone {
    bezier(0.34, 1.56, 0.64, 1.0)
}

pub fn c_alpha(c: C, a: f32) -> C {
    C(c.0, c.1, c.2, a)
}

pub fn wh(a: f32) -> C {
    rgba(255, 255, 255, a)
}
pub fn bk(a: f32) -> C {
    rgba(0, 0, 0, a)
}

#[cfg(test)]
mod animation_tests {
    use super::{gpui_animation, overshoot};

    fn samples() -> impl Iterator<Item = f32> {
        (0..=100).map(|i| i as f32 / 100.0)
    }

    #[test]
    fn overshoot_rises_above_one_by_design() {
        let e = overshoot();
        assert!(samples().any(|t| e(t) > 1.0), "the CSS overshoot curve must exceed 1");
    }

    #[test]
    fn gpui_never_sees_a_progress_outside_zero_to_one() {
        for repeat in [false, true] {
            let anim = gpui_animation(200, repeat);
            for t in samples() {
                let d = (anim.easing)(t);
                assert!((0.0..=1.0).contains(&d), "gpui would assert on {d} at t={t}");
            }
        }
    }

    #[test]
    fn the_modal_entrance_still_overshoots() {
        let e = overshoot();
        let lin = gpui_animation(200, false);
        assert!(samples().any(|t| e((lin.easing)(t)) > 1.0));
    }
}
