//! Effects gallery: every effect type in the app that the main screens do not already show.

use crate::css::{self, C, Spec, TRANSPARENT, hex, linear, rgba};
use crate::ui::*;
use crate::widget::{chamfer_points, glow_copies};
use gpui::*;

/// (blur px, saturate) combinations found by grepping `backdrop-filter` in the SCSS.
pub const LEVELS: [(f32, f32); 13] = [
    (8.0, 1.0),
    (12.0, 1.0),
    (16.0, 1.25),
    (18.0, 1.5),
    (20.0, 1.4),
    (20.0, 1.5),
    (24.0, 1.5),
    (24.0, 1.6),
    (28.0, 1.4),
    (28.0, 1.6),
    (28.0, 1.7),
    (32.0, 1.6),
    (36.0, 1.7),
];

pub const STRIPES: [u32; 6] = [0xf7768e, 0x7aa2f7, 0xe0af68, 0x9ece6a, 0xbb9af7, 0x7dcfff];

pub fn stripe_field(w: f32, h: f32) -> Div {
    let mut d = div().relative().w(px(w)).h(px(h)).flex().flex_row().rounded(px(8.0)).overflow_hidden();
    let n = (w / 14.0).ceil() as usize;
    for i in 0..n {
        d = d.child(div().w(px(14.0)).h_full().flex_shrink_0().bg(col(hex(STRIPES[i % STRIPES.len()]))));
    }
    d
}

fn small_label(text: &str) -> Div {
    ui_text(10.0).line_height(px(12.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT_DIM)).child(text.to_string())
}

fn heading(text: &str) -> Div {
    ui_text(11.0)
        .h(px(14.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(700.0))
        .text_color(col(TN_TEXT))
        .child(spaced(&text.to_uppercase(), 1.32))
}

fn level_cell(blur: f32, sat: f32) -> impl IntoElement {
    let label = if sat == 1.0 { format!("blur({blur}px)") } else { format!("blur({blur}px) saturate({sat})") };
    let tile = Glass::new(
        10.0,
        blur,
        sat,
        Spec::rrect(10.0).solid(rgba(16, 18, 36, 0.35)).border(1.0, rgba(122, 162, 247, 0.12)),
    )
    .el()
    .w(px(106.0))
    .h(px(46.0))
    .flex()
    .items_center()
    .justify_center()
    .text_align(TextAlign::Center)
    .child(ui_text(10.0).line_height(px(12.0)).w(px(96.0)).text_center().font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(label));
    stripe_field(146.0, 74.0).child(div().absolute().top(px(14.0)).left(px(20.0)).child(tile))
}

/// A one-shot keyframe demo cell. `p` is the progress of the active phase (0..1).
fn anim_cell(name: &'static str, dur: &str, demo: impl FnOnce() -> AnyElement) -> impl IntoElement {
    Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(12, 13, 24, 0.5)).border(1.0, rgba(41, 46, 66, 0.8)))
        .el()
        .w(px(128.0))
        .h(px(92.0))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(8.0))
        .child(div().h(px(40.0)).w_full().flex().items_center().justify_center().child(demo()))
        .child(small_label(name))
        .child(div().text_color(col(TN_MUTED)).font_family(UI_FONT).text_size(px(9.0)).line_height(px(12.0)).child(dur.to_string()))
}

/// Run a demo element through a CSS-like keyframe. `active_ms` plays, then it holds ~0.9s.
fn keyed<E: IntoElement + Styled + 'static>(
    el: E,
    id: &'static str,
    active_ms: u64,
    easing: impl Fn(f32) -> f32 + Clone + 'static,
    freeze_p: f32,
    f: impl Fn(E, f32) -> E + 'static,
) -> AnyElement {
    if let Some(ms) = anim_time() {
        return f(el, easing((ms / active_ms as f32).min(1.0))).into_any_element();
    }
    let period = active_ms + 900;
    let frac = active_ms as f32 / period as f32;
    animate(el, id, period, true, |t| t, freeze_p * frac, move |e, d| {
        let p = (d / frac).min(1.0);
        f(e, easing(p))
    })
}

fn chip(text: &str, scale: f32) -> Div {
    Glass::new(
        6.0 * scale,
        12.0,
        1.0,
        Spec::rrect(6.0 * scale).solid(rgba(122, 162, 247, 0.18)).border(1.0, rgba(122, 162, 247, 0.4)),
    )
    .el()
    .w(px(78.0 * scale))
    .h(px(28.0 * scale))
    .flex()
    .items_center()
    .justify_center()
    .text_color(col(TN_TEXT))
    .font_family(UI_FONT)
    .text_size(px(11.0 * scale))
    .child(text.to_string())
}

pub const ANIM_NAMES: [&str; 8] =
    ["spin", "fadeIn", "fade-in-up", "menuFadeIn", "modalEntrance", "placeholderBreath", "todoRowFlash", "dropHintEntrance"];

/// One keyframe demo cell, for the `--page anim:<name>` comparison captures.
pub fn anim_page(index: usize) -> impl IntoElement {
    let cell = keyframe_cells().into_iter().nth(index).expect("animation index");
    div().size_full().bg(col(TN_BG)).flex().items_center().justify_center().child(cell)
}

fn keyframe_cells() -> Vec<AnyElement> {
    let mut cells = Vec::new();
    cells.push(
        anim_cell("spin", "0.7s linear infinite", || {
            animate(
                svg().path("icons/spinner.svg").size(px(26.0)).text_color(col(TN_BLUE)),
                "g-spin",
                700,
                true,
                |t| t,
                0.125,
                |s, t| s.with_transformation(Transformation::rotate(percentage(t))),
            )
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("fadeIn", "0.2s ease-out", || {
            keyed(div().relative().child(chip("fadeIn", 1.0)), "g-fadein", 200, ease_out(), 0.5, |e, p| e.opacity(p).top(px(8.0 * (1.0 - p))))
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("fade-in-up", "0.28s ease", || {
            keyed(div().relative().child(chip("fade-in-up", 1.0)), "g-fiu", 280, ease(), 0.5, |e, p| e.opacity(p).top(px(10.0 * (1.0 - p))))
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("menuFadeIn", "0.12s ease-out", || {
            // scale(.95 -> 1) translateY(-4px -> 0): chip geometry scales with the keyframe.
            keyed(div().relative().h(px(28.0)).flex().items_center(), "g-menu", 120, ease_out(), 0.5, |e, p| {
                let s = 0.95 + 0.05 * p;
                e.opacity(p.clamp(0.0, 1.0)).top(px(-4.0 * s * (1.0 - p))).child(chip("menuFadeIn", s))
            })
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("modalEntrance", "0.2s cubic-bezier", || {
            keyed(div().relative().h(px(28.0)).flex().items_center(), "g-modal", 200, overshoot(), 0.5, |e, p| {
                let s = 0.94 + 0.06 * p;
                e.opacity(p.clamp(0.0, 1.0)).top(px(8.0 * s * (1.0 - p))).child(chip("modalEntrance", s))
            })
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("placeholderBreath", "4s ease-in-out", || {
            animate(
                div().font_family(UI_FONT).text_size(px(11.0)).text_color(col(ICON_DIM)).child("Describe\u{2026}"),
                "g-breath",
                4000,
                true,
                |t| t,
                0.5,
                |e, t| {
                    // 0%,100% -> .55 ; 50% -> .85, with `ease-in-out` restarting in each keyframe segment
                    let seg = if t < 0.5 { 2.0 * t } else { 2.0 * (1.0 - t) };
                    e.opacity(0.55 + 0.30 * ease_in_out_css()(seg))
                },
            )
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("todoRowFlash", "2s ease-out", || {
            let row = |e: Div, a_bg: f32, a_bar: f32| {
                e.bg(col(rgba(122, 162, 247, a_bg)))
                    .child(div().absolute().left_0().top_0().h_full().w(px(2.0)).bg(col(rgba(122, 162, 247, a_bar))))
            };
            let base = div().relative().w(px(104.0)).h(px(26.0)).flex().items_center().px(px(8.0)).font_family(UI_FONT).text_size(px(11.0)).text_color(col(TN_TEXT)).child("Todo row");
            // 0%,30% flash, then ease-out to transparent at 100%.
            keyed(base, "g-flash", 2000, |t| t, 0.6, move |e, p| {
                let q = ((p - 0.3) / 0.7).clamp(0.0, 1.0);
                let k = 1.0 - ease_out()(q);
                row(e, 0.28 * k, k)
            })
        })
        .into_any_element(),
    );
    cells.push(
        anim_cell("dropHintEntrance", "0.16s ease-out", || {
            keyed(div().relative().child(chip("drop here", 1.0)), "g-drop", 160, ease_out(), 0.5, |e, p| e.opacity(p).top(px(4.0 * (1.0 - p))))
        })
        .into_any_element(),
    );
    cells
}

fn shape_tile(w: f32, h: f32, name: &str, body: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .child(div().w(px(w)).h(px(h)).flex().items_center().justify_center().child(body))
        .child(small_label(name))
}

pub fn page() -> impl IntoElement {
    // mask / mask-composite: gradient ring, masked to the 1px padding box (widget border).
    let ring_w = 200.0;
    let ring_h = 72.0;
    let ring = div()
        .relative()
        .w(px(ring_w))
        .h(px(ring_h))
        .child(layer(
            Spec::polygon(chamfer_points(ring_w, ring_h, 10.0))
                .solid(rgba(8, 10, 22, 0.88))
                .ring(1.0, linear(135.0, &[(0.0, rgba(122, 162, 247, 0.9)), (0.5, rgba(187, 154, 247, 0.6)), (1.0, rgba(122, 162, 247, 0.8))])),
        ));
    let ring_flat = div().relative().w(px(ring_w)).h(px(ring_h)).child(layer(
        Spec::rrect(14.0).solid(rgba(8, 10, 22, 0.88)).ring(2.0, linear(135.0, &[(0.0, rgba(122, 162, 247, 0.9)), (0.5, rgba(187, 154, 247, 0.6)), (1.0, rgba(158, 206, 106, 0.8))])),
    ));
    let chamfer = div().relative().w(px(200.0)).h(px(72.0)).child(layer(
        Spec::polygon(chamfer_points(200.0, 72.0, 10.0))
            .fill(linear(170.0, &[(0.0, rgba(122, 162, 247, 0.5)), (0.4, rgba(187, 154, 247, 0.3)), (0.7, rgba(122, 162, 247, 0.1))]))
            .solid(rgba(8, 10, 22, 0.88)),
    ));
    let hex_pts = vec![(36.0, 0.0), (66.96, 18.0), (66.96, 54.0), (36.0, 72.0), (5.04, 54.0), (5.04, 18.0)];
    let hexagon = div().relative().w(px(72.0)).h(px(72.0)).child(layer(Spec::polygon(hex_pts).solid(rgba(122, 162, 247, 0.35))));
    let drop = {
        let glow: Vec<AnyElement> = glow_copies(4.0, rgba(122, 162, 247, 0.3 * 2.0), |c| {
            svg().path("icons/gear.svg").size(px(36.0)).text_color(col(c)).into_any_element()
        });
        div().relative().w(px(36.0)).h(px(36.0)).children(glow).child(svg().path("icons/gear.svg").size(px(36.0)).text_color(col(TN_BLUE)))
    };
    let text_shadow = {
        let make = |c: C| -> AnyElement {
            div()
                .font_family("Cascadia Code")
                .text_size(px(24.0))
                .line_height(px(24.0))
                .font_weight(FontWeight(700.0))
                .text_color(col(c))
                .child("24:59")
                .into_any_element()
        };
        let glow = glow_copies(12.0, rgba(122, 162, 247, 0.2), &make);
        div().relative().h(px(24.0)).w(px(80.0)).children(glow).child(make(TN_TEXT))
    };

    let mut level_rows = div().flex().flex_col().gap(px(8.0));
    for chunk in LEVELS.chunks(7) {
        let mut r = div().flex().flex_row().gap(px(8.0));
        for (b, s) in chunk {
            r = r.child(level_cell(*b, *s));
        }
        level_rows = level_rows.child(r);
    }
    let mut anim_row = div().flex().flex_row().gap(px(8.0));
    for c in keyframe_cells() {
        anim_row = anim_row.child(c);
    }

    div()
        .size_full()
        .p(px(24.0))
        .flex()
        .flex_col()
        .gap(px(10.0))
        .child(ui_text(13.0).h(px(16.0)).font_weight(FontWeight(700.0)).text_color(col(TN_TEXT)).child(spaced("EFFECTS GALLERY", 1.82)))
        .child(heading("backdrop-filter levels"))
        .child(level_rows)
        .child(div().mt(px(6.0)).child(heading("@keyframes (all 8)")))
        .child(anim_row)
        .child(div().mt(px(6.0)).child(heading("mask / mask-composite, clip-path, drop-shadow, text-shadow")))
        .child(
            div()
                .flex()
                .flex_row()
                .gap(px(14.0))
                .child(shape_tile(200.0, 72.0, "mask exclude 1px ring + chamfer", ring))
                .child(shape_tile(200.0, 72.0, "mask exclude 2px ring", ring_flat))
                .child(shape_tile(200.0, 72.0, "clip-path: chamfer polygon", chamfer))
                .child(shape_tile(72.0, 72.0, "clip-path: hexagon", hexagon))
                .child(shape_tile(60.0, 72.0, "drop-shadow 4px", drop))
                .child(shape_tile(90.0, 72.0, "text-shadow 12px", text_shadow)),
        )
}

#[allow(dead_code)]
fn _unused() -> C {
    TRANSPARENT
}
#[allow(dead_code)]
fn _css() {
    let _ = css::TRANSPARENT;
}

pub const SAMPLE_TEXT: &str = "The quick brown fox jumps over the lazy dog 0123456789 \u{4f60}\u{597d}\u{4e16}\u{754c}";

/// (size px, weight, color) rows of the text-contrast comparison page; `tools/textsample.html` mirrors it.
pub const SAMPLE_ROWS: [(f32, f32, u32); 7] = [
    (12.0, 400.0, 0xa9b1d6),
    (13.0, 400.0, 0xc0caf5),
    (14.0, 400.0, 0xc0caf5),
    (14.0, 400.0, 0x565f89),
    (12.0, 400.0, 0x7a8194),
    (13.0, 600.0, 0xc0caf5),
    (15.0, 400.0, 0xc0caf5),
];

/// Plain text rows on the app background, for pixel comparison against Chromium.
pub fn text_sample() -> impl IntoElement {
    let mut col_el = div().size_full().bg(col(TN_BG)).font_family(UI_FONT).pl(px(20.0)).pt(px(20.0)).flex().flex_col();
    for (size, weight, color) in SAMPLE_ROWS {
        col_el = col_el.child(
            div()
                .h(px(30.0))
                .line_height(px(30.0))
                .text_size(px(size))
                .font_weight(FontWeight(weight))
                .text_color(col(hex(color)))
                .child(SAMPLE_TEXT),
        );
    }
    col_el
}

/// Emoji row used to compare colour-glyph rendering with Chromium (`tools/emoji.html`).
pub fn emoji_sample() -> impl IntoElement {
    div()
        .size_full()
        .bg(col(TN_BG))
        .pl(px(20.0))
        .pt(px(20.0))
        .child(div().h(px(48.0)).line_height(px(48.0)).text_size(px(32.0)).font_family("Segoe UI Emoji").text_color(col(TN_TEXT)).child("\u{1F345} \u{1F600} \u{2764}\u{FE0F} \u{1F44D} \u{1F680} \u{1F525}"))
        .child(div().h(px(48.0)).line_height(px(48.0)).text_size(px(14.0)).font_family("Segoe UI Emoji").text_color(col(TN_TEXT)).child("\u{1F345} \u{1F600} \u{2764}\u{FE0F} \u{1F44D} \u{1F680} \u{1F525} inline 14px"))
}
