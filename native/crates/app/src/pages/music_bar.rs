//! `MusicBottomBar.tsx`: the persistent glass bar at the bottom of the window with the track,
//! transport, seek bar, speed, shuffle, repeat and volume.

use super::music_logic::*;
use super::music_ui::*;
use crate::css::{rgba, Spec};
use crate::music_hub::MusicHub;
use crate::ui::*;
use gpui::*;
use lizmeter_core::{MusicPlaybackState, RepeatMode};
use lizmeter_music::MusicService;

pub const BAR_HEIGHT: f32 = 76.0;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Drag {
    Seek(f64),
    Volume,
}

pub struct MusicBar {
    hub: Entity<MusicHub>,
    seek: Probe,
    volume: Probe,
    speed_btn: Probe,
    drag: Option<Drag>,
    speed_open: bool,
    previous_volume: f32,
    _watch: Subscription,
}

/// What the bar needs from the snapshot, copied out so the render holds no borrow of the hub.
struct View {
    title: Option<String>,
    artist: Option<String>,
    cached: bool,
    state: MusicPlaybackState,
    time: f64,
    duration: f64,
    buffered: f64,
    volume: f32,
    muted: bool,
    speed: f64,
    shuffle: bool,
    repeat: RepeatMode,
    can_next: bool,
    can_prev: bool,
    visible: bool,
    has_track: bool,
}

impl MusicBar {
    pub fn new(hub: Entity<MusicHub>, cx: &mut Context<Self>) -> Self {
        let watch = cx.observe(&hub, |_, _, cx| cx.notify());
        Self { hub, seek: probe(), volume: probe(), speed_btn: probe(), drag: None, speed_open: false, previous_volume: 0.3, _watch: watch }
    }

    pub fn visible(&self, cx: &App) -> bool {
        self.hub.read(cx).snap.is_bottom_bar_visible
    }

    /// Capture hook: the speed list open.
    pub fn capture_speed_menu(&mut self, cx: &mut Context<Self>) {
        self.speed_open = true;
        cx.notify();
    }

    fn view(&self, cx: &App) -> View {
        let s = &self.hub.read(cx).snap;
        View {
            title: s.current_track.as_ref().map(|t| t.title.clone()),
            artist: s.current_track.as_ref().and_then(|t| t.artist.clone()),
            cached: s.current_track.as_ref().is_some_and(|t| t.is_cached),
            state: s.playback_state,
            time: s.current_time,
            duration: s.duration,
            buffered: s.buffered,
            volume: s.volume,
            muted: s.muted,
            speed: s.playback_speed,
            shuffle: s.shuffle_enabled,
            repeat: s.repeat_mode,
            can_next: s.can_go_next,
            can_prev: s.can_go_prev,
            visible: s.is_bottom_bar_visible,
            has_track: s.current_track.is_some(),
        }
    }

    fn music(&self, cx: &App) -> std::sync::Arc<lizmeter_services::Services> {
        self.hub.read(cx).svc().clone()
    }

    fn act(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&MusicService)) {
        let svc = self.music(cx);
        f(svc.music());
        self.hub.update(cx, |h, cx| h.refresh(cx));
    }

    fn seek_to(&mut self, fraction: f64, cx: &mut Context<Self>) {
        let v = self.view(cx);
        if let Some(t) = seek_target(fraction, v.duration, v.buffered, v.cached) {
            self.act(cx, |m| {
                let _ = m.seek(t);
            });
        }
    }

    fn set_volume_at(&mut self, fraction: f64, cx: &mut Context<Self>) {
        let muted = self.view(cx).muted;
        self.act(cx, |m| {
            m.set_volume(fraction as f32);
            if fraction > 0.0 && muted {
                m.set_muted(false);
            }
        });
    }

    fn drag_move(&mut self, x: Pixels, cx: &mut Context<Self>) {
        match self.drag {
            Some(Drag::Seek(_)) => {
                self.drag = Some(Drag::Seek(fraction_in(self.seek.get(), x)));
                cx.notify();
            }
            Some(Drag::Volume) => self.set_volume_at(fraction_in(self.volume.get(), x), cx),
            None => {}
        }
    }

    fn drag_end(&mut self, x: Pixels, cx: &mut Context<Self>) {
        match self.drag.take() {
            Some(Drag::Seek(_)) => self.seek_to(fraction_in(self.seek.get(), x), cx),
            Some(Drag::Volume) | None => {}
        }
        cx.notify();
    }

    fn mute_toggle(&mut self, cx: &mut Context<Self>) {
        let v = self.view(cx);
        let (muted, restore) = toggle_mute(v.muted, v.volume, self.previous_volume);
        if muted {
            self.previous_volume = v.volume;
        }
        self.act(cx, |m| {
            m.set_muted(muted);
            if let Some(r) = restore {
                m.set_volume(r);
            }
        });
    }

    fn round_button(id: &'static str, size: f32, enabled: bool, icon: Svg) -> Stateful<Div> {
        let b = div().id(id).flex().items_center().justify_center().flex_shrink_0().w(px(size)).h(px(size)).rounded(px(size / 2.0)).child(icon);
        if enabled { b.cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.08)))) } else { b.opacity(0.3).cursor_not_allowed() }
    }

    fn slider(&self, id: &'static str, group: &'static str, width: Option<f32>, p: &Probe, played: f64, buffered: Option<f64>, dragging: bool, down: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static) -> impl IntoElement {
        let mut track = div().id(id).group(group).relative().h(px(4.0)).rounded(px(2.0)).bg(col(wh(0.08))).cursor_pointer();
        track = match width {
            Some(w) => track.w(px(w)).flex_shrink_0(),
            None => track.flex_1(),
        };
        track = track.child(measure(p));
        if let Some(b) = buffered {
            track = track.child(div().absolute().top_0().left_0().h_full().w(relative(b.clamp(0.0, 1.0) as f32)).rounded(px(2.0)).bg(col(rgba(122, 162, 247, 0.22))));
        }
        let thumb_visible = dragging;
        let mut thumb = div().absolute().top(px(-4.0)).left(relative(played.clamp(0.0, 1.0) as f32)).ml(px(-6.0)).w(px(12.0)).h(px(12.0)).rounded(px(6.0)).bg(col(TN_TEXT)).shadow(shadows(&[sh(0.0, 0.0, 4.0, bk(0.5))]));
        thumb = if thumb_visible { thumb.opacity(1.0) } else { thumb.opacity(0.0).group_hover(group, |s| s.opacity(1.0)) };
        track
            .child(div().absolute().top_0().left_0().h_full().w(relative(played.clamp(0.0, 1.0) as f32)).rounded(px(2.0)).bg(col(TN_BLUE)))
            .child(thumb)
            // The CSS `::before`: an 8px margin above and below that still takes the mouse.
            .child(div().absolute().top(px(-8.0)).left_0().w_full().h(px(20.0)).on_mouse_down(MouseButton::Left, down))
    }

    fn speed_popup(&self, window: &Window, cx: &mut Context<Self>, current: f64) -> Option<AnyElement> {
        if !self.speed_open {
            return None;
        }
        let b = self.speed_btn.get()?;
        let me = cx.entity();
        let mut list = popup_glass().min_w(px(72.0)).flex().flex_col();
        for (i, speed) in SPEED_OPTIONS.iter().copied().enumerate() {
            let selected = (speed - current).abs() < 1e-9;
            let m = me.clone();
            list = list.child(
                div()
                    .id(SharedString::from(format!("speed-{i}")))
                    .px(px(12.0))
                    .py(px(6.0))
                    .rounded(px(7.0))
                    .flex()
                    .justify_center()
                    .font_family(BTN_FONT)
                    .text_size(px(12.0))
                    .line_height(px(14.0))
                    .font_weight(FontWeight(if selected { 600.0 } else { 400.0 }))
                    .text_color(col(if selected { TN_BLUE } else { TN_TEXT_DIM }))
                    .when(selected, |d| d.bg(col(rgba(122, 162, 247, 0.15))))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
                    .child(speed_label(speed))
                    .on_click(move |_, _, app| {
                        m.update(app, |bar, cx| {
                            bar.speed_open = false;
                            bar.act(cx, |m| {
                                let _ = m.set_playback_speed(speed);
                            });
                        })
                    }),
            );
        }
        let at = point(b.origin.x + b.size.width / 2.0, b.origin.y - px(6.0));
        let close = me.clone();
        let backdrop = crate::pages::todos_menus::backdrop(window, None, move |_, app| {
            close.update(app, |bar, cx| {
                bar.speed_open = false;
                cx.notify();
            })
        });
        Some(
            div()
                .child(backdrop)
                .child(deferred(anchored().position(at).anchor(Corner::BottomLeft).offset(point(px(-36.0), px(0.0))).snap_to_window_with_margin(px(8.0)).child(list)).with_priority(8))
                .into_any_element(),
        )
    }
}

use gpui::prelude::FluentBuilder;

impl Render for MusicBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let v = self.view(cx);
        if !v.visible {
            return div().into_any_element();
        }
        let drag_watch = self.drag.is_some().then(|| {
            let (m_move, m_up) = (cx.entity(), cx.entity());
            on_drag_over_window(move |x, app| m_move.update(app, |b, cx| b.drag_move(x, cx)), move |x, app| m_up.update(app, |b, cx| b.drag_end(x, cx)))
        });
        let me = cx.entity();
        let playing = v.state == MusicPlaybackState::Playing;
        let buffering = v.state == MusicPlaybackState::Buffering;

        // Left: thumbnail, title and artist, clear.
        let thumb = div()
            .flex_shrink_0()
            .w(px(44.0))
            .h(px(44.0))
            .rounded(px(6.0))
            .bg(col(rgba(122, 162, 247, 0.1)))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.15)))
            .flex()
            .items_center()
            .justify_center()
            .child(ico("note", 20.0, 20.0, rgba(122, 162, 247, 0.6)));
        let info = div()
            .flex()
            .flex_col()
            .gap(px(2.0))
            .w(px(148.0))
            .flex_shrink_0()
            .child(
                div()
                    .truncate()
                    .font_family(UI_FONT)
                    .text_size(px(13.0))
                    .line_height(px(16.9))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(TN_TEXT))
                    .child(v.title.clone().unwrap_or_else(|| "No track".into())),
            )
            .children(v.artist.clone().map(|a| div().truncate().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_TEXT_DIM)).child(a)));
        let m_clear = me.clone();
        let clear = div()
            .id("bar-clear")
            .group("bar-clear-g")
            .ml_auto()
            .flex_shrink_0()
            .w(px(24.0))
            .h(px(24.0))
            .rounded(px(6.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .child(ico("clear", 14.0, 14.0, rgba(169, 177, 214, 0.45)).group_hover("bar-clear-g", |s| s.text_color(col(TN_RED))))
            .hover(|s| s.bg(col(rgba(247, 118, 142, 0.1))))
            .on_click(move |_, _, app| m_clear.update(app, |b, cx| b.act(cx, |m| m.clear_player())));
        let left = div().flex().flex_row().items_center().gap(px(12.0)).flex_none().w(px(240.0)).min_w_0().child(thumb).child(info).child(clear);

        // Centre: transport and seek.
        let (m_prev, m_play, m_next) = (me.clone(), me.clone(), me.clone());
        let play_icon = if buffering {
            animate(ico("buffering", 18.0, 18.0, TN_BLUE), "bar-buffering", 1000, true, |t| t, 0.25, |s, t| s.with_transformation(Transformation::rotate(percentage(t))))
        } else {
            ico(if playing { "pause" } else { "play" }, 18.0, 18.0, TN_BLUE).into_any_element()
        };
        let prev = Self::round_button("bar-prev", 32.0, v.can_prev, ico("prev", 16.0, 16.0, TN_TEXT_DIM)).when(v.can_prev, |b| b.on_click(move |_, _, app| m_prev.update(app, |b, cx| b.act(cx, |m| m.prev()))));
        let next = Self::round_button("bar-next", 32.0, v.can_next, ico("next", 16.0, 16.0, TN_TEXT_DIM)).when(v.can_next, |b| b.on_click(move |_, _, app| m_next.update(app, |b, cx| b.act(cx, |m| m.next()))));
        let play_enabled = !(buffering && !v.has_track);
        let play = div()
            .id("bar-play")
            .flex_shrink_0()
            .w(px(36.0))
            .h(px(36.0))
            .rounded(px(18.0))
            .border(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.25)))
            .bg(col(rgba(122, 162, 247, 0.15)))
            .flex()
            .items_center()
            .justify_center()
            .child(play_icon)
            .when(play_enabled, |b| {
                b.cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.25))).border_color(col(rgba(122, 162, 247, 0.4))))
                    .on_click(move |_, _, app| m_play.update(app, |b, cx| b.act(cx, |m| if playing { m.pause() } else { m.resume() })))
            })
            .when(!play_enabled, |b| b.opacity(0.4));
        let controls = div().flex().flex_row().items_center().gap(px(8.0)).child(prev).child(play).child(next);

        let dragging_seek = matches!(self.drag, Some(Drag::Seek(_)));
        let shown = match self.drag {
            Some(Drag::Seek(f)) => f,
            _ => percent_of(v.time, v.duration) / 100.0,
        };
        let seek_down = {
            let m = me.clone();
            move |e: &MouseDownEvent, _: &mut Window, app: &mut App| {
                let x = e.position.x;
                m.update(app, |b, cx| {
                    b.drag = Some(Drag::Seek(fraction_in(b.seek.get(), x)));
                    cx.notify();
                })
            }
        };
        let label = |text: String, right: bool| {
            let d = div().flex_shrink_0().min_w(px(36.0)).font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_TEXT_DIM)).child(text);
            if right { d.flex().justify_end() } else { d }
        };
        let seek_row = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .max_w(px(480.0))
            .child(label(format_time(v.time), true))
            .child(self.slider("bar-seek", "bar-seek-g", None, &self.seek, shown, Some(percent_of(v.buffered, v.duration) / 100.0), dragging_seek, seek_down))
            .child(label(if v.duration > 0.0 { format_time(v.duration) } else { "--:--".into() }, false));
        let center = div().flex_1().min_w_0().flex().flex_col().items_center().justify_center().gap(px(6.0)).py(px(8.0)).child(controls).child(seek_row);

        // Right: speed, shuffle, repeat, mute, volume.
        let m_speed = me.clone();
        let speed_btn = div()
            .id("bar-speed")
            .relative()
            .flex_shrink_0()
            .h(px(32.0))
            .px(px(6.0))
            .rounded(px(16.0))
            .flex()
            .items_center()
            .justify_center()
            .font_family(BTN_FONT)
            .text_size(px(11.0))
            .font_weight(FontWeight(600.0))
            .text_color(col(TN_TEXT_DIM))
            .cursor_pointer()
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.08))))
            .child(measure(&self.speed_btn))
            .child(speed_label(v.speed))
            .on_click(move |_, _, app| {
                m_speed.update(app, |b, cx| {
                    b.speed_open = !b.speed_open;
                    cx.notify();
                })
            });
        let toggle = |id: &'static str, active: bool, icon: Svg, on: Box<dyn Fn(&mut Window, &mut App)>| {
            let btn = Self::round_button(id, 32.0, true, icon).when(active, |b| b.hover(|s| s.bg(col(rgba(122, 162, 247, 0.12))))).on_click(move |_, w, a| on(w, a));
            div().relative().flex().flex_col().items_center().child(btn).when(active, |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(1.0))
                        .left(relative(0.5))
                        .ml(px(-2.0))
                        .w(px(4.0))
                        .h(px(4.0))
                        .rounded(px(2.0))
                        .bg(col(TN_BLUE))
                        .shadow(shadows(&[sh(0.0, 0.0, 4.0, rgba(122, 162, 247, 0.7))])),
                )
            })
        };
        let (m_shuffle, m_repeat, m_mute) = (me.clone(), me.clone(), me.clone());
        let shuffle_color = if v.shuffle { TN_BLUE } else { TN_TEXT_DIM };
        let repeat_color = if v.repeat != RepeatMode::Off { TN_BLUE } else { TN_TEXT_DIM };
        let shuffle_on = !v.shuffle;
        let shuffle = toggle("bar-shuffle", v.shuffle, ico("shuffle", 15.0, 15.0, shuffle_color), Box::new(move |_, app| m_shuffle.update(app, |b, cx| b.act(cx, |m| m.set_shuffle_enabled(shuffle_on)))));
        let repeat_icon = ico(if v.repeat == RepeatMode::One { "repeat-one" } else { "repeat" }, 15.0, 15.0, repeat_color);
        let next_mode = next_repeat(v.repeat);
        let repeat = toggle("bar-repeat", v.repeat != RepeatMode::Off, repeat_icon, Box::new(move |_, app| m_repeat.update(app, |b, cx| b.act(cx, |m| m.set_repeat_mode(next_mode)))));
        let vol_name = match volume_icon(v.muted, v.volume) {
            VolumeIcon::Muted => "vol-muted",
            VolumeIcon::Low => "vol-low",
            VolumeIcon::High => "vol-high",
        };
        let mute = Self::round_button("bar-mute", 32.0, true, ico(vol_name, 16.0, 16.0, TN_TEXT_DIM)).on_click(move |_, _, app| m_mute.update(app, |b, cx| b.mute_toggle(cx)));
        let vol_down = {
            let m = me.clone();
            move |e: &MouseDownEvent, _: &mut Window, app: &mut App| {
                let x = e.position.x;
                m.update(app, |b, cx| {
                    b.drag = Some(Drag::Volume);
                    let f = fraction_in(b.volume.get(), x);
                    b.set_volume_at(f, cx);
                })
            }
        };
        let vol_value = if v.muted { 0.0 } else { f64::from(v.volume) };
        let right = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(4.0))
            .flex_none()
            .w(px(260.0))
            .child(speed_btn)
            .child(shuffle)
            .child(repeat)
            .child(mute)
            .child(self.slider("bar-volume", "bar-volume-g", Some(90.0), &self.volume, vol_value, None, self.drag == Some(Drag::Volume), vol_down));

        let spec = Spec::rrect(0.0)
            .solid(rgba(10, 12, 24, 0.85))
            .border_sides(1.0, 0.0, 0.0, 0.0, rgba(122, 162, 247, 0.12))
            .inset(0.0, 1.0, wh(0.03));
        let bar = Glass::new(0.0, 24.0, 1.5, spec)
            .shadows(&[sh(0.0, -4.0, 32.0, bk(0.5)), sh(0.0, -1.0, 0.0, wh(0.04))])
            .el()
            .w_full()
            .h(px(BAR_HEIGHT))
            .px(px(16.0))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(16.0))
            .child(left)
            .child(center)
            .child(right);
        div().w_full().h(px(BAR_HEIGHT)).child(bar).children(drag_watch).children(self.speed_popup(window, cx, v.speed)).into_any_element()
    }
}
