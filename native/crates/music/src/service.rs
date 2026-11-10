//! The music service: what `music-ipc.ts` and `MusicPlayerContext.tsx` do together, without the
//! IPC boundary. It owns the queue, resolves a URL to audio (cache file or live yt-dlp stream that
//! is saved to the cache as it plays), drives the [`Transport`], and reports changes as
//! [`MusicEvent`]s. The UI reads [`MusicService::snapshot`] on its tick and reacts to events.
//!
//! Every method that can wait on yt-dlp, ffmpeg or the network blocks: call them off the UI thread.

use crate::binaries::{BinaryManager, Sources};
use crate::cache::CacheManager;
use crate::error::{MusicError, Result};
use crate::extractor::{validate_url, AudioStream, Extractor, TrackMetadata};
use crate::integrity::IntegrityChecker;
use crate::output::{FeedEvent, OutputHandle};
use crate::process::ProcessManager;
use crate::queue::{PrevAction, QueueState};
use crate::transport::{Source, Transport, TransportEvent};
use crate::{with_db, DbHandle};
use lizmeter_core::{
    BinaryDownloadProgress, ImportProgress, IntegrityProgress, MusicErrorCode, MusicPlaybackState, MusicQueueItem, MusicTrack, RepeatMode,
};
use lizmeter_db::TrackUpsert;
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

const MAX_CONSECUTIVE_FAILURES: u32 = 3;
pub(crate) const KEY_VOLUME: &str = "music.volume";
const KEY_MUTED: &str = "music.muted";
const KEY_SPEED: &str = "music.playbackSpeed";
const KEY_SHUFFLE: &str = "music.shuffleEnabled";
const KEY_REPEAT: &str = "music.repeatMode";

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn err<T>(code: MusicErrorCode, message: impl Into<String>) -> Result<T> {
    Err(MusicError::new(code, message))
}

/// Where sound goes.
#[derive(Debug, Clone, Copy)]
pub enum OutputKind {
    /// The default sound device, opened on the first play.
    Device,
    /// A silent sink that drains at real-time pace (tests, headless runs).
    Null(u32),
}

/// Something the UI should react to. Position changes are not events: read the snapshot on a tick.
#[derive(Debug, Clone)]
pub enum MusicEvent {
    /// The queue, current track, state, volume or error changed.
    Changed,
    /// A streamed track finished caching: seek is now available.
    Cached { track_id: String },
    ImportProgress(ImportProgress),
    /// Tracks of an imported playlist were appended to the queue.
    PlaylistImported(Vec<MusicTrack>),
    BinaryDownloadProgress(BinaryDownloadProgress),
    IntegrityProgress(IntegrityProgress),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayResult {
    pub track: MusicTrack,
    pub from_cache: bool,
}

/// Everything the music bar and queue view draw.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicSnapshot {
    pub current_track: Option<MusicTrack>,
    pub playback_state: MusicPlaybackState,
    pub current_time: f64,
    pub duration: f64,
    /// Seconds decoded so far (the whole track for a cached file).
    pub buffered: f64,
    pub queue: Vec<MusicQueueItem>,
    pub current_index: i64,
    pub queue_length: usize,
    pub volume: f32,
    pub muted: bool,
    pub playback_speed: f64,
    pub shuffle_enabled: bool,
    pub repeat_mode: RepeatMode,
    pub import_progress: Option<ImportProgress>,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub is_bottom_bar_visible: bool,
    pub can_go_next: bool,
    pub can_go_prev: bool,
    /// False while the track is still streaming in and has not been cached.
    pub seekable: bool,
}

pub(crate) struct State {
    pub queue: QueueState,
    pub current_track: Option<MusicTrack>,
    pub pending: bool,
    pub bottom_bar: bool,
    pub volume: f32,
    pub muted: bool,
    pub speed: f64,
    pub consecutive_failures: u32,
    pub last_error: Option<String>,
    pub import_progress: Option<ImportProgress>,
    /// Transport generation of the loaded track, and its id.
    pub generation: u64,
    pub loaded_id: Option<String>,
}

/// The state a failed play request puts back.
pub(crate) struct Restore {
    track: Option<MusicTrack>,
    index: i64,
    bar: bool,
    playback: MusicPlaybackState,
}

pub struct MusicService {
    pub(crate) db: DbHandle,
    pub bins: Arc<BinaryManager>,
    pub cache: Arc<CacheManager>,
    pub integrity: Arc<IntegrityChecker>,
    pub(crate) pm: Arc<ProcessManager>,
    pub(crate) extractor: Arc<Extractor>,
    output_kind: OutputKind,
    transport: Mutex<Option<Arc<Transport>>>,
    pub(crate) st: Mutex<State>,
    /// Held while a play request is replaced or committed, so "is this request still current" and
    /// "load it" are one step.
    commit: Mutex<()>,
    request: AtomicU64,
    pub(crate) import_cancel: Mutex<Option<Arc<AtomicBool>>>,
    listener: Mutex<Option<Arc<dyn Fn(MusicEvent) + Send + Sync>>>,
    me: Weak<MusicService>,
}

fn seed() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1)
}

/// `parseFloat` of a stored setting, `None` for NaN.
fn parse_f64(raw: &str) -> Option<f64> {
    let t = lizmeter_db::util::js_trim(raw);
    let end = t.char_indices().take_while(|(_, c)| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')).last().map(|(i, c)| i + c.len_utf8())?;
    t[..end].parse::<f64>().ok().filter(|v| v.is_finite())
}

impl MusicService {
    /// `user_data` is the folder that holds `bin/` and `music-cache/` (Electron's `userData`).
    pub fn new(user_data: &Path, db: DbHandle, output: OutputKind) -> Arc<MusicService> {
        Self::with_sources(user_data, db, output, Sources::default())
    }

    pub fn with_sources(user_data: &Path, db: DbHandle, output: OutputKind, sources: Sources) -> Arc<MusicService> {
        let bins = Arc::new(BinaryManager::with_sources(user_data, sources));
        let pm = Arc::new(ProcessManager::new(bins.yt_dlp_path()));
        let svc = Arc::new_cyclic(|me| MusicService {
            cache: Arc::new(CacheManager::new(user_data, db.clone())),
            integrity: Arc::new(IntegrityChecker::new(db.clone(), bins.clone())),
            extractor: Arc::new(Extractor::new(pm.clone(), bins.clone())),
            db,
            bins,
            pm,
            output_kind: output,
            transport: Mutex::new(None),
            st: Mutex::new(State {
                queue: QueueState::new(seed()),
                current_track: None,
                pending: false,
                bottom_bar: false,
                volume: 0.3,
                muted: false,
                speed: 1.0,
                consecutive_failures: 0,
                last_error: None,
                import_progress: None,
                generation: 0,
                loaded_id: None,
            }),
            commit: Mutex::new(()),
            request: AtomicU64::new(0),
            import_cancel: Mutex::new(None),
            listener: Mutex::new(None),
            me: me.clone(),
        });
        svc.load_settings();
        svc
    }

    /// Reads the saved volume, mute, speed, shuffle and repeat. A failure leaves the defaults.
    fn load_settings(&self) {
        let get = |k: &str| with_db(&self.db, |db| Ok(db.get_setting_value(k)?)).ok().flatten();
        let mut st = lock(&self.st);
        if let Some(v) = get(KEY_VOLUME).as_deref().and_then(parse_f64) {
            st.volume = v.clamp(0.0, 1.0) as f32;
        }
        if let Some(v) = get(KEY_MUTED) {
            st.muted = v == "1";
        }
        if let Some(v) = get(KEY_SPEED).as_deref().and_then(parse_f64).filter(|v| *v > 0.0) {
            st.speed = v;
        }
        if let Some(v) = get(KEY_SHUFFLE) {
            st.queue.shuffle_enabled = v == "1";
        }
        if let Some(v) = get(KEY_REPEAT) {
            st.queue.repeat = match v.as_str() {
                "queue" => RepeatMode::Queue,
                "one" => RepeatMode::One,
                _ => RepeatMode::Off,
            };
        }
    }

    // --- Events ---

    /// Registers the one listener. It runs on whatever thread caused the change.
    pub fn set_listener(&self, f: impl Fn(MusicEvent) + Send + Sync + 'static) {
        *lock(&self.listener) = Some(Arc::new(f));
    }

    pub(crate) fn emit(&self, ev: MusicEvent) {
        let l = lock(&self.listener).clone();
        if let Some(l) = l {
            l(ev);
        }
    }

    // --- Transport ---

    /// The transport, created (and the sound device opened) on first use.
    fn transport(&self) -> Result<Arc<Transport>> {
        let mut g = lock(&self.transport);
        if let Some(t) = g.as_ref() {
            return Ok(t.clone());
        }
        let output = match self.output_kind {
            OutputKind::Device => OutputHandle::open_device()?,
            OutputKind::Null(rate) => OutputHandle::open_null(rate),
        };
        let (t, rx) = Transport::new(self.bins.ffmpeg_path(), Arc::new(output));
        {
            let st = lock(&self.st);
            t.set_volume(st.volume);
            t.set_muted(st.muted);
            let _ = t.set_speed(st.speed);
        }
        spawn_worker(self.me.clone(), rx);
        *g = Some(t.clone());
        Ok(t)
    }

    fn transport_if_any(&self) -> Option<Arc<Transport>> {
        lock(&self.transport).clone()
    }

    /// The output sink, for tests that read what was played.
    pub fn output(&self) -> Option<Arc<OutputHandle>> {
        self.transport_if_any().map(|t| t.output().clone())
    }

    /// Whether the loaded source decodes inside the app rather than through an ffmpeg process.
    pub fn is_native_decode(&self) -> bool {
        self.transport_if_any().is_some_and(|t| t.is_native())
    }

    fn raw_state(&self) -> MusicPlaybackState {
        self.transport_if_any().map_or(MusicPlaybackState::Stopped, |t| t.state())
    }

    // --- Snapshot ---

    pub fn snapshot(&self) -> MusicSnapshot {
        let t = self.transport_if_any();
        let st = lock(&self.st);
        let raw = t.as_ref().map_or(MusicPlaybackState::Stopped, |t| t.state());
        let duration = st.current_track.as_ref().and_then(|c| c.duration_seconds).unwrap_or(0.0);
        let seekable = t.as_ref().is_some_and(|t| t.is_seekable());
        let (can_go_next, can_go_prev) = st.queue.can_go();
        MusicSnapshot {
            current_track: st.current_track.clone(),
            playback_state: if st.pending { MusicPlaybackState::Buffering } else { raw },
            current_time: t.as_ref().map_or(0.0, |t| t.position()),
            duration,
            buffered: match &t {
                Some(t) if t.is_loaded() => if seekable { duration.max(t.buffered()) } else { t.buffered() },
                _ => 0.0,
            },
            queue: st.queue.items.clone(),
            current_index: st.queue.current,
            queue_length: st.queue.len(),
            volume: st.volume,
            muted: st.muted,
            playback_speed: st.speed,
            shuffle_enabled: st.queue.shuffle_enabled,
            repeat_mode: st.queue.repeat,
            import_progress: st.import_progress.clone(),
            consecutive_failures: st.consecutive_failures,
            last_error: st.last_error.clone(),
            is_bottom_bar_visible: st.bottom_bar,
            can_go_next,
            can_go_prev,
            seekable,
        }
    }

    // --- Play requests ---

    fn is_current(&self, req: u64) -> bool {
        self.request.load(Ordering::SeqCst) == req
    }

    /// Starts a new play request: older requests become stale and the playing audio pauses.
    fn begin(&self, track: Option<MusicTrack>, queue_index: Option<i64>) -> (u64, Restore) {
        let _c = lock(&self.commit);
        let req = self.request.fetch_add(1, Ordering::SeqCst) + 1;
        let playback = self.raw_state();
        let t = self.transport_if_any();
        if let Some(t) = &t {
            t.pause();
        }
        let mut st = lock(&self.st);
        let restore = Restore { track: st.current_track.clone(), index: st.queue.current, bar: st.bottom_bar, playback };
        st.pending = true;
        if track.is_some() {
            st.bottom_bar = true;
            st.current_track = track;
        }
        if let Some(i) = queue_index {
            st.queue.current = i;
        }
        st.consecutive_failures = 0;
        st.last_error = None;
        drop(st);
        self.emit(MusicEvent::Changed);
        (req, restore)
    }

    /// Invalidates any play request in flight (stop, clear, removal of the playing item).
    pub(crate) fn cancel_requests(&self) {
        let _c = lock(&self.commit);
        self.request.fetch_add(1, Ordering::SeqCst);
        lock(&self.st).pending = false;
    }

    fn restore(&self, r: Restore) {
        {
            let mut st = lock(&self.st);
            st.current_track = r.track;
            st.queue.current = r.index;
            st.bottom_bar = r.bar;
            st.pending = false;
        }
        if let Some(t) = self.transport_if_any() {
            match r.playback {
                MusicPlaybackState::Playing | MusicPlaybackState::Buffering => t.resume(),
                MusicPlaybackState::Stopped => t.stop(),
                _ => {}
            }
        }
    }

    fn fail_request(&self, req: u64, e: &MusicError, restore: Option<Restore>) {
        if !self.is_current(req) {
            return;
        }
        match restore {
            Some(r) => self.restore(r),
            None => lock(&self.st).pending = false,
        }
        {
            let mut st = lock(&self.st);
            st.last_error = Some(e.message.clone());
            st.consecutive_failures += 1;
        }
        self.emit(MusicEvent::Changed);
    }

    /// Loads `source` if `req` is still the current request. `None`: it was replaced.
    fn commit_load(&self, req: u64, source: Source, track_id: &str) -> Result<Option<u64>> {
        let _c = lock(&self.commit);
        if !self.is_current(req) {
            return Ok(None);
        }
        let t = self.transport()?;
        let generation = t.load(source, 0.0)?;
        let mut st = lock(&self.st);
        st.generation = generation;
        st.loaded_id = Some(track_id.to_string());
        Ok(Some(generation))
    }

    fn finish_request(&self, req: u64, res: &PlayResult, place: impl FnOnce(&mut State)) {
        if !self.is_current(req) {
            return;
        }
        {
            let mut st = lock(&self.st);
            place(&mut st);
            st.pending = false;
            st.current_track = Some(res.track.clone());
            st.bottom_bar = true;
            st.consecutive_failures = 0;
            st.last_error = None;
            if res.from_cache {
                let cur = st.queue.current;
                if let Some(i) = usize::try_from(cur).ok().and_then(|i| st.queue.items.get_mut(i)) {
                    i.track.is_cached = true;
                }
                if let Some(c) = st.current_track.as_mut() {
                    c.is_cached = true;
                }
            }
        }
        self.emit(MusicEvent::Changed);
    }

    /// `play(url)` of the context: with something playing the track goes right after it and plays
    /// at once; otherwise it becomes the first item. `None`: a newer request replaced this one.
    pub fn play(&self, url: &str, optimistic: Option<MusicTrack>) -> Result<Option<PlayResult>> {
        let has_active = self.raw_state() != MusicPlaybackState::Stopped && lock(&self.st).queue.current >= 0;
        let current = lock(&self.st).current_track.clone();
        let (req, snap) = self.begin(optimistic.or(current), None);
        match self.start_track(url, req) {
            Ok(None) => Ok(None),
            Ok(Some(res)) => {
                let track = res.track.clone();
                self.finish_request(req, &res, move |st| {
                    if has_active {
                        st.queue.insert_after_current(track);
                    } else {
                        st.queue.insert_first(track);
                    }
                });
                Ok(Some(res))
            }
            Err(e) => {
                self.fail_request(req, &e, Some(snap));
                Err(e)
            }
        }
    }

    /// Plays the queue item at `index`. `Ok(false)`: nothing to play, or a newer request replaced
    /// this one.
    pub(crate) fn play_queue_item(&self, index: usize, restore_on_failure: bool) -> Result<bool> {
        let Some(item) = lock(&self.st).queue.items.get(index).cloned() else { return Ok(false) };
        let (req, snap) = self.begin(Some(item.track.clone()), Some(index as i64));
        match self.start_track(&item.track.source_url, req) {
            Ok(None) => Ok(false),
            Ok(Some(res)) => {
                let (queue_id, fallback) = (item.queue_id.clone(), index);
                self.finish_request(req, &res, move |st| {
                    // The queue may have shifted while the request ran: find the item again.
                    st.queue.current = st.queue.index_of_queue_id(&queue_id).unwrap_or(fallback) as i64;
                });
                Ok(true)
            }
            Err(e) => {
                let current = self.is_current(req);
                self.fail_request(req, &e, restore_on_failure.then_some(snap));
                // A request that a newer one replaced is not a failure of this chain.
                if current { Err(e) } else { Ok(false) }
            }
        }
    }

    /// Plays the item after `from`, skipping past items that fail, up to three failures in all.
    pub(crate) fn advance_from(&self, from: i64, treat_repeat_one_as_off: bool, failures_so_far: u32) {
        let (mut from, mut failures) = (from, failures_so_far);
        loop {
            let next = lock(&self.st).queue.compute_next_index(from, treat_repeat_one_as_off);
            let Some(next) = next else {
                if let Some(t) = self.transport_if_any() {
                    t.stop();
                }
                self.emit(MusicEvent::Changed);
                return;
            };
            match self.play_queue_item(next, false) {
                Ok(_) => return,
                Err(_) => {
                    failures += 1;
                    lock(&self.st).consecutive_failures = failures;
                    if failures >= MAX_CONSECUTIVE_FAILURES {
                        if let Some(t) = self.transport_if_any() {
                            t.stop();
                        }
                        self.emit(MusicEvent::Changed);
                        return;
                    }
                    from = next as i64;
                }
            }
        }
    }

    fn on_transport_event(&self, ev: TransportEvent) {
        let Some(t) = self.transport_if_any() else { return };
        if ev.generation != t.generation() {
            return;
        }
        let (idx, repeat) = {
            let st = lock(&self.st);
            (st.queue.current, st.queue.repeat)
        };
        match ev.kind {
            FeedEvent::Ended => {
                self.emit(MusicEvent::Changed);
                if idx < 0 {
                    return;
                }
                if repeat == RepeatMode::One {
                    let _ = self.play_queue_item(idx as usize, true);
                } else {
                    self.advance_from(idx, false, 0);
                }
            }
            FeedEvent::Failed(detail) => {
                eprintln!("[music] playback failed: {detail}");
                {
                    let mut st = lock(&self.st);
                    st.last_error = Some("Audio playback error".into());
                    st.consecutive_failures += 1;
                }
                self.emit(MusicEvent::Changed);
                if idx >= 0 {
                    self.advance_from(idx, true, 1);
                }
            }
        }
    }

    // --- Resolving a URL to audio ---

    /// `music:play`: validates, checks the binaries, imports a playlist or plays one track.
    /// `None`: a newer request replaced this one before it loaded.
    fn start_track(&self, url: &str, req: u64) -> Result<Option<PlayResult>> {
        validate_url(url)?;
        let status = self.bins.check();
        if !status.yt_dlp_installed || !status.ffmpeg_installed {
            return err(MusicErrorCode::BinaryMissing, "yt-dlp or ffmpeg is not installed");
        }
        if self.extractor.detect_playlist(url) {
            return self.play_playlist(url, req);
        }
        self.play_single(url, req)
    }

    fn play_single(&self, url: &str, req: u64) -> Result<Option<PlayResult>> {
        let existing = with_db(&self.db, |db| Ok(db.get_track_by_source_url(url)?))?;

        // A cached copy plays from disk if it passes the integrity probe; a damaged one is
        // deleted and the track streams again.
        if let Some(ex) = &existing {
            if let Some(path) = ex.cached_file_path.as_deref().filter(|p| Path::new(p).exists()) {
                if self.integrity.check_track(ex).is_none() {
                    if self.commit_load(req, Source::File(PathBuf::from(path)), &ex.id)?.is_none() {
                        return Ok(None);
                    }
                    return self.played(&ex.id, true).map(Some);
                }
                self.integrity.repair(&[ex.id.clone()])?;
            }
        }

        // Live streams never end: refuse them before any audio is fetched.
        let meta = self.extractor.extract_metadata(url)?;
        if meta.is_live {
            return err(MusicErrorCode::ExtractionFailed, "Live streams are not supported. Please use a regular video or audio URL.");
        }
        if !self.is_current(req) {
            return Ok(None);
        }

        let stream = self.extractor.extract_audio(url)?;
        let track_id = existing.as_ref().map_or_else(lizmeter_db::util::new_uuid, |e| e.id.clone());
        let cache_path = self.cache.file_path(&track_id);
        with_db(&self.db, |db| {
            db.upsert_track(&upsert_of(&track_id, &meta, existing.as_ref().map(|e| e.added_at.clone())))?;
            Ok(())
        })?;

        let abort = stream.abort_handle();
        // One temp file per stream: an older stream for the same track must not delete this one's.
        let tmp = cache_path.with_extension(format!("m4a.{}.tmp", &lizmeter_db::util::new_uuid()[..8]));
        let tee = TeeReader::new(stream, &tmp, {
            let (me, id, path, tmp) = (self.me.clone(), track_id.clone(), cache_path.clone(), tmp.clone());
            Box::new(move |ok, write_failed| {
                std::thread::spawn(move || {
                    if let Some(svc) = me.upgrade() {
                        svc.finish_stream(&id, &path, &tmp, ok && !write_failed);
                    } else {
                        let _ = fs::remove_file(&tmp);
                    }
                });
            })
        });
        let loaded = self.commit_load(req, Source::Stream { reader: Box::new(tee), abort }, &track_id)?;
        if loaded.is_none() {
            return Ok(None);
        }
        self.played(&track_id, false).map(Some)
    }

    /// Counts the play and returns the track as the UI sees it.
    fn played(&self, track_id: &str, from_cache: bool) -> Result<PlayResult> {
        let row = with_db(&self.db, |db| {
            db.increment_track_play_count(track_id)?;
            Ok(db.get_track_by_id(track_id)?)
        })?;
        let Some(row) = row else { return err(MusicErrorCode::TrackNotFound, format!("Track not found: {track_id}")) };
        Ok(PlayResult { track: row.to_renderer_track(), from_cache })
    }

    /// The stream of `track_id` ended (`ok`) or was cut off. Saves the cache file after an
    /// integrity probe, then lets the UI seek.
    fn finish_stream(&self, track_id: &str, final_path: &Path, tmp: &Path, ok: bool) {
        let tmp = tmp.to_path_buf();
        if !ok {
            let _ = fs::remove_file(&tmp);
            return;
        }
        let size = match fs::rename(&tmp, final_path).and_then(|_| fs::metadata(final_path)) {
            Ok(m) => m.len() as i64,
            Err(e) => {
                eprintln!("[music] could not finish the cache file: {e}");
                let _ = fs::remove_file(&tmp);
                let _ = fs::remove_file(final_path);
                return;
            }
        };
        let path_str = final_path.to_string_lossy().into_owned();

        let base = with_db(&self.db, |db| Ok(db.get_track_by_id(track_id)?)).ok().flatten();
        if let Some(mut row) = base {
            row.cached_file_path = Some(path_str.clone());
            if let Some(d) = self.integrity.check_track(&row) {
                eprintln!("[music] integrity check failed for {track_id}: {:?} - {}", d.reason, d.detail);
                let _ = fs::remove_file(final_path);
                return;
            }
        }

        // The user moved on while the probe ran: do not keep a file nothing points at.
        let generation = {
            let st = lock(&self.st);
            if st.loaded_id.as_deref() != Some(track_id) {
                drop(st);
                let _ = fs::remove_file(final_path);
                return;
            }
            st.generation
        };
        if with_db(&self.db, |db| Ok(db.update_track_cache(track_id, Some(&path_str), Some(size))?)).is_err() {
            let _ = fs::remove_file(final_path);
            return;
        }
        {
            let mut st = lock(&self.st);
            st.queue.mark_cached(track_id);
            if let Some(c) = st.current_track.as_mut().filter(|c| c.id == track_id) {
                c.is_cached = true;
            }
        }
        if let Some(t) = self.transport_if_any() {
            t.mark_seekable(generation, final_path.to_path_buf());
        }
        self.emit(MusicEvent::Cached { track_id: track_id.to_string() });
        self.emit(MusicEvent::Changed);
        let _ = self.cache.evict_if_needed(Some(track_id));
    }

    // --- Playlist import ---

    fn play_playlist(&self, url: &str, req: u64) -> Result<Option<PlayResult>> {
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut g = lock(&self.import_cancel);
            if let Some(prev) = g.replace(cancel.clone()) {
                prev.store(true, Ordering::SeqCst);
            }
        }
        let now = lizmeter_db::util::now_iso();
        let mut collected: Vec<(String, TrackMetadata)> = Vec::new();
        let mut import_err: Option<MusicError> = None;

        let result = self.extractor.extract_playlist_metadata(
            url,
            &mut |meta, index| {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                let stored = with_db(&self.db, |db| {
                    let existing = db.get_track_by_source_url(&meta.source_url)?;
                    let id = existing.as_ref().map_or_else(lizmeter_db::util::new_uuid, |e| e.id.clone());
                    db.upsert_track(&TrackUpsert {
                        cached_file_path: existing.as_ref().and_then(|e| e.cached_file_path.clone()),
                        cache_size_bytes: existing.as_ref().and_then(|e| e.cache_size_bytes),
                        ..upsert_of(&id, &meta, Some(existing.as_ref().map_or_else(|| now.clone(), |e| e.added_at.clone())))
                    })?;
                    Ok(id)
                });
                if let Ok(id) = stored {
                    let progress = ImportProgress { total: None, current: index as i64 + 1, title: meta.title.clone() };
                    lock(&self.st).import_progress = Some(progress.clone());
                    self.emit(MusicEvent::ImportProgress(progress));
                    collected.push((id, meta));
                }
            },
            cancel.clone(),
        );
        if let Err(e) = result {
            import_err = Some(e);
        }
        let aborted = cancel.load(Ordering::SeqCst);
        let finish = |me: &MusicService| {
            let mut g = lock(&me.import_cancel);
            if g.as_ref().is_some_and(|c| Arc::ptr_eq(c, &cancel)) {
                *g = None;
            }
        };

        if let Some(e) = import_err.filter(|_| !aborted && collected.is_empty()) {
            finish(self);
            lock(&self.st).import_progress = None;
            return err(MusicErrorCode::ExtractionFailed, format!("Playlist import failed: {}", e.message));
        }
        if collected.is_empty() {
            finish(self);
            lock(&self.st).import_progress = None;
            return err(MusicErrorCode::ExtractionFailed, "No tracks found in playlist");
        }

        let done = ImportProgress { total: Some(collected.len() as i64), current: collected.len() as i64, title: if aborted { "Import cancelled" } else { "Import complete" }.into() };
        lock(&self.st).import_progress = Some(done.clone());
        self.emit(MusicEvent::ImportProgress(done));

        // The rest of the playlist joins the queue before the first track starts.
        if collected.len() > 1 {
            let rest: Vec<MusicTrack> = collected[1..]
                .iter()
                .filter_map(|(id, _)| with_db(&self.db, |db| Ok(db.get_track_by_id(id)?)).ok().flatten().map(|r| r.to_renderer_track()))
                .collect();
            lock(&self.st).queue.enqueue_bulk(rest.clone(), None);
            self.emit(MusicEvent::PlaylistImported(rest));
        }

        let first = collected[0].1.source_url.clone();
        let played = self.play_single(&first, req);
        finish(self);
        played
    }

    /// `music:import:cancel`.
    pub fn import_cancel(&self) {
        if let Some(c) = lock(&self.import_cancel).take() {
            c.store(true, Ordering::SeqCst);
        }
    }

    // --- Transport controls ---

    pub fn pause(&self) {
        if let Some(t) = self.transport_if_any() {
            t.pause();
        }
        self.emit(MusicEvent::Changed);
    }

    pub fn resume(&self) {
        if let Some(t) = self.transport_if_any() {
            t.resume();
        }
        self.emit(MusicEvent::Changed);
    }

    /// Moves within the track. A streaming track cannot seek until it is cached.
    pub fn seek(&self, secs: f64) -> Result<()> {
        let Some(t) = self.transport_if_any() else { return Ok(()) };
        let dur = lock(&self.st).current_track.as_ref().and_then(|c| c.duration_seconds).unwrap_or(f64::MAX);
        let r = t.seek(secs.clamp(0.0, dur));
        self.emit(MusicEvent::Changed);
        r
    }

    /// Stops playback and empties the queue (the context's `stop`).
    pub fn stop(&self) {
        self.cancel_requests();
        self.stop_audio();
        {
            let mut st = lock(&self.st);
            st.current_track = None;
            st.queue.clear();
        }
        self.emit(MusicEvent::Changed);
    }

    /// Stops playback and hides the bar; the queue stays.
    pub fn clear_player(&self) {
        self.cancel_requests();
        self.stop_audio();
        {
            let mut st = lock(&self.st);
            st.current_track = None;
            st.queue.current = -1;
            st.queue.shuffle_order = None;
            st.bottom_bar = false;
            st.consecutive_failures = 0;
            st.last_error = None;
        }
        self.emit(MusicEvent::Changed);
    }

    pub fn clear_queue(&self) {
        self.stop();
    }

    /// Stops the audio and any extraction still streaming.
    pub(crate) fn stop_audio(&self) {
        if let Some(t) = self.transport_if_any() {
            t.stop();
        }
        self.pm.kill_by_prefix("stream:");
        lock(&self.st).loaded_id = None;
    }

    pub fn next(&self) {
        let from = lock(&self.st).queue.current;
        self.advance_from(from, true, 0);
    }

    pub fn prev(&self) {
        let pos = self.transport_if_any().map_or(0.0, |t| t.position());
        let action = lock(&self.st).queue.prev_action(pos);
        match action {
            PrevAction::Restart => {
                let _ = self.seek(0.0);
            }
            PrevAction::Index(i) => {
                let _ = self.play_queue_item(i, true);
            }
            PrevAction::Nothing => {}
        }
    }

    pub fn jump_to(&self, index: usize) {
        let _ = self.play_queue_item(index, true);
    }

    // --- Queue ---

    pub fn enqueue(&self, track: MusicTrack, playlist_id: Option<i64>) {
        lock(&self.st).queue.enqueue(track, playlist_id);
        self.emit(MusicEvent::Changed);
    }

    pub fn enqueue_bulk(&self, tracks: Vec<MusicTrack>, playlist_id: Option<i64>) {
        lock(&self.st).queue.enqueue_bulk(tracks, playlist_id);
        self.emit(MusicEvent::Changed);
    }

    pub fn dequeue_at(&self, index: usize) {
        let was_current = lock(&self.st).queue.dequeue_at(index);
        if was_current == Some(true) {
            self.cancel_requests();
            self.stop_audio();
            lock(&self.st).current_track = None;
        }
        self.emit(MusicEvent::Changed);
    }

    /// Removes a deleted library track from the queue. If it was playing, playback advances from
    /// index -1 as the TS context does: the first remaining item (first in shuffle order) plays.
    pub fn remove_track_from_queue(&self, track_id: &str) {
        let outcome = lock(&self.st).queue.remove_track(track_id);
        if !outcome.removed {
            return;
        }
        if outcome.removed_current {
            self.cancel_requests();
            self.stop_audio();
            let (has_items, from) = {
                let mut st = lock(&self.st);
                st.current_track = None;
                (!st.queue.is_empty(), st.queue.current)
            };
            self.emit(MusicEvent::Changed);
            if has_items {
                self.advance_from(from, true, 0);
            }
            return;
        }
        self.emit(MusicEvent::Changed);
    }

    pub fn reorder_queue(&self, from: usize, to: usize) {
        lock(&self.st).queue.reorder(from, to);
        self.emit(MusicEvent::Changed);
    }

    /// Re-reads which queued tracks are cached, after the cache changed behind the queue.
    pub(crate) fn sync_cached_flags(&self) {
        let ids: Vec<String> = lock(&self.st).queue.items.iter().map(|i| i.track.id.clone()).collect();
        let cached: Vec<(String, bool)> = ids
            .into_iter()
            .filter_map(|id| with_db(&self.db, |db| Ok(db.get_track_by_id(&id)?)).ok().flatten().map(|r| (id, r.cached_file_path.is_some())))
            .collect();
        {
            let mut st = lock(&self.st);
            for (id, c) in &cached {
                for i in st.queue.items.iter_mut().filter(|i| &i.track.id == id) {
                    i.track.is_cached = *c;
                }
                if let Some(t) = st.current_track.as_mut().filter(|t| &t.id == id) {
                    t.is_cached = *c;
                }
            }
        }
        self.emit(MusicEvent::Changed);
    }

    // --- Settings ---

    fn persist(&self, key: &str, value: &str) {
        let _ = with_db(&self.db, |db| Ok(db.set_setting_value(key, value)?));
    }

    pub fn set_volume(&self, v: f32) {
        let v = v.clamp(0.0, 1.0);
        lock(&self.st).volume = v;
        if let Some(t) = self.transport_if_any() {
            t.set_volume(v);
        }
        self.persist(KEY_VOLUME, &v.to_string());
        self.emit(MusicEvent::Changed);
    }

    pub fn set_muted(&self, m: bool) {
        lock(&self.st).muted = m;
        if let Some(t) = self.transport_if_any() {
            t.set_muted(m);
        }
        self.persist(KEY_MUTED, if m { "1" } else { "0" });
        self.emit(MusicEvent::Changed);
    }

    pub fn set_playback_speed(&self, r: f64) -> Result<()> {
        if !(r.is_finite() && r > 0.0) {
            return err(MusicErrorCode::FormatError, "Playback speed must be positive");
        }
        lock(&self.st).speed = r;
        if let Some(t) = self.transport_if_any() {
            t.set_speed(r)?;
        }
        self.persist(KEY_SPEED, &r.to_string());
        self.emit(MusicEvent::Changed);
        Ok(())
    }

    pub fn set_shuffle_enabled(&self, on: bool) {
        lock(&self.st).queue.set_shuffle(on);
        self.persist(KEY_SHUFFLE, if on { "1" } else { "0" });
        self.emit(MusicEvent::Changed);
    }

    pub fn set_repeat_mode(&self, m: RepeatMode) {
        lock(&self.st).queue.repeat = m;
        let s = match m {
            RepeatMode::Off => "off",
            RepeatMode::Queue => "queue",
            RepeatMode::One => "one",
        };
        self.persist(KEY_REPEAT, s);
        self.emit(MusicEvent::Changed);
    }

    // --- Debug ---

    /// Plays a local audio file without touching the database or the queue. The `--do music-play`
    /// capture hook uses it to check playback with no UI.
    pub fn play_local_file(&self, path: &Path) -> Result<()> {
        let t = self.transport()?;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let _c = lock(&self.commit);
        self.request.fetch_add(1, Ordering::SeqCst);
        let generation = t.load(Source::File(path.to_path_buf()), 0.0)?;
        let mut st = lock(&self.st);
        st.generation = generation;
        st.loaded_id = Some(format!("local:{name}"));
        st.pending = false;
        st.bottom_bar = true;
        st.current_track = Some(MusicTrack {
            id: format!("local:{name}"),
            source_url: path.to_string_lossy().into_owned(),
            source_id: name.clone(),
            source_site: "local".into(),
            title: name,
            artist: None,
            duration_seconds: None,
            thumbnail_url: None,
            is_cached: true,
            cache_size_bytes: None,
            play_count: 0,
            last_played_at: None,
            added_at: lizmeter_db::util::now_iso(),
        });
        drop(st);
        self.emit(MusicEvent::Changed);
        Ok(())
    }

    /// Stops playback and extraction. Call before the app exits.
    pub fn shutdown(&self) {
        self.import_cancel();
        self.cancel_requests();
        self.stop_audio();
        self.pm.kill_all();
    }
}

impl Drop for MusicService {
    fn drop(&mut self) {
        self.pm.kill_all();
    }
}

fn spawn_worker(me: Weak<MusicService>, rx: Receiver<TransportEvent>) {
    std::thread::spawn(move || loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(ev) => match me.upgrade() {
                Some(svc) => svc.on_transport_event(ev),
                None => return,
            },
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if me.upgrade().is_none() {
                    return;
                }
            }
            Err(_) => return,
        }
    });
}

pub(crate) fn upsert_of(id: &str, meta: &TrackMetadata, added_at: Option<String>) -> TrackUpsert {
    TrackUpsert {
        id: id.to_string(),
        source_url: meta.source_url.clone(),
        source_id: meta.source_id.clone(),
        source_site: meta.source_site.clone(),
        title: meta.title.clone(),
        artist: meta.artist.clone(),
        duration_seconds: meta.duration_seconds,
        thumbnail_url: meta.thumbnail_url.clone(),
        cached_file_path: None,
        cache_size_bytes: None,
        added_at,
    }
}

/// Copies an [`AudioStream`] to a `.tmp` cache file while the player reads it. On the end of the
/// stream, on a read error, or when dropped early it calls `on_finish(ok, write_failed)` once.
struct TeeReader {
    inner: AudioStream,
    file: Option<fs::File>,
    write_failed: bool,
    on_finish: Option<Box<dyn FnOnce(bool, bool) + Send>>,
}

impl TeeReader {
    fn new(inner: AudioStream, tmp: &Path, on_finish: Box<dyn FnOnce(bool, bool) + Send>) -> Self {
        let file = fs::File::create(tmp).map_err(|e| eprintln!("[music] cannot create the cache file: {e}")).ok();
        TeeReader { write_failed: file.is_none(), file, inner, on_finish: Some(on_finish) }
    }

    fn finish(&mut self, ok: bool) {
        if let Some(mut f) = self.file.take() {
            let _ = f.flush();
        }
        if let Some(cb) = self.on_finish.take() {
            cb(ok, self.write_failed);
        }
    }
}

impl Read for TeeReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self.inner.read(buf) {
            Ok(0) => {
                self.finish(true);
                Ok(0)
            }
            Ok(n) => {
                if let Some(f) = self.file.as_mut() {
                    if let Err(e) = f.write_all(&buf[..n]) {
                        eprintln!("[music] cache write failed (playback continues): {e}");
                        self.file = None;
                        self.write_failed = true;
                    }
                }
                Ok(n)
            }
            Err(e) => {
                self.finish(false);
                Err(e)
            }
        }
    }
}

impl Drop for TeeReader {
    fn drop(&mut self) {
        self.finish(false);
    }
}
