//! Timer screen: ModeToggle, TimerView card, TimerTypeSelector, TimerDisplay, TimerControls.

use crate::css::{Spec, TRANSPARENT, hex, linear, rgba};
use crate::ui::*;
use gpui::*;
use lizmeter_ui::text_input::{FieldStyle, TextField};

pub use crate::engine::Status;
pub use lizmeter_core::TimerType;

/// The accent colour of a timer type.
pub fn accent(ty: TimerType) -> crate::css::C {
    match ty {
        TimerType::Work | TimerType::Stopwatch => TN_BLUE,
        TimerType::ShortBreak => TN_GREEN,
        TimerType::LongBreak => TN_PURPLE,
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
        } else if !disabled {
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
pub fn card_glass(ttype: TimerType, border_alpha: f32) -> Glass {
    let (border, glow, hi_top, hi_side) = if ttype == TimerType::Work {
        (rgba(122, 162, 247, 0.22), Some(rgba(122, 162, 247, 0.07)), rgba(122, 162, 247, 0.18), rgba(122, 162, 247, 0.08))
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
        let accent = accent(ty);
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

/// The two fields of the click-to-edit display.
pub struct DisplayEdit {
    pub mins: Entity<TextField>,
    pub secs: Entity<TextField>,
}

pub fn display_field_style() -> FieldStyle {
    let mut st = FieldStyle::new(MONO, 104.0, 104.0, col(TN_TEXT));
    st.weight = FontWeight(700.0);
    st
}

pub fn timer_display(
    status: Status,
    remaining: i64,
    can_edit: bool,
    edit: Option<DisplayEdit>,
    on_edit: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
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
    let editing = edit.is_some();
    let row = if let Some(e) = edit {
        let underline = |field: Entity<TextField>| {
            div()
                .w(px(digits_w))
                .h(px(122.0))
                .pt(px(9.0))
                .pl(px((digits_w - 2.0 * step) / 2.0))
                .border_b_2()
                .border_color(col(rgba(122, 162, 247, 0.31)))
                .child(field)
        };
        div()
            .flex()
            .flex_row()
            .items_start()
            .child(underline(e.mins))
            .child(div().w(px(58.9 + 8.0)).h(px(122.0)).pt(px(9.0)).flex().justify_center().opacity(0.45).font_family(MONO).text_size(px(104.0)).line_height(px(104.0)).font_weight(FontWeight(300.0)).child(":"))
            .child(underline(e.secs))
            .into_any_element()
    } else {
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
        if can_edit {
            row.id("time-edit").cursor_pointer().on_click(move |_, w, a| on_edit(w, a)).into_any_element()
        } else {
            row.into_any_element()
        }
    };
    let hint = if editing {
        "enter to confirm"
    } else if can_edit {
        "click to edit"
    } else {
        ""
    };
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

/// `IssuePickerDropdown` trigger: the "Link issue" button, or the chosen issue with a clear button.
pub fn link_issue_button(
    selected: Option<(String, String)>,
    on_open: impl Fn(&mut Window, &mut App) + 'static,
    on_clear: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    if let Some((id, title)) = selected {
        return div()
            .max_w(px(260.0))
            .px(px(10.0))
            .py(px(4.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.25)))
            .bg(col(rgba(122, 162, 247, 0.063)))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .text_size(px(12.0))
            .text_color(col(TN_TEXT))
            .child(div().flex().flex_row().gap(px(5.0)).overflow_hidden().child(div().flex_shrink_0().font_weight(FontWeight(600.0)).text_color(col(TN_BLUE)).child(id)).child(div().truncate().child(title)))
            .child(
                div()
                    .id("issue-clear")
                    .flex_shrink_0()
                    .text_size(px(14.0))
                    .line_height(px(14.0))
                    .text_color(col(ICON_DIM))
                    .cursor_pointer()
                    .hover(|s| s.text_color(col(TN_TEXT)))
                    .on_click(move |_, w, a| on_clear(w, a))
                    .child("\u{2715}"),
            )
            .into_any_element();
    }
    Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(16, 18, 36, 0.35)).border(1.0, rgba(41, 46, 66, 0.8)))
        .el()
        .id("link-issue")
        .h(px(26.0))
        .px(px(13.0))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .text_color(col(TN_TEXT_DIM))
        .cursor_pointer()
        .on_click(move |_, w, a| on_open(w, a))
        .child(svg().path("icons/link.svg").size(px(14.0)).text_color(col(TN_TEXT_DIM)))
        .child(btn_text("Link issue", 12.0, 500.0, 0.0))
        .into_any_element()
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

pub struct ControlState {
    pub status: Status,
    pub start_disabled: bool,
    pub restored: bool,
}

pub fn controls(
    st: ControlState,
    on_start: impl Fn(&mut Window, &mut App) + 'static,
    on_pause: impl Fn(&mut Window, &mut App) + 'static,
    on_resume: impl Fn(&mut Window, &mut App) + 'static,
    on_reset: impl Fn(&mut Window, &mut App) + 'static,
    on_dismiss: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let status = st.status;
    let base = Btn { label: "", bg: None, hover_bg: None, fg: TN_BG, hover_fg: None, weight: 600.0, px: 36.0, spacing: 0.75, opacity: 1.0 };
    let mut row = div().flex().flex_row().justify_center().items_center().gap(px(8.0)).pt(px(20.0)).pb(px(6.0));
    let on_reset = std::rc::Rc::new(on_reset);
    match status {
        Status::Idle => {
            let b = Btn { label: "Start", bg: Some(TN_BLUE), hover_bg: Some(hex(0x89b4f8)), opacity: if st.start_disabled { 0.4 } else { 1.0 }, ..base };
            let start_disabled = st.start_disabled;
            row = row.child(control_button("start", b, move |w, a| {
                if !start_disabled {
                    on_start(w, a)
                }
            }));
            if st.restored {
                let cancel = on_reset.clone();
                row = row.child(control_button(
                    "cancel",
                    Btn { label: "Cancel", bg: None, hover_bg: None, fg: TN_TEXT_DIM, hover_fg: Some(TN_RED), weight: 500.0, px: 22.0, spacing: 0.6, opacity: 1.0 },
                    move |w, a| cancel(w, a),
                ));
            }
        }
        Status::Running => {
            row = row.child(control_button("pause", Btn { label: "Pause", bg: Some(TN_YELLOW), hover_bg: Some(hex(0xe8bc7a)), ..base }, on_pause));
        }
        Status::Paused => {
            row = row.child(control_button("resume", Btn { label: "Resume", bg: Some(TN_BLUE), hover_bg: Some(hex(0x89b4f8)), ..base }, on_resume));
        }
        Status::Completed => {
            row = row.child(control_button("again", Btn { label: "Start New Session", bg: Some(TN_GREEN), hover_bg: Some(hex(0xaad97a)), ..base }, on_dismiss));
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
