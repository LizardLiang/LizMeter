//! In-process decoding of cached tracks (AAC in MP4) into a silent test sink. ffmpeg
//! (`LIZMETER_TEST_FFMPEG`) only makes the fixtures and plays the files that are not AAC.
mod common;

use lizmeter_music::output::{FeedEvent, OutputHandle};
use lizmeter_music::transport::{Source, Transport, TransportEvent};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(secs) {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    panic!("timed out waiting for {what}");
}

struct Rig {
    t: Arc<Transport>,
    rx: Receiver<TransportEvent>,
    out: Arc<OutputHandle>,
    dir: tempfile::TempDir,
    ff: PathBuf,
}

fn rig(ff: &Path, out_rate: u32) -> Rig {
    let out = Arc::new(OutputHandle::open_null(out_rate));
    let (t, rx) = Transport::new(ff, out.clone());
    Rig { t, rx, out, dir: tempfile::tempdir().unwrap(), ff: ff.to_path_buf() }
}

impl Rig {
    fn aac(&self, name: &str, secs: f64, hz: u32, rate: u32) -> PathBuf {
        let p = self.dir.path().join(name);
        common::make_tone_with(&self.ff, &p, secs, hz, &["-ac", "2", "-ar", &rate.to_string(), "-c:a", "aac", "-b:a", "96k"]);
        p
    }

    fn ended(&self, secs: u64) -> TransportEvent {
        self.rx.recv_timeout(Duration::from_secs(secs)).expect("an event")
    }
}

#[test]
fn a_cached_aac_file_decodes_inside_the_app_and_plays_to_the_end() {
    let ff = need_ffmpeg!();
    for (file_rate, out_rate) in [(44_100, 44_100), (48_000, 44_100), (44_100, 48_000)] {
        let r = rig(&ff, out_rate);
        let file = r.aac("a.m4a", 1.5, 440, file_rate);
        r.t.set_volume(0.5);
        r.t.load(Source::File(file), 0.0).unwrap();
        assert!(r.t.is_native(), "{file_rate} Hz file did not take the in-process path");
        assert_eq!(r.ended(8).kind, FeedEvent::Ended);
        let pos = r.t.position();
        assert!((pos - 1.5).abs() < 0.12, "{file_rate}->{out_rate}: ended at {pos}");
        assert!(r.out.peak() > 0.03, "silent");
    }
}

#[test]
fn play_seek_and_speed_change_reach_the_device_at_once() {
    let ff = need_ffmpeg!();
    let r = rig(&ff, 48_000);
    let file = r.aac("a.m4a", 6.0, 440, 44_100);
    let took = |what: &str, act: &dyn Fn()| {
        let before = r.out.current_feed();
        let t0 = Instant::now();
        act();
        loop {
            if let Some(f) = r.out.current_feed() {
                let fresh = before.as_ref().is_none_or(|b| !Arc::ptr_eq(b, &f));
                if fresh && f.played_frames() > 0 {
                    break;
                }
            }
            assert!(t0.elapsed() < Duration::from_secs(5), "{what}: nothing played");
            std::thread::sleep(Duration::from_micros(500));
        }
        t0.elapsed()
    };
    let play = took("play", &|| {
        r.t.load(Source::File(file.clone()), 0.0).unwrap();
    });
    std::thread::sleep(Duration::from_millis(150));
    let seek = took("seek", &|| r.t.seek(3.0).unwrap());
    assert!((3.0..3.2).contains(&r.t.position()), "after seek {}", r.t.position());
    std::thread::sleep(Duration::from_millis(150));
    let before = r.t.position();
    let speed = took("speed", &|| r.t.set_speed(1.5).unwrap());
    assert!(r.t.is_native());
    assert!((before..before + 0.4).contains(&r.t.position()), "speed change moved {before} -> {}", r.t.position());
    std::thread::sleep(Duration::from_millis(150));
    let seek_fast = took("seek at 1.5x", &|| r.t.seek(1.0).unwrap());
    eprintln!("play {play:?}, seek {seek:?}, speed {speed:?}, seek at 1.5x {seek_fast:?}");
    for (what, d) in [("play", play), ("seek", seek), ("speed", speed), ("seek at 1.5x", seek_fast)] {
        assert!(d < Duration::from_millis(400), "{what} took {d:?}");
    }
}

#[test]
fn speed_shortens_the_wall_time_and_keeps_source_seconds() {
    let ff = need_ffmpeg!();
    let r = rig(&ff, 44_100);
    let file = r.aac("a.m4a", 4.0, 440, 44_100);
    r.t.set_speed(2.0).unwrap();
    r.t.load(Source::File(file), 0.0).unwrap();
    assert!(r.t.is_native());
    wait_until("playing", 5, || r.t.position() > 0.3);
    let started = Instant::now();
    let p0 = r.t.position();
    assert_eq!(r.ended(8).kind, FeedEvent::Ended);
    let took = started.elapsed().as_secs_f64();
    let covered = r.t.position() - p0;
    assert!(covered / took > 1.6, "covered {covered} source seconds in {took} s, expected about 2x");
    assert!((r.t.position() - 4.0).abs() < 0.3, "position {}", r.t.position());
}

#[test]
fn a_seek_into_the_second_half_plays_only_that_part() {
    let ff = need_ffmpeg!();
    let r = rig(&ff, 44_100);
    let file = r.aac("a.m4a", 4.0, 440, 44_100);
    r.t.set_volume(1.0);
    r.t.load(Source::File(file), 3.0).unwrap();
    assert!(r.t.is_native());
    assert_eq!(r.ended(8).kind, FeedEvent::Ended);
    let pos = r.t.position();
    assert!((pos - 4.0).abs() < 0.12, "started at 3.0 s, ended at {pos}");
    let played = r.out.audible_frames() as f64 / 44_100.0;
    assert!((0.85..1.15).contains(&played), "played {played} s of sound");
}

#[test]
fn an_opus_file_under_an_m4a_name_goes_to_ffmpeg() {
    let ff = need_ffmpeg!();
    let r = rig(&ff, 44_100);
    let file = r.dir.path().join("opus.m4a");
    common::make_tone_with(&ff, &file, 1.0, 440, &["-ac", "2", "-c:a", "libopus", "-b:a", "64k", "-f", "webm"]);
    r.t.load(Source::File(file), 0.0).unwrap();
    assert!(!r.t.is_native(), "symphonia has no Opus decoder: ffmpeg must take it");
    assert_eq!(r.ended(10).kind, FeedEvent::Ended);
    assert!(r.t.position() > 0.8);
}

#[test]
fn a_speed_outside_the_stretch_range_goes_to_ffmpeg() {
    let ff = need_ffmpeg!();
    let r = rig(&ff, 44_100);
    let file = r.aac("a.m4a", 1.0, 440, 44_100);
    r.t.set_speed(3.0).unwrap();
    r.t.load(Source::File(file), 0.0).unwrap();
    assert!(!r.t.is_native());
    assert_eq!(r.ended(10).kind, FeedEvent::Ended);
}

#[test]
fn a_cut_off_file_ends_instead_of_hanging() {
    let ff = need_ffmpeg!();
    let r = rig(&ff, 44_100);
    let file = r.aac("a.m4a", 3.0, 440, 44_100);
    let bytes = std::fs::read(&file).unwrap();
    let cut = r.dir.path().join("cut.m4a");
    std::fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    r.t.load(Source::File(cut), 0.0).unwrap();
    let ev = r.ended(10);
    assert!(matches!(ev.kind, FeedEvent::Ended | FeedEvent::Failed(_)), "{ev:?}");
}
