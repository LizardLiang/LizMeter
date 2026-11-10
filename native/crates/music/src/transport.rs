//! Playback of one source at a time: ffmpeg decodes to raw `f32` PCM, the [`Feed`] carries it to
//! the [`OutputHandle`]. Replaces the renderer's `<audio>` element (`useAudioPlayer`) and the
//! local HTTP server (`stream-server.ts`).
//!
//! A file source can seek (ffmpeg restarts at the offset). A stream source (yt-dlp output still
//! arriving) cannot until the track is cached; [`Transport::mark_seekable`] then points it at the
//! finished file. Speed is applied by ffmpeg's `atempo`, so it follows the same rule.

use crate::error::{MusicError, Result};
use crate::output::{Feed, FeedEvent, OutputHandle};
use crate::process::command;
use lizmeter_core::{MusicErrorCode, MusicPlaybackState};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where the audio comes from.
pub enum Source {
    File(PathBuf),
    /// Container bytes still arriving (yt-dlp output). A feeder thread drains `reader`; `abort`
    /// stops whatever produces it (the feeder may be blocked in a read).
    Stream { reader: Box<dyn Read + Send>, abort: Box<dyn Fn() + Send + Sync> },
}

/// What happened to the loaded source. `generation` ties it to a [`Transport::load`].
#[derive(Debug, Clone, PartialEq)]
pub struct TransportEvent {
    pub generation: u64,
    pub kind: FeedEvent,
}

struct Decoder {
    child: Arc<Mutex<Child>>,
    abort: Option<Box<dyn Fn() + Send + Sync>>,
}

impl Decoder {
    /// ffmpeg starts no children, so ending the process itself is enough and immediate.
    fn stop(&self) {
        if let Some(a) = &self.abort {
            a();
        }
        let _ = lock(&self.child).kill();
        let _ = lock(&self.child).wait();
    }
}

struct Loaded {
    feed: Arc<Feed>,
    decoder: Decoder,
    /// A file that can be seeked: the source file, or the cache file once a stream finished.
    seekable: Option<PathBuf>,
    /// False while the source is a stream that has not been cached.
    is_stream: bool,
}

struct Inner {
    loaded: Option<Loaded>,
    volume: f32,
    muted: bool,
    speed: f64,
    paused: bool,
}

pub struct Transport {
    ffmpeg: PathBuf,
    output: Arc<OutputHandle>,
    inner: Mutex<Inner>,
    generation: AtomicU64,
    events: Sender<TransportEvent>,
}

/// ffmpeg `atempo` accepts 0.5 to 2.0 per filter in older builds, so chain for the rest.
pub fn atempo_chain(speed: f64) -> Option<String> {
    if (speed - 1.0).abs() < 1e-9 || speed <= 0.0 {
        return None;
    }
    let mut parts = Vec::new();
    let mut r = speed;
    while r > 2.0 {
        parts.push("atempo=2.0".to_string());
        r /= 2.0;
    }
    while r < 0.5 {
        parts.push("atempo=0.5".to_string());
        r /= 0.5;
    }
    parts.push(format!("atempo={r:.6}"));
    Some(parts.join(","))
}

fn gain_of(volume: f32, muted: bool) -> f32 {
    if muted {
        0.0
    } else {
        volume.clamp(0.0, 1.0)
    }
}

impl Transport {
    /// Returns the transport and the receiver for its events.
    pub fn new(ffmpeg: impl Into<PathBuf>, output: Arc<OutputHandle>) -> (Arc<Transport>, Receiver<TransportEvent>) {
        let (tx, rx) = channel();
        let t = Transport {
            ffmpeg: ffmpeg.into(),
            output,
            inner: Mutex::new(Inner { loaded: None, volume: 0.3, muted: false, speed: 1.0, paused: false }),
            generation: AtomicU64::new(0),
            events: tx,
        };
        (Arc::new(t), rx)
    }

    pub fn output(&self) -> &Arc<OutputHandle> {
        &self.output
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Loads `source` and starts playing it at `start_secs`. The previous source is dropped.
    pub fn load(&self, source: Source, start_secs: f64) -> Result<u64> {
        let mut g = lock(&self.inner);
        let (seekable, is_stream) = match &source {
            Source::File(p) => (Some(p.clone()), false),
            Source::Stream { .. } => (None, true),
        };
        self.start_locked(&mut g, source, start_secs.max(0.0), seekable, is_stream, false)
    }

    fn start_locked(&self, g: &mut Inner, source: Source, start_secs: f64, seekable: Option<PathBuf>, is_stream: bool, keep_paused: bool) -> Result<u64> {
        self.stop_locked(g);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if !keep_paused {
            g.paused = false;
        }
        let (ftx, frx) = channel::<FeedEvent>();
        let feed = Feed::new(self.output.rate(), start_secs, g.speed, g.paused, gain_of(g.volume, g.muted), ftx);
        let decoder = spawn_decoder(&self.ffmpeg, source, &feed, start_secs, g.speed)?;
        // Forward this feed's events, stamped with its generation.
        let tx = self.events.clone();
        std::thread::spawn(move || {
            while let Ok(kind) = frx.recv() {
                if tx.send(TransportEvent { generation, kind }).is_err() {
                    return;
                }
            }
        });
        self.output.set_feed(Some(feed.clone()));
        g.loaded = Some(Loaded { feed, decoder, seekable, is_stream });
        Ok(generation)
    }

    fn stop_locked(&self, g: &mut Inner) {
        if let Some(l) = g.loaded.take() {
            l.feed.close();
            self.output.set_feed(None);
            l.decoder.stop();
        }
    }

    pub fn stop(&self) {
        let mut g = lock(&self.inner);
        self.stop_locked(&mut g);
        // A later event of the old feed must not count.
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn pause(&self) {
        let mut g = lock(&self.inner);
        g.paused = true;
        if let Some(l) = &g.loaded {
            l.feed.set_paused(true);
        }
    }

    pub fn resume(&self) {
        let mut g = lock(&self.inner);
        g.paused = false;
        if let Some(l) = &g.loaded {
            l.feed.set_paused(false);
        }
    }

    pub fn set_volume(&self, v: f32) {
        let mut g = lock(&self.inner);
        g.volume = v.clamp(0.0, 1.0);
        let gain = gain_of(g.volume, g.muted);
        if let Some(l) = &g.loaded {
            l.feed.set_gain(gain);
        }
    }

    pub fn set_muted(&self, m: bool) {
        let mut g = lock(&self.inner);
        g.muted = m;
        let gain = gain_of(g.volume, g.muted);
        if let Some(l) = &g.loaded {
            l.feed.set_gain(gain);
        }
    }

    /// Changes the tempo. Applies at once for a seekable source (ffmpeg restarts at the current
    /// position) and at the next seek or load for a stream that is still arriving.
    pub fn set_speed(&self, speed: f64) -> Result<()> {
        let mut g = lock(&self.inner);
        if speed <= 0.0 || !speed.is_finite() {
            return Err(MusicError::new(MusicErrorCode::FormatError, "Playback speed must be positive"));
        }
        g.speed = speed;
        self.restart_in_place(&mut g)
    }

    /// Whether `seek` can move within the current source.
    pub fn is_seekable(&self) -> bool {
        lock(&self.inner).loaded.as_ref().is_some_and(|l| l.seekable.is_some())
    }

    /// Moves to `secs`. A stream that is not cached yet cannot seek.
    pub fn seek(&self, secs: f64) -> Result<()> {
        let mut g = lock(&self.inner);
        let Some(l) = &g.loaded else { return Ok(()) };
        let Some(path) = l.seekable.clone() else {
            return Err(MusicError::new(MusicErrorCode::FormatError, "Seeking is available once the track is cached"));
        };
        let keep = g.paused;
        self.start_locked(&mut g, Source::File(path.clone()), secs.max(0.0), Some(path), false, keep)?;
        Ok(())
    }

    /// The streamed track finished caching at `path`: seeking and speed changes now work.
    pub fn mark_seekable(&self, generation: u64, path: PathBuf) {
        let mut g = lock(&self.inner);
        if self.generation() != generation {
            return;
        }
        if let Some(l) = &mut g.loaded {
            l.seekable = Some(path);
            if (l.feed.speed - g.speed).abs() > 1e-9 {
                let _ = self.restart_in_place(&mut g);
            }
        }
    }

    fn restart_in_place(&self, g: &mut Inner) -> Result<()> {
        let Some(l) = &g.loaded else { return Ok(()) };
        if (l.feed.speed - g.speed).abs() < 1e-9 {
            return Ok(());
        }
        let Some(path) = l.seekable.clone() else { return Ok(()) };
        let at = l.feed.position_secs();
        let keep = g.paused;
        self.start_locked(g, Source::File(path.clone()), at, Some(path), false, keep)?;
        Ok(())
    }

    /// Source position in seconds.
    pub fn position(&self) -> f64 {
        lock(&self.inner).loaded.as_ref().map_or(0.0, |l| l.feed.position_secs())
    }

    /// Source seconds decoded so far.
    pub fn buffered(&self) -> f64 {
        lock(&self.inner).loaded.as_ref().map_or(0.0, |l| l.feed.decoded_secs())
    }

    pub fn state(&self) -> MusicPlaybackState {
        let g = lock(&self.inner);
        let Some(l) = &g.loaded else { return MusicPlaybackState::Stopped };
        if l.feed.has_ended() {
            return MusicPlaybackState::Paused;
        }
        if g.paused {
            MusicPlaybackState::Paused
        } else if l.feed.is_buffering() {
            MusicPlaybackState::Buffering
        } else {
            MusicPlaybackState::Playing
        }
    }

    pub fn is_loaded(&self) -> bool {
        lock(&self.inner).loaded.is_some()
    }

    pub fn is_stream(&self) -> bool {
        lock(&self.inner).loaded.as_ref().is_some_and(|l| l.is_stream)
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        let mut g = lock(&self.inner);
        self.stop_locked(&mut g);
    }
}

fn spawn_decoder(ffmpeg: &Path, source: Source, feed: &Arc<Feed>, start_secs: f64, speed: f64) -> Result<Decoder> {
    let fail = |m: String| MusicError::new(MusicErrorCode::FormatError, m);
    let piped = matches!(source, Source::Stream { .. });
    let mut cmd = command(ffmpeg);
    cmd.args(["-v", "error"]);
    if !piped {
        cmd.arg("-nostdin");
    }
    if start_secs > 0.0 {
        cmd.arg("-ss").arg(format!("{start_secs:.3}"));
    }
    let input = match &source {
        Source::File(p) => p.to_string_lossy().into_owned(),
        Source::Stream { .. } => "pipe:0".to_string(),
    };
    cmd.arg("-i").arg(input).arg("-vn");
    if let Some(af) = atempo_chain(speed) {
        cmd.args(["-af", &af]);
    }
    cmd.args(["-f", "f32le", "-ac", "2", "-ar", &feed.rate.to_string(), "pipe:1"]);
    cmd.stdin(if piped { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| fail(format!("Failed to start ffmpeg: {e}")))?;
    let stdout = child.stdout.take().expect("piped");
    let stderr = child.stderr.take().expect("piped");
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));

    let stderr_text = Arc::new(Mutex::new(String::new()));
    {
        let t = stderr_text.clone();
        std::thread::spawn(move || {
            let mut s = stderr;
            let mut b = Vec::new();
            let _ = s.read_to_end(&mut b);
            *lock(&t) = String::from_utf8_lossy(&b).into_owned();
        });
    }

    // Source -> ffmpeg stdin, for a stream.
    let mut abort = None;
    if let (Source::Stream { mut reader, abort: a }, Some(mut stdin)) = (source, stdin) {
        abort = Some(a);
        let feed = feed.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                if feed.is_closed() {
                    return;
                }
                match reader.read(&mut buf) {
                    Ok(0) => return,
                    Ok(n) => {
                        if stdin.write_all(&buf[..n]).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        let msg = crate::extractor::AudioStream::error_of(&e).map(|m| m.message.clone()).unwrap_or_else(|| e.to_string());
                        feed.fail(msg);
                        return;
                    }
                }
            }
        });
    }

    // ffmpeg stdout -> feed.
    {
        let (feed, child, stderr_text) = (feed.clone(), child.clone(), stderr_text.clone());
        std::thread::spawn(move || {
            let mut out = stdout;
            let mut bytes = vec![0u8; 16 * 1024];
            let mut carry: Vec<u8> = Vec::new();
            let mut samples: Vec<f32> = Vec::with_capacity(4096);
            let mut any = false;
            loop {
                let n = match out.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                carry.extend_from_slice(&bytes[..n]);
                let whole = carry.len() / 8 * 8; // a stereo f32 frame is 8 bytes
                samples.clear();
                samples.extend(carry[..whole].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])));
                carry.drain(..whole);
                if !samples.is_empty() {
                    any = true;
                    if !feed.push(&samples) {
                        return;
                    }
                }
            }
            if feed.is_closed() {
                return;
            }
            let code = loop {
                if let Some(s) = lock(&child).try_wait().ok().flatten() {
                    break s.code();
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            // Give the stderr reader a moment to deliver.
            std::thread::sleep(std::time::Duration::from_millis(20));
            let err = lock(&stderr_text).trim().to_string();
            if code != Some(0) && (!any || !err.is_empty()) && feed.failure().is_none() {
                feed.fail(if err.is_empty() { "ffmpeg could not decode the audio".into() } else { err });
            } else {
                feed.finish();
            }
        });
    }
    Ok(Decoder { child, abort })
}
