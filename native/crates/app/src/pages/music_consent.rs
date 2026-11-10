//! `BinaryConsentDialog.tsx`: asks before downloading yt-dlp and ffmpeg, then shows the progress.

use super::music::spinner;
use super::music_logic::{format_bytes, format_speed};
use super::todo_widgets::{dialog_glass, modal_overlay};
use crate::css::{linear, rgba};
use crate::ui::*;
use gpui::*;
use lizmeter_core::{BinaryDownloadProgress, BinaryInfo};
use lizmeter_services::Services;
use std::sync::Arc;
use std::time::Duration;

const MONOSPACE: &str = "Consolas";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Loading,
    Consent,
    Downloading,
    Done,
    Error,
}

pub enum ConsentEvent {
    /// The download finished.
    Accept,
    Cancel,
}

impl EventEmitter<ConsentEvent> for ConsentDialog {}

pub struct ConsentDialog {
    svc: Arc<Services>,
    pub phase: Phase,
    info: Option<BinaryInfo>,
    load_error: Option<String>,
    download_error: Option<String>,
    yt_dlp: Option<BinaryDownloadProgress>,
    ffmpeg: Option<BinaryDownloadProgress>,
}

/// The percent a bar shows: full when done, else what the last progress event said.
pub fn shown_percent(done: bool, progress: Option<&BinaryDownloadProgress>) -> f64 {
    let p = if done { 100.0 } else { progress.map_or(0.0, |p| p.percent) };
    p.clamp(0.0, 100.0)
}

/// The stats text of a running download: `12.3 MB / 140.0 MB - 3.5 MB/s`.
pub fn stats_text(progress: Option<&BinaryDownloadProgress>, total_hint: Option<i64>) -> String {
    let downloaded = progress.map_or(0, |p| p.bytes_downloaded);
    let total = progress.map(|p| p.total_bytes).filter(|t| *t > 0).or(total_hint);
    let speed = progress.map_or(0.0, |p| p.speed);
    let mut s = match total {
        Some(t) => format!("{} / {}", format_bytes(Some(downloaded)), format_bytes(Some(t))),
        None => format_bytes(Some(downloaded)),
    };
    if speed > 0.0 {
        s.push_str(&format!(" \u{2014} {}", format_speed(speed)));
    }
    s
}

impl ConsentDialog {
    pub fn new(svc: Arc<Services>, cx: &mut Context<Self>) -> Self {
        let loader = svc.clone();
        cx.spawn(async move |this, cx| {
            let info = cx.background_executor().spawn(async move { loader.music().binary_info() }).await;
            let _ = this.update(cx, |d, cx| {
                d.info = Some(info);
                d.phase = Phase::Consent;
                cx.notify();
            });
        })
        .detach();
        Self { svc, phase: Phase::Loading, info: None, load_error: None, download_error: None, yt_dlp: None, ffmpeg: None }
    }

    pub fn on_progress(&mut self, p: BinaryDownloadProgress, cx: &mut Context<Self>) {
        if self.phase != Phase::Downloading {
            return;
        }
        if p.binary == "yt-dlp" {
            self.yt_dlp = Some(p);
        } else {
            self.ffmpeg = Some(p);
        }
        cx.notify();
    }

    fn download(&mut self, cx: &mut Context<Self>) {
        self.phase = Phase::Downloading;
        self.download_error = None;
        self.yt_dlp = None;
        self.ffmpeg = None;
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { svc.music().download_binaries() }).await;
            let ok = result.is_ok();
            let _ = this.update(cx, |d, cx| {
                match result {
                    Ok(()) => {
                        if let Some(p) = &mut d.yt_dlp {
                            p.percent = 100.0;
                        }
                        if let Some(p) = &mut d.ffmpeg {
                            p.percent = 100.0;
                        }
                        d.phase = Phase::Done;
                    }
                    Err(e) => {
                        d.download_error = Some(if e.message.is_empty() { "Download failed. Please try again.".into() } else { e.message });
                        d.phase = Phase::Consent;
                    }
                }
                cx.notify();
            });
            if ok {
                cx.background_executor().timer(Duration::from_millis(800)).await;
                let _ = this.update(cx, |_, cx| cx.emit(ConsentEvent::Accept));
            }
        })
        .detach();
        cx.notify();
    }

    fn open(&self, url: &'static str) {
        self.svc.host().open_external(url);
    }

    fn binary_row(&self, id: &'static str, name: String, size: Option<i64>, link: &'static str, link_text: &'static str, cx: &mut Context<Self>) -> Div {
        let me = cx.entity();
        Glass::new(8.0, 8.0, 1.0, crate::css::Spec::rrect(8.0).solid(rgba(12, 13, 26, 0.45)).border(1.0, rgba(86, 95, 137, 0.25)))
            .el()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .px(px(14.0))
            .py(px(10.0))
            .child(div().flex_shrink_0().text_size(px(16.0)).child("\u{1F4BE}"))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(div().font_family(MONOSPACE).text_size(px(13.0)).line_height(px(17.0)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(name))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .child(div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_TEXT_DIM)).child(format_bytes(size)))
                            .child(
                                div()
                                    .id(id)
                                    .font_family(BTN_FONT)
                                    .text_size(px(11.0))
                                    .line_height(px(13.0))
                                    .text_color(col(TN_BLUE))
                                    .cursor_pointer()
                                    .hover(|s| s.text_color(col(crate::css::hex(0xa3c4fa))))
                                    .child(link_text)
                                    .on_click(move |_, _, app| me.update(app, |d, _| d.open(link))),
                            ),
                    ),
            )
    }

    fn progress_item(name: String, progress: Option<&BinaryDownloadProgress>, done: bool, total_hint: Option<i64>) -> Div {
        let percent = shown_percent(done, progress);
        let fill: AnyElement = {
            let (a, b) = if done { (TN_GREEN, crate::css::hex(0x73c03a)) } else { (TN_BLUE, TN_PURPLE) };
            div().h_full().w(relative((percent / 100.0) as f32)).min_w(px(4.0)).rounded(px(2.0)).bg(lin(90.0, a, b)).into_any_element()
        };
        let right = if done {
            div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).font_weight(FontWeight(600.0)).text_color(col(TN_GREEN)).child("Done")
        } else {
            div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_TEXT_DIM)).child(stats_text(progress, total_hint))
        };
        div()
            .flex()
            .flex_col()
            .gap(px(6.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(div().font_family(MONOSPACE).text_size(px(12.0)).line_height(px(15.6)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(name))
                    .child(right),
            )
            .child(div().h(px(4.0)).w_full().rounded(px(2.0)).bg(col(rgba(86, 95, 137, 0.25))).overflow_hidden().child(fill))
    }

    fn banner(text: String, color: crate::css::C, border: crate::css::C, bg: crate::css::C, size: f32) -> Div {
        div().px(px(14.0)).py(px(10.0)).rounded(px(8.0)).border(px(1.0)).border_color(col(border)).bg(col(bg)).font_family(UI_FONT).text_size(px(size)).line_height(px(size * 1.5)).text_color(col(color)).child(text)
    }
}

impl Render for ConsentDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let me = cx.entity();
        let phase = self.phase;
        let escape = (phase != Phase::Downloading).then(|| {
            let esc = me.clone();
            super::music_ui::on_escape(move |app| esc.update(app, |_, cx| cx.emit(ConsentEvent::Cancel)))
        });
        let yt_name = self.info.as_ref().map_or("yt-dlp.exe".to_string(), |i| i.yt_dlp_filename.clone());
        let ff_name = self.info.as_ref().map_or("ffmpeg.exe".to_string(), |i| i.ffmpeg_filename.clone());
        let (yt_size, ff_size) = self.info.as_ref().map_or((None, None), |i| (i.yt_dlp_size, i.ffmpeg_size));

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.0))
            .px(px(20.0))
            .py(px(16.0))
            .border_b(px(1.0))
            .border_color(col(rgba(86, 95, 137, 0.3)))
            .child(div().flex_shrink_0().text_size(px(20.0)).line_height(px(20.0)).child("\u{266C}"))
            .child(div().font_family(UI_FONT).text_size(px(15.0)).line_height(px(19.5)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child("Music Setup Required"));

        let mut body = div().flex().flex_col().gap(px(16.0)).p(px(20.0));
        match phase {
            Phase::Loading => {
                body = div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(10.0))
                    .px(px(20.0))
                    .py(px(28.0))
                    .font_family(UI_FONT)
                    .text_size(px(13.0))
                    .line_height(px(16.9))
                    .text_color(col(TN_TEXT_DIM))
                    .child(spinner(16.0))
                    .child("Fetching binary information...");
            }
            Phase::Error => {
                let msg = self.load_error.clone().unwrap_or_else(|| "Unable to fetch binary information.".into());
                body = body.child(Self::banner(msg, TN_RED, rgba(247, 118, 142, 0.3), rgba(247, 118, 142, 0.07), 12.0));
            }
            Phase::Consent => {
                body = body.child(
                    div()
                        .font_family(UI_FONT)
                        .text_size(px(13.0))
                        .line_height(px(20.8))
                        .text_color(col(TN_TEXT))
                        .child("Music playback requires two open-source tools to be downloaded once and stored locally on your machine."),
                );
                if let Some(e) = self.download_error.clone() {
                    body = body.child(Self::banner(e, TN_RED, rgba(247, 118, 142, 0.3), rgba(247, 118, 142, 0.07), 12.0));
                }
                body = body.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .child(self.binary_row("link-ytdlp", yt_name.clone(), yt_size, "https://github.com/yt-dlp/yt-dlp", "github.com/yt-dlp/yt-dlp", cx))
                        .child(self.binary_row("link-ffmpeg", ff_name.clone(), ff_size, "https://ffmpeg.org", "ffmpeg.org", cx)),
                );
                if let Some(info) = &self.info {
                    body = body.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT_DIM)).child(spaced("STORAGE LOCATION", 0.66)))
                            .child(
                                Glass::new(6.0, 8.0, 1.0, crate::css::Spec::rrect(6.0).solid(rgba(12, 13, 26, 0.45)).border(1.0, rgba(86, 95, 137, 0.25)))
                                    .el()
                                    .px(px(10.0))
                                    .py(px(6.0))
                                    .font_family(MONOSPACE)
                                    .text_size(px(12.0))
                                    .line_height(px(18.0))
                                    .text_color(col(TN_TEXT))
                                    .child(info.storage_path.clone()),
                            ),
                    );
                }
                body = body.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(8.0))
                        .px(px(14.0))
                        .py(px(10.0))
                        .rounded(px(8.0))
                        .border(px(1.0))
                        .border_color(col(rgba(224, 175, 104, 0.3)))
                        .bg(col(rgba(224, 175, 104, 0.06)))
                        .child(div().flex_shrink_0().mt(px(1.0)).text_size(px(14.0)).line_height(px(14.0)).child("\u{26A0}"))
                        .child(
                            div()
                                .flex_1()
                                .font_family(UI_FONT)
                                .text_size(px(12.0))
                                .line_height(px(18.0))
                                .text_color(col(TN_YELLOW))
                                .child("Windows SmartScreen may flag these downloads. Both tools are open-source and widely used. You can verify the binaries on their official pages above."),
                        ),
                );
            }
            Phase::Downloading | Phase::Done => {
                let done = phase == Phase::Done;
                body = body.child(
                    div().flex().flex_col().gap(px(12.0)).child(
                        div().font_family(UI_FONT).text_size(px(13.0)).line_height(px(16.9)).font_weight(FontWeight(600.0)).text_color(col(TN_TEXT)).child(if done { "Download complete!" } else { "Downloading..." }),
                    )
                    .child(Self::progress_item(yt_name, self.yt_dlp.as_ref(), done || shown_percent(false, self.yt_dlp.as_ref()) >= 100.0, yt_size))
                    .child(Self::progress_item(ff_name, self.ffmpeg.as_ref(), done || shown_percent(false, self.ffmpeg.as_ref()) >= 100.0, ff_size)),
                );
            }
        }

        let cancel = |label: &'static str, enabled: bool, me: Entity<Self>| {
            let b = div()
                .id("consent-cancel")
                .px(px(18.0))
                .py(px(8.0))
                .rounded(px(6.0))
                .border(px(1.0))
                .border_color(col(TN_MUTED))
                .font_family(BTN_FONT)
                .text_size(px(13.0))
                .line_height(px(15.0))
                .text_color(col(TN_TEXT))
                .child(label);
            if enabled {
                b.cursor_pointer().hover(|s| s.bg(col(rgba(122, 162, 247, 0.08))).border_color(col(TN_BLUE))).on_click(move |_, _, app| me.update(app, |_, cx| cx.emit(ConsentEvent::Cancel)))
            } else {
                b.opacity(0.4)
            }
        };
        let mut footer = div().flex().flex_row().justify_end().gap(px(10.0)).px(px(20.0)).py(px(16.0)).border_t(px(1.0)).border_color(col(rgba(86, 95, 137, 0.3)));
        footer = match phase {
            Phase::Consent => {
                let m = me.clone();
                footer.child(cancel("Cancel", true, me.clone())).child(
                    div()
                        .id("consent-download")
                        .px(px(18.0))
                        .py(px(8.0))
                        .rounded(px(6.0))
                        .border(px(1.0))
                        .border_color(col(rgba(122, 162, 247, 0.4)))
                        .bg(col(rgba(122, 162, 247, 0.12)))
                        .font_family(BTN_FONT)
                        .text_size(px(13.0))
                        .line_height(px(15.0))
                        .font_weight(FontWeight(600.0))
                        .text_color(col(TN_BLUE))
                        .cursor_pointer()
                        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.22))).border_color(col(rgba(122, 162, 247, 0.6))))
                        .child("Download")
                        .on_click(move |_, _, app| m.update(app, |d, cx| d.download(cx))),
                )
            }
            Phase::Downloading => footer.child(cancel("Cancel", false, me.clone())),
            Phase::Done => footer.child(cancel("Cancel", true, me.clone())),
            Phase::Loading | Phase::Error => footer.child(cancel("Close", true, me.clone())),
        };

        let dialog = dialog_glass(18.0).w(px(480.0)).flex().flex_col().overflow_hidden().font_family(UI_FONT).child(header).child(body).child(footer);
        let close = me;
        let overlay = modal_overlay(
            "music-consent",
            None,
            div().id("music-consent-box").on_click(|_, _, _| {}).child(dialog),
            move |_, app| {
                close.update(app, |d, cx| {
                    if d.phase != Phase::Downloading {
                        cx.emit(ConsentEvent::Cancel);
                    }
                })
            },
        );
        let _ = linear;
        div().child(overlay).children(escape)
    }
}

#[cfg(test)]
mod tests {
    use super::{shown_percent, stats_text};
    use lizmeter_core::BinaryDownloadProgress;

    fn progress(percent: f64, done: i64, total: i64, speed: f64) -> BinaryDownloadProgress {
        BinaryDownloadProgress { binary: "yt-dlp".into(), percent, bytes_downloaded: done, total_bytes: total, speed }
    }

    #[test]
    fn a_finished_bar_is_full_whatever_the_last_event_said() {
        assert_eq!(shown_percent(true, Some(&progress(40.0, 1, 2, 0.0))), 100.0);
        assert_eq!(shown_percent(false, Some(&progress(40.0, 1, 2, 0.0))), 40.0);
        assert_eq!(shown_percent(false, None), 0.0);
        assert_eq!(shown_percent(false, Some(&progress(140.0, 1, 2, 0.0))), 100.0);
    }

    #[test]
    fn the_stats_line_names_size_and_speed() {
        let p = progress(8.0, 12 * 1024 * 1024, 140 * 1024 * 1024, 3.5 * 1024.0 * 1024.0);
        assert_eq!(stats_text(Some(&p), None), "12.0 MB / 140.0 MB \u{2014} 3.5 MB/s");
        assert_eq!(stats_text(None, Some(10 * 1024 * 1024)), "0 KB / 10.0 MB");
        let unknown = progress(0.0, 2048, 0, 0.0);
        assert_eq!(stats_text(Some(&unknown), None), "2 KB");
    }
}
