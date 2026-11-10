//! `cache-manager.ts`: size limit, stats, clearing and LRU eviction.
use lizmeter_db::{Database, TrackUpsert};
use lizmeter_music::cache::{CacheManager, DEFAULT_CACHE_MAX_BYTES};
use lizmeter_music::DbHandle;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Rig {
    root: tempfile::TempDir,
    db: DbHandle,
    cache: CacheManager,
}

fn rig() -> Rig {
    let root = tempfile::tempdir().unwrap();
    let db: DbHandle = Arc::new(Mutex::new(Database::open_in_memory().unwrap()));
    let cache = CacheManager::new(root.path(), db.clone());
    Rig { root, db, cache }
}

impl Rig {
    /// A cached track: the file exists with `size` bytes and `last_played` is its LRU key.
    fn cached_track(&self, id: &str, size: usize, last_played: Option<&str>) -> PathBuf {
        let path = self.cache.file_path(id);
        std::fs::write(&path, vec![1u8; size]).unwrap();
        let db = self.db.lock().unwrap();
        db.upsert_track(&TrackUpsert {
            id: id.into(),
            source_url: format!("https://example.com/{id}"),
            source_id: id.into(),
            source_site: "youtube".into(),
            title: id.into(),
            artist: None,
            duration_seconds: Some(10.0),
            thumbnail_url: None,
            cached_file_path: Some(path.to_string_lossy().into_owned()),
            cache_size_bytes: Some(size as i64),
            added_at: None,
        })
        .unwrap();
        if let Some(t) = last_played {
            db.conn().execute("UPDATE tracks SET last_played_at = ? WHERE id = ?", [t, id]).unwrap();
        }
        path
    }

    fn is_cached(&self, id: &str) -> bool {
        self.db.lock().unwrap().get_track_by_id(id).unwrap().unwrap().cached_file_path.is_some()
    }
}

#[test]
fn the_limit_defaults_to_two_gigabytes_and_follows_the_setting() {
    let r = rig();
    assert_eq!(r.cache.max_bytes(), DEFAULT_CACHE_MAX_BYTES);
    r.cache.set_max_bytes(5000).unwrap();
    assert_eq!(r.cache.max_bytes(), 5000);
    r.db.lock().unwrap().set_setting_value("music.cacheMaxBytes", "abc").unwrap();
    assert_eq!(r.cache.max_bytes(), DEFAULT_CACHE_MAX_BYTES, "NaN falls back to the default");
    r.db.lock().unwrap().set_setting_value("music.cacheMaxBytes", "123abc").unwrap();
    assert_eq!(r.cache.max_bytes(), 123, "parseInt reads the leading digits");
}

#[test]
fn stats_sum_the_cached_tracks() {
    let r = rig();
    r.cached_track("a", 100, None);
    r.cached_track("b", 250, None);
    r.cache.set_max_bytes(1000).unwrap();
    let s = r.cache.stats().unwrap();
    assert_eq!((s.current_bytes, s.max_bytes, s.track_count), (350, 1000, 2));
}

#[test]
fn clear_all_removes_audio_and_temp_files_and_the_database_fields() {
    let r = rig();
    let a = r.cached_track("a", 10, None);
    let tmp = r.cache.dir().join("b.m4a.tmp");
    std::fs::write(&tmp, b"partial").unwrap();
    let other = r.cache.dir().join("notes.txt");
    std::fs::write(&other, b"keep").unwrap();
    r.cache.clear_all().unwrap();
    assert!(!a.exists() && !tmp.exists());
    assert!(other.exists(), "only .m4a and .tmp files are cache files");
    assert!(!r.is_cached("a"));
    assert_eq!(r.cache.stats().unwrap().track_count, 0);
}

#[test]
fn eviction_does_nothing_while_the_cache_fits() {
    let r = rig();
    let a = r.cached_track("a", 100, Some("2026-01-01T00:00:00.000Z"));
    r.cache.set_max_bytes(100).unwrap();
    r.cache.evict_if_needed(None).unwrap();
    assert!(a.exists() && r.is_cached("a"));
}

#[test]
fn eviction_removes_the_least_recently_played_first_and_stops_once_under_the_limit() {
    let r = rig();
    let old = r.cached_track("old", 100, Some("2026-01-01T00:00:00.000Z"));
    let mid = r.cached_track("mid", 100, Some("2026-02-01T00:00:00.000Z"));
    let new = r.cached_track("new", 100, Some("2026-03-01T00:00:00.000Z"));
    r.cache.set_max_bytes(150).unwrap();
    r.cache.evict_if_needed(None).unwrap();
    assert!(!old.exists() && !r.is_cached("old"));
    assert!(!mid.exists() && !r.is_cached("mid"));
    assert!(new.exists() && r.is_cached("new"), "300 -> 100 bytes is under 150, so the newest stays");
}

#[test]
fn the_playing_track_is_never_evicted() {
    let r = rig();
    let playing = r.cached_track("playing", 100, Some("2026-01-01T00:00:00.000Z"));
    let other = r.cached_track("other", 100, Some("2026-02-01T00:00:00.000Z"));
    r.cache.set_max_bytes(100).unwrap();
    r.cache.evict_if_needed(Some("playing")).unwrap();
    assert!(playing.exists() && r.is_cached("playing"));
    assert!(!other.exists() && !r.is_cached("other"));
}

#[test]
fn a_track_that_was_never_played_is_evicted_before_a_played_one() {
    let r = rig();
    let never = r.cached_track("never", 100, None);
    let played = r.cached_track("played", 100, Some("2026-01-01T00:00:00.000Z"));
    r.cache.set_max_bytes(100).unwrap();
    r.cache.evict_if_needed(None).unwrap();
    assert!(!never.exists());
    assert!(played.exists());
}

#[test]
fn a_file_that_is_already_gone_still_loses_its_database_fields() {
    let r = rig();
    let gone = r.cached_track("gone", 100, Some("2026-01-01T00:00:00.000Z"));
    r.cached_track("keep", 100, Some("2026-02-01T00:00:00.000Z"));
    std::fs::remove_file(gone).unwrap();
    r.cache.set_max_bytes(100).unwrap();
    r.cache.evict_if_needed(None).unwrap();
    assert!(!r.is_cached("gone"));
    assert!(r.is_cached("keep"));
}

#[test]
fn cache_paths_live_under_music_cache() {
    let r = rig();
    assert_eq!(r.cache.file_path("abc"), r.root.path().join("music-cache").join("abc.m4a"));
}
