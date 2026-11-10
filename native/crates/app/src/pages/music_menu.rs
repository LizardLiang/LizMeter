//! `TrackContextMenu.tsx` and the confirm dialogs of the Music page (delete a track, clear the
//! library, delete a playlist).

use super::music::MusicPage;
use super::music_logic::play_next_move;
use super::music_ui::*;
use super::todo_widgets::{modal_overlay, window_layer};
use super::todos_menus::backdrop;
use crate::ui::*;
use gpui::*;
use lizmeter_core::{MusicTrack, PlaylistAddTrackInput};

const MENU_W: f32 = 180.0;
const MENU_H: f32 = 160.0;
const SUBMENU_W: f32 = 160.0;

/// The open "..." menu of one library row.
pub struct TrackMenu {
    pub track: MusicTrack,
    /// The box of the "..." button it hangs from.
    pub button: Option<Bounds<Pixels>>,
    pub sub_row: Probe,
    pub sub_row_hover: bool,
    pub sub_hover: bool,
}

/// Where the menu goes: under the button and right-aligned with it, or above when there is no room.
pub fn menu_origin(button: Bounds<Pixels>, viewport: Size<Pixels>) -> Point<Pixels> {
    let (vw, vh) = (f32::from(viewport.width), f32::from(viewport.height));
    let right = f32::from(button.right());
    let (top, bottom) = (f32::from(button.top()), f32::from(button.bottom()));
    let left = (right - MENU_W).min(vw - MENU_W - 8.0).max(8.0);
    let y = if bottom + 2.0 + MENU_H > vh { top - MENU_H - 2.0 } else { bottom + 2.0 };
    point(px(left), px(y))
}

/// Where the submenu goes: right of its row, or left of it when it would leave the window.
pub fn submenu_origin(row: Bounds<Pixels>, viewport_w: f32) -> Point<Pixels> {
    let right = f32::from(row.right());
    let x = if right + 4.0 + SUBMENU_W > viewport_w { f32::from(row.left()) - SUBMENU_W - 4.0 } else { right + 4.0 };
    point(px(x), row.top())
}

impl MusicPage {
    pub(super) fn open_track_menu(&mut self, track: MusicTrack, button: Option<Bounds<Pixels>>, cx: &mut Context<Self>) {
        self.playlists.list = self.music().playlist_list().unwrap_or_default();
        self.menu = Some(TrackMenu { track, button, sub_row: probe(), sub_row_hover: false, sub_hover: false });
        cx.notify();
    }

    fn menu_add_to_queue(&mut self, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        self.music().enqueue(menu.track, None);
        self.hub.update(cx, |h, cx| h.refresh(cx));
        cx.notify();
    }

    fn menu_play_next(&mut self, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        let (old_len, current) = (self.queue.len(), self.current_index);
        self.music().enqueue(menu.track, None);
        if let Some((from, to)) = play_next_move(old_len, current) {
            self.music().reorder_queue(from, to);
        }
        self.hub.update(cx, |h, cx| h.refresh(cx));
        cx.notify();
    }

    fn menu_add_to_playlist(&mut self, playlist_id: i64, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        let _ = self.music().playlist_add_track(&PlaylistAddTrackInput { playlist_id, track_id: Some(menu.track.id), url: None });
        cx.notify();
    }

    fn menu_delete(&mut self, cx: &mut Context<Self>) {
        if let Some(menu) = self.menu.take() {
            self.delete_track = Some(menu.track);
        }
        cx.notify();
    }

    fn menu_element(&self, window: &Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu.as_ref()?;
        let button = menu.button?;
        let me = cx.entity();
        let vp = window.viewport_size();
        let (m_queue, m_next, m_del, m_hover) = (me.clone(), me.clone(), me.clone(), me.clone());
        let sub_row = div()
            .id("tm-playlist")
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .px(px(10.0))
            .py(px(7.0))
            .rounded(px(7.0))
            .font_family(UI_FONT)
            .text_size(px(12.0))
            .line_height(px(15.6))
            .font_weight(FontWeight(500.0))
            .text_color(col(TN_TEXT_DIM))
            .cursor_pointer()
            .hover(|s| s.bg(col(crate::css::rgba(122, 162, 247, 0.1))).text_color(col(TN_TEXT)))
            .child(measure(&menu.sub_row))
            .child("Add to Playlist")
            .child(div().ml(px(4.0)).child(ico("chevron", 12.0, 12.0, TN_TEXT_DIM)))
            .on_hover(move |hovered, _, app| {
                m_hover.update(app, |p, cx| {
                    if let Some(m) = &mut p.menu {
                        m.sub_row_hover = *hovered;
                        cx.notify();
                    }
                })
            });
        let list = popup_glass()
            .min_w(px(MENU_W))
            .flex()
            .flex_col()
            .child(menu_row("tm-queue", "Add to Queue", false).on_click(move |_, _, app| m_queue.update(app, |p, cx| p.menu_add_to_queue(cx))))
            .child(menu_row("tm-next", "Play Next", false).on_click(move |_, _, app| m_next.update(app, |p, cx| p.menu_play_next(cx))))
            .child(menu_divider())
            .child(sub_row)
            .child(menu_divider())
            .child(menu_row("tm-delete", "Delete from Library", true).on_click(move |_, _, app| m_del.update(app, |p, cx| p.menu_delete(cx))));
        let close = me.clone();
        let back = backdrop(window, None, move |_, app| {
            close.update(app, |p, cx| {
                p.menu = None;
                cx.notify();
            })
        });
        let mut layer = div().child(back).child(deferred(anchored().position(menu_origin(button, vp)).anchor(Corner::TopLeft).child(list)).with_priority(7));
        if menu.sub_row_hover || menu.sub_hover {
            if let Some(row) = menu.sub_row.get() {
                let m_sub = me.clone();
                let mut sub = popup_glass().min_w(px(SUBMENU_W)).flex().flex_col();
                if self.playlists.list.is_empty() {
                    sub = sub.child(div().px(px(10.0)).py(px(7.0)).font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).italic().text_color(col(TN_TEXT_DIM)).child("No playlists"));
                }
                for p in &self.playlists.list {
                    let (id, m) = (p.id, me.clone());
                    sub = sub.child(menu_row(SharedString::from(format!("tm-pl-{id}")), &p.name, false).on_click(move |_, _, app| m.update(app, |pg, cx| pg.menu_add_to_playlist(id, cx))));
                }
                layer = layer.child(deferred(anchored().position(submenu_origin(row, f32::from(vp.width))).anchor(Corner::TopLeft).child(div().id("tm-sub").on_hover(move |hovered, _, app| {
                    m_sub.update(app, |p, cx| {
                        if let Some(m) = &mut p.menu {
                            m.sub_hover = *hovered;
                            cx.notify();
                        }
                    })
                }).child(sub))).with_priority(8));
            }
        }
        Some(layer.into_any_element())
    }

    pub(super) fn render_overlays(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if let Some(menu) = self.menu_element(window, cx) {
            out.push(menu);
        }
        let me = cx.entity();
        if let Some(track) = &self.delete_track {
            let (m_cancel, m_ok, m_close) = (me.clone(), me.clone(), me.clone());
            let actions = div()
                .child(dialog_cancel("del-cancel", "Cancel", true).on_click(move |_, _, app| {
                    m_cancel.update(app, |p, cx| {
                        p.delete_track = None;
                        cx.notify();
                    })
                }))
                .child(dialog_danger("del-ok", "Delete", true).on_click(move |_, _, app| m_ok.update(app, |p, cx| p.confirm_delete_track(cx))));
            let dialog = confirm_dialog("Delete from Library?", format!("\"{}\" will be removed from your library. This cannot be undone.", track.title), actions);
            let overlay = modal_overlay("music-delete", None, div().id("music-delete-box").on_click(|_, _, _| {}).child(dialog), move |_, app| {
                m_close.update(app, |p, cx| {
                    p.delete_track = None;
                    cx.notify();
                })
            });
            out.push(window_layer(window, overlay).into_any_element());
        }
        if let Some(clearing) = self.library.clear_dialog {
            let n = self.library.total;
            let (m_cancel, m_ok, m_close) = (me.clone(), me.clone(), me.clone());
            let actions = div()
                .child(dialog_cancel("clear-cancel", "Cancel", !clearing).on_click(move |_, _, app| {
                    if !clearing {
                        m_cancel.update(app, |p, cx| {
                            p.library.clear_dialog = None;
                            cx.notify();
                        })
                    }
                }))
                .child(dialog_danger("clear-ok", if clearing { "Clearing…" } else { "Clear Library" }, !clearing).on_click(move |_, _, app| m_ok.update(app, |p, cx| p.confirm_clear_library(cx))));
            let text = format!("Delete all {n} track{} and cached files? Playlists are kept but emptied. This cannot be undone.", if n == 1 { "" } else { "s" });
            let dialog = confirm_dialog("Clear Library?", text, actions);
            let overlay = modal_overlay("music-clear", None, div().id("music-clear-box").on_click(|_, _, _| {}).child(dialog), move |_, app| {
                m_close.update(app, |p, cx| {
                    if p.library.clear_dialog == Some(false) {
                        p.library.clear_dialog = None;
                        cx.notify();
                    }
                })
            });
            out.push(window_layer(window, overlay).into_any_element());
        }
        if let Some(pl) = &self.playlists.deleting {
            let (m_cancel, m_ok, m_close) = (me.clone(), me.clone(), me);
            let actions = div()
                .child(dialog_cancel("pl-del-cancel", "Cancel", true).on_click(move |_, _, app| {
                    m_cancel.update(app, |p, cx| {
                        p.playlists.deleting = None;
                        cx.notify();
                    })
                }))
                .child(dialog_danger("pl-del-ok", "Delete", true).on_click(move |_, _, app| m_ok.update(app, |p, cx| p.confirm_delete_playlist(cx))));
            let dialog = confirm_dialog(&format!("Delete \"{}\"?", pl.name), "This will remove the playlist. Your tracks will remain in the library.".into(), actions);
            let overlay = modal_overlay("music-pl-delete", None, div().id("music-pl-delete-box").on_click(|_, _, _| {}).child(dialog), move |_, app| {
                m_close.update(app, |p, cx| {
                    p.playlists.deleting = None;
                    cx.notify();
                })
            });
            out.push(window_layer(window, overlay).into_any_element());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::{menu_origin, submenu_origin};
    use gpui::{point, px, size, Bounds, Pixels};

    fn bounds(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        Bounds { origin: point(px(x), px(y)), size: size(px(w), px(h)) }
    }

    #[test]
    fn the_menu_hangs_under_its_button_and_flips_above_at_the_bottom() {
        let vp = size(px(900.0), px(600.0));
        let p = menu_origin(bounds(700.0, 100.0, 22.0, 22.0), vp);
        assert_eq!((f32::from(p.x), f32::from(p.y)), (542.0, 124.0));
        let p = menu_origin(bounds(700.0, 520.0, 22.0, 22.0), vp);
        assert_eq!(f32::from(p.y), 520.0 - 160.0 - 2.0);
        let p = menu_origin(bounds(880.0, 100.0, 22.0, 22.0), vp);
        assert_eq!(f32::from(p.x), 900.0 - 180.0 - 8.0);
        let p = menu_origin(bounds(2.0, 100.0, 22.0, 22.0), vp);
        assert_eq!(f32::from(p.x), 8.0);
    }

    #[test]
    fn the_submenu_opens_right_unless_it_would_leave_the_window() {
        let row = bounds(500.0, 200.0, 180.0, 30.0);
        let p = submenu_origin(row, 1000.0);
        assert_eq!((f32::from(p.x), f32::from(p.y)), (684.0, 200.0));
        let p = submenu_origin(row, 800.0);
        assert_eq!(f32::from(p.x), 500.0 - 160.0 - 4.0);
    }
}
