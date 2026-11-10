//! `LibraryView.tsx` and `useMusicLibrary.ts`: the paged, searchable library with the health
//! check, "Add All" and "Clear Library".

use super::music::{spinner, MusicPage};
use super::music_logic::*;
use super::music_queue::{duration_label, empty_state, thumb, track_text};
use super::music_ui::*;
use crate::css::{rgba, Spec};
use crate::ui::*;
use gpui::prelude::FluentBuilder;
use gpui::*;
use lizmeter_core::{DamagedTrackInfo, IntegrityProgress, MusicSortDir, MusicSortField, MusicTrack};
use lizmeter_services::Services;
use lizmeter_ui::text_input::{TextField, TextFieldEvent};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

pub enum Integrity {
    Idle,
    Scanning(Option<IntegrityProgress>),
    Done { damaged: Vec<DamagedTrackInfo>, checked: i64, error: Option<String> },
    Repairing,
}

pub struct LibraryUi {
    pub query: LibraryQuery,
    pub tracks: Vec<MusicTrack>,
    pub total: i64,
    pub loading: bool,
    pub loaded_once: bool,
    pub search: Entity<TextField>,
    /// Bumped by every request; an answer for an older number is dropped.
    pub generation: u64,
    pub integrity: Integrity,
    /// `Some(clearing)` while the Clear Library dialog is open.
    pub clear_dialog: Option<bool>,
    pub enqueuing: bool,
    /// Set while painting when the end of the list is inside the window.
    pub sentinel_seen: Rc<Cell<bool>>,
    pub menu_buttons: HashMap<String, Probe>,
}

impl LibraryUi {
    pub fn new(window: &mut Window, cx: &mut Context<MusicPage>, subs: &mut Vec<Subscription>) -> Self {
        let search = super::music::url_field("Search by title or artist...", 13.0, window, cx);
        subs.push(cx.subscribe(&search, |this, f, ev: &TextFieldEvent, cx| {
            if matches!(ev, TextFieldEvent::Changed) {
                let text = f.read(cx).text().to_string();
                this.library_search(text, cx);
            }
        }));
        Self {
            query: LibraryQuery::default(),
            tracks: vec![],
            total: 0,
            loading: false,
            loaded_once: false,
            search,
            generation: 0,
            integrity: Integrity::Idle,
            clear_dialog: None,
            enqueuing: false,
            sentinel_seen: Rc::new(Cell::new(false)),
            menu_buttons: HashMap::new(),
        }
    }

    pub fn has_more(&self) -> bool {
        (self.tracks.len() as i64) < self.total
    }
}

/// One page of the library for `query`.
pub fn fetch_page(svc: &Services, query: &LibraryQuery, offset: i64) -> Result<(Vec<MusicTrack>, i64), String> {
    svc.music().library_list(&query.input(PAGE_SIZE, offset)).map(|r| (r.tracks, r.total)).map_err(|e| e.message)
}

/// "Delete from Library": the track leaves the database, the cache and the queue.
pub fn delete_from_library(svc: &Services, track_id: &str) -> Result<(), String> {
    svc.music().library_delete(track_id).map_err(|e| e.message)
}

/// "Clear Library": every track and cache file goes, and the queue empties.
pub fn clear_library(svc: &Services) -> Result<(), String> {
    svc.music().library_clear().map_err(|e| e.message)?;
    svc.music().clear_queue();
    Ok(())
}

impl MusicPage {
    pub(super) fn library_search(&mut self, text: String, cx: &mut Context<Self>) {
        self.library.query.search = text;
        self.library.generation += 1;
        let generation = self.library.generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let _ = this.update(cx, |p, cx| {
                if p.library.generation == generation {
                    p.library_reload(cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    /// Reads the first page again (a new query, or a change somewhere else).
    pub fn library_reload(&mut self, cx: &mut Context<Self>) {
        self.library_fetch(0, cx);
    }

    fn library_fetch(&mut self, offset: i64, cx: &mut Context<Self>) {
        self.library.generation += 1;
        let generation = self.library.generation;
        self.library.loading = true;
        let (svc, query) = (self.svc.clone(), self.library.query.clone());
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { fetch_page(&svc, &query, offset) }).await;
            let _ = this.update(cx, |p, cx| {
                if p.library.generation != generation {
                    return;
                }
                p.library.loading = false;
                p.library.loaded_once = true;
                if let Ok((tracks, total)) = result {
                    if offset == 0 {
                        p.library.tracks = tracks;
                    } else {
                        p.library.tracks.extend(tracks);
                    }
                    p.library.total = total;
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn library_more(&mut self, cx: &mut Context<Self>) {
        if self.library.loading || !self.library.has_more() {
            return;
        }
        let offset = self.library.tracks.len() as i64;
        self.library_fetch(offset, cx);
    }

    fn sort_by(&mut self, field: MusicSortField, cx: &mut Context<Self>) {
        self.library.query.click_sort(field);
        self.library_reload(cx);
    }

    fn add_all(&mut self, cx: &mut Context<Self>) {
        if self.library.enqueuing || self.library.total == 0 {
            return;
        }
        if !self.library.has_more() && !self.library.tracks.is_empty() {
            self.music().enqueue_bulk(self.library.tracks.clone(), None);
            self.hub.update(cx, |h, cx| h.refresh(cx));
            return;
        }
        self.library.enqueuing = true;
        let (svc, query, total) = (self.svc.clone(), self.library.query.clone(), self.library.total);
        cx.spawn(async move |this, cx| {
            let all = cx.background_executor().spawn(async move { svc.music().library_list(&query.input(total, 0)).map(|r| r.tracks) }).await;
            let _ = this.update(cx, |p, cx| {
                p.library.enqueuing = false;
                if let Ok(tracks) = all {
                    p.music().enqueue_bulk(tracks, None);
                    p.hub.update(cx, |h, cx| h.refresh(cx));
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn confirm_delete_track(&mut self, cx: &mut Context<Self>) {
        let Some(track) = self.delete_track.take() else { return };
        let _ = delete_from_library(&self.svc, &track.id);
        self.hub.update(cx, |h, cx| h.refresh(cx));
        self.library_reload(cx);
    }

    pub(super) fn confirm_clear_library(&mut self, cx: &mut Context<Self>) {
        if self.library.clear_dialog != Some(false) {
            return;
        }
        self.library.clear_dialog = Some(true);
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let _ = cx.background_executor().spawn(async move { clear_library(&svc) }).await;
            let _ = this.update(cx, |p, cx| {
                p.library.clear_dialog = None;
                p.hub.update(cx, |h, cx| h.refresh(cx));
                p.library_reload(cx);
            });
        })
        .detach();
        cx.notify();
    }

    // --- Health check ---

    pub(super) fn capture_health(&mut self, cx: &mut Context<Self>) {
        self.integrity_check(cx);
    }

    fn integrity_check(&mut self, cx: &mut Context<Self>) {
        if matches!(self.library.integrity, Integrity::Scanning(_) | Integrity::Repairing) {
            return;
        }
        self.library.integrity = Integrity::Scanning(None);
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { svc.music().integrity_check() }).await;
            let _ = this.update(cx, |p, cx| {
                p.library.integrity = match result {
                    Ok(r) => Integrity::Done { damaged: r.damaged, checked: r.checked, error: r.error },
                    Err(e) => Integrity::Done { damaged: vec![], checked: 0, error: Some(if e.message.is_empty() { "Scan failed".into() } else { e.message }) },
                };
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn on_integrity_progress(&mut self, p: IntegrityProgress, cx: &mut Context<Self>) {
        if matches!(self.library.integrity, Integrity::Scanning(_)) {
            self.library.integrity = Integrity::Scanning(Some(p));
            cx.notify();
        }
    }

    fn integrity_repair(&mut self, ids: Vec<String>, all: bool, cx: &mut Context<Self>) {
        let Integrity::Done { damaged, .. } = &self.library.integrity else { return };
        if ids.is_empty() {
            return;
        }
        let remaining: Vec<DamagedTrackInfo> = damaged.iter().filter(|d| !ids.contains(&d.track.id)).cloned().collect();
        let checked = if let Integrity::Done { checked, .. } = &self.library.integrity { *checked } else { 0 };
        if all {
            self.library.integrity = Integrity::Repairing;
        }
        let svc = self.svc.clone();
        cx.spawn(async move |this, cx| {
            let _ = cx.background_executor().spawn(async move { svc.music().integrity_repair(&ids) }).await;
            let _ = this.update(cx, |p, cx| {
                p.library.integrity = if all || remaining.is_empty() { Integrity::Idle } else { Integrity::Done { damaged: remaining, checked, error: None } };
                p.library_reload(cx);
            });
        })
        .detach();
        cx.notify();
    }

    // --- Rendering ---

    fn track_row(&mut self, track: &MusicTrack, cx: &mut Context<Self>) -> Stateful<Div> {
        let me = cx.entity();
        let (m_play, m_menu) = (me.clone(), me);
        let group = SharedString::from(format!("lib-row-{}", track.id));
        let btn_probe = self.library.menu_buttons.entry(track.id.clone()).or_insert_with(probe).clone();
        let t_play = track.clone();
        let t_menu = track.clone();
        let meta = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .flex_shrink_0()
            .child(
                div()
                    .px(px(6.0))
                    .py(px(2.0))
                    .rounded(px(4.0))
                    .border(px(1.0))
                    .border_color(col(rgba(86, 95, 137, 0.3)))
                    .bg(col(rgba(41, 46, 66, 0.6)))
                    .font_family(BTN_FONT)
                    .text_size(px(10.0))
                    .line_height(px(12.0))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(TN_TEXT_DIM))
                    .child(spaced(&site_label(&track.source_site), 0.4)),
            )
            .children(track.is_cached.then(|| ico("download", 11.0, 11.0, TN_GREEN)))
            .child(duration_label(track.duration_seconds));
        let row = div()
            .id(SharedString::from(format!("lib-play-{}", track.id)))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .flex_1()
            .min_w_0()
            .px(px(8.0))
            .py(px(7.0))
            .rounded(px(8.0))
            .border(px(1.0))
            .border_color(col(rgba(0, 0, 0, 0.0)))
            .cursor_pointer()
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.06))).border_color(col(rgba(122, 162, 247, 0.1))))
            .active(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
            .child(thumb(36.0))
            .child(track_text(track, false))
            .child(meta)
            .on_click(move |_, _, app| {
                let t = t_play.clone();
                m_play.update(app, |p, cx| p.play_track(t, cx))
            });
        let menu_btn = div()
            .id(SharedString::from(format!("lib-menu-{}", track.id)))
            .relative()
            .flex_shrink_0()
            .mr(px(4.0))
            .w(px(22.0))
            .h(px(22.0))
            .rounded(px(4.0))
            .flex()
            .items_center()
            .justify_center()
            .opacity(0.0)
            .group_hover(group.clone(), |s| s.opacity(1.0))
            .cursor_pointer()
            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))).opacity(1.0))
            .child(measure(&btn_probe))
            .child(ico("dots", 14.0, 14.0, ICON_DIM))
            .on_click(move |_, _, app| {
                let t = t_menu.clone();
                let b = btn_probe.get();
                m_menu.update(app, |p, cx| p.open_track_menu(t, b, cx))
            });
        div().id(SharedString::from(format!("lib-row-{}", track.id))).group(group).relative().flex().flex_row().items_center().gap(px(2.0)).child(row).child(menu_btn)
    }

    fn sort_button(&self, label: &'static str, field: MusicSortField, cx: &mut Context<Self>) -> Stateful<Div> {
        let q = &self.library.query;
        let active = q.sort_field == field;
        let me = cx.entity();
        let mut b = div()
            .id(SharedString::from(format!("lib-sort-{label}")))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(3.0))
            .px(px(9.0))
            .py(px(5.0))
            .rounded(px(6.0))
            .border(px(1.0))
            .font_family(BTN_FONT)
            .text_size(px(11.0))
            .line_height(px(13.0))
            .font_weight(FontWeight(600.0))
            .cursor_pointer()
            .child(spaced(label, 0.33))
            .on_click(move |_, _, app| me.update(app, |p, cx| p.sort_by(field, cx)));
        b = if active {
            b.border_color(col(rgba(122, 162, 247, 0.15))).bg(col(rgba(122, 162, 247, 0.08))).text_color(col(TN_BLUE)).hover(|s| s.bg(col(rgba(122, 162, 247, 0.12))))
        } else {
            b.border_color(col(rgba(0, 0, 0, 0.0))).text_color(col(TN_TEXT_DIM)).hover(|s| s.bg(col(rgba(122, 162, 247, 0.05))))
        };
        if active {
            let mut arrow = ico("sort-up", 10.0, 10.0, TN_BLUE);
            if q.sort_dir == MusicSortDir::Desc {
                arrow = arrow.with_transformation(Transformation::rotate(percentage(0.5)));
            }
            b = b.child(arrow);
        }
        b
    }

    fn filter_chip(id: &'static str, icon: &str, label: &str, active: bool, enabled: bool) -> Stateful<Div> {
        let (bg, border, color) = if active {
            (rgba(122, 162, 247, 0.12), rgba(122, 162, 247, 0.3), TN_BLUE)
        } else {
            (rgba(12, 13, 24, 0.4), rgba(41, 46, 66, 0.8), TN_TEXT_DIM)
        };
        let b = div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.0))
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(20.0))
            .border(px(1.0))
            .border_color(col(border))
            .bg(col(bg))
            .font_family(BTN_FONT)
            .text_size(px(11.0))
            .line_height(px(13.0))
            .font_weight(FontWeight(600.0))
            .text_color(col(color))
            .child(ico(icon, 11.0, 11.0, color))
            .child(spaced(label, 0.44));
        if enabled {
            b.cursor_pointer().hover(move |s| if active { s.bg(col(rgba(122, 162, 247, 0.18))) } else { s.bg(col(rgba(122, 162, 247, 0.06))).border_color(col(rgba(122, 162, 247, 0.15))) })
        } else {
            b.opacity(0.7)
        }
    }

    fn integrity_panel(&mut self, cx: &mut Context<Self>) -> Option<Div> {
        let me = cx.entity();
        let title = |t: String| div().flex_1().min_w_0().truncate().font_family(UI_FONT).text_size(px(12.0)).line_height(px(15.6)).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child(t);
        let m_dismiss = me.clone();
        let close = move || {
            let m = m_dismiss.clone();
            div()
                .id("integrity-close")
                .flex_shrink_0()
                .w(px(20.0))
                .h(px(20.0))
                .rounded(px(4.0))
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
                .child(ico("close", 11.0, 11.0, TN_TEXT_DIM))
                .on_click(move |_, _, app| {
                    m.update(app, |p, cx| {
                        p.library.integrity = Integrity::Idle;
                        cx.notify();
                    })
                })
        };
        let panel = || {
            Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(12, 13, 24, 0.5)).border(1.0, rgba(41, 46, 66, 0.8))).el().w_full().px(px(12.0)).py(px(10.0)).flex().flex_col().gap(px(8.0))
        };
        let header = || div().flex().flex_row().items_center().gap(px(7.0)).min_h(px(20.0));
        match &self.library.integrity {
            Integrity::Idle => None,
            Integrity::Scanning(p) => {
                let mut panel = panel().child(header().child(spinner(13.0)).child(title(match p {
                    Some(p) => format!("Scanning {}/{}...", p.current, p.total),
                    None => "Starting scan...".into(),
                })));
                if let Some(p) = p {
                    let frac = if p.total > 0 { p.current as f32 / p.total as f32 } else { 0.0 };
                    panel = panel
                        .child(div().w_full().h(px(3.0)).rounded(px(2.0)).bg(col(rgba(41, 46, 66, 0.6))).overflow_hidden().child(div().h_full().w(relative(frac.clamp(0.0, 1.0))).rounded(px(2.0)).bg(col(TN_BLUE))))
                        .child(div().truncate().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_TEXT_DIM)).child(p.title.clone()));
                }
                Some(panel)
            }
            Integrity::Repairing => Some(panel().child(header().child(spinner(13.0)).child(title("Repairing...".into())))),
            Integrity::Done { error: Some(e), .. } => Some(panel().child(header().child(title(format!("Scan error: {e}"))).child(close()))),
            Integrity::Done { damaged, checked, .. } if damaged.is_empty() => {
                Some(panel().child(header().child(ico("check-circle", 13.0, 13.0, TN_GREEN)).child(title(format!("All {checked} cached tracks are healthy"))).child(close())))
            }
            Integrity::Done { damaged, .. } => {
                let n = damaged.len();
                let ids: Vec<String> = damaged.iter().map(|d| d.track.id.clone()).collect();
                let m_all = me.clone();
                let repair_all = div()
                    .id("integrity-repair-all")
                    .flex_shrink_0()
                    .px(px(10.0))
                    .py(px(3.0))
                    .rounded(px(12.0))
                    .border(px(1.0))
                    .border_color(col(rgba(247, 118, 142, 0.3)))
                    .bg(col(rgba(247, 118, 142, 0.1)))
                    .font_family(UI_FONT)
                    .text_size(px(11.0))
                    .line_height(px(14.3))
                    .font_weight(FontWeight(600.0))
                    .text_color(col(TN_RED))
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(247, 118, 142, 0.2))).border_color(col(rgba(247, 118, 142, 0.5))))
                    .child("Repair All")
                    .on_click(move |_, _, app| {
                        let ids = ids.clone();
                        m_all.update(app, |p, cx| p.integrity_repair(ids, true, cx))
                    });
                let mut list = div().flex().flex_col().gap(px(2.0)).max_h(px(200.0));
                for d in damaged {
                    let id = d.track.id.clone();
                    let m = me.clone();
                    list = list.child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.0))
                            .px(px(8.0))
                            .py(px(6.0))
                            .rounded(px(6.0))
                            .hover(|s| s.bg(col(rgba(122, 162, 247, 0.04))))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(1.0))
                                    .child(div().truncate().font_family(UI_FONT).text_size(px(12.0)).line_height(px(15.6)).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child(d.track.title.clone()))
                                    .child(div().truncate().font_family(UI_FONT).text_size(px(10.0)).line_height(px(13.0)).text_color(col(TN_TEXT_DIM)).child(d.detail.clone())),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("integrity-repair-{id}")))
                                    .flex_shrink_0()
                                    .px(px(8.0))
                                    .py(px(2.0))
                                    .rounded(px(10.0))
                                    .border(px(1.0))
                                    .border_color(col(rgba(158, 206, 106, 0.3)))
                                    .bg(col(rgba(158, 206, 106, 0.08)))
                                    .font_family(UI_FONT)
                                    .text_size(px(10.0))
                                    .line_height(px(13.0))
                                    .font_weight(FontWeight(600.0))
                                    .text_color(col(TN_GREEN))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(col(rgba(158, 206, 106, 0.18))).border_color(col(rgba(158, 206, 106, 0.5))))
                                    .child("Repair")
                                    .on_click(move |_, _, app| {
                                        let ids = vec![id.clone()];
                                        m.update(app, |p, cx| p.integrity_repair(ids, false, cx))
                                    }),
                            ),
                    );
                }
                Some(panel().child(header().child(ico("warning", 13.0, 13.0, TN_RED)).child(title(format!("{n} damaged track{} found", if n == 1 { "" } else { "s" }))).child(repair_all).child(close())).child(list))
            }
        }
    }

    pub(super) fn render_library(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lib = &self.library;
        if lib.tracks.is_empty() && !lib.loading && lib.loaded_once && !lib.query.filtered() {
            return empty_state("empty-library", "No tracks yet.", Some("Paste a URL above to get started.")).into_any_element();
        }
        // The end of the list came into view: ask for the next page (the sentinel of the CSS).
        if lib.sentinel_seen.get() && lib.has_more() && !lib.loading {
            self.library_more(cx);
        }
        let me = cx.entity();
        let focused = self.library.search.read(cx).focus_handle().is_focused(window);
        let border = if focused { rgba(122, 162, 247, 0.4) } else { rgba(41, 46, 66, 0.8) };
        let has_text = !self.library.query.search.is_empty();
        let m_clear = me.clone();
        let search = Glass::new(8.0, 8.0, 1.0, Spec::rrect(8.0).solid(rgba(12, 13, 24, 0.5)).border(1.0, border))
            .el()
            .flex()
            .flex_row()
            .items_center()
            .overflow_hidden()
            .when(focused, |d| d.shadow(shadows(&[Sh { dx: 0.0, dy: 0.0, blur: 0.0, spread: 2.0, color: rgba(122, 162, 247, 0.08) }])))
            .child(div().ml(px(12.0)).flex_shrink_0().child(ico("search", 14.0, 14.0, ICON_DIM)))
            .child(div().flex_1().min_w_0().py(px(9.5)).pl(px(8.0)).pr(px(10.0)).child(self.library.search.clone()))
            .children(has_text.then(|| {
                div()
                    .id("lib-clear-search")
                    .mr(px(4.0))
                    .flex_shrink_0()
                    .w(px(30.0))
                    .h(px(30.0))
                    .rounded(px(4.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(col(rgba(122, 162, 247, 0.1))))
                    .child(ico("close", 12.0, 12.0, TN_TEXT_DIM))
                    .on_click(move |_, _, app| {
                        m_clear.update(app, |p, cx| {
                            p.library.search.update(cx, |f, cx| f.set_text("", cx));
                        })
                    })
            }));

        let (m_offline, m_health) = (me.clone(), me.clone());
        let offline_on = self.library.query.offline_only;
        let busy = matches!(self.library.integrity, Integrity::Scanning(_) | Integrity::Repairing);
        let health_active = !matches!(self.library.integrity, Integrity::Idle);
        let chips = div()
            .flex()
            .flex_row()
            .gap(px(6.0))
            .child(Self::filter_chip("lib-offline", "download", "Offline only", offline_on, true).on_click(move |_, _, app| {
                m_offline.update(app, |p, cx| {
                    p.library.query.offline_only = !p.library.query.offline_only;
                    p.library_reload(cx);
                })
            }))
            .child(
                Self::filter_chip("lib-health", "check-circle", "Health Check", health_active, !busy)
                    .when(!busy, |c| c.on_click(move |_, _, app| m_health.update(app, |p, cx| p.integrity_check(cx)))),
            );
        let sorts = div()
            .flex()
            .flex_row()
            .gap(px(4.0))
            .ml_auto()
            .child(self.sort_button("Recent", MusicSortField::LastPlayedAt, cx))
            .child(self.sort_button("Title", MusicSortField::Title, cx))
            .child(self.sort_button("Duration", MusicSortField::DurationSeconds, cx))
            .child(self.sort_button("Added", MusicSortField::AddedAt, cx));
        let controls = div().flex().flex_row().items_center().gap(px(12.0)).flex_wrap().child(chips).child(sorts);

        let mut body = div().w_full().p(px(16.0)).flex().flex_col().gap(px(12.0)).child(search).child(controls);
        if let Some(p) = self.integrity_panel(cx) {
            body = body.child(p);
        }
        let total = self.library.total;
        if total > 0 {
            let (m_add, m_clear) = (me.clone(), me.clone());
            let adding = self.library.enqueuing;
            let add_label = if adding { "Adding…".to_string() } else { format!("Add All ({total})") };
            let add = div()
                .id("lib-add-all")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(5.0))
                .px(px(11.0))
                .py(px(5.0))
                .rounded(px(20.0))
                .border(px(1.0))
                .border_color(col(rgba(122, 162, 247, 0.25)))
                .bg(col(rgba(122, 162, 247, 0.08)))
                .font_family(UI_FONT)
                .text_size(px(11.0))
                .line_height(px(14.3))
                .font_weight(FontWeight(600.0))
                .text_color(col(if adding { rgba(122, 162, 247, 0.7) } else { TN_BLUE }))
                .child(if adding { spinner(11.0).into_any_element() } else { ico("arrow-left", 12.0, 12.0, TN_BLUE).into_any_element() })
                .child(spaced(&add_label, 0.44))
                .when(!adding, |b| {
                    b.cursor_pointer()
                        .hover(|s| s.bg(col(rgba(122, 162, 247, 0.16))).border_color(col(rgba(122, 162, 247, 0.4))))
                        .on_click(move |_, _, app| m_add.update(app, |p, cx| p.add_all(cx)))
                })
                .when(adding, |b| b.opacity(0.7));
            let clear = div()
                .id("lib-clear")
                .px(px(11.0))
                .py(px(5.0))
                .rounded(px(20.0))
                .border(px(1.0))
                .border_color(col(rgba(247, 118, 142, 0.25)))
                .bg(col(rgba(247, 118, 142, 0.06)))
                .font_family(UI_FONT)
                .text_size(px(11.0))
                .line_height(px(14.3))
                .font_weight(FontWeight(600.0))
                .text_color(col(TN_RED))
                .cursor_pointer()
                .hover(|s| s.bg(col(rgba(247, 118, 142, 0.16))).border_color(col(rgba(247, 118, 142, 0.4))))
                .child(spaced("Clear Library", 0.44))
                .on_click(move |_, _, app| {
                    m_clear.update(app, |p, cx| {
                        p.library.clear_dialog = Some(false);
                        cx.notify();
                    })
                });
            body = body.child(
                div()
                    .px(px(4.0))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .child(div().font_family(UI_FONT).text_size(px(11.0)).line_height(px(14.3)).text_color(col(TN_TEXT_DIM)).child(spaced(&format!("{total} track{}", if total == 1 { "" } else { "s" }), 0.55)))
                    .child(div().flex().flex_row().items_center().gap(px(8.0)).child(add).child(clear)),
            );
        }
        let tracks = self.library.tracks.clone();
        if tracks.is_empty() && !self.library.loading && self.library.query.filtered() {
            body = body.child(empty_state_plain("No tracks match your search."));
        }
        if tracks.is_empty() && self.library.loading {
            body = body.child(div().flex().justify_center().p(px(48.0)).child(spinner(16.0)));
        }
        if !tracks.is_empty() {
            let mut list = div().flex().flex_col().gap(px(1.0));
            for t in &tracks {
                list = list.child(self.track_row(t, cx));
            }
            let seen = self.library.sentinel_seen.clone();
            let window_h = window.viewport_size().height;
            list = list.child(canvas(move |b, _, _| seen.set(b.origin.y < window_h), |_, _, _, _| {}).h(px(1.0)).w_full());
            if self.library.loading {
                list = list.child(div().flex().justify_center().p(px(12.0)).child(spinner(16.0)));
            }
            body = body.child(list);
        }
        body.into_any_element()
    }
}

fn empty_state_plain(text: &str) -> Div {
    div().flex().flex_col().items_center().px(px(24.0)).py(px(48.0)).child(
        div().font_family(UI_FONT).text_size(px(14.0)).line_height(px(18.2)).font_weight(FontWeight(500.0)).text_color(col(TN_TEXT)).child(text.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::{clear_library, delete_from_library, fetch_page};
    use crate::pages::music_logic::LibraryQuery;
    use lizmeter_core::{MusicSortField, MusicTrack};
    use lizmeter_services::Services;
    use lizmeter_db::data_location::DataLocation;
    use lizmeter_db::TrackUpsert;
    use lizmeter_services::os::RecordingHost;
    use std::sync::Arc;

    fn open() -> (tempfile::TempDir, Arc<Services>) {
        std::env::set_var("LIZMETER_YT_DLP_API_URL", "http://127.0.0.1:9/yt-dlp");
        std::env::set_var("LIZMETER_FFMPEG_API_URL", "http://127.0.0.1:9/ffmpeg");
        let tmp = tempfile::tempdir().unwrap();
        let user_data = tmp.path().join("userData");
        let projects = tmp.path().join("projects");
        std::fs::create_dir_all(&user_data).unwrap();
        std::fs::create_dir_all(&projects).unwrap();
        let (svc, _) = Services::open(DataLocation::new(&user_data), Arc::new(RecordingHost::default()), &projects).unwrap();
        (tmp, svc)
    }

    fn add(svc: &Services, id: &str, title: &str, cached: bool) {
        svc.with_db(|db| {
            db.upsert_track(&TrackUpsert {
                id: id.into(),
                source_url: format!("https://example.com/{id}"),
                source_id: id.into(),
                source_site: "youtube".into(),
                title: title.into(),
                artist: Some("Artist".into()),
                duration_seconds: Some(180.0),
                thumbnail_url: None,
                cached_file_path: cached.then(|| format!("/cache/{id}.m4a")),
                cache_size_bytes: cached.then_some(1024),
                added_at: None,
            })?;
            Ok(())
        })
        .unwrap();
    }

    fn track(svc: &Services, id: &str) -> MusicTrack {
        fetch_page(svc, &LibraryQuery::default(), 0).unwrap().0.into_iter().find(|t| t.id == id).unwrap()
    }

    #[test]
    fn deleting_a_track_removes_it_from_the_library_and_the_queue() {
        let (_tmp, svc) = open();
        add(&svc, "track-1", "Track 1", true);
        add(&svc, "track-2", "Track 2", true);
        svc.music().enqueue(track(&svc, "track-1"), None);
        svc.music().enqueue(track(&svc, "track-2"), None);
        assert_eq!(fetch_page(&svc, &LibraryQuery::default(), 0).unwrap().1, 2);
        assert_eq!(svc.music().snapshot().queue_length, 2);

        delete_from_library(&svc, "track-1").unwrap();

        let (tracks, total) = fetch_page(&svc, &LibraryQuery::default(), 0).unwrap();
        assert_eq!((total, tracks.iter().map(|t| t.title.as_str()).collect::<Vec<_>>()), (1, vec!["Track 2"]));
        let queue = svc.music().snapshot().queue;
        assert_eq!(queue.iter().map(|q| q.track.id.as_str()).collect::<Vec<_>>(), vec!["track-2"]);
    }

    #[test]
    fn clearing_the_library_empties_the_list_and_the_queue() {
        let (_tmp, svc) = open();
        add(&svc, "track-1", "Track 1", true);
        svc.music().enqueue(track(&svc, "track-1"), None);

        clear_library(&svc).unwrap();

        assert_eq!(fetch_page(&svc, &LibraryQuery::default(), 0).unwrap(), (vec![], 0));
        assert_eq!(svc.music().snapshot().queue_length, 0);
    }

    #[test]
    fn the_library_pages_by_fifty_and_filters_by_search_and_offline() {
        let (_tmp, svc) = open();
        for i in 0..55 {
            add(&svc, &format!("t{i:02}"), &format!("Song {i:02}"), i % 2 == 0);
        }
        let mut q = LibraryQuery::default();
        let (first, total) = fetch_page(&svc, &q, 0).unwrap();
        assert_eq!((first.len(), total), (50, 55));
        let (rest, _) = fetch_page(&svc, &q, 50).unwrap();
        assert_eq!(rest.len(), 5);
        q.offline_only = true;
        assert_eq!(fetch_page(&svc, &q, 0).unwrap().1, 28);
        q.offline_only = false;
        q.search = "Song 07".into();
        let (hit, total) = fetch_page(&svc, &q, 0).unwrap();
        assert_eq!((hit.len(), total, hit[0].title.as_str()), (1, 1, "Song 07"));
        q.search.clear();
        q.click_sort(MusicSortField::Title);
        q.click_sort(MusicSortField::Title);
        let (asc, _) = fetch_page(&svc, &q, 0).unwrap();
        assert_eq!(asc[0].title, "Song 00");
    }
}
