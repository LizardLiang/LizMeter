//! `MusicPage.tsx`: the URL bar, the setup banner, the three tabs and the toasts. The tab bodies
//! live in `music_queue`, `music_library` and `music_playlists`; the dialogs in `music_menu` and
//! `music_consent`.

use super::music_consent::{ConsentDialog, ConsentEvent};
use super::music_library::LibraryUi;
use super::music_playlists::PlaylistsUi;
use super::music_queue::QueueUi;
use super::music_ui::*;
use crate::controls::{field_style, page_heading, page_shell};
use crate::css::{rgba, Spec};
use crate::music_hub::{HubEvent, MusicHub};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{BinaryStatus, ImportProgress, MusicErrorCode, MusicQueueItem, MusicTrack};
use lizmeter_music::{MusicEvent, MusicService};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent, TextInput};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Queue,
    Library,
    Playlists,
}

impl Tab {
    const ALL: [Tab; 3] = [Tab::Queue, Tab::Library, Tab::Playlists];

    fn label(self) -> &'static str {
        match self {
            Tab::Queue => "Queue",
            Tab::Library => "Library",
            Tab::Playlists => "Playlists",
        }
    }
}

struct Toast {
    id: u64,
    message: String,
}

pub struct MusicPage {
    pub(super) svc: Arc<Services>,
    pub(super) hub: Entity<MusicHub>,
    pub(super) queue: Vec<MusicQueueItem>,
    pub(super) current_index: i64,
    import: Option<ImportProgress>,
    url: Entity<TextField>,
    extracting: Option<Instant>,
    pub tab: Tab,
    binary: Option<BinaryStatus>,
    consent: Option<Entity<ConsentDialog>>,
    pending_url: Option<String>,
    toasts: Vec<Toast>,
    next_toast: u64,
    pub(super) queue_ui: QueueUi,
    pub(super) library: LibraryUi,
    pub(super) playlists: PlaylistsUi,
    pub(super) menu: Option<super::music_menu::TrackMenu>,
    pub(super) delete_track: Option<MusicTrack>,
    visible: bool,
    _subs: Vec<Subscription>,
}

/// Whether `text` parses as an absolute URL, as `new URL(text)` does.
pub fn is_url(text: &str) -> bool {
    lizmeter_music::extractor::validate_url(text).is_ok()
}

pub fn url_field(placeholder: &str, size: f32, window: &mut Window, cx: &mut App) -> Entity<TextField> {
    let mut style = field_style(size);
    style.placeholder_color = col(ICON_DIM);
    TextInput::new(style, placeholder, window, cx)
}

impl MusicPage {
    pub fn new(svc: Arc<Services>, hub: Entity<MusicHub>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let url = url_field("Paste a URL to play audio...", 14.0, window, cx);
        let mut subs = vec![cx.subscribe(&url, |this, _, ev: &TextFieldEvent, cx| {
            if matches!(ev, TextFieldEvent::Submit) {
                this.submit_url(cx);
            }
        })];
        subs.push(cx.subscribe(&hub, |this, _, ev: &HubEvent, cx| this.on_hub(ev, cx)));
        let queue_ui = QueueUi::new(window, cx, &mut subs);
        let library = LibraryUi::new(window, cx, &mut subs);
        let playlists = PlaylistsUi::new(window, cx, &mut subs);
        let snap = hub.read(cx).snap.clone();
        Self {
            svc,
            hub,
            queue: snap.queue,
            current_index: snap.current_index,
            import: snap.import_progress,
            url,
            extracting: None,
            tab: Tab::Queue,
            binary: None,
            consent: None,
            pending_url: None,
            toasts: vec![],
            next_toast: 0,
            queue_ui,
            library,
            playlists,
            menu: None,
            delete_track: None,
            visible: false,
            _subs: subs,
        }
    }

    pub(super) fn music(&self) -> &MusicService {
        self.svc.music()
    }

    /// The page was opened: read what it lists again.
    pub fn show(&mut self, cx: &mut Context<Self>) {
        self.visible = true;
        self.refresh_binary_status(cx);
        self.sync_from_hub(cx);
        if self.tab == Tab::Library {
            self.library_reload(cx);
        }
        if self.tab == Tab::Playlists {
            self.playlists_reload(cx);
        }
        cx.notify();
    }

    /// Reads which binaries are installed (the check runs each one) without blocking the window.
    fn refresh_binary_status(&mut self, cx: &mut Context<Self>) {
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let status = cx.background_executor().spawn(async move { svc.music().binary_status() }).await;
            let _ = this.update(cx, |p, cx| {
                p.binary = Some(status);
                cx.notify();
            });
        })
        .detach();
    }

    pub fn hide(&mut self) {
        self.visible = false;
    }

    fn sync_from_hub(&mut self, cx: &mut Context<Self>) {
        let snap = &self.hub.read(cx).snap;
        self.queue = snap.queue.clone();
        self.current_index = snap.current_index;
        self.import = snap.import_progress.clone();
    }

    fn on_hub(&mut self, ev: &HubEvent, cx: &mut Context<Self>) {
        match ev {
            HubEvent::Structure => {
                self.sync_from_hub(cx);
                cx.notify();
            }
            HubEvent::Service(MusicEvent::BinaryDownloadProgress(p)) => {
                if let Some(c) = self.consent.clone() {
                    let p = p.clone();
                    c.update(cx, |c, cx| c.on_progress(p, cx));
                }
            }
            HubEvent::Service(MusicEvent::IntegrityProgress(p)) => self.on_integrity_progress(p.clone(), cx),
            HubEvent::Service(MusicEvent::PlaylistImported(_)) => {
                if self.tab == Tab::Playlists {
                    self.playlists_reload(cx);
                }
            }
            HubEvent::Service(_) => {}
        }
    }

    pub(super) fn toast(&mut self, message: impl Into<String>, cx: &mut Context<Self>) {
        self.next_toast += 1;
        let id = self.next_toast;
        self.toasts.push(Toast { id, message: message.into() });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(3)).await;
            let _ = this.update(cx, |p, cx| {
                p.toasts.retain(|t| t.id != id);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn set_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        self.tab = tab;
        self.menu = None;
        match tab {
            Tab::Queue => {}
            Tab::Library => self.library_reload(cx),
            Tab::Playlists => self.playlists_reload(cx),
        }
        cx.notify();
    }

    fn binaries_missing(&self) -> bool {
        self.binary.as_ref().is_some_and(|b| !b.yt_dlp_installed || !b.ffmpeg_installed)
    }

    fn submit_url(&mut self, cx: &mut Context<Self>) {
        let text = self.url.read(cx).text().trim().to_string();
        if text.is_empty() || self.extracting.is_some() {
            return;
        }
        self.play_url(text, cx);
    }

    /// `MusicPage.handlePlay`.
    fn play_url(&mut self, url: String, cx: &mut Context<Self>) {
        if !is_url(&url) {
            self.toast("Please enter a valid URL.", cx);
            return;
        }
        if self.binaries_missing() {
            self.pending_url = Some(url);
            self.open_consent(cx);
            return;
        }
        self.extracting = Some(Instant::now());
        let svc = self.svc.clone();
        let started = url.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { svc.music().play(&started, None).map(|_| ()) }).await;
            let _ = this.update(cx, |p, cx| {
                p.extracting = None;
                match result {
                    Ok(()) => {
                        p.url.update(cx, |u, cx| u.set_text("", cx));
                        p.set_tab(Tab::Queue, cx);
                    }
                    Err(e) if e.code == MusicErrorCode::BinaryMissing => {
                        p.pending_url = Some(url);
                        p.open_consent(cx);
                    }
                    Err(e) => p.toast(if e.message.is_empty() { "Playback failed.".to_string() } else { e.message }, cx),
                }
                p.hub.update(cx, |h, cx| h.refresh(cx));
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Plays a library or playlist track straight from its stored URL.
    pub(super) fn play_track(&mut self, track: MusicTrack, cx: &mut Context<Self>) {
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let url = track.source_url.clone();
            let _ = cx.background_executor().spawn(async move { svc.music().play(&url, Some(track)) }).await;
            let _ = this.update(cx, |p, cx| p.hub.update(cx, |h, cx| h.refresh(cx)));
        })
        .detach();
    }

    pub(super) fn capture_consent(&mut self, cx: &mut Context<Self>) {
        self.open_consent(cx);
    }

    fn open_consent(&mut self, cx: &mut Context<Self>) {
        let svc = self.svc.clone();
        let dialog = cx.new(|cx| ConsentDialog::new(svc, cx));
        let sub = cx.subscribe(&dialog, |this, _, ev: &ConsentEvent, cx| match ev {
            ConsentEvent::Accept => this.consent_accepted(cx),
            ConsentEvent::Cancel => {
                this.consent = None;
                this.pending_url = None;
                cx.notify();
            }
        });
        self._subs.push(sub);
        self.consent = Some(dialog);
        cx.notify();
    }

    fn consent_accepted(&mut self, cx: &mut Context<Self>) {
        self.consent = None;
        let Some(url) = self.pending_url.take() else {
            self.refresh_binary_status(cx);
            cx.notify();
            return;
        };
        // The next play needs the new status: read it first, then play.
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let status = cx.background_executor().spawn(async move { svc.music().binary_status() }).await;
            let _ = this.update(cx, |p, cx| {
                p.binary = Some(status);
                p.url.update(cx, |u, cx| u.set_text(&url, cx));
                p.play_url(url, cx);
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn escape(&mut self, cx: &mut Context<Self>) -> bool {
        if self.delete_track.take().is_some() || self.menu.take().is_some() || self.library.clear_dialog.take().is_some() || self.playlists.deleting.take().is_some() {
            cx.notify();
            return true;
        }
        false
    }

    fn overlay_open(&self) -> bool {
        self.menu.is_some() || self.delete_track.is_some() || self.library.clear_dialog.is_some() || self.playlists.deleting.is_some()
    }

    fn setup_banner(&self, cx: &mut Context<Self>) -> Option<Div> {
        if !self.binaries_missing() || self.consent.is_some() {
            return None;
        }
        let me = cx.entity();
        let yellow = TN_YELLOW;
        Some(
            Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(224, 175, 104, 0.08)).border(1.0, rgba(224, 175, 104, 0.22)))
                .el()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.0))
                .px(px(16.0))
                .py(px(12.0))
                .mb(px(20.0))
                .child(div().flex_1().font_family(UI_FONT).text_size(px(13.0)).line_height(px(16.9)).text_color(col(yellow)).child("Music playback requires a one-time setup."))
                .child(
                    div()
                        .id("music-setup")
                        .px(px(14.0))
                        .py(px(6.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(rgba(224, 175, 104, 0.35)))
                        .bg(col(rgba(224, 175, 104, 0.12)))
                        .font_family(BTN_FONT)
                        .text_size(px(12.0))
                        .line_height(px(14.0))
                        .font_weight(FontWeight(600.0))
                        .text_color(col(yellow))
                        .cursor_pointer()
                        .hover(|s| s.bg(col(rgba(224, 175, 104, 0.2))).border_color(col(rgba(224, 175, 104, 0.5))))
                        .child(spaced("Set Up Now", 0.36))
                        .on_click(move |_, _, app| me.update(app, |p, cx| p.open_consent(cx))),
                ),
        )
    }

    fn url_bar(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let focused = self.url.read(cx).focus_handle().is_focused(window);
        let busy = self.extracting.is_some();
        let empty = self.url.read(cx).text().trim().is_empty();
        let enabled = !busy && !empty;
        let me = cx.entity();
        let button = div()
            .id("music-play-url")
            .flex_shrink_0()
            .w(px(48.0))
            .flex()
            .items_center()
            .justify_center()
            .border_l(px(1.0))
            .border_color(col(rgba(41, 46, 66, 0.8)))
            .when(enabled, |b| {
                b.bg(col(rgba(122, 162, 247, 0.12))).cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.22)))).on_click(move |_, _, app| me.update(app, |p, cx| p.submit_url(cx)))
            })
            .when(!enabled, |b| b.cursor_not_allowed())
            .child(if busy {
                spinner(16.0).into_any_element()
            } else {
                ico("url-play", 16.0, 16.0, if enabled { TN_BLUE } else { rgba(65, 72, 104, 1.0) }).into_any_element()
            });
        let field = div().flex_1().px(px(16.0)).py(px(12.0)).child(self.url.clone());
        let mut form = div().mb(px(24.0)).child(url_frame(focused).flex().flex_row().overflow_hidden().child(field).child(button));
        if let Some(since) = self.extracting {
            let slow = since.elapsed() >= Duration::from_secs(5);
            form = form.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.0))
                    .pt(px(8.0))
                    .pl(px(4.0))
                    .font_family(UI_FONT)
                    .text_size(px(13.0))
                    .line_height(px(16.9))
                    .text_color(col(TN_TEXT_DIM))
                    .child("Extracting audio...")
                    .children(slow.then(|| div().text_size(px(12.0)).child("This is taking longer than usual."))),
            );
        }
        if let Some(p) = &self.import {
            let importing = p.total.is_none() || p.total.is_some_and(|t| p.current < t);
            let n = p.current;
            let tracks = if n == 1 { "track" } else { "tracks" };
            let text = if importing { format!("Loading playlist... {n} {tracks} added") } else { format!("Playlist loaded: {n} {tracks}") };
            let mut row = div().flex().flex_row().items_center().gap(px(10.0)).pt(px(8.0)).pl(px(4.0));
            if importing {
                row = row.child(spinner(16.0));
            }
            row = row.child(div().flex_1().font_family(UI_FONT).text_size(px(12.0)).line_height(px(15.6)).text_color(col(TN_TEXT_DIM)).child(text));
            if importing {
                let svc = self.svc.clone();
                row = row.child(
                    div()
                        .id("music-cancel-import")
                        .px(px(10.0))
                        .py(px(4.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(rgba(247, 118, 142, 0.3)))
                        .bg(col(rgba(247, 118, 142, 0.08)))
                        .font_family(BTN_FONT)
                        .text_size(px(11.0))
                        .line_height(px(13.0))
                        .font_weight(FontWeight(600.0))
                        .text_color(col(TN_RED))
                        .cursor_pointer()
                        .hover(|s| s.bg(col(rgba(247, 118, 142, 0.15))).border_color(col(rgba(247, 118, 142, 0.5))))
                        .child(spaced("Cancel", 0.33))
                        .on_click(move |_, _, _| svc.music().import_cancel()),
                );
            }
            form = form.child(row);
        }
        form
    }

    fn tab_bar(&self, cx: &mut Context<Self>) -> Div {
        let mut bar = Glass::new(10.0, 8.0, 1.0, Spec::rrect(10.0).solid(rgba(12, 13, 24, 0.5)).border(1.0, rgba(41, 46, 66, 0.8)))
            .el()
            .flex()
            .flex_row()
            .gap(px(2.0))
            .p(px(3.0));
        for tab in Tab::ALL {
            let active = self.tab == tab;
            let me = cx.entity();
            let mut b = div()
                .id(SharedString::from(format!("music-tab-{}", tab.label())))
                .relative()
                .px(px(20.0))
                .py(px(7.0))
                .rounded(px(7.0))
                .border(px(1.0))
                .border_color(col(if active { rgba(122, 162, 247, 0.2) } else { rgba(0, 0, 0, 0.0) }))
                .font_family(BTN_FONT)
                .text_size(px(13.0))
                .line_height(px(15.0))
                .font_weight(FontWeight(600.0))
                .text_color(col(if active { TN_BLUE } else { TN_TEXT_DIM }))
                .cursor_pointer()
                .child(spaced(tab.label(), 0.52))
                .on_click(move |_, _, app| me.update(app, |p, cx| p.set_tab(tab, cx)));
            b = if active {
                b.bg(col(rgba(122, 162, 247, 0.1))).shadow(shadows(&[sh(0.0, 1.0, 8.0, rgba(122, 162, 247, 0.1))])).hover(|s| s.bg(col(rgba(122, 162, 247, 0.14))))
            } else {
                b.hover(|s| s.bg(col(rgba(122, 162, 247, 0.06))))
            };
            bar = bar.child(b);
        }
        div().flex().flex_row().mb(px(20.0)).child(bar)
    }

    fn tab_content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Div {
        let body = match self.tab {
            Tab::Queue => self.render_queue(window, cx).into_any_element(),
            Tab::Library => self.render_library(window, cx).into_any_element(),
            Tab::Playlists => self.render_playlists(window, cx).into_any_element(),
        };
        let spec = Spec::rrect(12.0)
            .solid(rgba(16, 18, 36, 0.45))
            .border(1.0, rgba(122, 162, 247, 0.1))
            .inset(0.0, 1.0, wh(0.06));
        Glass::new(12.0, 20.0, 1.4, spec).shadows(&[sh(0.0, 4.0, 24.0, bk(0.25))]).el().min_h(px(240.0)).flex().flex_col().overflow_hidden().child(body)
    }

    fn toast_layer(&self) -> Option<impl IntoElement> {
        if self.toasts.is_empty() {
            return None;
        }
        let mut col_el = div().absolute().bottom(px(96.0)).left_0().right_0().flex().flex_col().items_center().gap(px(8.0));
        for t in &self.toasts {
            col_el = col_el.child(
                Glass::new(8.0, 12.0, 1.0, Spec::rrect(8.0).solid(rgba(22, 24, 40, 0.92)).border(1.0, rgba(122, 162, 247, 0.15)))
                    .shadows(&[sh(0.0, 4.0, 20.0, bk(0.4))])
                    .el()
                    .px(px(20.0))
                    .py(px(10.0))
                    .font_family(UI_FONT)
                    .text_size(px(13.0))
                    .line_height(px(16.9))
                    .font_weight(FontWeight(500.0))
                    .text_color(col(TN_TEXT))
                    .child(t.message.clone()),
            );
        }
        Some(col_el)
    }
}

use gpui::prelude::FluentBuilder;

/// The spinner of the music CSS: a faint ring with a blue quarter turning on it (0.7 s).
pub fn spinner(size: f32) -> AnyElement {
    let arc = svg().path("icons/spinner.svg").absolute().top(px(-2.0)).left(px(-2.0)).w(px(size)).h(px(size)).text_color(col(TN_BLUE));
    let arc = animate(arc, "music-spinner", 700, true, |t| t, 0.125, |a, t| a.with_transformation(Transformation::rotate(percentage(t))));
    div().relative().flex_shrink_0().w(px(size)).h(px(size)).rounded(px(size / 2.0)).border(px(2.0)).border_color(col(rgba(122, 162, 247, 0.25))).child(arc).into_any_element()
}

impl Render for MusicPage {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let heading = page_heading("Music").mt(px(8.7)).mb(px(24.0));
        let banner = self.setup_banner(cx);
        let url_bar = self.url_bar(window, cx);
        let tabs = self.tab_bar(cx);
        let content = self.tab_content(window, cx);
        let body = div().flex().flex_col().child(heading).children(banner).child(url_bar).child(tabs).child(content);
        let page = page_shell("music-page", 760.0, body);
        let esc = self.overlay_open().then(|| {
            let me = cx.entity();
            on_escape(move |app| {
                me.update(app, |p, cx| {
                    p.escape(cx);
                })
            })
        });
        let overlays = self.render_overlays(window, cx);
        let consent = self.consent.clone().map(|c| crate::pages::todo_widgets::window_layer(window, c));
        div().relative().flex_1().h_full().child(page).children(self.toast_layer()).children(esc).children(overlays).children(consent)
    }
}
