//! Desktop widget (`electron/main/widget-window.ts`, `src/renderer/widget/Widget.tsx`): a frameless,
//! transparent, always-on-top holographic HUD that mirrors the main window's timer or stopwatch.
//!
//! The widget is a second window of the same process. The main window pushes a
//! [`WidgetTimerSnapshot`] whenever its state changes and the widget answers with
//! [`WidgetEvent::Control`] when one of its two buttons is pressed (`useWidgetBridge.ts`).

use crate::avatar::{self, Avatar};
use crate::css::{self, C, Spec, TRANSPARENT, linear, rgba};
use crate::fmt::strip_html;
use crate::ui::*;
use gpui::*;
use lizmeter_core::{AppMode, AvatarPaths, ClaudeSessionActivityType, TimerStatus, TimerType, WidgetControlAction, WidgetTimerSnapshot};
use lizmeter_services::Services;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const WIDTH: f32 = 260.0;
pub const HEIGHT: f32 = 80.0;
pub const HEIGHT_WITH_AVATAR: f32 = 112.0;
/// Gap between the widget and the work area's top-right corner.
pub const MARGIN: f32 = 20.0;

pub fn chamfer_points(w: f32, h: f32, c: f32) -> Vec<(f32, f32)> {
    vec![(c, 0.0), (w - c, 0.0), (w, c), (w, h - c), (w - c, h), (c, h), (0.0, h - c), (0.0, c)]
}

/// Gaussian text glow (`text-shadow: 0 0 <blur> color`): weighted copies on a grid.
pub fn glow_copies(blur: f32, color: css::C, build: impl Fn(css::C) -> AnyElement) -> Vec<AnyElement> {
    glow_copies_gain(blur, color, 3.4, build)
}

/// [`glow_copies`] with the copies' combined strength set by `gain`.
pub fn glow_copies_gain(blur: f32, color: css::C, gain: f32, build: impl Fn(css::C) -> AnyElement) -> Vec<AnyElement> {
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
            let a = color.3 * (w / total) * gain;
            div()
                .absolute()
                .left(px(dx))
                .top(px(dy))
                .child(build(css::C(color.0, color.1, color.2, a.min(1.0))))
                .into_any_element()
        })
        .collect()
}

// ---------- Pure view state ----------

/// `Widget.tsx` `formatTime`: MM:SS under an hour, HH:MM:SS from an hour.
pub fn format_time(seconds: i64) -> String {
    let s = seconds.max(0);
    if s < 3600 {
        format!("{:02}:{:02}", s / 60, s % 60)
    } else {
        format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
    }
}

/// `Widget.tsx` `getModeIcon`.
pub fn mode_icon(snap: Option<&WidgetTimerSnapshot>) -> &'static str {
    let Some(s) = snap else { return "\u{23F1}" };
    if s.mode == AppMode::TimeTracking {
        return "\u{23F1}";
    }
    match s.timer_type {
        TimerType::Work => "\u{1F345}",
        TimerType::ShortBreak | TimerType::LongBreak => "\u{2615}",
        TimerType::Stopwatch => "\u{23F1}",
    }
}

/// Which avatar slot the Claude session's activity picks (`getAvatarForActivity`).
pub fn avatar_slot(activity: Option<ClaudeSessionActivityType>) -> lizmeter_services::avatars::AvatarSlot {
    use lizmeter_services::avatars::AvatarSlot;
    match activity {
        Some(ClaudeSessionActivityType::Thinking) => AvatarSlot::Thinking,
        Some(ClaudeSessionActivityType::ToolUse) => AvatarSlot::ToolUse,
        _ => AvatarSlot::Idle,
    }
}

/// The snapshot's title as the widget shows it: tags removed, trimmed.
pub fn display_title(snap: Option<&WidgetTimerSnapshot>) -> String {
    snap.map(|s| strip_html(&s.title)).unwrap_or_default()
}

pub fn is_active(status: TimerStatus) -> bool {
    matches!(status, TimerStatus::Running | TimerStatus::Paused)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Btn {
    PlayPause,
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BtnState {
    Idle,
    Hover,
    Pressed,
    Disabled,
}

/// What a button looks like in one state (`.btn`, `.btn:hover`, `.btn:active`, `.btn:disabled`).
#[derive(Clone, Copy, PartialEq, Debug)]
struct BtnLook {
    bg: f32,
    border: f32,
    glow: f32,
    scale: f32,
    opacity: f32,
}

impl BtnLook {
    fn of(state: BtnState, danger: bool) -> Self {
        let idle = BtnLook { bg: 0.04, border: if danger { 0.15 } else { 0.12 }, glow: 0.0, scale: 1.0, opacity: 1.0 };
        match state {
            BtnState::Idle => idle,
            BtnState::Hover => BtnLook { bg: 0.12, border: 0.3, glow: 0.12, scale: 1.05, opacity: 1.0 },
            // The play button also darkens to 0.2; the stop button's hover rule keeps its 0.12.
            BtnState::Pressed => BtnLook { bg: if danger { 0.12 } else { 0.2 }, border: 0.3, glow: 0.12, scale: 0.94, opacity: 1.0 },
            BtnState::Disabled => BtnLook { opacity: 0.25, ..idle },
        }
    }

    fn lerp(self, to: Self, t: f32) -> Self {
        let m = |a: f32, b: f32| a + (b - a) * t;
        BtnLook { bg: m(self.bg, to.bg), border: m(self.border, to.border), glow: m(self.glow, to.glow), scale: m(self.scale, to.scale), opacity: m(self.opacity, to.opacity) }
    }
}

/// A button's transition (`transition: all 0.15s ease`).
#[derive(Clone, Copy)]
struct BtnFx {
    from: BtnLook,
    state: BtnState,
    at: Instant,
}

const BTN_MS: f32 = 150.0;
const DOT_MS: f32 = 300.0;

impl BtnFx {
    fn new(state: BtnState, danger: bool) -> Self {
        Self { from: BtnLook::of(state, danger), state, at: Instant::now() - Duration::from_secs(5) }
    }

    fn progress(&self, ms: f32) -> f32 {
        (self.at.elapsed().as_secs_f32() * 1000.0 / ms).min(1.0)
    }

    fn look(&self, danger: bool) -> BtnLook {
        let t = ease()(self.progress(BTN_MS));
        self.from.lerp(BtnLook::of(self.state, danger), t)
    }

    fn go(&mut self, state: BtnState, danger: bool) {
        if state != self.state {
            self.from = self.look(danger);
            self.state = state;
            self.at = Instant::now();
        }
    }
}

/// The status dot (`.statusDot`, with `transition: background 0.3s, box-shadow 0.3s`).
#[derive(Clone, Copy, PartialEq, Debug)]
struct DotLook {
    bg: C,
    blur: f32,
    glow: C,
}

fn dot_look(status: TimerStatus) -> DotLook {
    match status {
        TimerStatus::Running => DotLook { bg: TN_GREEN, blur: 8.0, glow: rgba(158, 206, 106, 0.6) },
        TimerStatus::Paused => DotLook { bg: TN_YELLOW, blur: 6.0, glow: rgba(224, 175, 104, 0.35) },
        TimerStatus::Completed => DotLook { bg: TN_BLUE, blur: 8.0, glow: rgba(122, 162, 247, 0.5) },
        TimerStatus::Idle => DotLook { bg: css::hex(0x3b4261), blur: 0.0, glow: rgba(0, 0, 0, 0.0) },
    }
}

fn lerp_c(a: C, b: C, t: f32) -> C {
    let m = |x: f32, y: f32| x + (y - x) * t;
    C(m(a.0, b.0), m(a.1, b.1), m(a.2, b.2), m(a.3, b.3))
}

impl DotLook {
    fn lerp(self, to: Self, t: f32) -> Self {
        DotLook { bg: lerp_c(self.bg, to.bg, t), blur: self.blur + (to.blur - self.blur) * t, glow: lerp_c(self.glow, to.glow, t) }
    }
}

// ---------- The view ----------

/// What the widget tells the main window.
pub enum WidgetEvent {
    Control(WidgetControlAction),
}

impl EventEmitter<WidgetEvent> for Widget {}

/// Everything a widget needs to open.
pub struct WidgetInit {
    pub snap: Option<WidgetTimerSnapshot>,
    pub avatars: AvatarPaths,
    /// Where a drag is remembered (`widget_pos_x`, `widget_pos_y`); none for a capture.
    pub services: Option<Arc<Services>>,
}

pub struct Widget {
    snap: Option<WidgetTimerSnapshot>,
    avatars: [Option<Avatar>; 3],
    scale: f32,
    btn: [BtnFx; 2],
    hover: Option<Btn>,
    pressed: Option<Btn>,
    dot_from: DotLook,
    dot_status: TimerStatus,
    dot_at: Instant,
    services: Option<Arc<Services>>,
    last_pos: Option<(i32, i32)>,
    save_gen: u64,
}

fn slot_index(slot: lizmeter_services::avatars::AvatarSlot) -> usize {
    lizmeter_services::avatars::AvatarSlot::ALL.iter().position(|s| *s == slot).unwrap_or(0)
}

impl Widget {
    pub fn new(window: &mut Window, cx: &mut Context<Self>, init: WidgetInit) -> Self {
        let status = init.snap.as_ref().map(|s| s.status).unwrap_or(TimerStatus::Idle);
        let mut this = Self {
            snap: init.snap,
            avatars: [None, None, None],
            scale: window.scale_factor(),
            btn: [BtnFx::new(BtnState::Idle, false), BtnFx::new(BtnState::Idle, true)],
            hover: None,
            pressed: None,
            dot_from: dot_look(status),
            dot_status: status,
            dot_at: Instant::now() - Duration::from_secs(5),
            services: init.services,
            last_pos: None,
            save_gen: 0,
        };
        this.load_avatars(&init.avatars);
        this.refresh_buttons();
        for fx in &mut this.btn {
            fx.at = Instant::now() - Duration::from_secs(5);
        }
        if this.services.is_some() {
            this.last_pos = Some(position_of(window));
            cx.observe_window_bounds(window, |this, window, cx| this.on_moved(window, cx)).detach();
        }
        this
    }

    fn load_avatars(&mut self, files: &AvatarPaths) {
        let load = |p: &Option<String>| p.as_deref().and_then(|p| avatar::load(std::path::Path::new(p), self.scale));
        self.avatars = [load(&files.idle), load(&files.thinking), load(&files.tool_use)];
    }

    pub fn set_avatars(&mut self, files: &AvatarPaths, cx: &mut Context<Self>) {
        self.load_avatars(files);
        cx.notify();
    }

    pub fn set_snapshot(&mut self, snap: WidgetTimerSnapshot, cx: &mut Context<Self>) {
        if self.snap.as_ref() == Some(&snap) {
            return;
        }
        let status = snap.status;
        if status != self.dot_status {
            self.dot_from = self.dot_now();
            self.dot_status = status;
            self.dot_at = Instant::now();
        }
        self.snap = Some(snap);
        self.refresh_buttons();
        cx.notify();
    }

    fn status(&self) -> TimerStatus {
        self.snap.as_ref().map(|s| s.status).unwrap_or(TimerStatus::Idle)
    }

    fn dot_now(&self) -> DotLook {
        let t = (self.dot_at.elapsed().as_secs_f32() * 1000.0 / DOT_MS).min(1.0);
        self.dot_from.lerp(dot_look(self.dot_status), ease()(t))
    }

    fn state_of(&self, b: Btn) -> BtnState {
        if !is_active(self.status()) {
            BtnState::Disabled
        } else if self.hover == Some(b) {
            if self.pressed == Some(b) { BtnState::Pressed } else { BtnState::Hover }
        } else {
            BtnState::Idle
        }
    }

    fn refresh_buttons(&mut self) {
        for (i, b) in [Btn::PlayPause, Btn::Stop].into_iter().enumerate() {
            let state = self.state_of(b);
            self.btn[i].go(state, b == Btn::Stop);
        }
    }

    fn control(&mut self, b: Btn, cx: &mut Context<Self>) {
        if !is_active(self.status()) {
            return;
        }
        cx.emit(WidgetEvent::Control(if b == Btn::Stop { WidgetControlAction::Stop } else { WidgetControlAction::PlayPause }));
    }

    /// Remembers where the user dropped the widget (`moved` in `widget-window.ts`), once the drag settles.
    fn on_moved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pos = position_of(window);
        if self.last_pos == Some(pos) {
            return;
        }
        self.last_pos = Some(pos);
        self.save_gen += 1;
        let generation = self.save_gen;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            let _ = this.update(cx, |w, _| {
                if w.save_gen == generation {
                    if let (Some(svc), Some((x, y))) = (&w.services, w.last_pos) {
                        let _ = svc.set_setting_value("widget_pos_x", Some(&x.to_string()));
                        let _ = svc.set_setting_value("widget_pos_y", Some(&y.to_string()));
                    }
                }
            });
        })
        .detach();
    }
}

fn position_of(window: &Window) -> (i32, i32) {
    let b = window.bounds();
    (f32::from(b.origin.x).round() as i32, f32::from(b.origin.y).round() as i32)
}

fn hex_c(v: u32) -> css::C {
    css::hex(v)
}

fn lin_h(c: css::C, from: f32, to: f32) -> Background {
    linear_gradient(90.0, linear_color_stop(col(css::C(c.0, c.1, c.2, from)), 0.0), linear_color_stop(col(css::C(c.0, c.1, c.2, to)), 1.0))
}

/// One control button (`.btn`, `.btn.stopBtn`).
fn ctl_button(id: &'static str, label: &'static str, danger: bool, look: BtnLook, state: BtnState, on_hover: impl Fn(&bool, &mut Window, &mut App) + 'static, on_down: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static, on_up: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
    let accent = if danger { TN_RED } else { TN_BLUE };
    let a = |al: f32| css::C(accent.0, accent.1, accent.2, al);
    let size = 28.0 * look.scale;
    let inset = (28.0 - size) / 2.0;
    let inner = div()
        .absolute()
        .top(px(inset))
        .left(px(inset))
        .w(px(size))
        .h(px(size))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(4.0 * look.scale))
        .child(div().absolute().size_full().rounded(px(4.0 * look.scale)).shadow(shadows(&[sh(0.0, 0.0, 10.0, a(look.glow))])))
        .child(
            div()
                .absolute()
                .size_full()
                .rounded(px(4.0 * look.scale))
                .overflow_hidden()
                .child(layer(Spec::rrect(4.0 * look.scale).solid(a(look.bg)).border(1.0, a(look.border))))
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left(px(size * 0.2))
                        .w(px(size * 0.3))
                        .h(px(1.0))
                        .bg(lin_h(accent, 0.0, 0.2)),
                )
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left(px(size * 0.5))
                        .w(px(size * 0.3))
                        .h(px(1.0))
                        .bg(lin_h(accent, 0.2, 0.0)),
                ),
        )
        .child(
            div()
                .text_color(col(accent))
                .font_family("Segoe UI Symbol")
                .text_size(px((if danger { 7.0 } else { 11.0 }) * look.scale))
                .child(label),
        );
    let mut cell = div().id(id).relative().w(px(28.0)).h(px(28.0)).flex_shrink_0().occlude().opacity(look.opacity).child(inner);
    if state != BtnState::Disabled {
        cell = cell.cursor_pointer().on_hover(on_hover).on_mouse_down(MouseButton::Left, on_down).on_mouse_up(MouseButton::Left, on_up).on_click(on_click);
    }
    cell
}

/// Width of every glyph of `text` with the letter spacing after it.
fn glyph_widths(window: &Window, text: &str, size: f32, weight: f32, spacing: f32) -> Vec<f32> {
    let font = Font { family: UI_FONT.into(), features: FontFeatures::default(), fallbacks: None, weight: FontWeight(weight), style: FontStyle::Normal };
    text.chars()
        .map(|ch| {
            let s = ch.to_string();
            let run = TextRun { len: s.len(), font: font.clone(), color: gpui::black(), background_color: None, underline: None, strikethrough: None };
            f32::from(window.text_system().shape_line(SharedString::from(s), px(size), &[run], None).width) + spacing
        })
        .collect()
}

/// `text-overflow: ellipsis` for the title: the longest head that fits `max` with the ellipsis.
fn ellipsize(window: &Window, text: &str, size: f32, weight: f32, spacing: f32, max: f32) -> String {
    let widths = glyph_widths(window, text, size, weight, spacing);
    if widths.iter().sum::<f32>() <= max {
        return text.to_string();
    }
    let dots: f32 = glyph_widths(window, "\u{2026}", size, weight, spacing).iter().sum();
    let head = head_that_fits(&widths, max - dots);
    let kept: String = text.chars().take(head).collect();
    format!("{}\u{2026}", kept.trim_end())
}

/// How many leading glyphs fit in `room`.
fn head_that_fits(widths: &[f32], room: f32) -> usize {
    let mut used = 0.0;
    for (i, w) in widths.iter().enumerate() {
        used += w;
        if used > room {
            return i;
        }
    }
    widths.len()
}

impl Render for Widget {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let snap = self.snap.clone();
        let status = self.status();
        let activity = snap.as_ref().and_then(|s| s.claude_activity);
        let avatar = self.avatars[slot_index(avatar_slot(activity))].clone();
        let has_avatar = avatar.is_some();
        let view = window.viewport_size();
        let (w, h) = (f32::from(view.width), f32::from(view.height));

        let mut animating = false;
        let dot_t = (self.dot_at.elapsed().as_secs_f32() * 1000.0 / DOT_MS).min(1.0);
        animating |= dot_t < 1.0;
        let dotl = self.dot_now();
        let dot = dot_el(&dotl);

        let spec = Spec::polygon(chamfer_points(w, h, 10.0))
            .fill(linear(170.0, &[(0.0, rgba(122, 162, 247, 0.06)), (0.4, rgba(187, 154, 247, 0.03)), (0.7, TRANSPARENT)]))
            .solid(rgba(8, 10, 22, 0.88))
            .ring(1.0, linear(135.0, &[(0.0, rgba(122, 162, 247, 0.18)), (0.5, rgba(187, 154, 247, 0.08)), (1.0, rgba(122, 162, 247, 0.12))]));

        let seconds = snap.as_ref().map(|s| s.display_seconds).unwrap_or(0);
        let time = format_time(seconds);
        let time_size = if seconds >= 3600 { 18.0 } else { 24.0 };
        let time_text = move |c: css::C| -> AnyElement {
            div()
                .font_family("JetBrains Mono")
                .text_size(px(time_size))
                .line_height(px(time_size))
                .font_weight(FontWeight(700.0))
                .text_color(col(c))
                .child(spaced(&time, 0.02 * time_size))
                .into_any_element()
        };
        let glow = glow_copies_gain(12.0, rgba(122, 162, 247, 0.2), 1.9, &time_text);

        let status_bar = div()
            .absolute()
            .left(px(16.0))
            .right(px(16.0))
            .bottom_0()
            .h(px(2.0))
            .rounded(px(1.0))
            .bg(col(rgba(86, 95, 137, 0.3)))
            .overflow_hidden()
            .child(match status {
                TimerStatus::Running => {
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
                TimerStatus::Paused => div().size_full().bg(col(TN_YELLOW)).opacity(0.5).into_any_element(),
                TimerStatus::Completed => div().size_full().bg(col(TN_BLUE)).into_any_element(),
                TimerStatus::Idle => div().into_any_element(),
            });

        let left = match &avatar {
            Some(a) => div()
                .w(px(86.0))
                .h_full()
                .flex_shrink_0()
                .pl(px(14.0))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .child(img(a.image.clone()).w(px(avatar::FRAME)).h(px(avatar::FRAME)).object_fit(ObjectFit::Fill))
                .into_any_element(),
            None => div()
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
                        .child(div().absolute().size(px(16.0)).rounded_full().shadow(shadows(&[sh(0.0, 0.0, 4.0, rgba(122, 162, 247, 0.3))])))
                        .child(div().text_size(px(20.0)).line_height(px(20.0)).font_family("Segoe UI Emoji").child(mode_icon(snap.as_ref()))),
                )
                .child(dot_el(&dotl))
                .into_any_element(),
        };

        let title = display_title(snap.as_ref());
        let title_el = (!title.is_empty()).then(|| {
            let shown = ellipsize(window, &title.to_uppercase(), 10.0, 500.0, 0.4, 120.0);
            ui_text(10.0).h(px(14.0)).max_w(px(120.0)).overflow_hidden().font_weight(FontWeight(500.0)).text_color(col(TN_MUTED)).child(spaced(&shown, 0.4))
        });

        let mut time_row = div().flex().flex_row().items_center().gap(px(8.0)).child(div().relative().h(px(time_size)).children(glow).child(time_text(hex_c(0xc0caf5))));
        if has_avatar {
            time_row = time_row.child(dot);
        }

        let me = cx.entity();
        let looks = [self.btn[0].look(false), self.btn[1].look(true)];
        animating |= self.btn.iter().any(|fx| fx.progress(BTN_MS) < 1.0);
        let states = [self.state_of(Btn::PlayPause), self.state_of(Btn::Stop)];
        let button = |i: usize, b: Btn, id: &'static str, label: &'static str| {
            let (m_hover, m_down, m_up, m_click) = (me.clone(), me.clone(), me.clone(), me.clone());
            ctl_button(
                id,
                label,
                b == Btn::Stop,
                looks[i],
                states[i],
                move |hovered, _, app| {
                    m_hover.update(app, |t, cx| {
                        t.hover = if *hovered { Some(b) } else if t.hover == Some(b) { None } else { t.hover };
                        if !*hovered && t.pressed == Some(b) {
                            t.pressed = None;
                        }
                        t.refresh_buttons();
                        cx.notify();
                    })
                },
                move |_, _, app| {
                    m_down.update(app, |t, cx| {
                        t.pressed = Some(b);
                        t.refresh_buttons();
                        cx.notify();
                    })
                },
                move |_, _, app| {
                    m_up.update(app, |t, cx| {
                        t.pressed = None;
                        t.refresh_buttons();
                        cx.notify();
                    })
                },
                move |_, _, app| m_click.update(app, |t, cx| t.control(b, cx)),
            )
        };
        let play_label = if status == TimerStatus::Running { "\u{23F8}" } else { "\u{25B6}" };

        if animating {
            window.request_animation_frame();
        }

        let widget = Glass::new(0.0, 28.0, 1.4, spec)
            .chamfer(10.0)
            .el()
            .size_full()
            .flex()
            .flex_row()
            .items_center()
            .child(status_bar)
            .child(left)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .px(px(4.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .items_start()
                    .gap(px(2.0))
                    .child(time_row)
                    .children(title_el),
            )
            .child(
                div()
                    .pr(px(14.0))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(3.0))
                    .child(button(0, Btn::PlayPause, "widget-play", play_label))
                    .child(button(1, Btn::Stop, "widget-stop", "\u{25A0}")),
            );
        // `@keyframes fadeIn`: 0.3s ease, opacity 0 -> 1 and 4px up.
        animate(div().size_full().relative().window_control_area(WindowControlArea::Drag).child(widget), "widget-fade-in", 300, false, ease(), 1.0, |el, t| el.opacity(t).top(px(4.0 * (1.0 - t))))
    }
}

fn dot_el(d: &DotLook) -> Div {
    let mut dot = div().size(px(6.0)).flex_shrink_0().rounded_full().bg(col(d.bg));
    if d.glow.3 > 0.001 {
        dot = dot.shadow(shadows(&[sh(0.0, 0.0, d.blur, d.glow)]));
    }
    dot
}

// ---------- Window plumbing ----------

/// `getDefaultPosition`: the work area's top-right corner, `MARGIN` in from the edges.
pub fn default_position(cx: &App) -> (f32, f32) {
    let display = cx.primary_display().map(|d| d.bounds()).unwrap_or(Bounds::new(point(px(0.0), px(0.0)), size(px(1920.0), px(1080.0))));
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SPI_GETWORKAREA, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW};
        let mut rect = RECT::default();
        let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, Some(&mut rect as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok() };
        let physical_w = unsafe { GetSystemMetrics(SM_CXSCREEN) } as f32;
        let logical_w = f32::from(display.size.width);
        if ok && physical_w > 0.0 && logical_w > 0.0 {
            let scale = physical_w / logical_w;
            return (rect.right as f32 / scale - WIDTH - MARGIN, rect.top as f32 / scale + MARGIN);
        }
    }
    (f32::from(display.right()) - WIDTH - MARGIN, f32::from(display.top()) + MARGIN)
}

/// `isPositionOnScreen`: the point lies on some display.
pub fn on_screen(cx: &App, x: f32, y: f32) -> bool {
    cx.displays().iter().any(|d| {
        let b = d.bounds();
        x >= f32::from(b.left()) && x < f32::from(b.right()) && y >= f32::from(b.top()) && y < f32::from(b.bottom())
    })
}

/// The saved position when it is still on a display, else the default one.
pub fn start_position(cx: &App, saved: Option<(f32, f32)>) -> (f32, f32) {
    match saved {
        Some((x, y)) if on_screen(cx, x, y) => (x, y),
        _ => default_position(cx),
    }
}

pub fn window_options(pos: (f32, f32), tall: bool, show: bool) -> WindowOptions {
    let bounds = Bounds::new(point(px(pos.0), px(pos.1)), size(px(WIDTH), px(if tall { HEIGHT_WITH_AVATAR } else { HEIGHT })));
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: None,
        kind: WindowKind::PopUp,
        focus: false,
        show,
        is_resizable: false,
        window_background: WindowBackgroundAppearance::Transparent,
        ..Default::default()
    }
}

#[cfg(target_os = "windows")]
fn hwnd_of(window: &Window) -> Option<windows::Win32::Foundation::HWND> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Win32(h) => Some(windows::Win32::Foundation::HWND(h.hwnd.get() as *mut _)),
        _ => None,
    }
}

/// Keeps the widget above every other window (`setAlwaysOnTop(true, "screen-saver")`).
pub fn make_topmost(window: &Window) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
        if let Some(hwnd) = hwnd_of(window) {
            unsafe {
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }
    let _ = window;
}

/// `widget.show()` / `widget.hide()`; showing does not take the focus from the app in use.
pub fn set_visible(window: &Window, visible: bool) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNOACTIVATE, ShowWindow};
        if let Some(hwnd) = hwnd_of(window) {
            unsafe {
                let _ = ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }
    let _ = (window, visible);
}

/// `widget.setPosition` in logical pixels.
pub fn move_to(window: &Window, x: f32, y: f32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos};
        if let Some(hwnd) = hwnd_of(window) {
            let s = window.scale_factor();
            unsafe {
                let _ = SetWindowPos(hwnd, None, (x * s).round() as i32, (y * s).round() as i32, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            }
        }
    }
    let _ = (window, x, y);
}

/// `widget.setSize`: the avatar makes the widget 112 px tall instead of 80.
pub fn set_tall(window: &mut Window, tall: bool) {
    window.resize(size(px(WIDTH), px(if tall { HEIGHT_WITH_AVATAR } else { HEIGHT })));
}

/// Restores a minimized main window and brings it to the front (the stop button in `widget:control`).
pub fn raise(window: &Window) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, SW_RESTORE, ShowWindow};
        if let Some(hwnd) = hwnd_of(window) {
            unsafe {
                if IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
            }
        }
    }
    window.activate_window();
}

// ---------- Capture mode (`--page widget`) ----------

fn arg_after(flag: &str) -> Option<String> {
    let mut it = std::env::args();
    while let Some(a) = it.next() {
        if a == flag {
            return it.next();
        }
    }
    None
}

/// A scripted snapshot for `--page widget --widget-state <name>`.
pub fn demo_snapshot(name: &str) -> WidgetTimerSnapshot {
    let base = WidgetTimerSnapshot {
        mode: AppMode::Pomodoro,
        status: TimerStatus::Running,
        timer_type: TimerType::Work,
        display_seconds: 17 * 60 + 48,
        title: "<p>Review native spike</p>".into(),
        planned_duration_seconds: Some(25 * 60),
        claude_activity: None,
    };
    match name {
        "idle" => WidgetTimerSnapshot { status: TimerStatus::Idle, display_seconds: 25 * 60, title: String::new(), ..base },
        "paused" => WidgetTimerSnapshot { status: TimerStatus::Paused, ..base },
        "completed" => WidgetTimerSnapshot { status: TimerStatus::Completed, display_seconds: 0, ..base },
        "break" => WidgetTimerSnapshot { timer_type: TimerType::ShortBreak, display_seconds: 4 * 60 + 12, title: String::new(), ..base },
        "stopwatch" => WidgetTimerSnapshot { mode: AppMode::TimeTracking, timer_type: TimerType::Stopwatch, display_seconds: 12 * 60 + 34, planned_duration_seconds: None, ..base },
        "hours" => WidgetTimerSnapshot { mode: AppMode::TimeTracking, timer_type: TimerType::Stopwatch, display_seconds: 3600 + 2 * 60 + 3, planned_duration_seconds: None, ..base },
        "long-title" => WidgetTimerSnapshot { title: "<p>A very long title that cannot fit in the widget</p>".into(), ..base },
        "thinking" => WidgetTimerSnapshot { claude_activity: Some(ClaudeSessionActivityType::Thinking), ..base },
        "tool_use" => WidgetTimerSnapshot { claude_activity: Some(ClaudeSessionActivityType::ToolUse), ..base },
        _ => base,
    }
}

/// Opens the widget alone on a scripted state: `--widget-state`, `--widget-avatar <png|gif>`
/// (used for every slot) and `--widget-hover play|stop|play-down|stop-down`.
pub fn open_demo(cx: &mut App) -> AnyWindowHandle {
    let state = arg_after("--widget-state").unwrap_or_else(|| "running".into());
    let avatar = arg_after("--widget-avatar");
    let hover = arg_after("--widget-hover");
    let tall = avatar.is_some();
    let pos = default_position(cx);
    let init = WidgetInit {
        snap: Some(demo_snapshot(&state)),
        avatars: AvatarPaths { idle: avatar.clone(), thinking: avatar.clone(), tool_use: avatar },
        services: None,
    };
    let handle = cx
        .open_window(window_options(pos, tall, true), |window, cx| {
            make_topmost(window);
            cx.new(|cx| {
                let mut w = Widget::new(window, cx, init);
                if let Some(h) = hover.as_deref() {
                    let b = if h.starts_with("stop") { Btn::Stop } else { Btn::PlayPause };
                    w.hover = Some(b);
                    if h.ends_with("-down") {
                        w.pressed = Some(b);
                    }
                    w.refresh_buttons();
                    for fx in &mut w.btn {
                        fx.at = Instant::now() - Duration::from_secs(5);
                    }
                }
                w
            })
        })
        .expect("widget window");
    handle.into()
}

#[cfg(test)]
mod tests {
    use super::{AppMode, BtnLook, BtnState, ClaudeSessionActivityType, TimerStatus, TimerType, WidgetTimerSnapshot, TN_BLUE, TN_GREEN, TN_YELLOW};
    use super::{avatar_slot, chamfer_points, display_title, dot_look, format_time, head_that_fits, is_active, mode_icon};

    fn snap(mode: AppMode, ty: TimerType, status: TimerStatus, secs: i64, title: &str) -> WidgetTimerSnapshot {
        WidgetTimerSnapshot { mode, status, timer_type: ty, display_seconds: secs, title: title.into(), planned_duration_seconds: None, claude_activity: None }
    }

    #[test]
    fn the_time_switches_to_hours_at_one_hour() {
        assert_eq!(format_time(0), "00:00");
        assert_eq!(format_time(25 * 60), "25:00");
        assert_eq!(format_time(3599), "59:59");
        assert_eq!(format_time(3600), "01:00:00");
        assert_eq!(format_time(3600 * 10 + 61), "10:01:01");
        assert_eq!(format_time(-5), "00:00");
    }

    #[test]
    fn the_icon_follows_the_mode_and_the_timer_type() {
        let s = |mode, ty| snap(mode, ty, TimerStatus::Idle, 0, "");
        assert_eq!(mode_icon(None), "\u{23F1}");
        assert_eq!(mode_icon(Some(&s(AppMode::Pomodoro, TimerType::Work))), "\u{1F345}");
        assert_eq!(mode_icon(Some(&s(AppMode::Pomodoro, TimerType::ShortBreak))), "\u{2615}");
        assert_eq!(mode_icon(Some(&s(AppMode::Pomodoro, TimerType::LongBreak))), "\u{2615}");
        assert_eq!(mode_icon(Some(&s(AppMode::TimeTracking, TimerType::Stopwatch))), "\u{23F1}");
        assert_eq!(mode_icon(Some(&s(AppMode::TimeTracking, TimerType::Work))), "\u{23F1}", "time tracking always shows the stopwatch icon");
    }

    #[test]
    fn the_title_loses_its_tags() {
        let s = snap(AppMode::Pomodoro, TimerType::Work, TimerStatus::Running, 1, "<p>Fix <b>the</b> bug</p>");
        assert_eq!(display_title(Some(&s)), "Fix the bug");
        assert_eq!(display_title(None), "");
        assert_eq!(display_title(Some(&snap(AppMode::Pomodoro, TimerType::Work, TimerStatus::Idle, 0, "<p></p>"))), "");
    }

    #[test]
    fn the_activity_picks_the_avatar_slot() {
        use lizmeter_services::avatars::AvatarSlot;
        assert_eq!(avatar_slot(None), AvatarSlot::Idle);
        assert_eq!(avatar_slot(Some(ClaudeSessionActivityType::Idle)), AvatarSlot::Idle);
        assert_eq!(avatar_slot(Some(ClaudeSessionActivityType::Thinking)), AvatarSlot::Thinking);
        assert_eq!(avatar_slot(Some(ClaudeSessionActivityType::ToolUse)), AvatarSlot::ToolUse);
    }

    #[test]
    fn only_a_running_or_paused_timer_has_live_controls() {
        assert!(is_active(TimerStatus::Running));
        assert!(is_active(TimerStatus::Paused));
        assert!(!is_active(TimerStatus::Idle));
        assert!(!is_active(TimerStatus::Completed));
    }

    #[test]
    fn button_looks_follow_the_stylesheet() {
        let idle = BtnLook::of(BtnState::Idle, false);
        assert_eq!((idle.bg, idle.border, idle.scale), (0.04, 0.12, 1.0));
        assert_eq!(BtnLook::of(BtnState::Idle, true).border, 0.15);
        let hover = BtnLook::of(BtnState::Hover, false);
        assert_eq!((hover.bg, hover.border, hover.glow, hover.scale), (0.12, 0.3, 0.12, 1.05));
        assert_eq!(BtnLook::of(BtnState::Pressed, false).bg, 0.2);
        assert_eq!(BtnLook::of(BtnState::Pressed, true).bg, 0.12, "the stop button's hover rule wins over :active");
        assert_eq!(BtnLook::of(BtnState::Pressed, true).scale, 0.94);
        let disabled = BtnLook::of(BtnState::Disabled, false);
        assert_eq!((disabled.opacity, disabled.scale, disabled.glow), (0.25, 1.0, 0.0), "a disabled button ignores hover");
    }

    #[test]
    fn the_dot_colours_follow_the_status() {
        assert_eq!(dot_look(TimerStatus::Running).bg, TN_GREEN);
        assert_eq!(dot_look(TimerStatus::Paused).bg, TN_YELLOW);
        assert_eq!(dot_look(TimerStatus::Completed).bg, TN_BLUE);
        assert_eq!(dot_look(TimerStatus::Idle).glow.3, 0.0);
    }

    #[test]
    fn the_ellipsis_keeps_the_glyphs_that_fit() {
        let w = [10.0, 10.0, 10.0, 10.0];
        assert_eq!(head_that_fits(&w, 25.0), 2);
        assert_eq!(head_that_fits(&w, 40.0), 4);
        assert_eq!(head_that_fits(&w, 5.0), 0);
    }

    #[test]
    fn the_chamfer_is_an_octagon() {
        let p = chamfer_points(260.0, 80.0, 10.0);
        assert_eq!(p.len(), 8);
        assert_eq!(p[0], (10.0, 0.0));
        assert_eq!(p[3], (260.0, 70.0));
    }
}
