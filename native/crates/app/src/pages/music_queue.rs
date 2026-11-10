//! `QueueView.tsx`: the playing queue with drag reorder, jump, remove and "Save as Playlist".

use super::music::MusicPage;
use super::music_logic::*;
use super::music_ui::*;
use crate::controls::{page_text, state_message};
use crate::css::rgba;
use crate::ui::*;
use gpui::prelude::FluentBuilder;
use gpui::*;
use lizmeter_core::MusicTrack;
use lizmeter_ui::text_input::{TextField, TextFieldEvent};

/// One row: 6px padding twice, a 36px thumbnail and the 1px border twice.
pub const ROW_H: f32 = 50.0;
pub const ROW_GAP: f32 = 2.0;

pub struct QueueUi {
    pub save_form: bool,
    pub save_name: Entity<TextField>,
    pub saving: bool,
    pub save_toast: Option<String>,
    /// `(row being dragged, row it would take the place of)`.
    pub drag: Option<(usize, usize)>,
    pub list: Probe,
}

#[derive(Clone)]
pub struct QueueDrag(pub usize);

pub struct Ghost(pub String);

impl Render for Ghost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        popup_glass().px(px(12.0)).py(px(8.0)).max_w(px(320.0)).font_family(UI_FONT).text_size(px(13.0)).text_color(col(TN_TEXT)).truncate().child(self.0.clone())
    }
}

impl QueueUi {
    pub fn new(window: &mut Window, cx: &mut Context<MusicPage>, subs: &mut Vec<Subscription>) -> Self {
        let save_name = super::music::url_field("Playlist name", 12.0, window, cx);
        subs.push(cx.subscribe(&save_name, |this, _, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Submit => this.queue_save(cx),
            TextFieldEvent::Cancel => {
                this.queue_ui.save_form = false;
                cx.notify();
            }
            TextFieldEvent::Changed => cx.notify(),
        }));
        Self { save_form: false, save_name, saving: false, save_toast: None, drag: None, list: probe() }
    }
}

/// The row a pointer at `y` (list-local) is over, clamped to the list.
pub fn row_at(y: f32, count: usize) -> usize {
    if count == 0 {
        return 0;
    }
    ((y / (ROW_H + ROW_GAP)).floor().max(0.0) as usize).min(count - 1)
}

pub fn thumb(size: f32) -> Div {
    div().flex_shrink_0().w(px(size)).h(px(size)).rounded(px(4.0)).bg(col(rgba(41, 46, 66, 0.5))).flex().items_center().justify_center().child(ico("track-note", 14.0, 14.0, ICON_DIM))
}

pub fn track_text(track: &MusicTrack, active: bool) -> Div {
    div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(2.0))
        .child(
            div()
                .truncate()
                .font_family(BTN_FONT)
                .text_size(px(13.0))
                .line_height(px(15.0))
                .font_weight(FontWeight(500.0))
                .text_color(col(if active { TN_BLUE } else { TN_TEXT }))
                .child(track.title.clone()),
        )
        .children(track.artist.clone().map(|a| div().truncate().font_family(BTN_FONT).text_size(px(11.0)).line_height(px(13.0)).text_color(col(TN_TEXT_DIM)).child(a)))
}

pub fn duration_label(seconds: Option<f64>) -> Div {
    div().min_w(px(34.0)).flex().justify_end().font_family(BTN_FONT).text_size(px(11.0)).line_height(px(13.0)).text_color(col(TN_TEXT_DIM)).child(format_duration(seconds))
}

pub fn empty_state(icon: &str, title: &str, hint: Option<&str>) -> Div {
    div()
        .flex()
        .flex_col()
        .items_center()
        .gap(px(8.0))
        .px(px(24.0))
        .py(px(48.0))
        .child(div().mb(px(4.0)).child(ico(icon, 32.0, 32.0, rgba(169, 177, 214, 0.3))))
        .child(page_text(14.0).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child(title.to_string()))
        .children(hint.map(|h| page_text(12.0).text_color(col(TN_TEXT_DIM)).child(h.to_string())))
}

impl MusicPage {
    pub(super) fn queue_save(&mut self, cx: &mut Context<Self>) {
        let name = self.queue_ui.save_name.read(cx).text().trim().to_string();
        if name.is_empty() || self.queue.is_empty() || self.queue_ui.saving {
            return;
        }
        let ids: Vec<String> = self.queue.iter().map(|q| q.track.id.clone()).collect();
        self.queue_ui.saving = true;
        match self.music().playlist_create(&name, &ids) {
            Ok(_) => {
                self.queue_ui.save_name.update(cx, |f, cx| f.set_text("", cx));
                self.queue_ui.save_form = false;
                self.queue_ui.save_toast = Some(format!("Queue saved as \"{name}\""));
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(std::time::Duration::from_secs(3)).await;
                    let _ = this.update(cx, |p, cx| {
                        p.queue_ui.save_toast = None;
                        cx.notify();
                    });
                })
                .detach();
            }
            Err(_) => {}
        }
        self.queue_ui.saving = false;
        cx.notify();
    }

    fn jump_to(&mut self, index: usize, cx: &mut Context<Self>) {
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            cx.background_executor().spawn(async move { svc.music().jump_to(index) }).await;
            let _ = this.update(cx, |p, cx| p.hub.update(cx, |h, cx| h.refresh(cx)));
        })
        .detach();
    }

    fn dequeue(&mut self, index: usize, cx: &mut Context<Self>) {
        self.music().dequeue_at(index);
        self.hub.update(cx, |h, cx| h.refresh(cx));
    }

    fn drop_queue_row(&mut self, from: usize, cx: &mut Context<Self>) {
        let over = self.queue_ui.drag.take().map(|(_, o)| o).unwrap_or(from);
        if over != from && over < self.queue.len() {
            self.music().reorder_queue(from, over);
            self.hub.update(cx, |h, cx| h.refresh(cx));
        }
        cx.notify();
    }

    fn queue_row(&self, index: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let item = &self.queue[index];
        let active = index as i64 == self.current_index;
        let dragging = self.queue_ui.drag.is_some_and(|(f, _)| f == index);
        let me = cx.entity();
        let (m_jump, m_rm, m_drag) = (me.clone(), me.clone(), me.clone());
        let title = item.track.title.clone();
        let group = SharedString::from(format!("queue-row-{index}"));
        let grip = div()
            .id(SharedString::from(format!("queue-grip-{index}")))
            .flex_shrink_0()
            .w(px(20.0))
            .h(px(20.0))
            .rounded(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_grab()
            .child(ico("grip", 14.0, 14.0, ICON_DIM).hover(|s| s.text_color(col(TN_TEXT_DIM))))
            .on_drag(QueueDrag(index), move |_, _, _, app| {
                m_drag.update(app, |p, _| p.queue_ui.drag = Some((index, index)));
                let t = title.clone();
                app.new(|_| Ghost(t))
            });
        let meta = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .flex_shrink_0()
            .child(duration_label(item.track.duration_seconds))
            .children(item.track.is_cached.then(|| ico("download", 10.0, 10.0, TN_GREEN)));
        let info = div()
            .id(SharedString::from(format!("queue-info-{index}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .flex_1()
            .min_w_0()
            .rounded(px(4.0))
            .cursor_pointer()
            .child(thumb(36.0))
            .child(track_text(&item.track, active))
            .child(meta)
            .on_click(move |_, _, app| m_jump.update(app, |p, cx| p.jump_to(index, cx)));
        let remove = div()
            .id(SharedString::from(format!("queue-rm-{index}")))
            .flex_shrink_0()
            .w(px(22.0))
            .h(px(22.0))
            .rounded(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0))
            .cursor_pointer()
            .hover(|s| s.bg(col(rgba(247, 118, 142, 0.1))))
            .child(ico("close", 12.0, 12.0, ICON_DIM))
            .on_click(move |_, _, app| m_rm.update(app, |p, cx| p.dequeue(index, cx)));
        let (bg, border, hover_bg) = if active {
            (rgba(122, 162, 247, 0.08), rgba(122, 162, 247, 0.18), rgba(122, 162, 247, 0.12))
        } else {
            (rgba(0, 0, 0, 0.0), rgba(0, 0, 0, 0.0), rgba(122, 162, 247, 0.05))
        };
        div()
            .id(SharedString::from(format!("queue-row-{index}")))
            .group(group)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(8.0))
            .py(px(6.0))
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(border))
            .bg(col(bg))
            .hover(move |s| s.bg(col(hover_bg)))
            .when(dragging, |d| d.opacity(0.5))
            .child(grip)
            .child(info)
            .child(remove)
    }

    pub(super) fn render_queue(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.queue.is_empty() {
            return empty_state("empty-queue", "Your queue is empty.", Some("Paste a URL above or browse your library.")).into_any_element();
        }
        let me = cx.entity();
        let n = self.queue.len();
        let count = format!("{n} track{}", if n == 1 { "" } else { "s" });
        let mut header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(4.0))
            .pb(px(4.0))
            .border_b(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.08)))
            .child(div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT_DIM)).child(spaced(&count.to_uppercase(), 0.66)));
        if !self.queue_ui.save_form {
            let m = me.clone();
            header = header.child(
                div()
                    .id("queue-save-open")
                    .px(px(10.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 162, 247, 0.2)))
                    .bg(col(rgba(122, 162, 247, 0.06)))
                    .font_family(BTN_FONT)
                    .text_size(px(11.0))
                    .line_height(px(13.0))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(TN_TEXT_DIM))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.12))).border_color(col(rgba(122, 162, 247, 0.3))).text_color(col(TN_BLUE)))
                    .child(spaced("Save as Playlist", 0.22))
                    .on_click(move |_, window, app| {
                        m.update(app, |p, cx| {
                            p.queue_ui.save_name.update(cx, |f, cx| f.set_text("", cx));
                            p.queue_ui.save_form = true;
                            let focus = p.queue_ui.save_name.read(cx).focus_handle().clone();
                            window.focus(&focus);
                            cx.notify();
                        })
                    }),
            );
        }
        let mut body = div().w_full().p(px(16.0)).flex().flex_col().gap(px(12.0)).child(header);
        if self.queue_ui.save_form {
            let focused = self.queue_ui.save_name.read(cx).focus_handle().is_focused(_window);
            let enabled = !self.queue_ui.saving && !self.queue_ui.save_name.read(cx).text().trim().is_empty();
            let (m_save, m_cancel) = (me.clone(), me.clone());
            body = body.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(4.0))
                    .py(px(6.0))
                    .mb(px(4.0))
                    .border_b(px(1.0))
                    .border_color(col(rgba(122, 162, 247, 0.06)))
                    .child(inline_input(&self.queue_ui.save_name, focused, 6.0, (8.0, 6.0), rgba(122, 162, 247, 0.3), false))
                    .child(
                        tint_button("queue-save-go", if self.queue_ui.saving { "Saving..." } else { "Save" }, 12.0, enabled, 6.0, (10.0, 5.0))
                            .when(enabled, |b| b.on_click(move |_, _, app| m_save.update(app, |p, cx| p.queue_save(cx)))),
                    )
                    .child(ghost_button("queue-save-cancel", "Cancel", 12.0, (8.0, 5.0)).on_click(move |_, _, app| {
                        m_cancel.update(app, |p, cx| {
                            p.queue_ui.save_form = false;
                            cx.notify();
                        })
                    })),
            );
        }
        if let Some(t) = &self.queue_ui.save_toast {
            body = body.child(
                div()
                    .mx(px(4.0))
                    .mt(px(4.0))
                    .mb(px(8.0))
                    .px(px(10.0))
                    .py(px(6.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(158, 206, 106, 0.2)))
                    .bg(col(rgba(158, 206, 106, 0.08)))
                    .child(state_message(t.clone(), TN_GREEN, false).text_size(px(12.0))),
            );
        }

        let mut list = div().relative().flex().flex_col().gap(px(ROW_GAP)).child(measure(&self.queue_ui.list));
        for i in 0..n {
            list = list.child(self.queue_row(i, cx));
        }
        if let Some((from, over)) = self.queue_ui.drag {
            if over != from {
                let y = if over > from { (over as f32 + 1.0) * (ROW_H + ROW_GAP) - ROW_GAP / 2.0 } else { over as f32 * (ROW_H + ROW_GAP) - ROW_GAP / 2.0 };
                list = list.child(div().absolute().left_0().w_full().top(px(y - 1.0)).h(px(2.0)).rounded(px(1.0)).bg(col(TN_BLUE)));
            }
        }
        let (m_move, m_drop) = (me.clone(), me);
        let list = list
            .on_drag_move(move |ev: &DragMoveEvent<QueueDrag>, _, app| {
                let from = ev.drag(app).0;
                let top = f32::from(ev.bounds.origin.y);
                let y = f32::from(ev.event.position.y) - top;
                m_move.update(app, |p, cx| {
                    let over = row_at(y, p.queue.len());
                    if p.queue_ui.drag != Some((from, over)) {
                        p.queue_ui.drag = Some((from, over));
                        cx.notify();
                    }
                })
            })
            .on_drop(move |d: &QueueDrag, _, app| {
                let from = d.0;
                m_drop.update(app, |p, cx| p.drop_queue_row(from, cx))
            });
        body.child(list).into_any_element()
    }
}
