//! Desktop widget: frameless, transparent, always-on-top holographic HUD (Widget.module.scss).

use crate::css::{self, Spec, TRANSPARENT, linear, rgba};
use crate::timer::Status;
use crate::ui::*;
use gpui::*;
use std::time::{Duration, Instant};

pub fn chamfer_points(w: f32, h: f32, c: f32) -> Vec<(f32, f32)> {
    vec![(c, 0.0), (w - c, 0.0), (w, c), (w, h - c), (w - c, h), (c, h), (0.0, h - c), (0.0, c)]
}

/// Gaussian text glow (`text-shadow: 0 0 <blur> color`): weighted copies on a grid.
pub fn glow_copies(blur: f32, color: css::C, build: impl Fn(css::C) -> AnyElement) -> Vec<AnyElement> {
    let sigma = blur / 2.0;
    let step = (sigma * 0.4).max(0.4);
    let n = 4i32;
    let mut weights = Vec::new();
    let mut total = 0.0;
    for iy in -n..=n {
        for ix in -n..=n {
            let (dx, dy) = (ix as f32 * step, iy as f32 * step);
            let w = (-(dx * dx + dy * dy) / (2.0 * sigma * sigma)).exp();
            weights.push((dx, dy, w));
            total += w;
        }
    }
    // Each copy carries alpha a_i so that the stack's peak coverage ~ color.a * (w_i / max_w_sum).
    weights
        .into_iter()
        .map(|(dx, dy, w)| {
            let a = color.3 * (w / total) * 3.4;
            div()
                .absolute()
                .left(px(dx))
                .top(px(dy))
                .child(build(css::C(color.0, color.1, color.2, a.min(1.0))))
                .into_any_element()
        })
        .collect()
}

pub struct Widget {
    status: Status,
    remaining: i32,
    base: i32,
    started: Instant,
    pub title: &'static str,
}

impl Widget {
    pub fn new(cx: &mut Context<Self>, status: Status) -> Self {
        let this = Self { status, remaining: 25 * 60 - 7 * 60 - 12, base: 25 * 60 - 7 * 60 - 12, started: Instant::now(), title: "Review native spike" };
        if status == Status::Running && !frozen() {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_millis(1000)).await;
                    if this
                        .update(cx, |w, cx| {
                            w.remaining = (w.base - w.started.elapsed().as_secs() as i32).max(0);
                            cx.notify();
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }
        this
    }
}

fn mm_ss(secs: i32) -> String {
    format!("{:02}:{:02}", secs / 60, secs % 60)
}

fn ctl_button(label: &'static str, danger: bool) -> impl IntoElement {
    let accent = if danger { TN_RED } else { TN_BLUE };
    div()
        .relative()
        .w(px(28.0))
        .h(px(28.0))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .overflow_hidden()
        .child(layer(
            Spec::rrect(4.0)
                .solid(css::C(accent.0, accent.1, accent.2, if danger { 0.04 } else { 0.04 }))
                .border(1.0, css::C(accent.0, accent.1, accent.2, if danger { 0.15 } else { 0.12 })),
        ))
        .child(
            div()
                .absolute()
                .top_0()
                .left(px(5.6))
                .w(px(16.8))
                .h(px(1.0))
                .bg(lin_h(css::C(accent.0, accent.1, accent.2, 0.2))),
        )
        .text_color(col(accent))
        .font_family("Segoe UI Symbol")
        .text_size(px(if danger { 7.0 } else { 11.0 }))
        .child(label)
}

fn lin_h(c: css::C) -> Background {
    linear_gradient(90.0, linear_color_stop(col(css::C(c.0, c.1, c.2, 0.0)), 0.0), linear_color_stop(col(c), 0.5))
}

impl Render for Widget {
    fn render(&mut self, _w: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let (w, h) = (260.0f32, 80.0f32);
        let spec = Spec::polygon(chamfer_points(w, h, 10.0))
            .fill(linear(170.0, &[(0.0, rgba(122, 162, 247, 0.06)), (0.4, rgba(187, 154, 247, 0.03)), (0.7, TRANSPARENT)]))
            .solid(rgba(8, 10, 22, 0.88))
            .ring(1.0, linear(135.0, &[(0.0, rgba(122, 162, 247, 0.18)), (0.5, rgba(187, 154, 247, 0.08)), (1.0, rgba(122, 162, 247, 0.12))]));
        let status_color = match self.status {
            Status::Running => TN_GREEN,
            Status::Paused => TN_YELLOW,
            Status::Completed => TN_BLUE,
            Status::Idle => hex_c(0x3b4261),
        };
        let dot = {
            let mut d = div().size(px(6.0)).rounded_full().bg(col(status_color));
            if self.status != Status::Idle {
                let (a, b) = match self.status {
                    Status::Running => (0.6, 8.0),
                    Status::Paused => (0.35, 6.0),
                    _ => (0.5, 8.0),
                };
                d = d.shadow(shadows(&[sh(0.0, 0.0, b, css::C(status_color.0, status_color.1, status_color.2, a))]));
            }
            d
        };
        let time = mm_ss(self.remaining);
        let time_text = move |c: css::C| -> AnyElement {
            div()
                .font_family("JetBrains Mono")
                .text_size(px(24.0))
                .line_height(px(24.0))
                .font_weight(FontWeight(700.0))
                .text_color(col(c))
                .child(spaced(&time, 0.48))
                .into_any_element()
        };
        let glow = glow_copies(12.0, rgba(122, 162, 247, 0.2), &time_text);
        let status_bar = div()
            .absolute()
            .left(px(16.0))
            .right(px(16.0))
            .bottom_0()
            .h(px(2.0))
            .rounded(px(1.0))
            .bg(col(rgba(86, 95, 137, 0.3)))
            .overflow_hidden()
            .child(match self.status {
                Status::Running => {
                    let g = |a: css::C, b: css::C| linear_gradient(90.0, linear_color_stop(col(a), 0.0), linear_color_stop(col(b), 1.0));
                    let z = css::C(0.62, 0.81, 0.42, 0.0);
                    div()
                        .size_full()
                        .flex()
                        .flex_row()
                        .child(div().flex_1().h_full().bg(g(z, TN_GREEN)))
                        .child(div().flex_1().h_full().bg(g(TN_GREEN, TN_CYAN)))
                        .child(div().flex_1().h_full().bg(g(TN_CYAN, TN_GREEN)))
                        .child(div().flex_1().h_full().bg(g(TN_GREEN, z)))
                        .into_any_element()
                }
                Status::Paused => div().size_full().bg(col(TN_YELLOW)).opacity(0.5).into_any_element(),
                Status::Completed => div().size_full().bg(col(TN_BLUE)).into_any_element(),
                Status::Idle => div().into_any_element(),
            });
        let body = Glass::new(0.0, 28.0, 1.4, spec).chamfer(10.0).el().w(px(w)).h(px(h)).flex().flex_row().items_center();
        let widget = body
            .child(status_bar)
            .child(
                div()
                    .w(px(41.5))
                    .h_full()
                    .flex_shrink_0()
                    .pl(px(14.0))
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(6.0))
                    .child(
                        div()
                            .relative()
                            .w(px(27.5))
                            .h(px(20.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .absolute()
                                    .size(px(16.0))
                                    .rounded_full()
                                    .shadow(shadows(&[sh(0.0, 0.0, 4.0, rgba(122, 162, 247, 0.3))])),
                            )
                            .child(img("icons/tomato.png").w(px(27.46875)).h(px(20.0))),
                    )
                    .child(dot),
            )
            .child(
                div()
                    .flex_1()
                    .px(px(4.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(2.0))
                    .child(
                        div()
                            .relative()
                            .h(px(24.0))
                            .children(glow)
                            .child(time_text(hex_c(0xc0caf5))),
                    )
                    .child(
                        ui_text(10.0)
                            .h(px(14.0))
                            .max_w(px(120.0))
                            .overflow_hidden()
                            .font_weight(FontWeight(500.0))
                            .text_color(col(TN_MUTED))
                            .child(spaced(&self.title.to_uppercase(), 0.4)),
                    ),
            )
            .child(
                div()
                    .pr(px(14.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(3.0))
                    .child(ctl_button("\u{23F8}", false))
                    .child(ctl_button("\u{25A0}", true)),
            );
        div().size_full().window_control_area(WindowControlArea::Drag).child(widget)
    }
}

fn hex_c(v: u32) -> css::C {
    css::hex(v)
}
