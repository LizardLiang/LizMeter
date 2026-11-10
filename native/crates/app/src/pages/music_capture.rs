//! `--do music-...` capture hooks of the Music page: they put the page into a state a screenshot
//! shows (a tab, a menu, a dialog, a playing track) without a mouse.

use super::music::{MusicPage, Tab};
use super::music_menu::TrackMenu;
use super::music_ui::probe;
use gpui::*;

impl MusicPage {
    /// `tab:<queue|library|playlists>`, `fill-queue`, `play`, `pause`, `menu`, `menu-sub`,
    /// `delete-dialog`, `clear-dialog`, `playlist:<n>`, `playlist-delete`, `consent`, `health`,
    /// `save-form`, `new-playlist`, `search:<text>`, `offline`.
    pub fn capture(&mut self, op: &str, window: &mut Window, cx: &mut Context<Self>) {
        match op {
            "fill-queue" => {
                let tracks = self.music().library_list(&Default::default()).map(|r| r.tracks).unwrap_or_default();
                self.music().enqueue_bulk(tracks.into_iter().take(6).collect(), None);
                self.hub.update(cx, |h, cx| h.refresh(cx));
            }
            "play" => {
                let first = self.music().library_list(&lizmeter_core::MusicLibraryListInput { cached_only: Some(true), ..Default::default() }).ok().and_then(|r| r.tracks.into_iter().nth(1));
                if let Some(t) = first {
                    self.play_track(t, cx);
                }
            }
            "pause" => {
                self.music().pause();
                self.hub.update(cx, |h, cx| h.refresh(cx));
            }
            "menu" => {
                if let Some(t) = self.library.tracks.first().cloned() {
                    let b = self.library.menu_buttons.get(&t.id).and_then(|p| p.get());
                    self.open_track_menu(t, b, cx);
                }
            }
            "menu-sub" => {
                if let Some(TrackMenu { sub_row_hover, .. }) = &mut self.menu {
                    *sub_row_hover = true;
                }
            }
            "delete-dialog" => self.delete_track = self.library.tracks.first().cloned(),
            "clear-dialog" => self.library.clear_dialog = Some(false),
            "playlist-delete" => self.playlists.deleting = self.playlists.selected_playlist().cloned(),
            "consent" => self.capture_consent(cx),
            "health" => self.capture_health(cx),
            "save-form" => self.queue_ui.save_form = true,
            "new-playlist" => {
                self.playlists.new_form = true;
                let focus = self.playlists.new_name.read(cx).focus_handle().clone();
                window.focus(&focus);
            }
            "offline" => {
                self.library.query.offline_only = true;
                self.library_reload(cx);
            }
            op if op.starts_with("tab:") => {
                let tab = match &op[4..] {
                    "library" => Tab::Library,
                    "playlists" => Tab::Playlists,
                    _ => Tab::Queue,
                };
                self.set_tab(tab, cx);
            }
            op if op.starts_with("playlist:") => {
                if let Some(p) = op[9..].parse::<usize>().ok().and_then(|i| self.playlists.list.get(i)).map(|p| p.id) {
                    self.capture_select_playlist(p, cx);
                }
            }
            op if op.starts_with("search:") => {
                let text = op[7..].to_string();
                self.library.search.update(cx, |f, cx| f.set_text(&text, cx));
            }
            _ => {}
        }
        let _ = probe;
        cx.notify();
    }
}
