//! `PlaylistManager.tsx` and `usePlaylists.ts`: playlists on the left, the selected playlist's
//! tracks on the right with drag reorder, remove and add-by-URL.

use super::music::{is_url, spinner, url_field, MusicPage};
use super::music_queue::{duration_label, row_at, sort_shift, thumb, track_text, Ghost, ROW_GAP, ROW_H};
use super::music_ui::*;
use crate::css::rgba;
use crate::ui::*;
use gpui::prelude::FluentBuilder;
use gpui::*;
use lizmeter_core::{MusicPlaylist, PlaylistAddTrackInput, PlaylistTrack};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent};

pub struct PlaylistsUi {
    pub list: Vec<MusicPlaylist>,
    pub loaded: bool,
    pub selected: Option<i64>,
    pub tracks: Vec<PlaylistTrack>,
    pub tracks_loading: bool,
    pub new_form: bool,
    pub new_name: Entity<TextField>,
    pub new_loading: bool,
    pub renaming: Option<i64>,
    pub rename_field: Entity<TextField>,
    pub deleting: Option<MusicPlaylist>,
    pub add_url: Entity<TextField>,
    pub add_loading: bool,
    pub add_error: Option<String>,
    pub drag: Option<(usize, usize)>,
    generation: u64,
}

#[derive(Clone)]
pub struct PlaylistDrag(pub usize);

impl PlaylistsUi {
    pub fn new(window: &mut Window, cx: &mut Context<MusicPage>, subs: &mut Vec<Subscription>) -> Self {
        let new_name = url_field("Playlist name", 12.0, window, cx);
        subs.push(cx.subscribe(&new_name, |this, _, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Submit => this.playlist_create(cx),
            TextFieldEvent::Cancel => {
                this.playlists.new_form = false;
                cx.notify();
            }
            TextFieldEvent::Changed => cx.notify(),
        }));
        let rename_field = url_field("", 13.0, window, cx);
        subs.push(cx.subscribe(&rename_field, |this, _, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Submit => this.playlist_rename(cx),
            TextFieldEvent::Cancel => {
                this.playlists.renaming = None;
                cx.notify();
            }
            TextFieldEvent::Changed => {}
        }));
        let add_url = url_field("Paste URL to add track...", 12.0, window, cx);
        subs.push(cx.subscribe(&add_url, |this, _, ev: &TextFieldEvent, cx| match ev {
            TextFieldEvent::Submit => this.playlist_add_url(cx),
            TextFieldEvent::Changed => {
                this.playlists.add_error = None;
                cx.notify();
            }
            TextFieldEvent::Cancel => {}
        }));
        Self {
            list: vec![],
            loaded: false,
            selected: None,
            tracks: vec![],
            tracks_loading: false,
            new_form: false,
            new_name,
            new_loading: false,
            renaming: None,
            rename_field,
            deleting: None,
            add_url,
            add_loading: false,
            add_error: None,
            drag: None,
            generation: 0,
        }
    }

    pub fn selected_playlist(&self) -> Option<&MusicPlaylist> {
        self.selected.and_then(|id| self.list.iter().find(|p| p.id == id))
    }
}

/// The playlists, and the tracks of `selected` when there is one.
pub fn load(svc: &Services, selected: Option<i64>) -> (Vec<MusicPlaylist>, Option<Vec<PlaylistTrack>>) {
    let list = svc.music().playlist_list().unwrap_or_default();
    let tracks = selected.filter(|id| list.iter().any(|p| p.id == *id)).and_then(|id| svc.music().playlist_tracks(id).ok());
    (list, tracks)
}

impl MusicPage {
    pub fn playlists_reload(&mut self, cx: &mut Context<Self>) {
        self.playlists.generation += 1;
        let generation = self.playlists.generation;
        let (svc, selected) = (self.svc.clone(), self.playlists.selected);
        self.playlists.tracks_loading = selected.is_some();
        cx.spawn(async move |this, cx| {
            let (list, tracks) = cx.background_executor().spawn(async move { load(&svc, selected) }).await;
            let _ = this.update(cx, |p, cx| {
                if p.playlists.generation != generation {
                    return;
                }
                p.playlists.loaded = true;
                p.playlists.list = list;
                p.playlists.tracks_loading = false;
                match tracks {
                    Some(t) => p.playlists.tracks = t,
                    None => {
                        if p.playlists.selected_playlist().is_none() {
                            p.playlists.selected = None;
                        }
                        p.playlists.tracks.clear();
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn capture_select_playlist(&mut self, id: i64, cx: &mut Context<Self>) {
        self.select_playlist(id, cx);
    }

    fn select_playlist(&mut self, id: i64, cx: &mut Context<Self>) {
        self.playlists.selected = Some(id);
        self.playlists.renaming = None;
        self.playlists.add_error = None;
        self.playlists_reload(cx);
    }

    fn playlist_create(&mut self, cx: &mut Context<Self>) {
        let name = self.playlists.new_name.read(cx).text().trim().to_string();
        if name.is_empty() || self.playlists.new_loading {
            return;
        }
        if let Ok(created) = self.music().playlist_create(&name, &[]) {
            self.playlists.new_name.update(cx, |f, cx| f.set_text("", cx));
            self.playlists.new_form = false;
            self.select_playlist(created.id, cx);
        }
    }

    fn playlist_rename(&mut self, cx: &mut Context<Self>) {
        let name = self.playlists.rename_field.read(cx).text().trim().to_string();
        let Some(id) = self.playlists.renaming else { return };
        if name.is_empty() {
            return;
        }
        let _ = self.music().playlist_rename(id, &name);
        self.playlists.renaming = None;
        self.playlists_reload(cx);
    }

    pub(super) fn confirm_delete_playlist(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.playlists.deleting.take() else { return };
        let _ = self.music().playlist_delete(p.id);
        if self.playlists.selected == Some(p.id) {
            self.playlists.selected = None;
            self.playlists.tracks.clear();
        }
        self.playlists_reload(cx);
    }

    fn playlist_add_url(&mut self, cx: &mut Context<Self>) {
        let url = self.playlists.add_url.read(cx).text().trim().to_string();
        let Some(id) = self.playlists.selected else { return };
        if url.is_empty() || self.playlists.add_loading {
            return;
        }
        if !is_url(&url) {
            self.playlists.add_error = Some("Invalid URL".into());
            cx.notify();
            return;
        }
        self.playlists.add_error = None;
        self.playlists.add_loading = true;
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { svc.music().playlist_add_track(&PlaylistAddTrackInput { playlist_id: id, track_id: None, url: Some(url) }) })
                .await;
            let _ = this.update(cx, |p, cx| {
                p.playlists.add_loading = false;
                match result {
                    Ok(_) => {
                        p.playlists.add_url.update(cx, |f, cx| f.set_text("", cx));
                        p.playlists_reload(cx);
                    }
                    Err(e) => p.playlists.add_error = Some(if e.message.is_empty() { "Failed to add track".into() } else { e.message }),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn play_playlist(&mut self, cx: &mut Context<Self>) {
        let tracks: Vec<_> = self.playlists.tracks.iter().map(|t| t.track.clone()).collect();
        let Some(first) = tracks.first().cloned() else { return };
        self.music().clear_queue();
        self.music().enqueue_bulk(tracks, self.playlists.selected);
        self.play_track(first, cx);
    }

    fn drop_playlist_row(&mut self, from: usize, cx: &mut Context<Self>) {
        let over = self.playlists.drag.take().map(|(_, o)| o).unwrap_or(from);
        let (Some(pid), Some(entry), Some(target)) = (self.playlists.selected, self.playlists.tracks.get(from), self.playlists.tracks.get(over)) else {
            cx.notify();
            return;
        };
        if over != from {
            let _ = self.music().playlist_reorder(pid, entry.id, target.position);
            self.playlists_reload(cx);
        }
        cx.notify();
    }

    fn playlist_track_row(&self, index: usize, cx: &mut Context<Self>) -> Stateful<Div> {
        let entry = &self.playlists.tracks[index];
        let me = cx.entity();
        let (m_play, m_rm, m_drag) = (me.clone(), me.clone(), me.clone());
        let group = SharedString::from(format!("pl-row-{index}"));
        let title = entry.track.title.clone();
        let (track, entry_id) = (entry.track.clone(), entry.id);
        let dragging = self.playlists.drag.is_some_and(|(f, _)| f == index);
        let grip = div()
            .id(SharedString::from(format!("pl-grip-{index}")))
            .flex_shrink_0()
            .w(px(20.0))
            .h(px(20.0))
            .rounded(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .cursor_grab()
            .child(ico("grip", 14.0, 14.0, ICON_DIM).hover(|s| s.text_color(col(TN_TEXT_DIM))))
            .on_drag(PlaylistDrag(index), move |_, _, _, app| {
                m_drag.update(app, |p, _| p.playlists.drag = Some((index, index)));
                let t = title.clone();
                app.new(|_| Ghost(t))
            });
        let info = div()
            .id(SharedString::from(format!("pl-info-{index}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .flex_1()
            .min_w_0()
            .rounded(px(4.0))
            .cursor_pointer()
            .child(thumb(36.0))
            .child(track_text(&entry.track, false))
            .child(duration_label(entry.track.duration_seconds))
            .on_click(move |_, _, app| {
                let t = track.clone();
                m_play.update(app, |p, cx| p.play_track(t, cx))
            });
        let remove = div()
            .id(SharedString::from(format!("pl-rm-{index}")))
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
            .on_click(move |_, _, app| {
                m_rm.update(app, |p, cx| {
                    let _ = p.music().playlist_remove_track(entry_id);
                    p.playlists_reload(cx);
                })
            });
        div()
            .id(SharedString::from(format!("pl-row-{index}")))
            .group(group)
            .relative()
            .top(px(sort_shift(self.playlists.drag, index)))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .px(px(8.0))
            .py(px(6.0))
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(rgba(0, 0, 0, 0.0)))
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.05))).border_color(col(rgba(122, 162, 247, 0.08))))
            .when(dragging, |d| d.opacity(0.5))
            .child(grip)
            .child(info)
            .child(remove)
    }

    fn icon_action(id: &'static str, icon: &str, danger: bool) -> Stateful<Div> {
        let (border, hover_bg, hover_border) = if danger {
            (rgba(247, 118, 142, 0.2), rgba(247, 118, 142, 0.08), rgba(247, 118, 142, 0.35))
        } else {
            (rgba(0, 0, 0, 0.0), rgba(122, 162, 247, 0.08), rgba(122, 162, 247, 0.15))
        };
        let glyph = ico(icon, 13.0, 13.0, TN_TEXT_DIM).group_hover(id, move |s| s.text_color(col(if danger { TN_RED } else { TN_TEXT_DIM })));
        div()
            .id(id)
            .group(id)
            .w(px(26.0))
            .h(px(26.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .border_color(col(border))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .hover(move |s| s.bg(col(hover_bg)).border_color(col(hover_border)))
            .child(glyph)
    }

    fn sidebar(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let m_new = me.clone();
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .flex_shrink_0()
            .px(px(12.0))
            .pt(px(12.0))
            .pb(px(8.0))
            .border_b(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.08)))
            .child(div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT_DIM)).child(spaced("PLAYLISTS", 0.66)))
            .child(
                div()
                    .id("pl-new")
                    .w(px(22.0))
                    .h(px(22.0))
                    .rounded(px(5.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
                    .child(ico("plus", 14.0, 14.0, TN_TEXT_DIM))
                    .on_click(move |_, window, app| {
                        m_new.update(app, |p, cx| {
                            p.playlists.new_form = true;
                            p.playlists.new_name.update(cx, |f, cx| f.set_text("", cx));
                            let focus = p.playlists.new_name.read(cx).focus_handle().clone();
                            window.focus(&focus);
                            cx.notify();
                        })
                    }),
            );
        let mut side = div().flex_none().w(px(200.0)).flex().flex_col().border_r(px(1.0)).border_color(col(rgba(122, 162, 247, 0.1))).child(header);
        if self.playlists.new_form {
            let focused = self.playlists.new_name.read(cx).focus_handle().is_focused(window);
            let enabled = !self.playlists.new_loading && !self.playlists.new_name.read(cx).text().trim().is_empty();
            let (m_add, m_cancel) = (me.clone(), me.clone());
            side = side.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .px(px(8.0))
                    .pt(px(8.0))
                    .pb(px(4.0))
                    .child(inline_input(&self.playlists.new_name, focused, 6.0, (8.0, 6.0), rgba(122, 162, 247, 0.3), false))
                    .child(tint_button("pl-new-add", "Add", 12.0, enabled, 6.0, (10.0, 5.0)).when(enabled, |b| b.on_click(move |_, _, app| m_add.update(app, |p, cx| p.playlist_create(cx)))))
                    .child(
                        div()
                            .id("pl-new-cancel")
                            .flex_shrink_0()
                            .px(px(8.0))
                            .py(px(5.0))
                            .rounded(px(6.0))
                            .cursor_pointer()
                            .child(ico("close", 12.0, 12.0, TN_TEXT_DIM))
                            .on_click(move |_, _, app| {
                                m_cancel.update(app, |p, cx| {
                                    p.playlists.new_form = false;
                                    cx.notify();
                                })
                            }),
                    ),
            );
        }
        let mut list = div().flex_1().flex().flex_col().gap(px(1.0)).px(px(6.0)).py(px(6.0));
        if self.playlists.list.is_empty() && self.playlists.loaded {
            list = list.child(div().px(px(12.0)).py(px(24.0)).flex().justify_center().font_family(UI_FONT).text_size(px(12.0)).line_height(px(15.6)).text_color(col(TN_TEXT_DIM)).child("No playlists yet"));
        }
        for p in &self.playlists.list {
            let active = self.playlists.selected == Some(p.id);
            let (id, m) = (p.id, me.clone());
            list = list.child(
                div()
                    .id(SharedString::from(format!("pl-item-{id}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .w_full()
                    .px(px(8.0))
                    .py(px(7.0))
                    .rounded(px(7.0))
                    .border(px(1.0))
                    .border_color(col(if active { rgba(122, 162, 247, 0.18) } else { rgba(0, 0, 0, 0.0) }))
                    .bg(col(if active { rgba(122, 162, 247, 0.1) } else { rgba(0, 0, 0, 0.0) }))
                    .cursor_pointer()
                    .hover(move |s| if active { s.bg(col(rgba(122, 162, 247, 0.14))) } else { s.bg(col(rgba(122, 162, 247, 0.05))).border_color(col(rgba(122, 162, 247, 0.08))) })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_family(BTN_FONT)
                            .text_size(px(12.0))
                            .line_height(px(14.0))
                            .font_weight(FontWeight(500.0))
                            .text_color(col(if active { TN_BLUE } else { TN_TEXT }))
                            .child(p.name.clone()),
                    )
                    .child(div().flex_shrink_0().font_family(BTN_FONT).text_size(px(10.0)).line_height(px(12.0)).text_color(col(TN_TEXT_DIM)).child(p.track_count.to_string()))
                    .on_click(move |_, _, app| m.update(app, |p, cx| p.select_playlist(id, cx))),
            );
        }
        side.child(list)
    }

    fn track_panel(&mut self, window: &Window, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        let Some(selected) = self.playlists.selected_playlist().cloned() else {
            return div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.0))
                .px(px(24.0))
                .py(px(32.0))
                .child(div().font_family(UI_FONT).text_size(px(13.0)).line_height(px(16.9)).text_color(col(TN_TEXT)).child("Select a playlist to view tracks"))
                .child(div().font_family(UI_FONT).text_size(px(12.0)).line_height(px(15.6)).text_color(col(TN_TEXT_DIM)).child("Or create a new playlist using the + button"));
        };
        let renaming = self.playlists.renaming == Some(selected.id);
        let title: AnyElement = if renaming {
            let focused = self.playlists.rename_field.read(cx).focus_handle().is_focused(window);
            let (m_save, m_cancel) = (me.clone(), me.clone());
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .flex_1()
                .min_w_0()
                .child(inline_input(&self.playlists.rename_field, focused, 5.0, (8.0, 4.0), rgba(122, 162, 247, 0.35), false))
                .child(tint_button("pl-rename-save", "Save", 11.0, true, 5.0, (10.0, 4.0)).on_click(move |_, _, app| m_save.update(app, |p, cx| p.playlist_rename(cx))))
                .child(ghost_button("pl-rename-cancel", "Cancel", 11.0, (8.0, 4.0)).on_click(move |_, _, app| {
                    m_cancel.update(app, |p, cx| {
                        p.playlists.renaming = None;
                        cx.notify();
                    })
                }))
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(UI_FONT)
                .text_size(px(13.0))
                .line_height(px(16.9))
                .font_weight(FontWeight(600.0))
                .text_color(col(TN_TEXT))
                .child(selected.name.clone())
                .into_any_element()
        };
        let (m_play, m_rename, m_delete) = (me.clone(), me.clone(), me.clone());
        let (sel_name, sel_for_delete) = (selected.name.clone(), selected.clone());
        let mut actions = div().flex().flex_row().items_center().gap(px(6.0)).flex_shrink_0();
        if selected.track_count > 0 {
            actions = actions.child(
                div()
                    .id("pl-play")
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .px(px(10.0))
                    .py(px(4.0))
                    .rounded(px(6.0))
                    .border(px(1.0))
                    .border_color(col(rgba(122, 162, 247, 0.2)))
                    .bg(col(rgba(122, 162, 247, 0.08)))
                    .font_family(BTN_FONT)
                    .text_size(px(11.0))
                    .line_height(px(13.0))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(TN_BLUE))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.15))).border_color(col(rgba(122, 162, 247, 0.35))))
                    .child(ico("play-small", 12.0, 12.0, TN_BLUE))
                    .child(spaced("Play", 0.22))
                    .on_click(move |_, _, app| m_play.update(app, |p, cx| p.play_playlist(cx))),
            );
        }
        actions = actions
            .child(Self::icon_action("pl-rename", "pencil", false).on_click(move |_, window, app| {
                let name = sel_name.clone();
                m_rename.update(app, |p, cx| {
                    p.playlists.renaming = Some(p.playlists.selected.unwrap_or_default());
                    p.playlists.rename_field.update(cx, |f, cx| f.set_text(&name, cx));
                    let focus = p.playlists.rename_field.read(cx).focus_handle().clone();
                    window.focus(&focus);
                    cx.notify();
                })
            }))
            .child(Self::icon_action("pl-delete", "trash", true).on_click(move |_, _, app| {
                let p = sel_for_delete.clone();
                m_delete.update(app, |pg, cx| {
                    pg.playlists.deleting = Some(p);
                    cx.notify();
                })
            }));
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .flex_shrink_0()
            .px(px(16.0))
            .pt(px(12.0))
            .pb(px(8.0))
            .border_b(px(1.0))
            .border_color(col(rgba(122, 162, 247, 0.08)))
            .child(title)
            .child(actions);

        let n = self.playlists.tracks.len();
        let list: AnyElement = if self.playlists.tracks_loading {
            div().flex().flex_col().items_center().px(px(24.0)).py(px(32.0)).child(spinner(16.0)).into_any_element()
        } else if n == 0 {
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.0))
                .px(px(24.0))
                .py(px(32.0))
                .child(div().font_family(UI_FONT).text_size(px(13.0)).line_height(px(16.9)).text_color(col(TN_TEXT)).child("No tracks in this playlist"))
                .child(div().font_family(UI_FONT).text_size(px(12.0)).line_height(px(15.6)).text_color(col(TN_TEXT_DIM)).child("Paste a URL below to add a track"))
                .into_any_element()
        } else {
            let mut rows = div().relative().flex().flex_col().gap(px(ROW_GAP));
            for i in 0..n {
                rows = rows.child(self.playlist_track_row(i, cx));
            }
            let (m_move, m_drop, m_cancel) = (me.clone(), me.clone(), me.clone());
            rows.on_drag_move(move |ev: &DragMoveEvent<PlaylistDrag>, _, app| {
                let from = ev.drag(app).0;
                let y = f32::from(ev.event.position.y) - f32::from(ev.bounds.origin.y);
                m_move.update(app, |p, cx| {
                    let over = row_at(y, p.playlists.tracks.len());
                    if p.playlists.drag != Some((from, over)) {
                        p.playlists.drag = Some((from, over));
                        cx.notify();
                    }
                })
            })
            .on_drop(move |d: &PlaylistDrag, _, app| {
                let from = d.0;
                m_drop.update(app, |p, cx| p.drop_playlist_row(from, cx))
            })
            .on_mouse_up_out(MouseButton::Left, move |_, _, app| {
                m_cancel.update(app, |p, cx| {
                    if p.playlists.drag.take().is_some() {
                        cx.notify();
                    }
                })
            })
            .into_any_element()
        };

        let focused = self.playlists.add_url.read(cx).focus_handle().is_focused(window);
        let can_add = !self.playlists.add_loading && !self.playlists.add_url.read(cx).text().trim().is_empty();
        let m_add = me;
        let mut add = div().flex_shrink_0().px(px(12.0)).pt(px(8.0)).pb(px(12.0)).border_t(px(1.0)).border_color(col(rgba(122, 162, 247, 0.08))).child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(inline_input(&self.playlists.add_url, focused, 7.0, (10.0, 7.0), rgba(41, 46, 66, 0.8), true).opacity(if self.playlists.add_loading { 0.7 } else { 1.0 }))
                .child(
                    tint_button("pl-add-url", if self.playlists.add_loading { "" } else { "Add" }, 12.0, can_add, 7.0, (12.0, 7.0))
                        .when(self.playlists.add_loading, |b| b.child(spinner(16.0)))
                        .when(can_add, |b| b.on_click(move |_, _, app| m_add.update(app, |p, cx| p.playlist_add_url(cx)))),
                ),
        );
        if let Some(e) = &self.playlists.add_error {
            add = add.child(div().pt(px(4.0)).pl(px(2.0)).font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_RED)).child(e.clone()));
        }
        div().flex_1().min_w_0().flex().flex_col().child(header).child(div().flex_1().px(px(8.0)).py(px(8.0)).child(list)).child(add)
    }

    pub(super) fn render_playlists(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let side = self.sidebar(window, cx);
        let panel = self.track_panel(window, cx);
        div().flex().flex_row().w_full().min_h(px(320.0)).overflow_hidden().child(side).child(panel)
    }
}
