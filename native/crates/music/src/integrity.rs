//! `integrity-checker.ts`: find damaged or truncated cached audio with ffmpeg, and repair by
//! deleting the cache file so the track streams again on the next play.
//!
//! Two probes per file: the container's duration (`ffmpeg -i`), then a one second decode near the
//! end (`ffmpeg -ss <end-5> -t 1 -f null`), which catches data cut off behind an intact header.

use crate::binaries::BinaryManager;
use crate::error::Result;
use crate::process::run_capture;
use crate::DbHandle;
use lizmeter_core::{DamageReason, DamagedTrackInfo, IntegrityCheckResult};
use lizmeter_db::InternalTrackRecord;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const FINALIZE_TIMEOUT: Duration = Duration::from_millis(60_000);
const BULK_PROBE_TIMEOUT: Duration = Duration::from_millis(20_000);

#[cfg(windows)]
const NULL_DEVICE: &str = "NUL";
#[cfg(not(windows))]
const NULL_DEVICE: &str = "/dev/null";

/// `Duration: HH:MM:SS.cc` from ffmpeg's banner, in seconds.
pub fn parse_container_duration(stderr: &str) -> Option<f64> {
    let at = stderr.find("Duration:")? + "Duration:".len();
    let rest = stderr[at..].trim_start();
    let mut parts = rest.splitn(3, ':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let tail = parts.next()?;
    let (s, frac) = tail.split_once('.')?;
    let secs: f64 = s.trim().parse().ok()?;
    let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    // The TS regex reads the fraction as centiseconds whatever its width.
    let centis: f64 = digits.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + secs + centis / 100.0)
}

fn container_duration(file: &Path, ffmpeg: &Path, timeout: Duration) -> Option<f64> {
    let out = run_capture(ffmpeg, &["-i", &file.to_string_lossy(), "-hide_banner"], timeout).ok()?;
    parse_container_duration(&out.stderr)
}

fn can_decode_at(file: &Path, ffmpeg: &Path, seek: f64, timeout: Duration) -> bool {
    let ss = seek.floor().max(0.0).to_string();
    let path = file.to_string_lossy();
    match run_capture(ffmpeg, &["-v", "error", "-ss", &ss, "-i", &path, "-t", "1", "-f", "null", NULL_DEVICE], timeout) {
        Ok(o) => o.code == Some(0) && o.stderr.trim().is_empty(),
        Err(_) => false,
    }
}

fn damaged(track: &InternalTrackRecord, reason: DamageReason, detail: String, container: Option<f64>) -> DamagedTrackInfo {
    DamagedTrackInfo {
        track: track.to_renderer_track(),
        reason,
        detail,
        container_duration: container,
        expected_duration: track.duration_seconds,
    }
}

/// JS `Math.round`: halves go up.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `${n}` of a JS number: integers print without a decimal point.
fn num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// Probes one cached track. `None` means healthy.
pub fn probe_track(track: &InternalTrackRecord, ffmpeg: &Path, timeout: Duration) -> Option<DamagedTrackInfo> {
    let file = Path::new(track.cached_file_path.as_deref()?);
    if !file.exists() {
        return Some(damaged(track, DamageReason::Missing, "Cache file no longer exists on disk".into(), None));
    }
    match fs::metadata(file) {
        Ok(m) if m.len() < 1024 => {
            return Some(damaged(track, DamageReason::Empty, format!("File is only {} bytes", m.len()), None));
        }
        Ok(_) => {}
        Err(_) => return Some(damaged(track, DamageReason::Unreadable, "Cannot read cache file".into(), None)),
    }

    let Some(container) = container_duration(file, ffmpeg, timeout) else {
        return Some(damaged(track, DamageReason::Corrupt, "Cannot read audio metadata (missing moov atom or invalid container)".into(), None));
    };

    let expected = track.duration_seconds;
    if let Some(exp) = expected.filter(|e| *e > 0.0) {
        let ratio = container / exp;
        if ratio < 0.85 {
            return Some(damaged(
                track,
                DamageReason::Truncated,
                format!("Container duration {}s vs expected {}s ({}%)", num(round(container)), num(exp), num(round(ratio * 100.0))),
                Some(round(container)),
            ));
        }
    }

    // The "stops halfway" check: decode a second near the end.
    let reference = expected.unwrap_or(container);
    if reference > 10.0 {
        let seek = reference - 5.0;
        if !can_decode_at(file, ffmpeg, seek, timeout) {
            return Some(damaged(
                track,
                DamageReason::Truncated,
                format!("Audio data ends before expected (cannot decode at {}s / {}s)", num(round(seek)), num(round(reference))),
                Some(round(container)),
            ));
        }
    }
    None
}

pub struct IntegrityChecker {
    db: DbHandle,
    bins: Arc<BinaryManager>,
    running: AtomicBool,
}

impl IntegrityChecker {
    pub fn new(db: DbHandle, bins: Arc<BinaryManager>) -> Self {
        IntegrityChecker { db, bins, running: AtomicBool::new(false) }
    }

    /// Validates one cached track before it is served. A missing ffmpeg means no verdict (healthy).
    pub fn check_track(&self, track: &InternalTrackRecord) -> Option<DamagedTrackInfo> {
        let ffmpeg = self.bins.ffmpeg_path();
        if !ffmpeg.exists() {
            return None;
        }
        probe_track(track, &ffmpeg, FINALIZE_TIMEOUT)
    }

    /// Scans every cached track. Only one scan runs at a time.
    pub fn check_all(&self, on_progress: &mut dyn FnMut(i64, i64, &str)) -> Result<IntegrityCheckResult> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(IntegrityCheckResult { damaged: vec![], checked: 0, total: 0, error: Some("Integrity check already in progress".into()) });
        }
        struct Reset<'a>(&'a AtomicBool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(&self.running);

        let ffmpeg = self.bins.ffmpeg_path();
        if !ffmpeg.exists() {
            return Ok(IntegrityCheckResult { damaged: vec![], checked: 0, total: 0, error: Some("ffmpeg is not installed".into()) });
        }
        let tracks = crate::with_db(&self.db, |db| Ok(db.get_all_cached_tracks()?))?;
        let total = tracks.len() as i64;
        let mut found = Vec::new();
        for (i, t) in tracks.iter().enumerate() {
            on_progress(i as i64 + 1, total, &t.title);
            if let Some(d) = probe_track(t, &ffmpeg, BULK_PROBE_TIMEOUT) {
                found.push(d);
            }
        }
        Ok(IntegrityCheckResult { damaged: found, checked: total, total, error: None })
    }

    /// Deletes the cache file of each listed track and clears its cache fields. Returns how many
    /// tracks were repaired.
    pub fn repair(&self, track_ids: &[String]) -> Result<i64> {
        let cached = crate::with_db(&self.db, |db| Ok(db.get_all_cached_tracks()?))?;
        let mut repaired = 0;
        for id in track_ids {
            let Some(track) = cached.iter().find(|t| &t.id == id) else { continue };
            if let Some(path) = &track.cached_file_path {
                let _ = fs::remove_file(path);
            }
            crate::with_db(&self.db, |db| Ok(db.update_track_cache(id, None, None)?))?;
            repaired += 1;
        }
        Ok(repaired)
    }
}
