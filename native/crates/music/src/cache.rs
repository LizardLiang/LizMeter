//! `cache-manager.ts`: the LRU cache of audio files in `<userData>/music-cache`.
//!
//! The database holds the size of every cached track; eviction removes the least recently played
//! first and never touches the track that is playing. Playlist tracks are not protected (the
//! database query only excludes the ids it is given), as in the TS code.

use crate::error::Result;
use crate::DbHandle;
use lizmeter_core::CacheStats;
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_CACHE_MAX_BYTES: i64 = 2 * 1024 * 1024 * 1024;
const SETTING_KEY: &str = "music.cacheMaxBytes";

/// `parseInt(raw, 10)`: the leading integer, or `None` for NaN.
fn parse_int(raw: &str) -> Option<i64> {
    let t = lizmeter_db::util::js_trim(raw);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let n: i64 = digits.parse().ok()?;
    Some(if neg { -n } else { n })
}

pub struct CacheManager {
    dir: PathBuf,
    db: DbHandle,
}

impl CacheManager {
    /// `user_data` is the folder that holds `music-cache/`.
    pub fn new(user_data: &Path, db: DbHandle) -> Self {
        CacheManager { dir: user_data.join("music-cache"), db }
    }

    /// The cache folder, created when missing.
    pub fn dir(&self) -> PathBuf {
        let _ = fs::create_dir_all(&self.dir);
        self.dir.clone()
    }

    pub fn file_path(&self, track_id: &str) -> PathBuf {
        self.dir().join(format!("{track_id}.m4a"))
    }

    pub fn max_bytes(&self) -> i64 {
        let raw = crate::with_db(&self.db, |db| Ok(db.get_setting_value(SETTING_KEY)?)).ok().flatten();
        match raw.as_deref() {
            None | Some("") => DEFAULT_CACHE_MAX_BYTES,
            Some(s) => parse_int(s).unwrap_or(DEFAULT_CACHE_MAX_BYTES),
        }
    }

    pub fn set_max_bytes(&self, max_bytes: i64) -> Result<()> {
        crate::with_db(&self.db, |db| Ok(db.set_setting_value(SETTING_KEY, &max_bytes.to_string())?))
    }

    pub fn stats(&self) -> Result<CacheStats> {
        let (current_bytes, track_count) = crate::with_db(&self.db, |db| Ok(db.get_cache_usage()?))?;
        Ok(CacheStats { current_bytes, max_bytes: self.max_bytes(), track_count })
    }

    /// Deletes every `.m4a` and `.tmp` file and clears the cache columns of all tracks.
    pub fn clear_all(&self) -> Result<()> {
        if let Ok(entries) = fs::read_dir(self.dir()) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".m4a") || name.ends_with(".tmp") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        crate::with_db(&self.db, |db| Ok(db.clear_all_cached_tracks()?))
    }

    /// LRU eviction until the cache fits `max_bytes`. A cache file that cannot be deleted still
    /// loses its database fields, so the track is streamed again next time.
    pub fn evict_if_needed(&self, currently_playing: Option<&str>) -> Result<()> {
        let (current, _) = crate::with_db(&self.db, |db| Ok(db.get_cache_usage()?))?;
        let max = self.max_bytes();
        if current <= max {
            return Ok(());
        }
        let exclude: Vec<String> = currently_playing.into_iter().map(str::to_string).collect();
        let candidates = crate::with_db(&self.db, |db| Ok(db.get_eviction_candidates(&exclude)?))?;
        let mut remaining = current - max;
        for c in candidates {
            if remaining <= 0 {
                break;
            }
            let Some(path) = c.cached_file_path.as_deref() else { continue };
            let _ = fs::remove_file(path);
            crate::with_db(&self.db, |db| Ok(db.update_track_cache(&c.id, None, None)?))?;
            remaining -= c.cache_size_bytes.unwrap_or(0);
        }
        Ok(())
    }
}
