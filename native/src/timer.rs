//! Timer screen: ModeToggle, TimerView card, TimerTypeSelector, TimerDisplay, TimerControls.

use crate::css::{Spec, TRANSPARENT, hex, linear, rgba};
use crate::ui::*;
use gpui::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Idle,
    Running,
    Paused,
    Completed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TimerType {
    Work,
    ShortBreak,
    LongBreak,
}

impl TimerType {
    pub fn accent(self) -> crate::css::C {
        match self {
            TimerType::Work => TN_BLUE,
            TimerType::ShortBreak => TN_GREEN,
            TimerType::LongBreak => TN_PURPLE,
        }
    }
    pub fn seconds(self) -> i32 {
        match self {
            TimerType::Work => 25 * 60,
            TimerType::ShortBreak => 5 * 60,
            TimerType::LongBreak => 15 * 60,
        }
    }
}

pub fn btn_text(label: &str, size: f32, weight: f32, spacing: f32) -> Div {
    div()
        .font_family(BTN_FONT)
        .text_size(px(size))
        .line_height(px((size * 1.15).round()))
        .font_weight(FontWeight(weight))
        .child(spaced(label, spacing))
}

/// ModeToggle: Pomodoro / Time Tracking segmented control.
pub fn mode_toggle(
    pomodoro_active: bool,
    disabled: bool,
    on_pick: impl Fn(bool, &mut Window, &mut App) + Clone + 'static,
) -> impl IntoElement {
    let glass = Glass::new(
        12.0,
        20.0,
        1.5,
        Spec::rrect(12.0)
            .fill(linear(135.0, &[(0.0, wh(0.06)), (0.5, TRANSPARENT)]))
            .solid(rgba(10, 11, 22, 0.58))
            .border(1.0, rgba(122, 162, 247, 0.10))
            .inset(0.0, 1.0, wh(0.08))
            .inset(0.0, -1.0, bk(0.10)),
    )
    .shadows(&[sh(0.0, 2.0, 12.0, bk(0.30))]);

    let tab = |label: &'static str, active: bool, pomodoro: bool, on_pick: Box<dyn Fn(&mut Window, &mut App)>| {
        let mut t = div()
            .id(label)
            .relative()
            .flex_1()
            .h(px(33.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(9.0))
            .cursor_pointer()
            .on_click(move |_, w, a| on_pick(w, a));
        if active {
            t = t
                .shadow(shadows(&[sh(0.0, 2.0, 10.0, rgba(122, 162, 247, 0.15))]))
                .child(layer(
                    Spec::rrect(9.0)
                        .fill(linear(135.0, &[(0.0, wh(0.12)), (0.4, wh(0.02)), (0.65, TRANSPARENT)]))
                        .solid(rgba(122, 162, 247, 0.16))
                        .border(1.0, rgba(122, 162, 247, 0.32))
                        .inset(0.0, 1.0, wh(0.16))
                        .inset(0.0, -1.0, bk(0.10)),
                ));
        } else {
            t = t.hover(|s| s.bg(col(rgba(122, 162, 247, 0.07))));
        }
        let _ = pomodoro;
        // ModeToggle.module.scss: `.tab:disabled { opacity: .5 }`, `.tab.active:disabled { opacity: .7 }`
        if disabled {
            t = t.opacity(if active { 0.7 } else { 0.5 }).cursor_not_allowed();
        }
        t.text_color(col(if active { TN_BLUE } else { TN_TEXT_DIM })).child(btn_text(label, 13.0, if active { 600.0 } else { 500.0 }, 0.0))
    };
    let p1 = on_pick.clone();
    let p2 = on_pick;
    glass
        .el()
        .w_full()
        .h(px(41.0))
        .flex()
        .flex_row()
        .gap(px(2.0))
        .p(px(4.0))
        .child(tab("Pomodoro", pomodoro_active, true, Box::new(move |w, a| p1(true, w, a))))
        .child(tab("Time Tracking", !pomodoro_active, false, Box::new(move |w, a| p2(false, w, a))))
}

/// The idle/running/hover look of the big card (TimerView.module.scss `.container`).
pub fn card_glass(status: Status, ttype: TimerType, border_alpha: f32) -> Glass {
    // The SCSS selector `[data-timer-type="work"]:not([data-status="idle"])` also matches the idle card
    // (data-status lives on a child), so Electron always renders the Work card with the accent look.
    let _ = status;
    let accent_active = true;
    let (border, glow, hi_top, hi_side) = if accent_active && ttype == TimerType::Work {
        (rgba(122, 162, 247, 0.22), Some(rgba(122, 162, 247, 0.07)), rgba(122, 162, 247, 0.18), rgba(122, 162, 247, 0.08))
    } else if false {
        (rgba(158, 206, 106, 0.20), Some(rgba(158, 206, 106, 0.06)), rgba(158, 206, 106, 0.16), rgba(158, 206, 106, 0.07))
    } else {
        (rgba(122, 162, 247, border_alpha), None, wh(0.12), wh(0.06))
    };
    let mut shd = vec![sh(0.0, 12.0, 40.0, bk(0.40))];
    if let Some(g) = glow {
        shd.push(sh(0.0, 0.0, 50.0, g));
    } else {
        shd.push(sh(0.0, 4.0, 12.0, bk(0.25)));
    }
    Glass::new(
        18.0,
        32.0,
        1.6,
        Spec::rrect(18.0)
            .fill(linear(135.0, &[(0.0, wh(0.08)), (0.35, wh(0.02)), (0.58, TRANSPARENT)]))
            .fill(linear(315.0, &[(0.0, bk(0.08)), (0.38, TRANSPARENT)]))
            .solid(rgba(16, 18, 36, 0.52))
            .border(1.0, border)
            .inset(0.0, 1.0, hi_top)
            .inset(1.0, 0.0, hi_side)
            .inset(0.0, -1.0, bk(0.18))
            .inset(-1.0, 0.0, bk(0.06)),
    )
    .shadows(&shd)
}

pub fn section_label(text: &str) -> Div {
    ui_text(11.0)
        .h(px(14.0))
        .line_height(px(14.0))
        .font_weight(FontWeight(700.0))
        .text_color(col(TN_TEXT))
        .child(spaced(&text.to_uppercase(), 1.32))
}

pub fn type_selector(selected: TimerType, enabled: bool, on_pick: impl Fn(TimerType, &mut Window, &mut App) + Clone + 'static) -> impl IntoElement {
    let mut row = div().relative().w_full().h(px(33.0)).flex().flex_row();
    row = row.child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(122, 162, 247, 0.08))));
    for (label, ty) in [("Work", TimerType::Work), ("Short Break", TimerType::ShortBreak), ("Long Break", TimerType::LongBreak)] {
        let is_sel = ty == selected;
        let accent = ty.accent();
        let pick = on_pick.clone();
        let mut b = div()
            .id(label)
            .flex_1()
            .h(px(33.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(col(if is_sel { accent } else { TN_TEXT_DIM }))
            .on_click(move |_, w, a| pick(ty, w, a))
            .child(btn_text(label, 13.0, if is_sel { 600.0 } else { 400.0 }, 0.39));
        if !enabled && !is_sel {
            b = b.opacity(0.35);
        }
        if is_sel {
            b = b.child(div().absolute().left_0().right_0().bottom(px(0.0)).h(px(2.0)).bg(col(accent)));
        }
        row = row.child(b);
    }
    row
}

pub fn timer_display(status: Status, remaining: i32, can_edit: bool) -> impl IntoElement {
    let mins = remaining.max(0) / 60;
    let secs = remaining.max(0) % 60;
    let color = match status {
        Status::Completed => TN_GREEN,
        Status::Paused => TN_YELLOW,
        _ => TN_TEXT,
    };
    // Cascadia Code advance is 1200/2048 em; the CSS applies letter-spacing -0.02em per glyph.
    let step = 104.0 * 1200.0 / 2048.0 - 2.08;
    let glyphs = |t: &str, left: f32| {
        let mut run = div().absolute().left(px(left)).top(px(9.0)).h(px(104.0)).w(px(step * t.chars().count() as f32));
        for (i, ch) in t.chars().enumerate() {
            run = run.child(div().absolute().left(px(i as f32 * step)).top_0().child(ch.to_string()));
        }
        run
    };
    let digits_w = 152.3;
    let row = div()
        .relative()
        .w(px(2.0 * digits_w + 8.0 + 58.9))
        .h(px(122.0))
        .flex_shrink_0()
        .font_family(MONO)
        .text_size(px(104.0))
        .line_height(px(104.0))
        .font_weight(FontWeight(700.0))
        .text_color(col(color))
        .child(glyphs(&format!("{mins:02}"), (digits_w - 2.0 * step) / 2.0))
        .child(
            div()
                .absolute()
                .left(px(digits_w + 4.0))
                .top_0()
                .w(px(58.9))
                .h(px(122.0))
                .opacity(0.45)
                .font_weight(FontWeight(300.0))
                .child(glyphs(":", (58.9 - step) / 2.0)),
        )
        .child(glyphs(&format!("{secs:02}"), digits_w + 8.0 + 58.9 + (digits_w - 2.0 * step) / 2.0));
    let hint = if can_edit { "click to edit" } else { "" };
    div()
        .w_full()
        .pt(px(24.0))
        .pb(px(14.0))
        .flex()
        .flex_col()
        .items_center()
        .child(row)
        .child(
            ui_text(11.0)
                .mt(px(8.0))
                .h(px(13.2))
                .flex()
                .items_center()
                .justify_center()
                .font_weight(FontWeight(700.0))
                .text_color(col(TN_TEXT_DIM))
                .child(spaced(&hint.to_uppercase(), 1.1)),
        )
        .child(if status == Status::Completed {
            ui_text(12.0)
                .mt(px(12.0))
                .font_weight(FontWeight(700.0))
                .text_color(col(TN_GREEN))
                .child(spaced("SESSION COMPLETE!", 1.68))
                .into_any_element()
        } else {
            div().into_any_element()
        })
}

fn toolbar_button(icon: &'static str) -> impl IntoElement {
    div()
        .w(px(28.0))
        .h(px(26.0))
        .flex()
        .items_center()
        .justify_center()
        .child(svg().path(icon).size(px(14.0)).text_color(col(TN_TEXT_DIM)))
}

fn toolbar_sep() -> impl IntoElement {
    div().w(px(1.0)).h(px(14.0)).mx(px(5.0)).bg(col(rgba(86, 95, 137, 0.5)))
}

/// RichTextInput glass pane (SessionTitleInput) with its toolbar. Editing is not wired in the spike.
pub fn rich_input(height: f32, text: Option<&str>) -> impl IntoElement {
    let glass = Glass::new(
        10.0,
        12.0,
        1.0,
        Spec::rrect(10.0).solid(rgba(16, 17, 32, 0.72)).border(1.0, rgba(59, 66, 97, 0.7)),
    );
    glass
        .el()
        .w_full()
        .h(px(height))
        .flex()
        .flex_row()
        .overflow_hidden()
        .child(div().ml(px(1.0)).mt(px(1.0)).mb(px(1.0)).w(px(2.0)).h(px(height - 2.0)).bg(col(hex(0x292e42))))
        .child(
            div()
                .flex_1()
                .flex()
                .flex_col()
                .mt(px(1.0))
                .child(
                    div()
                        .relative()
                        .h(px(35.0))
                        .px(px(8.0))
                        .py(px(4.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(2.0))
                        .opacity(0.65)
                        .child(layer(Spec::rrect(0.0).border_sides(0.0, 0.0, 1.0, 0.0, rgba(59, 66, 97, 0.6))))
                        .child(div().flex().flex_row().gap(px(1.0)).child(toolbar_button("icons/bold.svg")).child(toolbar_button("icons/italic.svg")).child(toolbar_button("icons/strike.svg")))
                        .child(toolbar_sep())
                        .child(div().flex().flex_row().gap(px(1.0)).child(toolbar_button("icons/bullets.svg")).child(toolbar_button("icons/numbered.svg")))
                        .child(toolbar_sep())
                        .child(div().flex().flex_row().child(toolbar_button("icons/code.svg"))),
                )
                .children(text.map(|t| {
                    // .editor .ProseMirror: padding 10px 12px, 15px / 1.65, letter-spacing .01em
                    ui_text(15.0).px(px(12.0)).pt(px(10.0)).line_height(px(24.75)).text_color(col(TN_TEXT)).child(spaced(t, 0.15))
                })),
        )
        .child(
            div()
                .absolute()
                .right(px(1.0))
                .bottom(px(1.0))
                .w(px(20.0))
                .h(px(16.0))
                .rounded_tl(px(4.0))
                .flex()
                .items_center()
                .justify_center()
                .child(svg().path("icons/expand.svg").size(px(14.0)).text_color(col(ICON_DIM))),
        )
}

pub fn link_issue_button() -> impl IntoElement {
    Glass::new(
        8.0,
        8.0,
        1.0,
        Spec::rrect(8.0).solid(rgba(16, 18, 36, 0.35)).border(1.0, rgba(41, 46, 66, 0.8)),
    )
    .el()
    .h(px(26.0))
    .px(px(13.0))
    .flex()
    .flex_row()
    .items_center()
    .gap(px(6.0))
    .text_color(col(TN_TEXT_DIM))
    .child(svg().path("icons/link.svg").size(px(14.0)).text_color(col(TN_TEXT_DIM)))
    .child(btn_text("Link issue", 12.0, 500.0, 0.0))
}

pub struct Btn {
    pub label: &'static str,
    pub bg: Option<crate::css::C>,
    pub hover_bg: Option<crate::css::C>,
    pub fg: crate::css::C,
    pub hover_fg: Option<crate::css::C>,
    pub weight: f32,
    pub px: f32,
    pub spacing: f32,
    pub opacity: f32,
}

pub fn control_button(id: &'static str, b: Btn, on_click: impl Fn(&mut Window, &mut App) + 'static) -> impl IntoElement {
    let mut el = div()
        .id(id)
        .h(px(39.0))
        .px(px(b.px))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.0))
        .text_color(col(b.fg))
        .cursor_pointer()
        .opacity(b.opacity)
        .on_click(move |_, w, a| on_click(w, a));
    if let Some(bg) = b.bg {
        el = el.bg(col(bg));
    }
    let hb = b.hover_bg;
    let hf = b.hover_fg;
    el = el.hover(move |s| {
        let mut s = s;
        if let Some(c) = hb {
            s = s.bg(col(c));
        }
        if let Some(c) = hf {
            s = s.text_color(col(c));
        }
        s
    });
    el.child(btn_text(b.label, 15.0, b.weight, b.spacing))
}

pub fn controls(
    status: Status,
    on_start: impl Fn(&mut Window, &mut App) + 'static,
    on_pause: impl Fn(&mut Window, &mut App) + 'static,
    on_resume: impl Fn(&mut Window, &mut App) + 'static,
    on_reset: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let base = Btn { label: "", bg: None, hover_bg: None, fg: TN_BG, hover_fg: None, weight: 600.0, px: 36.0, spacing: 0.75, opacity: 1.0 };
    let mut row = div().flex().flex_row().justify_center().items_center().gap(px(8.0)).pt(px(20.0)).pb(px(6.0));
    match status {
        Status::Idle => {
            row = row.child(control_button("start", Btn { label: "Start", bg: Some(TN_BLUE), hover_bg: Some(hex(0x89b4f8)), ..base }, on_start));
        }
        Status::Running => {
            row = row.child(control_button("pause", Btn { label: "Pause", bg: Some(TN_YELLOW), hover_bg: Some(hex(0xe8bc7a)), ..base }, on_pause));
        }
        Status::Paused => {
            row = row.child(control_button("resume", Btn { label: "Resume", bg: Some(TN_BLUE), hover_bg: Some(hex(0x89b4f8)), ..base }, on_resume));
        }
        Status::Completed => {
            row = row.child(control_button("again", Btn { label: "Start New Session", bg: Some(TN_GREEN), hover_bg: Some(hex(0xaad97a)), ..base }, on_reset));
            return row;
        }
    }
    let can_reset = matches!(status, Status::Running | Status::Paused);
    row.child(control_button(
        "reset",
        Btn { label: "Reset", bg: None, hover_bg: None, fg: TN_TEXT_DIM, hover_fg: if can_reset { Some(TN_RED) } else { None }, weight: 500.0, px: 22.0, spacing: 0.6, opacity: if can_reset { 1.0 } else { 0.2 } },
        move |w, a| {
            if can_reset {
                on_reset(w, a)
            }
        },
    ))
}
