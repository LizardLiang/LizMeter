//! Headless capture hooks for the music backend (`--do music-...`): they run with no window, print
//! one JSON line per observation, and make the process exit code the verdict.
//!
//! * `music-status`: yt-dlp / ffmpeg installed state.
//! * `music-download`: download yt-dlp and ffmpeg into `<data dir>/bin` (needs the network).
//! * `music-play:<file>`: play a local audio file through the sound device at volume 0.1, pausing,
//!   resuming and seeking on the way (about a second of quiet sound).
//! * `music-latency:<file>`: time from each call (play, seek, speed change, seek at that speed) to
//!   the first frame the device takes from the new source, at volume 0.1.

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
