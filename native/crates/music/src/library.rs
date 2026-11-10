//! The data-side `music:*` channels of `music-ipc.ts`: library, playlists, cache, binaries and
//! integrity. Playback lives in [`crate::service`].

use crate::error::{MusicError, Result};
use crate::extractor::validate_url;
use crate::service::{err, lock, upsert_of, MusicEvent, MusicService};
use crate::with_db;
use lizmeter_core::{
    BinaryInfo, BinaryStatus, CacheStats, IntegrityCheckResult, IntegrityProgress, MusicErrorCode, MusicLibraryListInput, MusicLibraryListResult,
    MusicMetaResult, MusicPlaylist, PlaylistAddTrackInput, PlaylistSource, PlaylistTrack,
};
use lizmeter_db::InternalTrackRecord;
use std::fs;
use std::path::Path;
use std::time::Duration;

/// Windows holds a file for a moment after the last handle closes (sharing violation, error 32).
const UNLINK_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Deletes a cache file, retrying once when the file is still busy. A file that cannot be deleted
/// is an error, so the caller never drops the database row and orphans the file.
fn unlink_with_retry(path: &Path) -> Result<()> {
    let busy = |e: &std::io::Error| e.raw_os_error() == Some(32) || e.kind() == std::io::ErrorKind::PermissionDenied;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) if busy(&e) => {
            std::thread::sleep(UNLINK_RETRY_DELAY);
            match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(e2) if e2.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e2) => {
                    eprintln!("[music] cache file still busy after retry: {} ({e2})", path.display());
                    err(MusicErrorCode::CacheFileBusy, format!("Cache file is still in use: {}", path.display()))
                }
            }
        }
        Err(e) => {
            eprintln!("[music] failed to delete cache file: {} ({e})", path.display());
            err(MusicErrorCode::CacheFileBusy, format!("Failed to delete cache file: {}", path.display()))
        }
    }
}

fn as_code(code: MusicErrorCode) -> impl Fn(lizmeter_db::DbError) -> MusicError {
    move |e| MusicError::new(code, e.to_string())
}

impl MusicService {
    // --- Binaries ---

    pub fn binary_status(&self) -> BinaryStatus {
        self.bins.check()
    }

    pub fn binary_info(&self) -> BinaryInfo {
        self.bins.info()
    }

    /// Downloads yt-dlp and ffmpeg. Progress arrives as [`MusicEvent::BinaryDownloadProgress`].
    pub fn download_binaries(&self) -> Result<()> {
        self.bins.download(&mut |p| self.emit(MusicEvent::BinaryDownloadProgress(p)))
    }

    // --- Metadata ---

    /// `music:meta`: a track's details without saving it or fetching audio.
    pub fn meta(&self, url: &str) -> Result<MusicMetaResult> {
        validate_url(url)?;
        if !self.bins.check().yt_dlp_installed {
            return err(MusicErrorCode::BinaryMissing, "yt-dlp is not installed");
        }
        let m = self.extractor.extract_metadata(url)?;
        let record = InternalTrackRecord {
            id: lizmeter_db::util::new_uuid(),
            source_url: m.source_url,
            source_id: m.source_id,
            source_site: m.source_site,
            title: m.title,
            artist: m.artist,
            duration_seconds: m.duration_seconds,
            thumbnail_url: m.thumbnail_url,
            cached_file_path: None,
            cache_size_bytes: None,
            play_count: 0,
            last_played_at: None,
            added_at: lizmeter_db::util::now_iso(),
        };
        Ok(MusicMetaResult { track: record.to_renderer_track() })
    }

    // --- Library ---

    pub fn library_list(&self, input: &MusicLibraryListInput) -> Result<MusicLibraryListResult> {
        with_db(&self.db, |db| Ok(db.list_music_tracks(input)?))
    }

    /// Deletes a track and its cache file. A playing track stops first, so the file is free.
    pub fn library_delete(&self, track_id: &str) -> Result<()> {
        let Some(row) = with_db(&self.db, |db| Ok(db.get_track_by_id(track_id)?))? else {
            return err(MusicErrorCode::TrackNotFound, format!("Track not found: {track_id}"));
        };
        let playing = lock(&self.st).loaded_id.as_deref() == Some(track_id);
        if playing {
            self.halt_audio_for_file_delete();
        }
        if let Some(path) = &row.cached_file_path {
            unlink_with_retry(Path::new(path))?;
        }
        with_db(&self.db, |db| Ok(db.delete_track(track_id)?))?;
        self.remove_track_from_queue(track_id);
        Ok(())
    }

    /// Deletes every track and cache file. Playlists stay as empty shells.
    pub fn library_clear(&self) -> Result<()> {
        self.clear_player();
        self.cache.clear_all()?;
        with_db(&self.db, |db| Ok(db.delete_all_tracks()?))?;
        lock(&self.st).queue.clear();
        self.emit(MusicEvent::Changed);
        Ok(())
    }

    /// Frees the cache file of the playing track: the queue keeps its place, so removing the item
    /// afterwards advances to the next one.
    fn halt_audio_for_file_delete(&self) {
        self.cancel_requests();
        self.stop_audio();
    }

    // --- Cache ---

    pub fn cache_stats(&self) -> Result<CacheStats> {
        self.cache.stats()
    }

    pub fn cache_clear(&self) -> Result<()> {
        self.cache.clear_all()
    }

    /// Sets the limit and evicts at once if the cache is now over it.
    pub fn cache_set_limit(&self, max_bytes: i64) -> Result<()> {
        self.cache.set_max_bytes(max_bytes)?;
        let playing = lock(&self.st).loaded_id.clone();
        self.cache.evict_if_needed(playing.as_deref())
    }

    // --- Playlists ---

    pub fn playlist_create(&self, name: &str, track_ids: &[String]) -> Result<MusicPlaylist> {
        if lizmeter_db::util::js_trim(name).is_empty() {
            return err(MusicErrorCode::PlaylistNotFound, "Playlist name cannot be empty");
        }
        with_db(&self.db, |db| {
            let playlist = db.create_playlist(name, PlaylistSource::UserCreated)?;
            for tid in track_ids {
                // Missing or invalid tracks are skipped silently.
                let _ = db.add_track_to_playlist(playlist.id, tid);
            }
            Ok(db.get_playlist_by_id(playlist.id)?.unwrap_or(playlist))
        })
    }

    pub fn playlist_rename(&self, id: i64, name: &str) -> Result<()> {
        with_db(&self.db, |db| db.rename_playlist(id, name).map_err(as_code(MusicErrorCode::PlaylistNotFound)))
    }

    pub fn playlist_delete(&self, id: i64) -> Result<()> {
        with_db(&self.db, |db| db.delete_playlist(id).map_err(as_code(MusicErrorCode::PlaylistNotFound)))
    }

    pub fn playlist_list(&self) -> Result<Vec<MusicPlaylist>> {
        with_db(&self.db, |db| Ok(db.list_playlists()?))
    }

    pub fn playlist_tracks(&self, playlist_id: i64) -> Result<Vec<PlaylistTrack>> {
        with_db(&self.db, |db| {
            if db.get_playlist_by_id(playlist_id)?.is_none() {
                return err(MusicErrorCode::PlaylistNotFound, format!("Playlist not found: {playlist_id}"));
            }
            Ok(db.get_playlist_tracks(playlist_id)?)
        })
    }

    /// Adds a track by id, or by URL (fetching its metadata first if it is not in the library).
    pub fn playlist_add_track(&self, input: &PlaylistAddTrackInput) -> Result<PlaylistTrack> {
        let exists = with_db(&self.db, |db| Ok(db.get_playlist_by_id(input.playlist_id)?.is_some()))?;
        if !exists {
            return err(MusicErrorCode::PlaylistNotFound, format!("Playlist not found: {}", input.playlist_id));
        }
        let track_id = match (input.track_id.as_deref().filter(|s| !s.is_empty()), input.url.as_deref().filter(|s| !s.is_empty())) {
            (Some(id), _) => {
                if with_db(&self.db, |db| Ok(db.get_track_by_id(id)?))?.is_none() {
                    return err(MusicErrorCode::TrackNotFound, format!("Track not found: {id}"));
                }
                id.to_string()
            }
            (None, Some(url)) => {
                if !self.bins.check().yt_dlp_installed {
                    return err(MusicErrorCode::BinaryMissing, "yt-dlp is not installed");
                }
                match with_db(&self.db, |db| Ok(db.get_track_by_source_url(url)?))? {
                    Some(existing) => existing.id,
                    None => {
                        let meta = self.extractor.extract_metadata(url)?;
                        let id = lizmeter_db::util::new_uuid();
                        let row = with_db(&self.db, |db| Ok(db.upsert_track(&upsert_of(&id, &meta, Some(lizmeter_db::util::now_iso())))?))?;
                        row.id
                    }
                }
            }
            (None, None) => return err(MusicErrorCode::TrackNotFound, "Invalid playlist add-track input: must provide trackId or url"),
        };
        with_db(&self.db, |db| Ok(db.add_track_to_playlist(input.playlist_id, &track_id)?))
    }

    pub fn playlist_remove_track(&self, playlist_track_id: i64) -> Result<()> {
        with_db(&self.db, |db| db.remove_track_from_playlist(playlist_track_id).map_err(as_code(MusicErrorCode::TrackNotFound)))
    }

    pub fn playlist_reorder(&self, playlist_id: i64, track_entry_id: i64, to_position: i64) -> Result<()> {
        with_db(&self.db, |db| {
            if db.get_playlist_by_id(playlist_id)?.is_none() {
                return err(MusicErrorCode::PlaylistNotFound, format!("Playlist not found: {playlist_id}"));
            }
            db.reorder_playlist_track(playlist_id, track_entry_id, to_position).map_err(as_code(MusicErrorCode::TrackNotFound))
        })
    }

    // --- Integrity ---

    /// Scans every cached track. Progress arrives as [`MusicEvent::IntegrityProgress`].
    pub fn integrity_check(&self) -> Result<IntegrityCheckResult> {
        self.integrity.check_all(&mut |current, total, title| {
            self.emit(MusicEvent::IntegrityProgress(IntegrityProgress { current, total, title: title.to_string() }));
        })
    }

    pub fn integrity_repair(&self, track_ids: &[String]) -> Result<i64> {
        self.integrity.repair(track_ids)
    }

    // --- Reset ---

    /// `music:reset`: clears the cache and optionally deletes the binaries. Playback stops first,
    /// because a running ffmpeg locks its own executable.
    pub fn reset(&self, delete_binaries: bool) -> Result<()> {
        self.clear_player();
        self.cache.clear_all()?;
        if delete_binaries {
            let dir = self.bins.bin_dir();
            if dir.exists() {
                if let Err(e) = fs::remove_dir_all(&dir) {
                    eprintln!("[music] failed to delete the bin directory: {e}");
                }
            }
            self.bins.reset_cache();
        }
        Ok(())
    }
}
