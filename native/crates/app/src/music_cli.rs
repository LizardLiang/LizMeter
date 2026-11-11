//! Headless capture hooks for the music backend (`--do music-...`): they run with no window, print
//! one JSON line per observation, and make the process exit code the verdict.
//!
//! * `music-status`: yt-dlp / ffmpeg installed state.
//! * `music-download`: download yt-dlp and ffmpeg into `<data dir>/bin` (needs the network).
//! * `music-play:<file>`: play a local audio file through the sound device at volume 0.1, pausing,
//!   resuming and seeking on the way (about a second of quiet sound).
//! * `music-library-play`: play the first cached library track through the service (the path the
//!   Music page takes), print the state for 2 s at volume 0.1, then stop.
//! * `music-latency:<file>`: time from each call (play, seek, speed change, seek at that speed) to
//!   the first frame the device takes from the new source, at volume 0.1.
//! * `music-url:<url>`: play a YouTube URL as the Music page does (yt-dlp extraction, stream, cache),
//!   at volume 0.1, until the track is cached; then play it again from the cache. Needs the network
//!   and yt-dlp / ffmpeg in `<data dir>/bin`.

use lizmeter_music::{MusicEvent, MusicService};
use lizmeter_services::Services;
use std::path::Path;
use std::time::{Duration, Instant};

/// Runs the music ops in `ops`. Returns the exit code, or `None` when there were none.
pub fn run(svc: &Services, ops: &[String]) -> Option<i32> {
    let mut ran = false;
    let mut code = 0;
    for op in ops {
        let result = if op == "music-status" {
            ran = true;
            status(svc.music())
        } else if op == "music-download" {
            ran = true;
            download(svc.music())
        } else if let Some(file) = op.strip_prefix("music-play:") {
            ran = true;
            play(svc.music(), Path::new(file))
        } else if op == "music-library-play" {
            ran = true;
            library_play(svc.music())
        } else if let Some(url) = op.strip_prefix("music-url:") {
            ran = true;
            url_play(svc.music(), url)
        } else if let Some(file) = op.strip_prefix("music-latency:") {
            ran = true;
            latency(svc.music(), Path::new(file))
        } else {
            continue;
        };
        if let Err(e) = result {
            println!("{}", serde_json::json!({ "op": op, "error": e }));
            code = 1;
        }
    }
    ran.then_some(code)
}

fn line(op: &str, v: serde_json::Value) {
    println!("{}", serde_json::json!({ "op": op, "result": v }));
}

fn status(m: &MusicService) -> Result<(), String> {
    line("music-status", serde_json::to_value(m.binary_status()).map_err(|e| e.to_string())?);
    Ok(())
}

fn download(m: &MusicService) -> Result<(), String> {
    let last = std::sync::Mutex::new((String::new(), -1.0f64));
    m.set_listener(move |e| {
        if let MusicEvent::BinaryDownloadProgress(p) = e {
            let mut last = last.lock().unwrap();
            if p.binary != last.0 || p.percent - last.1 >= 10.0 || p.percent == 100.0 {
                println!("{}", serde_json::json!({ "op": "music-download", "progress": p }));
                *last = (p.binary.clone(), p.percent);
            }
        }
    });
    m.download_binaries().map_err(|e| format!("{} ({})", e.message, e.code_str()))?;
    status(m)
}

fn play(m: &MusicService, file: &Path) -> Result<(), String> {
    let snap = |label: &str, m: &MusicService| {
        let s = m.snapshot();
        println!(
            "{}",
            serde_json::json!({ "op": "music-play", "at": label, "state": s.playback_state, "time": (s.current_time * 1000.0).round() / 1000.0, "volume": s.volume, "title": s.current_track.map(|t| t.title) })
        );
        s.current_time
    };
    m.set_volume(0.1);
    m.play_local_file(file).map_err(|e| e.message)?;
    let started = Instant::now();
    // ffmpeg takes a moment to start: wait for the first audible frames.
    while m.snapshot().current_time < 0.3 {
        if started.elapsed() > Duration::from_secs(20) {
            return Err("no audio frames were played within 20 s".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let t1 = snap("playing", m);
    m.pause();
    std::thread::sleep(Duration::from_millis(80));
    let p1 = snap("paused", m);
    std::thread::sleep(Duration::from_millis(300));
    let p2 = snap("still paused", m);
    if (p2 - p1).abs() > 0.001 {
        return Err("the position moved while paused".into());
    }
    m.resume();
    std::thread::sleep(Duration::from_millis(300));
    let t2 = snap("resumed", m);
    if t2 <= p2 {
        return Err("the position did not advance after resume".into());
    }
    m.seek(0.1).map_err(|e| e.message)?;
    let after = snap("seeked", m);
    if !(0.1..0.9).contains(&after) {
        return Err(format!("seek to 0.1 s landed at {after} s"));
    }
    std::thread::sleep(Duration::from_millis(300));
    snap("after seek", m);
    m.stop();
    snap("stopped", m);
    let _ = t1;
    Ok(())
}

/// Milliseconds from `action` to the first frame the device takes from the source it started.
fn first_frame_ms(m: &MusicService, label: &str, action: impl FnOnce() -> Result<(), String>) -> Result<f64, String> {
    // The sink exists once something has played.
    let before = m.output().and_then(|o| o.current_feed());
    let t0 = Instant::now();
    action()?;
    loop {
        let feed = m.output().and_then(|o| o.current_feed());
        let fresh = match (&feed, &before) {
            (Some(f), Some(b)) => !std::sync::Arc::ptr_eq(f, b),
            (Some(_), None) => true,
            _ => false,
        };
        if fresh && feed.as_ref().is_some_and(|f| f.played_frames() > 0) {
            break;
        }
        if t0.elapsed() > Duration::from_secs(10) {
            let state = feed.map(|f| format!("played {} queued {} paused {} closed {} buffering {}", f.played_frames(), f.queued_frames(), f.is_paused(), f.is_closed(), f.is_buffering()));
            return Err(format!("{label}: no frame reached the device within 10 s ({}; {:?})", state.unwrap_or_else(|| "no feed".into()), m.snapshot().playback_state));
        }
        std::thread::sleep(Duration::from_micros(500));
    }
    let ms = (t0.elapsed().as_secs_f64() * 10_000.0).round() / 10.0;
    println!(
        "{}",
        serde_json::json!({ "op": "music-latency", "step": label, "ms": ms, "native_decode": m.is_native_decode(), "position": m.snapshot().current_time })
    );
    Ok(ms)
}

fn latency(m: &MusicService, file: &Path) -> Result<(), String> {
    m.set_volume(0.1);
    // The saved speed carries over between runs; the speed step needs to start from normal speed.
    m.set_playback_speed(1.0).map_err(|e| e.message)?;
    first_frame_ms(m, "play", || m.play_local_file(file).map_err(|e| e.message))?;
    std::thread::sleep(Duration::from_millis(400));
    first_frame_ms(m, "seek to 1.0 s", || m.seek(1.0).map_err(|e| e.message))?;
    std::thread::sleep(Duration::from_millis(400));
    first_frame_ms(m, "speed 1.5", || m.set_playback_speed(1.5).map_err(|e| e.message))?;
    std::thread::sleep(Duration::from_millis(400));
    first_frame_ms(m, "seek to 0.5 s at 1.5x", || m.seek(0.5).map_err(|e| e.message))?;
    std::thread::sleep(Duration::from_millis(300));
    m.stop();
    Ok(())
}

fn library_play(m: &MusicService) -> Result<(), String> {
    m.set_volume(0.1);
    let input = lizmeter_core::MusicLibraryListInput { cached_only: Some(true), limit: Some(1), ..Default::default() };
    let track = m.library_list(&input).map_err(|e| e.message)?.tracks.into_iter().next().ok_or("no cached track in the library")?;
    // The app checks the binaries and opens the sound device once at start, in the background; the
    // timed play below starts after that.
    let warm = Instant::now();
    m.warm_up();
    let warm_ms = warm.elapsed().as_millis();
    let started = Instant::now();
    let url = track.source_url.clone();
    // The play call itself, then the first frame the device takes: both from the same start.
    let returned = m.play(&url, Some(track)).map(|_| started.elapsed()).map_err(|e| e.message)?;
    let mut first_frame = None;
    while started.elapsed() < Duration::from_millis(3000) {
        if first_frame.is_none() && m.output().and_then(|o| o.current_feed()).is_some_and(|f| f.played_frames() > 0) {
            first_frame = Some(started.elapsed());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let snap = m.snapshot();
    println!(
        "{}",
        serde_json::json!({
            "op": "music-library-play",
            "warm_up_ms": warm_ms,
            "play_returned_ms": returned.as_millis(),
            "first_frame_ms": first_frame.map(|d| d.as_millis()),
            "state": snap.playback_state,
            "time": snap.current_time,
            "native_decode": m.is_native_decode(),
        })
    );
    m.stop();
    first_frame.map(|_| ()).ok_or_else(|| "no frame reached the device".to_string())
}

/// Streams `url` until its track is cached (at most 180 s), then plays the cached copy (up to 10 s after `play` returns).
fn url_play(m: &MusicService, url: &str) -> Result<(), String> {
    m.set_volume(0.1);
    m.set_playback_speed(1.0).map_err(|e| e.message)?;
    let cached = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let sink = cached.clone();
    m.set_listener(move |e| {
        if let MusicEvent::Cached { track_id } = e {
            *sink.lock().unwrap() = Some(track_id);
        }
    });
    let started = Instant::now();
    let result = m.play(url, None).map_err(|e| format!("{} ({})", e.message, e.code_str()))?;
    let returned_ms = started.elapsed().as_millis();
    let mut first_frame = None;
    let mut last_print = Instant::now();
    while started.elapsed() < Duration::from_secs(180) && cached.lock().unwrap().is_none() {
        if first_frame.is_none() && m.output().and_then(|o| o.current_feed()).is_some_and(|f| f.played_frames() > 0) {
            first_frame = Some(started.elapsed().as_millis());
        }
        if last_print.elapsed() >= Duration::from_secs(5) {
            let s = m.snapshot();
            println!("{}", serde_json::json!({ "op": "music-url", "at_ms": started.elapsed().as_millis(), "state": s.playback_state, "time": s.current_time, "buffered": s.buffered, "error": s.last_error }));
            last_print = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let s = m.snapshot();
    let track = s.current_track.clone();
    println!(
        "{}",
        serde_json::json!({
            "op": "music-url",
            "step": "stream",
            "play_returned_ms": returned_ms,
            "from_cache": result.as_ref().map(|r| r.from_cache),
            "first_frame_ms": first_frame,
            "cached_after_ms": cached.lock().unwrap().as_ref().map(|_| started.elapsed().as_millis()),
            "title": track.as_ref().map(|t| t.title.clone()),
            "duration": s.duration,
            "state": s.playback_state,
            "error": s.last_error,
        })
    );
    m.stop();
    let track_id = cached.lock().unwrap().clone().ok_or("the track was not cached within 180 s")?;
    first_frame.ok_or("no streamed frame reached the device")?;
    // The second play must come from the cache, decoded in-process.
    let input = lizmeter_core::MusicLibraryListInput { cached_only: Some(true), ..Default::default() };
    let entry = m.library_list(&input).map_err(|e| e.message)?.tracks.into_iter().find(|t| t.id == track_id).ok_or("the cached track is missing from the library")?;
    let again = Instant::now();
    let source = entry.source_url.clone();
    let replay = m.play(&source, Some(entry)).map_err(|e| e.message)?;
    let replay_returned_ms = again.elapsed().as_millis();
    let waited = Instant::now();
    let mut replay_frame = None;
    while replay_frame.is_none() && waited.elapsed() < Duration::from_secs(10) {
        if m.output().and_then(|o| o.current_feed()).is_some_and(|f| f.played_frames() > 0) {
            replay_frame = Some(again.elapsed().as_millis());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let s = m.snapshot();
    println!(
        "{}",
        serde_json::json!({
            "op": "music-url",
            "step": "replay from cache",
            "from_cache": replay.as_ref().map(|r| r.from_cache),
            "play_returned_ms": replay_returned_ms,
            "feed": m.output().and_then(|o| o.current_feed()).map(|f| f.played_frames()),
            "native_decode": m.is_native_decode(),
            "first_frame_ms": replay_frame,
            "state": s.playback_state,
            "time": s.current_time,
        })
    );
    m.stop();
    replay_frame.map(|_| ()).ok_or_else(|| "no cached frame reached the device".to_string())
}
