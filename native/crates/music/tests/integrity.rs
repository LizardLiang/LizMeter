//! `integrity-checker.ts` against a real ffmpeg (`LIZMETER_TEST_FFMPEG`); skipped without one.
mod common;

use lizmeter_core::DamageReason;
use lizmeter_db::{Database, InternalTrackRecord, TrackUpsert};
use lizmeter_music::binaries::BinaryManager;
use lizmeter_music::integrity::{parse_container_duration, probe_track, IntegrityChecker};
use lizmeter_music::DbHandle;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn record(path: &Path, expected: Option<f64>) -> InternalTrackRecord {
    InternalTrackRecord {
        id: "t1".into(),
        source_url: "https://example.com/t1".into(),
        source_id: "t1".into(),
        source_site: "youtube".into(),
        title: "Tone".into(),
        artist: None,
        duration_seconds: expected,
        thumbnail_url: None,
        cached_file_path: Some(path.to_string_lossy().into_owned()),
        cache_size_bytes: None,
        play_count: 0,
        last_played_at: None,
        added_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

const T: Duration = Duration::from_secs(30);

macro_rules! need_ffmpeg {
    () => {
        match common::ffmpeg() {
            Some(f) => f,
            None => {
                eprintln!("SKIP: set LIZMETER_TEST_FFMPEG");
                return;
            }
        }
    };
}

/// Keeps the header and the first `keep` of the data and overwrites the rest with 0xFF, so the
/// container still claims the full duration.
fn damaged_tail_copy(src: &Path, dst: &Path, keep: f64) {
    let mut bytes = std::fs::read(src).unwrap();
    let from = (bytes.len() as f64 * keep) as usize;
    bytes[from..].fill(0xFF);
    std::fs::write(dst, &bytes).unwrap();
}

#[test]
fn reads_the_duration_from_the_ffmpeg_banner() {
    assert_eq!(parse_container_duration("  Duration: 00:03:25.50, start: 0.0"), Some(205.5));
    assert_eq!(parse_container_duration("Duration: 01:00:00.00, bitrate"), Some(3600.0));
    assert_eq!(parse_container_duration("Duration: N/A, bitrate: N/A"), None);
    assert_eq!(parse_container_duration("no banner"), None);
}

#[test]
fn a_healthy_file_passes_both_probes() {
    let ff = need_ffmpeg!();
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("ok.m4a");
    common::make_tone_with(&ff, &f, 14.0, 440, &["-movflags", "+faststart"]);
    assert!(probe_track(&record(&f, Some(14.0)), &ff, T).is_none());
    assert!(probe_track(&record(&f, None), &ff, T).is_none(), "no expected duration: judged by the container alone");
}

#[test]
fn a_track_without_a_cache_path_is_not_probed() {
    let ff = need_ffmpeg!();
    let mut r = record(Path::new("x"), None);
    r.cached_file_path = None;
    assert!(probe_track(&r, &ff, T).is_none());
}

#[test]
fn reports_missing_empty_and_corrupt_files() {
    let ff = need_ffmpeg!();
    let dir = tempfile::tempdir().unwrap();
    let missing = probe_track(&record(&dir.path().join("none.m4a"), Some(10.0)), &ff, T).unwrap();
    assert_eq!(missing.reason, DamageReason::Missing);
    assert_eq!(missing.detail, "Cache file no longer exists on disk");

    let empty = dir.path().join("empty.m4a");
    std::fs::write(&empty, vec![0u8; 100]).unwrap();
    let d = probe_track(&record(&empty, Some(10.0)), &ff, T).unwrap();
    assert_eq!((d.reason, d.detail.as_str()), (DamageReason::Empty, "File is only 100 bytes"));

    let junk = dir.path().join("junk.m4a");
    std::fs::write(&junk, vec![0x41u8; 4096]).unwrap();
    let d = probe_track(&record(&junk, Some(10.0)), &ff, T).unwrap();
    assert_eq!(d.reason, DamageReason::Corrupt);
    assert_eq!(d.container_duration, None);
}

#[test]
fn a_container_far_shorter_than_expected_is_truncated() {
    let ff = need_ffmpeg!();
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("short.m4a");
    common::make_tone_with(&ff, &f, 14.0, 440, &["-movflags", "+faststart"]);
    let d = probe_track(&record(&f, Some(100.0)), &ff, T).unwrap();
    assert_eq!(d.reason, DamageReason::Truncated);
    assert_eq!(d.detail, "Container duration 14s vs expected 100s (14%)");
    assert_eq!(d.container_duration, Some(14.0));
    assert_eq!(d.expected_duration, Some(100.0));
}

#[test]
fn damaged_audio_data_behind_an_intact_header_is_caught_by_the_decode_probe() {
    let ff = need_ffmpeg!();
    let dir = tempfile::tempdir().unwrap();
    let whole = dir.path().join("whole.m4a");
    common::make_tone_with(&ff, &whole, 14.0, 440, &["-movflags", "+faststart"]);
    let cut = dir.path().join("cut.m4a");
    damaged_tail_copy(&whole, &cut, 0.6);
    let d = probe_track(&record(&cut, Some(14.0)), &ff, T).unwrap();
    assert_eq!(d.reason, DamageReason::Truncated);
    assert!(d.detail.starts_with("Audio data ends before expected (cannot decode at 9s / 14s)"), "{}", d.detail);
}

fn checker(ff: &Path) -> (IntegrityChecker, DbHandle, tempfile::TempDir) {
    let db: DbHandle = Arc::new(Mutex::new(Database::open_in_memory().unwrap())).into();
    let user_data = ff.parent().unwrap().parent().unwrap();
    let bins = Arc::new(BinaryManager::new(user_data));
    (IntegrityChecker::new(db.clone(), bins), db, tempfile::tempdir().unwrap())
}

fn add_cached(db: &DbHandle, id: &str, path: &Path, duration: f64) {
    let db = db.lock().unwrap();
    db.upsert_track(&TrackUpsert {
        id: id.into(),
        source_url: format!("https://example.com/{id}"),
        source_id: id.into(),
        source_site: "youtube".into(),
        title: format!("Title {id}"),
        artist: None,
        duration_seconds: Some(duration),
        thumbnail_url: None,
        cached_file_path: Some(path.to_string_lossy().into_owned()),
        cache_size_bytes: Some(std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)),
        added_at: None,
    })
    .unwrap();
}

#[test]
fn check_all_reports_progress_and_the_damaged_tracks_and_repair_clears_them() {
    let ff = need_ffmpeg!();
    let (checker, db, dir) = checker(&ff);
    let good = dir.path().join("good.m4a");
    common::make_tone_with(&ff, &good, 12.0, 440, &["-movflags", "+faststart"]);
    let bad: PathBuf = dir.path().join("bad.m4a");
    std::fs::write(&bad, vec![0x41u8; 4096]).unwrap();
    add_cached(&db, "good", &good, 12.0);
    add_cached(&db, "bad", &bad, 12.0);

    let mut progress = Vec::new();
    let result = checker.check_all(&mut |c, t, title| progress.push((c, t, title.to_string()))).unwrap();
    assert_eq!((result.checked, result.total, result.error), (2, 2, None));
    assert_eq!(progress.len(), 2);
    assert_eq!(progress[0].1, 2);
    assert_eq!(result.damaged.len(), 1);
    assert_eq!(result.damaged[0].track.id, "bad");
    assert_eq!(result.damaged[0].reason, DamageReason::Corrupt);

    assert_eq!(checker.repair(&["bad".into(), "unknown".into()]).unwrap(), 1);
    assert!(!bad.exists());
    let row = db.lock().unwrap().get_track_by_id("bad").unwrap().unwrap();
    assert_eq!((row.cached_file_path, row.cache_size_bytes), (None, None));
    assert_eq!(row.title, "Title bad", "track metadata survives a repair");
    assert!(good.exists());
}

#[test]
fn an_empty_library_has_nothing_to_check() {
    let ff = need_ffmpeg!();
    let (checker, _db, _dir) = checker(&ff);
    let r = checker.check_all(&mut |_, _, _| {}).unwrap();
    assert_eq!((r.checked, r.total, r.error), (0, 0, None));
}

#[test]
fn without_ffmpeg_a_scan_says_so_and_a_single_check_gives_no_verdict() {
    let db: DbHandle = Arc::new(Mutex::new(Database::open_in_memory().unwrap())).into();
    let root = tempfile::tempdir().unwrap();
    let checker = IntegrityChecker::new(db, Arc::new(BinaryManager::new(root.path())));
    let r = checker.check_all(&mut |_, _, _| {}).unwrap();
    assert_eq!(r.error.as_deref(), Some("ffmpeg is not installed"));
    assert!(checker.check_track(&record(Path::new("x"), None)).is_none());
}
