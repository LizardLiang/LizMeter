//! Playback through a real ffmpeg (`LIZMETER_TEST_FFMPEG`) into a silent test sink.
mod common;

use lizmeter_core::MusicPlaybackState;
use lizmeter_music::output::{FeedEvent, OutputHandle};
use lizmeter_music::transport::{atempo_chain, Source, Transport, TransportEvent};
use std::io::Read;
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

fn stream(r: impl Read + Send + 'static) -> Source {
    Source::Stream { reader: Box::new(r), abort: Box::new(|| {}) }
}

struct Rig {
    t: Arc<Transport>,
    rx: Receiver<TransportEvent>,
    out: Arc<OutputHandle>,
    dir: tempfile::TempDir,
    ff: PathBuf,
}

fn rig(ff: &Path) -> Rig {
    let out = Arc::new(OutputHandle::open_null(44_100));
    let (t, rx) = Transport::new(ff, out.clone());
    Rig { t, rx, out, dir: tempfile::tempdir().unwrap(), ff: ff.to_path_buf() }
}

impl Rig {
    fn tone(&self, name: &str, secs: f64) -> PathBuf {
        let p = self.dir.path().join(name);
        common::make_tone(&self.ff, &p, secs, 440);
        p
    }

    fn wait_event(&self, within: Duration) -> Option<TransportEvent> {
        self.rx.recv_timeout(within).ok()
    }
}

fn wait_until(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn atempo_is_chained_outside_the_single_filter_range() {
    assert_eq!(atempo_chain(1.0), None);
    assert_eq!(atempo_chain(1.5).as_deref(), Some("atempo=1.500000"));
    assert_eq!(atempo_chain(4.0).as_deref(), Some("atempo=2.0,atempo=2.000000"));
    assert_eq!(atempo_chain(0.25).as_deref(), Some("atempo=0.5,atempo=0.500000"));
}

#[test]
fn a_file_plays_at_the_set_volume_and_ends() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    let tone = r.tone("a.wav", 1.2);
    r.t.set_volume(0.5);
    let generation = r.t.load(Source::File(tone), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.2);
    assert_eq!(r.t.state(), MusicPlaybackState::Playing);
    // ffmpeg's sine has amplitude 1/8, the mono-to-stereo mix takes 3 dB off, the gain halves it.
    let expected = 0.125 * std::f32::consts::FRAC_1_SQRT_2 * 0.5;
    let peak = r.out.peak();
    assert!((peak - expected).abs() < 0.005, "peak {peak}, expected {expected}");
    let ev = r.wait_event(Duration::from_secs(5)).expect("ended");
    assert_eq!(ev, TransportEvent { generation, kind: FeedEvent::Ended });
    let pos = r.t.position();
    assert!((pos - 1.2).abs() < 0.15, "position {pos}");
}

#[test]
fn pause_freezes_the_position_and_resume_continues() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.load(Source::File(r.tone("a.wav", 3.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.2);
    r.t.pause();
    assert_eq!(r.t.state(), MusicPlaybackState::Paused);
    std::thread::sleep(Duration::from_millis(60));
    let frozen = r.t.position();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(r.t.position(), frozen);
    r.t.resume();
    wait_until("moving again", 5, || r.t.position() > frozen + 0.15);
    assert_eq!(r.t.state(), MusicPlaybackState::Playing);
}

#[test]
fn seek_restarts_decoding_at_the_offset() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.load(Source::File(r.tone("a.wav", 4.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.1);
    r.t.seek(3.2).unwrap();
    let p = r.t.position();
    assert!((3.2..3.4).contains(&p), "position after seek {p}");
    let ev = r.wait_event(Duration::from_secs(5)).expect("ended");
    assert_eq!(ev.kind, FeedEvent::Ended);
    assert!(r.t.position() > 3.8);
}

#[test]
fn seeking_while_paused_stays_paused() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.load(Source::File(r.tone("a.wav", 4.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.1);
    r.t.pause();
    r.t.seek(2.0).unwrap();
    assert_eq!(r.t.state(), MusicPlaybackState::Paused);
    std::thread::sleep(Duration::from_millis(200));
    assert!((r.t.position() - 2.0).abs() < 0.05);
}

#[test]
fn mute_silences_the_output_and_unmute_restores_it() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.set_volume(1.0);
    r.t.set_muted(true);
    r.t.load(Source::File(r.tone("a.wav", 1.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.3);
    assert_eq!(r.out.peak(), 0.0, "muted");
    r.t.set_muted(false);
    wait_until("sound", 5, || r.out.peak() > 0.03);
}

#[test]
fn speed_shortens_the_wall_time_and_reports_source_seconds() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.set_speed(2.0).unwrap();
    r.t.load(Source::File(r.tone("a.wav", 4.0)), 0.0).unwrap();
    // Time from the first audible second: ffmpeg's own start-up is slow on some machines.
    wait_until("playing", 10, || r.t.position() > 0.3);
    let started = Instant::now();
    let p0 = r.t.position();
    let ev = r.wait_event(Duration::from_secs(8)).expect("ended");
    assert_eq!(ev.kind, FeedEvent::Ended);
    let took = started.elapsed().as_secs_f64();
    let covered = r.t.position() - p0;
    assert!(covered / took > 1.6, "covered {covered} source seconds in {took} s, expected about 2x");
    assert!((r.t.position() - 4.0).abs() < 0.3, "position {}", r.t.position());
}

#[test]
fn changing_speed_mid_track_continues_from_the_same_position() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.load(Source::File(r.tone("a.wav", 6.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.5);
    let before = r.t.position();
    r.t.set_speed(1.5).unwrap();
    let after = r.t.position();
    assert!(after >= before && after < before + 0.4, "{before} -> {after}");
}

#[test]
fn a_stream_cannot_seek_until_it_is_marked_cached() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    let tone = r.tone("a.wav", 3.0);
    let reader = std::fs::File::open(&tone).unwrap();
    let generation = r.t.load(stream(reader), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.2);
    assert!(r.t.is_stream() && !r.t.is_seekable());
    let e = r.t.seek(1.0).unwrap_err();
    assert_eq!(e.message, "Seeking is available once the track is cached");
    r.t.mark_seekable(generation, tone);
    assert!(r.t.is_seekable());
    r.t.seek(2.0).unwrap();
    assert!((2.0..2.3).contains(&r.t.position()));
}

#[test]
fn a_stale_mark_seekable_is_ignored() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    let a = r.tone("a.wav", 2.0);
    let g1 = r.t.load(stream(std::fs::File::open(&a).unwrap()), 0.0).unwrap();
    r.t.load(Source::File(r.tone("b.wav", 2.0)), 0.0).unwrap();
    r.t.mark_seekable(g1, a);
    assert!(!r.t.is_stream());
}

#[test]
fn undecodable_audio_fails_with_ffmpegs_message() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    let junk = r.dir.path().join("junk.m4a");
    std::fs::write(&junk, vec![0x41u8; 4096]).unwrap();
    let generation = r.t.load(Source::File(junk), 0.0).unwrap();
    let ev = r.wait_event(Duration::from_secs(5)).expect("failure");
    assert_eq!(ev.generation, generation);
    assert!(matches!(ev.kind, FeedEvent::Failed(ref m) if !m.is_empty()), "{ev:?}");
}

struct FailingReader(u8);

impl Read for FailingReader {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        if self.0 == 0 {
            return Err(std::io::Error::other("network dropped"));
        }
        self.0 -= 1;
        b[..4].copy_from_slice(b"RIFF");
        Ok(4)
    }
}

#[test]
fn a_stream_that_errors_fails_the_track_with_the_stream_message() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    r.t.load(stream(FailingReader(1)), 0.0).unwrap();
    let ev = r.wait_event(Duration::from_secs(5)).expect("failure");
    assert_eq!(ev.kind, FeedEvent::Failed("network dropped".into()));
}

#[test]
fn stop_unloads_and_a_late_event_of_the_old_source_is_not_current() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    let g = r.t.load(Source::File(r.tone("a.wav", 3.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.1);
    r.t.stop();
    assert_eq!(r.t.state(), MusicPlaybackState::Stopped);
    assert!(!r.t.is_loaded());
    assert_ne!(r.t.generation(), g);
    assert_eq!(r.t.position(), 0.0);
}

#[test]
fn loading_a_new_source_replaces_the_old_one() {
    let ff = need_ffmpeg!();
    let r = rig(&ff);
    let g1 = r.t.load(Source::File(r.tone("a.wav", 5.0)), 0.0).unwrap();
    wait_until("playing", 5, || r.t.position() > 0.1);
    let g2 = r.t.load(Source::File(r.tone("b.wav", 1.0)), 0.0).unwrap();
    assert!(g2 > g1);
    let ev = r.wait_event(Duration::from_secs(5)).expect("ended");
    assert_eq!(ev.generation, g2, "the replaced source never reports an end");
}
