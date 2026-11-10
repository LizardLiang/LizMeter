//! The music service end to end: a fake yt-dlp, a real ffmpeg, a silent sink and an in-memory
//! database. Covers what `music-ipc.ts` and `MusicPlayerContext.test.tsx` cover.
mod common;

use common::{fake_bin_dir, link_ffmpeg, pid_alive, read_args_log, read_pids, tone_m4a};
use lizmeter_core::{MusicErrorCode, MusicPlaybackState, MusicTrack, PlaylistAddTrackInput, RepeatMode};
use lizmeter_db::Database;
use lizmeter_music::{DbHandle, MusicEvent, MusicService, OutputKind};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const META: &str = r#"{"title":"Song {id}","uploader":"Artist","duration":3,"id":"{id}","extractor_key":"Youtube","webpage_url":"{url}","is_live":false}"#;

fn url(id: &str) -> String {
    format!("https://example.com/watch?v={id}")
}

struct Rig {
    root: tempfile::TempDir,
    bin: PathBuf,
    db: DbHandle,
    svc: Arc<MusicService>,
    events: Receiver<MusicEvent>,
}

/// `tone`: seconds of m4a audio the fake streams (`None`: no stream file).
fn rig_with(cfg: &[(&str, &str)], tone: Option<f64>, with_ffmpeg: bool) -> Option<Rig> {
    let ff = common::ffmpeg();
    if with_ffmpeg && ff.is_none() {
        eprintln!("SKIP: set LIZMETER_TEST_FFMPEG");
        return None;
    }
    let root = tempfile::tempdir().unwrap();
    let audio = match (&ff, tone) {
        (Some(f), Some(s)) => tone_m4a(f, s),
        _ => Vec::new(),
    };
    let mut full: Vec<(&str, &str)> = vec![("meta_file", "meta.json"), ("stream_file", "audio.m4a")];
    full.extend_from_slice(cfg);
    let bin = fake_bin_dir(root.path(), &full, &[("meta.json", META.as_bytes()), ("audio.m4a", &audio)]);
    if with_ffmpeg {
        link_ffmpeg(&bin, ff.as_ref().unwrap());
    }
    let db: DbHandle = Arc::new(Mutex::new(Database::open_in_memory().unwrap())).into();
    let svc = MusicService::new(root.path(), db.clone(), OutputKind::Null(44_100));
    let (tx, events) = channel();
    let tx = Mutex::new(tx);
    svc.set_listener(move |e| {
        let _ = tx.lock().unwrap().send(e);
    });
    Some(Rig { root, bin, db, svc, events })
}

macro_rules! rig {
    ($cfg:expr, $tone:expr) => {
        match rig_with($cfg, $tone, true) {
            Some(r) => r,
            None => return,
        }
    };
}

fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

fn wait_cached(r: &Rig, id: &str) {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match r.events.recv_timeout(left) {
            Ok(MusicEvent::Cached { track_id }) if track_id == id => return,
            Ok(_) => {}
            Err(_) => panic!("no Cached event for {id}"),
        }
    }
}

fn track_id_of(r: &Rig, u: &str) -> String {
    r.db.lock().unwrap().get_track_by_source_url(u).unwrap().expect("track row").id
}

fn stream_runs(r: &Rig) -> usize {
    read_args_log(&r.bin).iter().filter(|a| a.iter().any(|x| x == "-o")).count()
}

fn title_of(t: &Option<MusicTrack>) -> String {
    t.as_ref().map(|t| t.title.clone()).unwrap_or_default()
}

#[test]
fn a_streamed_track_plays_is_cached_and_then_plays_from_disk() {
    let r = rig!(&[], Some(3.0));
    let u = url("aaa");
    r.svc.play(&u, None).unwrap();
    let s = r.svc.snapshot();
    assert_eq!(title_of(&s.current_track), "Song aaa");
    assert_eq!((s.queue_length, s.current_index, s.is_bottom_bar_visible), (1, 0, true));
    assert!(!s.seekable, "a stream cannot seek until it is cached");
    wait_for("sound", 20, || r.svc.output().is_some_and(|o| o.peak() > 0.0));
    // A stream can dip into Buffering while ffmpeg waits for bytes; it settles on Playing.
    wait_for("playing", 10, || r.svc.snapshot().playback_state == MusicPlaybackState::Playing);

    let id = track_id_of(&r, &u);
    wait_cached(&r, &id);
    let row = r.db.lock().unwrap().get_track_by_id(&id).unwrap().unwrap();
    let cached = PathBuf::from(row.cached_file_path.clone().expect("cache path saved"));
    assert!(cached.exists() && cached.starts_with(r.root.path().join("music-cache")));
    assert_eq!(row.cache_size_bytes, Some(std::fs::metadata(&cached).unwrap().len() as i64));
    assert!(!cached.with_extension("m4a.tmp").exists());
    let s = r.svc.snapshot();
    assert!(s.seekable && s.current_track.unwrap().is_cached && s.queue[0].track.is_cached);
    r.svc.seek(1.0).unwrap();
    assert!((1.0..1.6).contains(&r.svc.snapshot().current_time));

    assert_eq!(stream_runs(&r), 1);
    r.svc.stop();
    r.svc.play(&u, None).unwrap();
    assert_eq!(stream_runs(&r), 1, "the second play reads the cache file");
    let s = r.svc.snapshot();
    assert!(s.seekable, "a cache file seeks at once");
    assert_eq!(r.db.lock().unwrap().get_track_by_id(&id).unwrap().unwrap().play_count, 2);
}

#[test]
fn a_live_stream_is_refused_and_the_player_is_left_as_it_was() {
    let r = rig!(&[], Some(3.0));
    std::fs::write(r.bin.join("meta.json"), r#"{"title":"Live","id":"x","webpage_url":"{url}","is_live":true}"#).unwrap();
    let e = r.svc.play(&url("live"), None).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::ExtractionFailed);
    assert_eq!(e.message, "Live streams are not supported. Please use a regular video or audio URL.");
    let s = r.svc.snapshot();
    assert_eq!((s.queue_length, s.playback_state, s.consecutive_failures), (0, MusicPlaybackState::Stopped, 1));
    assert_eq!(s.last_error.as_deref(), Some(e.message.as_str()));
    assert!(s.current_track.is_none() && !s.is_bottom_bar_visible);
}

#[test]
fn missing_binaries_are_reported_before_anything_runs() {
    let r = match rig_with(&[], None, false) {
        Some(r) => r,
        None => return,
    };
    std::fs::remove_file(r.bin.join("yt-dlp.exe")).unwrap();
    let e = r.svc.play(&url("aaa"), None).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (MusicErrorCode::BinaryMissing, "yt-dlp or ffmpeg is not installed"));
    let e = r.svc.play("not a url", None).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::InvalidUrl);
}

#[test]
fn a_newer_play_request_replaces_an_older_one_that_is_still_resolving() {
    let r = rig!(&[("slow_url", "slow")], Some(3.0));
    let svc = r.svc.clone();
    let slow = url("slow1");
    let first = std::thread::spawn(move || svc.play(&slow, None));
    std::thread::sleep(Duration::from_millis(400));
    r.svc.play(&url("fast1"), None).unwrap();
    first.join().unwrap().unwrap();
    let s = r.svc.snapshot();
    assert_eq!(title_of(&s.current_track), "Song fast1");
    assert_eq!(s.queue.iter().map(|i| i.track.title.clone()).collect::<Vec<_>>(), vec!["Song fast1"], "the stale request never reached the queue");
    assert_eq!(stream_runs(&r), 1, "the replaced request did not start a download");
}

fn queued(r: &Rig, ids: &[&str]) {
    // Library rows first (as the library view has them), then the queue items made from them.
    let tracks: Vec<MusicTrack> = ids
        .iter()
        .map(|i| {
            let m = r.svc.meta(&url(i)).unwrap().track;
            let db = r.db.lock().unwrap();
            db.upsert_track(&lizmeter_db::TrackUpsert {
                id: lizmeter_db::util::new_uuid(),
                source_url: m.source_url.clone(),
                source_id: m.source_id.clone(),
                source_site: m.source_site.clone(),
                title: m.title.clone(),
                artist: m.artist.clone(),
                duration_seconds: m.duration_seconds,
                thumbnail_url: None,
                cached_file_path: None,
                cache_size_bytes: None,
                added_at: None,
            })
            .unwrap()
            .to_renderer_track()
        })
        .collect();
    r.svc.enqueue_bulk(tracks, None);
}

#[test]
fn next_skips_past_failing_tracks_until_one_plays() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["ok0", "bad1", "bad2", "ok3"]);
    std::fs::write(r.bin.join("fake.cfg"), "meta_file=meta.json\nstream_file=audio.m4a\nfail_url=bad\n").unwrap();
    r.svc.jump_to(0);
    assert_eq!(r.svc.snapshot().current_index, 0);
    r.svc.next();
    let s = r.svc.snapshot();
    assert_eq!((s.current_index, title_of(&s.current_track)), (3, "Song ok3".to_string()));
    assert_eq!((s.consecutive_failures, s.last_error), (0, None), "a successful play resets the failure count");
}

#[test]
fn three_failures_in_a_row_stop_the_chain_and_keep_the_error() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["ok0", "bad1", "bad2", "bad3", "bad4"]);
    std::fs::write(r.bin.join("fake.cfg"), "meta_file=meta.json\nstream_file=audio.m4a\nfail_url=bad\n").unwrap();
    r.svc.jump_to(0);
    r.svc.next();
    let s = r.svc.snapshot();
    assert_eq!(s.playback_state, MusicPlaybackState::Stopped);
    assert_eq!(s.consecutive_failures, 3, "three attempts, not four");
    assert!(s.last_error.unwrap().starts_with("Metadata extraction failed"));
    assert_eq!(s.current_index, 3, "the chain stops on the last item it tried");
    // Only the setup lookup (queued) asked about bad4; the chain never reached it.
    assert_eq!(read_args_log(&r.bin).iter().filter(|a| a.iter().any(|x| x.contains("bad4"))).count(), 1);
}

#[test]
fn a_failed_jump_puts_the_previous_track_back() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["ok0", "bad1"]);
    std::fs::write(r.bin.join("fake.cfg"), "meta_file=meta.json\nstream_file=audio.m4a\nfail_url=bad\n").unwrap();
    r.svc.jump_to(0);
    r.svc.jump_to(1);
    let s = r.svc.snapshot();
    assert_eq!((s.current_index, title_of(&s.current_track)), (0, "Song ok0".to_string()));
    assert_eq!(s.playback_state, MusicPlaybackState::Playing, "playback resumes where it was");
    assert_eq!(s.consecutive_failures, 1);
}

#[test]
fn the_end_of_a_track_starts_the_next_and_the_end_of_the_queue_stops() {
    let r = rig!(&[], Some(1.0));
    std::fs::write(r.bin.join("meta.json"), META.replace("\"duration\":3", "\"duration\":1")).unwrap();
    queued(&r, &["e0", "e1"]);
    r.svc.jump_to(0);
    wait_for("second track", 40, || r.svc.snapshot().current_index == 1 && r.svc.snapshot().playback_state != MusicPlaybackState::Buffering);
    assert_eq!(title_of(&r.svc.snapshot().current_track), "Song e1");
    wait_for("stop at the end", 40, || r.svc.snapshot().playback_state == MusicPlaybackState::Stopped);
    assert_eq!(r.svc.snapshot().current_index, 1);
}

#[test]
fn repeat_one_replays_the_same_track_when_it_ends() {
    let r = rig!(&[], Some(1.0));
    std::fs::write(r.bin.join("meta.json"), META.replace("\"duration\":3", "\"duration\":1")).unwrap();
    queued(&r, &["r0", "r1"]);
    r.svc.set_repeat_mode(RepeatMode::One);
    r.svc.jump_to(0);
    let id = track_id_of(&r, &url("r0"));
    wait_for("replay", 60, || r.db.lock().unwrap().get_track_by_id(&id).unwrap().unwrap().play_count >= 2);
    assert_eq!(r.svc.snapshot().current_index, 0);
}

#[test]
fn removing_the_playing_track_from_the_queue_stops_it_and_advances_from_the_start_like_the_ts_context() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["d0", "d1", "d2"]);
    r.svc.jump_to(1);
    let id = track_id_of(&r, &url("d1"));
    r.svc.remove_track_from_queue(&id);
    let s = r.svc.snapshot();
    assert_eq!(s.queue_length, 2);
    // The TS context advances from index -1, so the first remaining item plays (not the one that
    // followed the removed track).
    assert_eq!((title_of(&s.current_track), s.current_index), ("Song d0".to_string(), 0));
}

#[test]
fn dequeuing_the_playing_item_stops_playback() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["q0", "q1"]);
    r.svc.jump_to(0);
    r.svc.dequeue_at(0);
    let s = r.svc.snapshot();
    assert_eq!((s.playback_state, s.current_index, s.queue_length), (MusicPlaybackState::Stopped, -1, 1));
    assert!(s.current_track.is_none());
}

#[test]
fn deleting_the_playing_library_track_frees_the_file_and_moves_on() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["l0", "l1"]);
    r.svc.jump_to(0);
    let id = track_id_of(&r, &url("l0"));
    wait_cached(&r, &id);
    let path = PathBuf::from(r.db.lock().unwrap().get_track_by_id(&id).unwrap().unwrap().cached_file_path.unwrap());
    r.svc.library_delete(&id).unwrap();
    assert!(!path.exists());
    assert!(r.db.lock().unwrap().get_track_by_id(&id).unwrap().is_none());
    let s = r.svc.snapshot();
    assert_eq!((title_of(&s.current_track), s.queue_length), ("Song l1".to_string(), 1));
    assert_eq!(r.svc.library_delete(&id).unwrap_err().code, MusicErrorCode::TrackNotFound);
}

#[test]
fn clearing_the_library_stops_everything_and_keeps_playlists_as_shells() {
    let r = rig!(&[], Some(3.0));
    queued(&r, &["c0"]);
    let id = r.db.lock().unwrap().get_track_by_source_url(&url("c0")).unwrap().unwrap().id;
    let pl = r.svc.playlist_create("Mix", &[id]).unwrap();
    assert_eq!(pl.track_count, 1);
    r.svc.jump_to(0);
    r.svc.library_clear().unwrap();
    let s = r.svc.snapshot();
    assert_eq!((s.queue_length, s.playback_state), (0, MusicPlaybackState::Stopped));
    assert_eq!(r.svc.library_list(&Default::default()).unwrap().total, 0);
    assert_eq!(r.svc.playlist_list().unwrap()[0].track_count, 0);
}

#[test]
fn a_damaged_cache_file_is_repaired_and_streamed_again() {
    let r = rig!(&[], Some(3.0));
    let u = url("dmg");
    r.svc.play(&u, None).unwrap();
    let id = track_id_of(&r, &u);
    wait_cached(&r, &id);
    r.svc.stop();
    let path = PathBuf::from(r.db.lock().unwrap().get_track_by_id(&id).unwrap().unwrap().cached_file_path.unwrap());
    std::fs::write(&path, vec![0x41u8; 4096]).unwrap();
    r.svc.play(&u, None).unwrap();
    assert_eq!(stream_runs(&r), 2, "the corrupt cache file was not played");
    wait_cached(&r, &id);
    assert!(std::fs::metadata(&path).unwrap().len() > 4096 || std::fs::read(&path).unwrap()[0] != 0x41);
}

#[test]
fn the_cache_limit_evicts_older_tracks_when_a_new_one_finishes() {
    let r = rig!(&[], Some(3.0));
    let a = url("ev1");
    r.svc.play(&a, None).unwrap();
    let ida = track_id_of(&r, &a);
    wait_cached(&r, &ida);
    r.svc.cache_set_limit(1).unwrap();
    let b = url("ev2");
    r.svc.play(&b, None).unwrap();
    let idb = track_id_of(&r, &b);
    wait_cached(&r, &idb);
    wait_for("eviction", 10, || r.db.lock().unwrap().get_track_by_id(&ida).unwrap().unwrap().cached_file_path.is_none());
    assert!(r.db.lock().unwrap().get_track_by_id(&idb).unwrap().unwrap().cached_file_path.is_some(), "the playing track is protected");
    assert_eq!(r.svc.cache_stats().unwrap().track_count, 1);
}

#[test]
fn stopping_kills_the_download_and_leaves_no_temp_file() {
    let r = rig!(&[("stream_mode", "hang")], Some(3.0));
    r.svc.play(&url("hang"), None).unwrap();
    wait_for("yt-dlp stream started", 10, || read_pids(&r.bin).iter().any(|(role, _)| role == "stream"));
    let pid = read_pids(&r.bin).into_iter().find(|(role, _)| role == "stream").unwrap().1;
    r.svc.stop();
    wait_for("yt-dlp gone", 10, || !pid_alive(pid));
    assert_eq!(r.svc.snapshot().playback_state, MusicPlaybackState::Stopped);
    let tmp: Vec<_> = std::fs::read_dir(r.root.path().join("music-cache")).unwrap().flatten().collect();
    wait_for("temp file removed", 10, || std::fs::read_dir(r.root.path().join("music-cache")).unwrap().flatten().count() == 0);
    let _ = tmp;
}

#[test]
fn a_playlist_url_queues_the_rest_and_plays_the_first() {
    let lines: String = (1..=3).map(|i| format!("{{\"id\":\"p{i}\",\"title\":\"P{i}\",\"url\":\"{}\",\"ie_key\":\"Youtube\"}}\n", url(&format!("p{i}")))).collect();
    let r = rig!(&[("playlist_file", "list.ndjson")], Some(3.0));
    std::fs::write(r.bin.join("list.ndjson"), lines).unwrap();
    r.svc.play("https://example.com/playlist?list=PL1", None).unwrap();
    let s = r.svc.snapshot();
    assert_eq!(s.queue.iter().map(|i| i.track.source_url.clone()).collect::<Vec<_>>(), vec![url("p1"), url("p2"), url("p3")]);
    assert_eq!((s.current_index, title_of(&s.current_track)), (0, "Song p1".to_string()));
    let mut saw_done = false;
    let mut imported = 0;
    while let Ok(e) = r.events.try_recv() {
        match e {
            MusicEvent::ImportProgress(p) if p.total == Some(3) => saw_done = true,
            MusicEvent::PlaylistImported(t) => imported = t.len(),
            _ => {}
        }
    }
    assert!(saw_done && imported == 2);
    assert!(r.svc.snapshot().import_progress.is_some());
}

#[test]
fn volume_mute_speed_shuffle_and_repeat_survive_a_restart() {
    let r = match rig_with(&[], None, false) {
        Some(r) => r,
        None => return,
    };
    assert_eq!(r.svc.snapshot().volume, 0.3, "the default volume");
    r.svc.set_volume(0.2);
    r.svc.set_muted(true);
    r.svc.set_playback_speed(1.5).unwrap();
    r.svc.set_shuffle_enabled(true);
    r.svc.set_repeat_mode(RepeatMode::Queue);
    assert!(r.svc.set_playback_speed(0.0).is_err());
    let again = MusicService::new(r.root.path(), r.db.clone(), OutputKind::Null(44_100));
    let s = again.snapshot();
    assert_eq!((s.volume, s.muted, s.playback_speed, s.shuffle_enabled, s.repeat_mode), (0.2, true, 1.5, true, RepeatMode::Queue));
    r.svc.set_volume(7.0);
    assert_eq!(r.svc.snapshot().volume, 1.0, "volume is clamped");
}

#[test]
fn playlists_follow_the_ipc_rules_and_error_codes() {
    let r = match rig_with(&[], None, false) {
        Some(r) => r,
        None => return,
    };
    let svc = &r.svc;
    assert!(svc.playlist_create("   ", &[]).is_err());
    let a = svc.playlist_create("  Road trip ", &["missing".to_string()]).unwrap();
    assert_eq!((a.name.as_str(), a.track_count), ("Road trip", 0));
    // Two library tracks.
    {
        let db = r.db.lock().unwrap();
        for id in ["t1", "t2"] {
            db.upsert_track(&lizmeter_db::TrackUpsert {
                id: id.into(),
                source_url: format!("https://x/{id}"),
                source_id: id.into(),
                source_site: "youtube".into(),
                title: id.into(),
                artist: None,
                duration_seconds: None,
                thumbnail_url: None,
                cached_file_path: None,
                cache_size_bytes: None,
                added_at: None,
            })
            .unwrap();
        }
    }
    let e1 = svc.playlist_add_track(&PlaylistAddTrackInput { playlist_id: a.id, track_id: Some("t1".into()), url: None }).unwrap();
    let e2 = svc.playlist_add_track(&PlaylistAddTrackInput { playlist_id: a.id, track_id: Some("t2".into()), url: None }).unwrap();
    assert_eq!((e1.position, e2.position), (0, 1));
    svc.playlist_reorder(a.id, e2.id, 0).unwrap();
    let order: Vec<_> = svc.playlist_tracks(a.id).unwrap().into_iter().map(|t| t.track_id).collect();
    assert_eq!(order, vec!["t2", "t1"]);

    let missing = svc.playlist_add_track(&PlaylistAddTrackInput { playlist_id: a.id, track_id: Some("nope".into()), url: None }).unwrap_err();
    assert_eq!((missing.code, missing.message.as_str()), (MusicErrorCode::TrackNotFound, "Track not found: nope"));
    let no_pl = svc.playlist_add_track(&PlaylistAddTrackInput { playlist_id: 999, track_id: Some("t1".into()), url: None }).unwrap_err();
    assert_eq!((no_pl.code, no_pl.message.as_str()), (MusicErrorCode::PlaylistNotFound, "Playlist not found: 999"));
    let neither = svc.playlist_add_track(&PlaylistAddTrackInput { playlist_id: a.id, track_id: None, url: None }).unwrap_err();
    assert_eq!(neither.message, "Invalid playlist add-track input: must provide trackId or url");
    assert_eq!(svc.playlist_tracks(999).unwrap_err().code, MusicErrorCode::PlaylistNotFound);
    assert_eq!(svc.playlist_rename(999, "x").unwrap_err().code, MusicErrorCode::PlaylistNotFound);
    assert_eq!(svc.playlist_delete(999).unwrap_err().code, MusicErrorCode::PlaylistNotFound);
    assert_eq!(svc.playlist_remove_track(999).unwrap_err().code, MusicErrorCode::TrackNotFound);

    svc.playlist_rename(a.id, "Renamed").unwrap();
    svc.playlist_remove_track(e1.id).unwrap();
    assert_eq!(svc.playlist_list().unwrap()[0].name, "Renamed");
    assert_eq!(svc.playlist_list().unwrap()[0].track_count, 1);
    svc.playlist_delete(a.id).unwrap();
    assert!(svc.playlist_list().unwrap().is_empty());
}

#[test]
fn meta_returns_a_transient_track_and_the_binaries_gate_it() {
    let r = match rig_with(&[], None, false) {
        Some(r) => r,
        None => return,
    };
    let m = r.svc.meta(&url("zzz")).unwrap().track;
    assert_eq!((m.title.as_str(), m.is_cached, m.play_count), ("Song zzz", false, 0));
    assert!(r.db.lock().unwrap().get_track_by_source_url(&url("zzz")).unwrap().is_none(), "meta does not save the track");
    std::fs::remove_file(r.bin.join("yt-dlp.exe")).unwrap();
    r.svc.bins.reset_cache();
    assert_eq!(r.svc.meta(&url("zzz")).unwrap_err().code, MusicErrorCode::BinaryMissing);
}

#[test]
fn reset_clears_the_cache_and_can_delete_the_binaries() {
    let r = rig!(&[], Some(3.0));
    let u = url("rst");
    r.svc.play(&u, None).unwrap();
    let id = track_id_of(&r, &u);
    wait_cached(&r, &id);
    r.svc.reset(false).unwrap();
    assert_eq!(r.svc.cache_stats().unwrap().track_count, 0);
    assert!(r.bin.join("yt-dlp.exe").exists());
    assert_eq!(r.svc.snapshot().playback_state, MusicPlaybackState::Stopped);
    r.svc.reset(true).unwrap();
    assert!(!r.bin.exists());
    assert!(!r.svc.binary_status().yt_dlp_installed);
}

#[test]
fn the_local_file_hook_plays_without_the_database() {
    let ff = match common::ffmpeg() {
        Some(f) => f,
        None => return,
    };
    let r = rig!(&[], None);
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("tone.wav");
    common::make_tone(&ff, &f, 1.5, 440);
    r.svc.set_volume(0.1);
    r.svc.play_local_file(&f).unwrap();
    wait_for("sound", 20, || r.svc.output().is_some_and(|o| o.peak() > 0.0));
    let peak = r.svc.output().unwrap().peak();
    assert!(peak <= 0.1 * 0.125 + 0.001, "volume 0.1 keeps the output quiet: {peak}");
    assert_eq!(title_of(&r.svc.snapshot().current_track), "tone.wav");
    assert_eq!(r.svc.library_list(&Default::default()).unwrap().total, 0);
}
