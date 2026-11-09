//! Port of `music-library.test.ts` and `claude-code-database.test.ts`, plus coverage for the
//! music/nvim/settings functions of `database.ts` that had no dedicated TypeScript test.

use lizmeter_core::{
    ClaudeCodeIdlePeriod, ClaudeCodeSessionData, ListSessionsInput, MusicLibraryListInput, MusicSortDir,
    MusicSortField, PlaylistSource, SaveSessionInput, SaveSessionWithTrackingInput, TimerType,
};
use lizmeter_db::{Database, TrackUpsert};

fn db() -> Database {
    Database::open_in_memory().unwrap()
}

fn track(db: &Database, id: &str, url: &str) -> lizmeter_db::InternalTrackRecord {
    db.upsert_track(&TrackUpsert {
        id: id.into(),
        source_url: url.into(),
        source_id: id.into(),
        source_site: "youtube".into(),
        title: format!("Track {id}"),
        artist: None,
        duration_seconds: Some(180.0),
        thumbnail_url: None,
        cached_file_path: Some(format!("/cache/{id}.m4a")),
        cache_size_bytes: Some(1024),
        added_at: Some(lizmeter_db::util::now_iso()),
    })
    .unwrap()
}

fn playlist(db: &Database, name: &str) -> i64 {
    db.create_playlist(name, PlaylistSource::UserCreated).unwrap().id
}

fn total(db: &Database) -> i64 {
    db.list_music_tracks(&MusicLibraryListInput::default()).unwrap().total
}

// --- music-library.test.ts ---

#[test]
fn delete_all_tracks_removes_every_row() {
    let db = db();
    track(&db, "t1", "https://example.com/t1");
    track(&db, "t2", "https://example.com/t2");
    assert_eq!(total(&db), 2);
    db.delete_all_tracks().unwrap();
    assert_eq!(total(&db), 0);
    assert!(db.get_track_by_id("t1").unwrap().is_none());
    assert!(db.get_track_by_id("t2").unwrap().is_none());
}

#[test]
fn delete_all_tracks_cascades_but_leaves_empty_playlists() {
    let db = db();
    track(&db, "t1", "https://example.com/t1");
    track(&db, "t2", "https://example.com/t2");
    let id = playlist(&db, "My Mix");
    db.add_track_to_playlist(id, "t1").unwrap();
    db.add_track_to_playlist(id, "t2").unwrap();
    assert_eq!(db.get_playlist_by_id(id).unwrap().unwrap().track_count, 2);
    db.delete_all_tracks().unwrap();
    let after = db.get_playlist_by_id(id).unwrap().unwrap();
    assert_eq!((after.track_count, after.name.as_str()), (0, "My Mix"));
}

#[test]
fn delete_all_tracks_is_noop_when_empty() {
    let db = db();
    db.delete_all_tracks().unwrap();
    assert_eq!(total(&db), 0);
}

#[test]
fn delete_track_removes_only_that_track_and_its_entries() {
    let db = db();
    track(&db, "t1", "https://example.com/t1");
    track(&db, "t2", "https://example.com/t2");
    let id = playlist(&db, "My Mix");
    db.add_track_to_playlist(id, "t1").unwrap();
    db.add_track_to_playlist(id, "t2").unwrap();
    db.delete_track("t1").unwrap();
    assert!(db.get_track_by_id("t1").unwrap().is_none());
    assert!(db.get_track_by_id("t2").unwrap().is_some());
    assert_eq!(db.get_playlist_by_id(id).unwrap().unwrap().track_count, 1);
}

// --- tracks, cache, listing ---

#[test]
fn upsert_refreshes_metadata_but_not_counters_and_maps_cache_flag() {
    let db = db();
    let first = track(&db, "t1", "https://example.com/t1");
    db.increment_track_play_count("t1").unwrap();
    let again = db
        .upsert_track(&TrackUpsert {
            id: "ignored".into(),
            source_url: "https://example.com/t1".into(),
            source_id: "t1".into(),
            source_site: "youtube".into(),
            title: "Renamed".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!((again.id.as_str(), again.title.as_str(), again.play_count), ("t1", "Renamed", 1));
    assert!(again.last_played_at.is_some());
    // cached_file_path is never overwritten by an upsert.
    assert_eq!(again.cached_file_path, first.cached_file_path);
    assert!(again.to_renderer_track().is_cached);
    assert_eq!(db.get_track_by_source_url("https://example.com/t1").unwrap().unwrap().id, "t1");

    db.update_track_cache("t1", None, None).unwrap();
    assert!(!db.get_track_by_id("t1").unwrap().unwrap().to_renderer_track().is_cached);
}

#[test]
fn cache_usage_eviction_and_clear() {
    let db = db();
    track(&db, "a", "https://example.com/a");
    track(&db, "b", "https://example.com/b");
    assert_eq!(db.get_cache_usage().unwrap(), (2048, 2));
    assert_eq!(db.get_eviction_candidates(&[]).unwrap().len(), 2);
    let kept = db.get_eviction_candidates(&["a".to_string()]).unwrap();
    assert_eq!(kept.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["b"]);
    assert_eq!(db.get_all_cached_tracks().unwrap().len(), 2);
    db.clear_all_cached_tracks().unwrap();
    assert_eq!(db.get_cache_usage().unwrap(), (0, 0));
    assert!(db.get_all_cached_tracks().unwrap().is_empty());
}

#[test]
fn list_music_tracks_searches_sorts_and_pages() {
    let db = db();
    for (id, title, artist) in [("1", "Alpha", Some("Zed")), ("2", "Beta", None), ("3", "Gamma", Some("alpha band"))] {
        db.upsert_track(&TrackUpsert {
            id: id.into(),
            source_url: format!("https://example.com/{id}"),
            source_id: id.into(),
            source_site: "youtube".into(),
            title: title.into(),
            artist: artist.map(String::from),
            added_at: Some(format!("2026-01-0{id}T00:00:00.000Z")),
            cached_file_path: if id == "2" { Some("/c/2.m4a".into()) } else { None },
            ..Default::default()
        })
        .unwrap();
    }
    let list = |input: MusicLibraryListInput| db.list_music_tracks(&input).unwrap();
    let by_title = list(MusicLibraryListInput { sort_field: Some(MusicSortField::Title), sort_dir: Some(MusicSortDir::Asc), ..Default::default() });
    assert_eq!(by_title.tracks.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["Alpha", "Beta", "Gamma"]);
    let search = list(MusicLibraryListInput { search: Some("  alpha ".into()), sort_field: Some(MusicSortField::Title), sort_dir: Some(MusicSortDir::Asc), ..Default::default() });
    assert_eq!((search.total, search.tracks.len()), (2, 2));
    let cached = list(MusicLibraryListInput { cached_only: Some(true), ..Default::default() });
    assert_eq!(cached.tracks[0].id, "2");
    let newest = list(MusicLibraryListInput { sort_field: Some(MusicSortField::AddedAt), limit: Some(1), offset: Some(1), ..Default::default() });
    assert_eq!((newest.total, newest.tracks[0].id.as_str()), (3, "2"));
}

// --- playlists ---

#[test]
fn playlist_lifecycle_and_reorder() {
    let db = db();
    assert!(db.create_playlist("   ", PlaylistSource::UserCreated).is_err());
    let id = playlist(&db, "  Mix  ");
    assert_eq!(db.list_playlists().unwrap()[0].name, "Mix");
    db.rename_playlist(id, "Renamed").unwrap();
    assert_eq!(db.get_playlist_by_id(id).unwrap().unwrap().name, "Renamed");
    assert!(db.rename_playlist(999, "x").unwrap_err().to_string().contains("not found"));

    for n in ["a", "b", "c"] {
        track(&db, n, &format!("https://example.com/{n}"));
    }
    let entries: Vec<_> = ["a", "b", "c"].iter().map(|n| db.add_track_to_playlist(id, n).unwrap()).collect();
    assert_eq!(entries.iter().map(|e| e.position).collect::<Vec<_>>(), [0, 1, 2]);
    db.reorder_playlist_track(id, entries[0].id, 2).unwrap();
    let order: Vec<_> = db.get_playlist_tracks(id).unwrap().into_iter().map(|t| t.track_id).collect();
    assert_eq!(order, ["b", "c", "a"]);
    db.reorder_playlist_track(id, entries[0].id, 0).unwrap();
    let order: Vec<_> = db.get_playlist_tracks(id).unwrap().into_iter().map(|t| t.track_id).collect();
    assert_eq!(order, ["a", "b", "c"]);
    assert!(db.reorder_playlist_track(id, 9999, 1).unwrap_err().to_string().contains("not found in playlist"));

    assert_eq!(db.get_all_playlist_track_ids().unwrap().len(), 3);
    db.remove_track_from_playlist(entries[1].id).unwrap();
    assert!(db.remove_track_from_playlist(entries[1].id).is_err());
    db.delete_playlist(id).unwrap();
    assert!(db.delete_playlist(id).is_err());
    assert!(db.get_all_playlist_track_ids().unwrap().is_empty());
}

// --- claude-code-database.test.ts ---

fn session_input() -> SaveSessionWithTrackingInput {
    SaveSessionWithTrackingInput {
        title: "Test session".into(),
        timer_type: TimerType::Work,
        planned_duration_seconds: 1500,
        actual_duration_seconds: 1200,
        issue_number: None,
        issue_title: None,
        issue_url: None,
        issue_provider: None,
        issue_id: None,
        claude_code_sessions: None,
    }
}

fn cc(uuid: &str) -> ClaudeCodeSessionData {
    ClaudeCodeSessionData {
        cc_session_uuid: uuid.into(),
        file_edit_count: 3,
        total_idle_seconds: 120,
        idle_period_count: 1,
        first_activity_at: Some("2026-02-25T10:00:00.000Z".into()),
        last_activity_at: Some("2026-02-25T11:00:00.000Z".into()),
        files_edited: vec!["C:\\Users\\test\\types.ts".into(), "C:\\Users\\test\\index.ts".into()],
        idle_periods: vec![ClaudeCodeIdlePeriod {
            start_at: "2026-02-25T10:20:00.000Z".into(),
            end_at: "2026-02-25T10:22:00.000Z".into(),
            duration_seconds: 120,
        }],
    }
}

fn with_cc(sessions: Vec<ClaudeCodeSessionData>) -> SaveSessionWithTrackingInput {
    SaveSessionWithTrackingInput { claude_code_sessions: Some(sessions), ..session_input() }
}

#[test]
fn tracking_save_inserts_session_and_cc_data_atomically() {
    let db = db();
    let data = cc("069362b8-73da-42cb-b6f2-33f94fb220d9");
    let session = db.save_session_with_tracking(&with_cc(vec![data.clone()])).unwrap();
    let got = db.get_claude_code_data_for_session(&session.id).unwrap().unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].data, data);
    assert!(!got[0].id.is_empty());
}

#[test]
fn tracking_absent_or_empty_means_no_cc_data() {
    let db = db();
    let none = db.save_session_with_tracking(&session_input()).unwrap();
    assert!(db.get_claude_code_data_for_session(&none.id).unwrap().is_none());
    let empty = db.save_session_with_tracking(&with_cc(vec![])).unwrap();
    assert!(db.get_claude_code_data_for_session(&empty.id).unwrap().is_none());
    let plain = db
        .save_session(&SaveSessionInput {
            title: "p".into(),
            timer_type: TimerType::Work,
            planned_duration_seconds: 1,
            actual_duration_seconds: 1,
            issue_number: None,
            issue_title: None,
            issue_url: None,
            issue_provider: None,
            issue_id: None,
        })
        .unwrap();
    assert!(db.get_claude_code_data_for_session(&plain.id).unwrap().is_none());
    assert!(db.get_claude_code_data_for_session("non-existent-uuid").unwrap().is_none());
}

#[test]
fn idle_periods_round_trip_in_order() {
    let db = db();
    let mut data = cc("u1");
    data.idle_periods = vec![
        ClaudeCodeIdlePeriod { start_at: "2026-02-25T10:40:00.000Z".into(), end_at: "2026-02-25T10:47:00.000Z".into(), duration_seconds: 420 },
        ClaudeCodeIdlePeriod { start_at: "2026-02-25T10:20:00.000Z".into(), end_at: "2026-02-25T10:26:00.000Z".into(), duration_seconds: 360 },
    ];
    let s = db.save_session_with_tracking(&with_cc(vec![data])).unwrap();
    let got = db.get_claude_code_data_for_session(&s.id).unwrap().unwrap();
    // Read back ordered by start_at.
    assert_eq!(got[0].data.idle_periods.iter().map(|p| p.duration_seconds).collect::<Vec<_>>(), [360, 420]);
}

#[test]
fn duplicate_cc_uuid_in_one_save_is_ignored_and_multiple_are_kept() {
    let db = db();
    let s = db.save_session_with_tracking(&with_cc(vec![cc("dup"), cc("dup")])).unwrap();
    assert_eq!(db.get_claude_code_data_for_session(&s.id).unwrap().unwrap().len(), 1);

    let mut a = cc("uuid-001");
    a.files_edited = vec!["a.ts".into(), "b.ts".into()];
    let mut b = cc("uuid-002");
    b.files_edited = vec![];
    b.first_activity_at = Some("2026-02-25T12:00:00.000Z".into());
    let s = db.save_session_with_tracking(&with_cc(vec![a, b])).unwrap();
    let got = db.get_claude_code_data_for_session(&s.id).unwrap().unwrap();
    assert_eq!(got.iter().map(|x| x.data.cc_session_uuid.as_str()).collect::<Vec<_>>(), ["uuid-001", "uuid-002"]);
    assert!(got[1].data.files_edited.is_empty());
}

#[test]
fn deleting_the_session_cascades_to_cc_data() {
    let db = db();
    let s = db.save_session_with_tracking(&with_cc(vec![cc("u1")])).unwrap();
    assert!(db.get_claude_code_data_for_session(&s.id).unwrap().is_some());
    db.delete_session(&s.id).unwrap();
    assert!(db.get_claude_code_data_for_session(&s.id).unwrap().is_none());
    let idle: i64 = db.conn().query_row("SELECT COUNT(*) FROM claude_code_idle_periods", [], |r| r.get(0)).unwrap();
    assert_eq!(idle, 0);
}

#[test]
fn tracking_save_is_atomic_and_list_still_works() {
    let db = db();
    let s = db.save_session_with_tracking(&with_cc(vec![cc("u1")])).unwrap();
    // An invalid duration must fail before anything is written.
    let mut bad = with_cc(vec![cc("u2")]);
    bad.actual_duration_seconds = -1;
    assert!(db.save_session_with_tracking(&bad).is_err());
    let list = db.list_sessions(&ListSessionsInput::default()).unwrap();
    assert_eq!((list.total, list.sessions[0].id.as_str()), (1, s.id.as_str()));
    let rows: i64 = db.conn().query_row("SELECT COUNT(*) FROM claude_code_sessions", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1);
}

// --- settings KV, nvim activity ---

#[test]
fn setting_value_round_trip() {
    let db = db();
    assert_eq!(db.get_setting_value("k").unwrap(), None);
    db.set_setting_value("k", "v").unwrap();
    db.set_setting_value("k", "v2").unwrap();
    assert_eq!(db.get_setting_value("k").unwrap().as_deref(), Some("v2"));
    db.delete_setting_value("k").unwrap();
    assert_eq!(db.get_setting_value("k").unwrap(), None);
}

#[test]
fn nvim_activity_validation_dedupe_and_by_date() {
    let db = db();
    assert!(db.insert_nvim_activity("  ", "f").is_err());
    assert!(db.insert_nvim_activity("p", &"x".repeat(1001)).is_err());
    assert!(!db.is_duplicate_nvim_activity("proj", "a.ts").unwrap());
    db.insert_nvim_activity(" proj ", " a.ts ").unwrap();
    assert!(db.is_duplicate_nvim_activity("proj", "a.ts").unwrap());
    assert!(!db.is_duplicate_nvim_activity("proj", "b.ts").unwrap());

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let records = db.list_nvim_activity_by_date(&today).unwrap();
    assert_eq!((records.len(), records[0].project.as_str(), records[0].file.as_str()), (1, "proj", "a.ts"));
    let long_ago = db.list_nvim_activity_by_date("2001-01-01").unwrap();
    assert!(long_ago.is_empty());
    assert!(db.list_nvim_activity_by_date("2026-1-1").unwrap_err().to_string().contains("Expected YYYY-MM-DD"));
}
