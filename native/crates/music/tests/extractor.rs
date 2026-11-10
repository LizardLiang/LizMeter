//! `audio-extractor.ts` against the fake yt-dlp: metadata, playlist detection and import, and
//! the audio stream with its Opus fallback.
mod common;

use common::{fake_bin_dir, pid_alive, read_args_log, read_pids};
use lizmeter_core::MusicErrorCode;
use lizmeter_music::binaries::BinaryManager;
use lizmeter_music::extractor::{parse_yt_dlp_json, AudioStream, Extractor};
use lizmeter_music::process::ProcessManager;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Rig {
    _root: tempfile::TempDir,
    bin: PathBuf,
    ex: Extractor,
    pm: Arc<ProcessManager>,
}

fn rig(cfg: &[(&str, &str)], files: &[(&str, &[u8])]) -> Rig {
    let root = tempfile::tempdir().unwrap();
    let bin = fake_bin_dir(root.path(), cfg, files);
    let bins = Arc::new(BinaryManager::new(root.path()));
    let pm = Arc::new(ProcessManager::new(bins.yt_dlp_path()));
    let ex = Extractor::new(pm.clone(), bins);
    Rig { _root: root, bin, ex, pm }
}

const META: &str = r#"{"title":"Song","uploader":"Artist","duration":212.6,"thumbnail":"https://img/x.jpg","id":"abc","extractor_key":"Youtube","webpage_url":"https://www.youtube.com/watch?v=abc","is_live":false}"#;
const URL: &str = "https://www.youtube.com/watch?v=abc";

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn parses_metadata_with_the_same_fallbacks_as_the_ts_code() {
    let m = parse_yt_dlp_json(META, "https://input").unwrap();
    assert_eq!((m.title.as_str(), m.artist.as_deref(), m.duration_seconds), ("Song", Some("Artist"), Some(213.0)));
    assert_eq!((m.source_site.as_str(), m.source_id.as_str(), m.is_live), ("youtube", "abc", false));
    assert_eq!(m.source_url, "https://www.youtube.com/watch?v=abc");

    let bare = parse_yt_dlp_json("{}", "https://input").unwrap();
    assert_eq!(bare.title, "Unknown title");
    assert_eq!((bare.artist, bare.duration_seconds, bare.thumbnail_url), (None, None, None));
    assert_eq!((bare.source_site.as_str(), bare.source_url.as_str()), ("unknown", "https://input"));

    let chan = parse_yt_dlp_json(r#"{"uploader":"","channel":"Chan","extractor":"generic","is_live":true}"#, "u").unwrap();
    assert_eq!((chan.artist.as_deref(), chan.source_site.as_str(), chan.is_live), (Some("Chan"), "generic", true));

    assert_eq!(parse_yt_dlp_json("not json", "u").unwrap_err().code, MusicErrorCode::ExtractionFailed);
}

#[test]
fn rounds_half_up_like_math_round() {
    assert_eq!(parse_yt_dlp_json(r#"{"duration":10.5}"#, "u").unwrap().duration_seconds, Some(11.0));
    assert_eq!(parse_yt_dlp_json(r#"{"duration":10.4}"#, "u").unwrap().duration_seconds, Some(10.0));
}

#[test]
fn extract_metadata_runs_dump_json_and_returns_the_parsed_track() {
    let r = rig(&[("meta_file", "meta.json")], &[("meta.json", META.as_bytes())]);
    let m = r.ex.extract_metadata(URL).unwrap();
    assert_eq!(m.title, "Song");
    assert_eq!(read_args_log(&r.bin)[0], vec!["--no-playlist", "--dump-json", "--no-download", URL]);
}

#[test]
fn extract_metadata_failures() {
    let r = rig(&[("meta_exit", "1"), ("stderr_msg", "ERROR: Video unavailable")], &[]);
    let e = r.ex.extract_metadata(URL).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::ExtractionFailed);
    assert_eq!(e.message, "Metadata extraction failed: ERROR: Video unavailable");

    let r = rig(&[("meta_file", "meta.json")], &[("meta.json", b"  ")]);
    assert_eq!(r.ex.extract_metadata(URL).unwrap_err().message, "yt-dlp produced no output for metadata extraction");

    let r = rig(&[], &[]);
    let e = r.ex.extract_metadata("not a url").unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (MusicErrorCode::InvalidUrl, "Invalid URL: not a url"));
}

#[test]
fn detect_playlist_needs_two_entries_and_treats_errors_as_single() {
    let three = "{\"id\":\"1\"}\n{\"id\":\"2\"}\n{\"id\":\"3\"}\n";
    let r = rig(&[("playlist_file", "p.ndjson")], &[("p.ndjson", three.as_bytes())]);
    assert!(r.ex.detect_playlist("https://www.youtube.com/playlist?list=PL1"));
    let log = read_args_log(&r.bin);
    assert_eq!(
        log[0],
        vec!["--flat-playlist", "--dump-json", "--playlist-items", "1:2", "https://www.youtube.com/playlist?list=PL1"],
        "no --no-playlist for a playlist command"
    );

    let one = rig(&[("playlist_file", "p.ndjson")], &[("p.ndjson", b"{\"id\":\"1\"}\n")]);
    assert!(!one.ex.detect_playlist(URL));
    assert!(!one.ex.detect_playlist("garbage"));
}

fn playlist_lines(n: usize) -> String {
    (1..=n)
        .map(|i| format!("{{\"id\":\"v{i}\",\"title\":\"T{i}\",\"url\":\"https://y/v{i}\",\"ie_key\":\"Youtube\",\"duration\":60}}\n"))
        .collect()
}

#[test]
fn playlist_import_reports_each_entry_and_honours_cancel() {
    let lines = playlist_lines(5);
    let r = rig(&[("playlist_file", "p.ndjson")], &[("p.ndjson", lines.as_bytes())]);
    let mut seen = Vec::new();
    let n = r
        .ex
        .extract_playlist_metadata("https://y/pl", &mut |m, i| seen.push((i, m.title, m.source_url, m.source_site)), Arc::new(AtomicBool::new(false)))
        .unwrap();
    assert_eq!(n, 5);
    assert_eq!(seen[0], (0, "T1".to_string(), "https://y/v1".to_string(), "youtube".to_string()));
    assert_eq!(seen[4].0, 4);

    // Cancel after the second entry: the fake emits one entry per 100 ms and then keeps running.
    let r = rig(&[("playlist_file", "p.ndjson"), ("chunk_delay_ms", "100"), ("hang_after_playlist", "1")], &[("p.ndjson", lines.as_bytes())]);
    let cancel = Arc::new(AtomicBool::new(false));
    let c2 = cancel.clone();
    let n = r
        .ex
        .extract_playlist_metadata(
            "https://y/pl",
            &mut |_, i| {
                if i == 1 {
                    c2.store(true, Ordering::SeqCst);
                }
            },
            cancel,
        )
        .unwrap();
    assert!((2..5).contains(&n), "stopped early: {n}");
    wait_until("yt-dlp stopped", || r.pm.active_count() == 0);
}

#[test]
fn playlist_import_stops_at_the_500_track_cap() {
    let lines = playlist_lines(520);
    let r = rig(&[("playlist_file", "p.ndjson")], &[("p.ndjson", lines.as_bytes())]);
    let n = r.ex.extract_playlist_metadata("https://y/pl", &mut |_, _| {}, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(n, 500);
}

fn read_stream(mut s: AudioStream) -> Result<Vec<u8>, std::io::Error> {
    let mut out = Vec::new();
    s.read_to_end(&mut out)?;
    Ok(out)
}

#[test]
fn the_audio_stream_carries_the_bytes_yt_dlp_writes() {
    let payload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let r = rig(&[("stream_file", "a.bin")], &[("a.bin", &payload)]);
    let got = read_stream(r.ex.extract_audio(URL).unwrap()).unwrap();
    assert_eq!(got, payload);
    let log = read_args_log(&r.bin);
    assert_eq!(log[0][0], "--no-playlist");
    assert_eq!(&log[0][1..5], ["-f", "bestaudio[ext=m4a]/bestaudio", "--audio-format", "m4a"]);
    assert_eq!(&log[0][5..6], ["--ffmpeg-location"]);
    assert_eq!(&log[0][7..], ["-o", "-", URL]);
}

#[test]
fn m4a_failure_before_any_byte_falls_back_to_opus() {
    let r = rig(&[("stream_mode", "fail-m4a"), ("stream_file", "a.bin")], &[("a.bin", b"opus-bytes")]);
    let got = read_stream(r.ex.extract_audio(URL).unwrap()).unwrap();
    assert_eq!(got, b"opus-bytes");
    let log = read_args_log(&r.bin);
    assert_eq!(log.len(), 2);
    assert!(log[1].windows(2).any(|w| w == ["-f", "bestaudio"]));
    assert!(log[1].windows(2).any(|w| w == ["--audio-format", "opus"]));
}

#[test]
fn when_both_formats_fail_the_stream_errors_with_format_error() {
    let r = rig(&[("stream_mode", "fail")], &[]);
    let e = read_stream(r.ex.extract_audio(URL).unwrap()).unwrap_err();
    let me = AudioStream::error_of(&e).expect("a MusicError");
    assert_eq!(me.code, MusicErrorCode::FormatError);
    assert_eq!(me.message, "Audio extraction failed: stream failed");
}

#[test]
fn a_failure_after_bytes_went_out_is_an_error_not_a_second_format_spliced_on() {
    let r = rig(&[("stream_mode", "partial-fail"), ("stream_file", "a.bin")], &[("a.bin", b"first-bytes")]);
    let e = read_stream(r.ex.extract_audio(URL).unwrap()).unwrap_err();
    assert_eq!(AudioStream::error_of(&e).unwrap().code, MusicErrorCode::FormatError);
    assert_eq!(read_args_log(&r.bin).len(), 1, "no opus retry after output started");
}

#[test]
fn dropping_the_stream_stops_yt_dlp() {
    let r = rig(&[("stream_mode", "hang")], &[]);
    let s = r.ex.extract_audio(URL).unwrap();
    wait_until("process started", || !read_pids(&r.bin).is_empty());
    let pid = read_pids(&r.bin)[0].1;
    assert!(pid_alive(pid));
    drop(s);
    wait_until("process gone", || !pid_alive(pid));
    assert_eq!(r.pm.active_count(), 0);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(read_args_log(&r.bin).len(), 1, "a stopped stream does not start the Opus fallback");
}

#[test]
fn killing_the_stream_process_from_outside_ends_the_stream_with_an_error() {
    let r = rig(&[("stream_mode", "hang")], &[]);
    let s = r.ex.extract_audio(URL).unwrap();
    wait_until("process started", || r.pm.active_count() == 1);
    r.pm.kill_by_prefix("stream:");
    let e = read_stream(s).unwrap_err();
    assert!(AudioStream::error_of(&e).unwrap().message.contains("stopped"));
    assert_eq!(read_args_log(&r.bin).len(), 1);
}
