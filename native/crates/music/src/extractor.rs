//! `audio-extractor.ts`: metadata, playlist and audio extraction through yt-dlp. Every call goes
//! through the [`ProcessManager`]; there is no raw spawn here.

use crate::binaries::BinaryManager;
use crate::error::{MusicError, Result};
use crate::process::{ProcHandle, ProcessManager, SpawnOptions};
use lizmeter_core::MusicErrorCode;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Tracks taken from one playlist before the import stops.
pub const PLAYLIST_IMPORT_CAP: usize = 500;
const DETECT_TIMEOUT: Duration = Duration::from_millis(10_000);
const PUMP_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct TrackMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub duration_seconds: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub source_id: String,
    pub source_site: String,
    /// `webpage_url` (canonical).
    pub source_url: String,
    pub is_live: bool,
}

fn fail<T>(code: MusicErrorCode, message: impl Into<String>) -> Result<T> {
    Err(MusicError::new(code, message))
}

/// Rejects anything `new URL(...)` would reject.
pub fn validate_url(url: &str) -> Result<()> {
    match reqwest::Url::parse(url) {
        Ok(_) => Ok(()),
        Err(_) => fail(MusicErrorCode::InvalidUrl, format!("Invalid URL: {url}")),
    }
}

/// `Math.round` of a JSON number.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn duration_field(v: &Value) -> Option<f64> {
    v.get("duration").and_then(Value::as_f64).map(js_round)
}

/// Parses `--dump-json` output of one video.
pub fn parse_yt_dlp_json(raw: &str, input_url: &str) -> Result<TrackMetadata> {
    let data: Value = match serde_json::from_str(raw.trim()) {
        Ok(v @ Value::Object(_)) => v,
        _ => return fail(MusicErrorCode::ExtractionFailed, "Failed to parse yt-dlp metadata output"),
    };
    let artist = str_field(&data, "uploader")
        .filter(|s| !s.is_empty())
        .or_else(|| str_field(&data, "channel").filter(|s| !s.is_empty()))
        .map(str::to_string);
    let source_site = match str_field(&data, "extractor_key") {
        Some(k) => k.to_lowercase(),
        None => str_field(&data, "extractor").unwrap_or("unknown").to_string(),
    };
    Ok(TrackMetadata {
        title: str_field(&data, "title").unwrap_or("Unknown title").to_string(),
        artist,
        duration_seconds: duration_field(&data),
        thumbnail_url: str_field(&data, "thumbnail").map(str::to_string),
        source_id: str_field(&data, "id").unwrap_or("").to_string(),
        source_site,
        source_url: str_field(&data, "webpage_url").unwrap_or(input_url).to_string(),
        is_live: data.get("is_live") == Some(&Value::Bool(true)),
    })
}

/// One `--flat-playlist` line: a reduced entry (`url`, `title`, `duration`).
fn parse_flat_entry(data: &Value, playlist_url: &str) -> TrackMetadata {
    let source_site = match str_field(data, "ie_key") {
        Some(k) => k.to_lowercase(),
        None => str_field(data, "extractor").unwrap_or("unknown").to_string(),
    };
    let source_url = str_field(data, "url").or_else(|| str_field(data, "webpage_url")).unwrap_or(playlist_url);
    TrackMetadata {
        title: str_field(data, "title").unwrap_or("Unknown").to_string(),
        artist: str_field(data, "uploader").map(str::to_string),
        duration_seconds: duration_field(data),
        thumbnail_url: str_field(data, "thumbnail").map(str::to_string),
        source_id: str_field(data, "id").unwrap_or("").to_string(),
        source_site,
        source_url: source_url.to_string(),
        is_live: data.get("is_live") == Some(&Value::Bool(true)),
    }
}

fn read_all(mut r: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = r.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
    })
}

enum Chunk {
    Data(Vec<u8>),
    Failed(MusicError),
}

/// The audio of one track as a byte stream (M4A, or Opus after a fallback). Reading past the end
/// of a failed extraction returns an error, so a caller never mistakes a cut-off stream for a
/// finished one. Dropping the stream stops yt-dlp.
pub struct AudioStream {
    rx: Receiver<Chunk>,
    pending: Vec<u8>,
    pos: usize,
    finished: bool,
    cancel: Arc<AtomicBool>,
    /// The yt-dlp process this stream reads now. Stopping kills this one, never a newer process
    /// that reuses the key.
    proc: Arc<Mutex<Option<Arc<ProcHandle>>>>,
}

impl Read for AudioStream {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.pending.len() {
            if self.finished {
                return Ok(0);
            }
            match self.rx.recv() {
                Ok(Chunk::Data(d)) => {
                    self.pending = d;
                    self.pos = 0;
                }
                Ok(Chunk::Failed(e)) => {
                    self.finished = true;
                    return Err(std::io::Error::other(e));
                }
                Err(_) => {
                    self.finished = true;
                    return Ok(0);
                }
            }
        }
        let n = out.len().min(self.pending.len() - self.pos);
        out[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

impl Drop for AudioStream {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(h) = self.proc.lock().unwrap_or_else(|e| e.into_inner()).take() {
            h.kill();
        }
    }
}

impl AudioStream {
    /// A function that stops the extraction from any thread, even while a read is blocked.
    pub fn abort_handle(&self) -> Box<dyn Fn() + Send + Sync> {
        let (cancel, proc) = (self.cancel.clone(), self.proc.clone());
        Box::new(move || {
            cancel.store(true, Ordering::SeqCst);
            if let Some(h) = proc.lock().unwrap_or_else(|e| e.into_inner()).take() {
                h.kill();
            }
        })
    }

    /// The [`MusicError`] inside an I/O error this stream returned.
    pub fn error_of(e: &std::io::Error) -> Option<&MusicError> {
        e.get_ref().and_then(|inner| inner.downcast_ref::<MusicError>())
    }
}

pub struct Extractor {
    pm: Arc<ProcessManager>,
    bins: Arc<BinaryManager>,
}

impl Extractor {
    pub fn new(pm: Arc<ProcessManager>, bins: Arc<BinaryManager>) -> Self {
        Extractor { pm, bins }
    }

    pub fn process_manager(&self) -> &Arc<ProcessManager> {
        &self.pm
    }

    /// `yt-dlp --dump-json --no-download <url>`.
    pub fn extract_metadata(&self, url: &str) -> Result<TrackMetadata> {
        validate_url(url)?;
        let spawned = self.pm.spawn(&format!("metadata:{url}"), &["--dump-json".into(), "--no-download".into(), url.into()], &SpawnOptions::default())?;
        let (out, err) = (read_all(spawned.stdout), read_all(spawned.stderr));
        let code = spawned.handle.wait();
        let (raw, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
        if let Some(c) = code {
            if c != 0 {
                let msg = stderr.trim();
                let msg = if msg.is_empty() { "yt-dlp exited with non-zero code" } else { msg };
                return fail(MusicErrorCode::ExtractionFailed, format!("Metadata extraction failed: {msg}"));
            }
        }
        if raw.trim().is_empty() {
            return fail(MusicErrorCode::ExtractionFailed, "yt-dlp produced no output for metadata extraction");
        }
        parse_yt_dlp_json(&raw, url)
    }

    fn ffmpeg_args(&self) -> Vec<String> {
        vec!["--ffmpeg-location".into(), self.bins.ffmpeg_path().to_string_lossy().into_owned()]
    }

    fn stream_args(&self, format: &str, audio_format: &str, url: &str) -> Vec<String> {
        let mut a = vec!["-f".to_string(), format.to_string(), "--audio-format".into(), audio_format.into()];
        a.extend(self.ffmpeg_args());
        a.extend(["-o".to_string(), "-".into(), url.into()]);
        a
    }

    /// Starts the audio stream of `url`: M4A first, Opus when M4A fails before sending a byte.
    /// A failure after bytes went out is an error on the stream (the two formats cannot be joined).
    pub fn extract_audio(&self, url: &str) -> Result<AudioStream> {
        validate_url(url)?;
        let key = format!("stream:{url}");
        let first = self.pm.spawn(&key, &self.stream_args("bestaudio[ext=m4a]/bestaudio", "m4a", url), &SpawnOptions::default())?;
        let (tx, rx) = channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let proc: Arc<Mutex<Option<Arc<ProcHandle>>>> = Arc::new(Mutex::new(Some(first.handle.clone())));
        let stream = AudioStream { rx, pending: Vec::new(), pos: 0, finished: false, cancel: cancel.clone(), proc: proc.clone() };

        let (pm, proc) = (self.pm.clone(), proc);
        let opus_args = self.stream_args("bestaudio", "opus", url);
        std::thread::spawn(move || {
            let (mut sent, mut stderr_msg) = (0usize, String::new());
            let mut current = Some(first);
            let mut is_fallback = false;
            loop {
                let Some(proc_spawned) = current.take() else { return };
                *proc.lock().unwrap_or_else(|e| e.into_inner()) = Some(proc_spawned.handle.clone());
                let proc_spawned = proc_spawned;
                let stderr = read_all(proc_spawned.stderr);
                let ok = pump(proc_spawned.stdout, &tx, &cancel, &mut sent);
                if !ok {
                    // The reader went away: stop yt-dlp and finish.
                    proc_spawned.handle.kill();
                    return;
                }
                let code = proc_spawned.handle.wait();
                let msg = stderr.join().unwrap_or_default().trim().to_string();
                if code == Some(0) {
                    return;
                }
                if cancel.load(Ordering::SeqCst) || proc_spawned.handle.was_killed() {
                    let _ = tx.send(Chunk::Failed(MusicError::new(MusicErrorCode::ExtractionFailed, "Audio stream was stopped")));
                    return;
                }
                if is_fallback {
                    let m = if !msg.is_empty() { msg } else if !stderr_msg.is_empty() { stderr_msg } else { "All audio formats failed".into() };
                    let _ = tx.send(Chunk::Failed(MusicError::new(MusicErrorCode::FormatError, format!("Audio extraction failed: {m}"))));
                    return;
                }
                if sent > 0 {
                    let m = if msg.is_empty() { "yt-dlp exited with non-zero code".to_string() } else { msg };
                    let _ = tx.send(Chunk::Failed(MusicError::new(MusicErrorCode::FormatError, format!("Audio extraction failed: {m}"))));
                    return;
                }
                stderr_msg = msg;
                match pm.spawn(&key, &opus_args, &SpawnOptions::default()) {
                    Ok(p) => {
                        current = Some(p);
                        is_fallback = true;
                    }
                    Err(e) => {
                        let _ = tx.send(Chunk::Failed(MusicError::new(MusicErrorCode::FormatError, format!("Audio extraction failed: {}", e.message))));
                        return;
                    }
                }
            }
        });
        Ok(stream)
    }

    /// Whether `url` is a playlist: `--flat-playlist --playlist-items 1:2` prints more than one
    /// entry. Any error counts as a single track.
    pub fn detect_playlist(&self, url: &str) -> bool {
        if validate_url(url).is_err() {
            return false;
        }
        let args = ["--flat-playlist", "--dump-json", "--playlist-items", "1:2", url].map(String::from);
        let opts = SpawnOptions { no_playlist: Some(false), timeout: Some(DETECT_TIMEOUT) };
        let Ok(spawned) = self.pm.spawn(&format!("detect:{url}"), &args, &opts) else { return false };
        let _stderr = read_all(spawned.stderr);
        let raw = read_all(spawned.stdout).join().unwrap_or_default();
        spawned.handle.wait();
        raw.lines().filter(|l| !l.trim().is_empty()).count() > 1
    }

    /// `--flat-playlist --dump-json`: calls `on_track` for each entry as it arrives, up to
    /// [`PLAYLIST_IMPORT_CAP`]. Setting `cancel` stops it. Returns the number of tracks taken.
    pub fn extract_playlist_metadata(&self, url: &str, on_track: &mut dyn FnMut(TrackMetadata, usize), cancel: Arc<AtomicBool>) -> Result<usize> {
        validate_url(url)?;
        let key = format!("import:{url}");
        let args = ["--flat-playlist", "--dump-json", url].map(String::from);
        let spawned = self.pm.spawn(&key, &args, &SpawnOptions { no_playlist: Some(false), timeout: None })?;
        let _stderr = read_all(spawned.stderr);

        let done = Arc::new(AtomicBool::new(false));
        let watcher = {
            let (pm, key, done, cancel) = (self.pm.clone(), key.clone(), done.clone(), cancel.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    if cancel.load(Ordering::SeqCst) {
                        pm.kill_process(&key);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            })
        };

        let mut count = 0usize;
        let mut reader = BufReader::new(spawned.stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let text = String::from_utf8_lossy(&line);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(data) = serde_json::from_str::<Value>(trimmed) else { continue };
            if !data.is_object() {
                continue;
            }
            on_track(parse_flat_entry(&data, url), count);
            count += 1;
            if count >= PLAYLIST_IMPORT_CAP {
                self.pm.kill_process(&key);
                break;
            }
        }
        done.store(true, Ordering::SeqCst);
        let _ = watcher.join();
        drop(reader);
        spawned.handle.wait();
        Ok(count)
    }
}

/// Copies `stdout` into the channel. `false` means the reader went away or was cancelled.
fn pump(stdout: std::process::ChildStdout, tx: &Sender<Chunk>, cancel: &AtomicBool, sent: &mut usize) -> bool {
    let mut stdout = stdout;
    let mut buf = vec![0u8; PUMP_CHUNK];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => return true,
            Ok(n) => {
                *sent += n;
                if tx.send(Chunk::Data(buf[..n].to_vec())).is_err() {
                    return false;
                }
            }
        }
    }
}
