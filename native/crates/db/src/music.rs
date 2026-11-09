//! Music tracks and playlists (`database.ts` music sections).

use crate::error::{fail, Result};
use crate::util::{js_trim, js_truncate, now_iso};
use crate::{optional_row, placeholders, Database};
use lizmeter_core::{
    MusicLibraryListInput, MusicLibraryListResult, MusicPlaylist, MusicSortDir, MusicSortField, MusicTrack,
    PlaylistSource, PlaylistTrack,
};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Row};

/// Raw row of the `tracks` table. `cached_file_path` is an absolute OS path and must never reach the UI.
#[derive(Debug, Clone, PartialEq)]
pub struct InternalTrackRecord {
    pub id: String,
    pub source_url: String,
    pub source_id: String,
    pub source_site: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_seconds: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub cached_file_path: Option<String>,
    pub cache_size_bytes: Option<i64>,
    pub play_count: i64,
    pub last_played_at: Option<String>,
    pub added_at: String,
}

impl InternalTrackRecord {
    /// Maps `cached_file_path` to the boolean `is_cached`, so no filesystem path leaks.
    pub fn to_renderer_track(&self) -> MusicTrack {
        MusicTrack {
            id: self.id.clone(),
            source_url: self.source_url.clone(),
            source_id: self.source_id.clone(),
            source_site: self.source_site.clone(),
            title: self.title.clone(),
            artist: self.artist.clone(),
            duration_seconds: self.duration_seconds,
            thumbnail_url: self.thumbnail_url.clone(),
            is_cached: self.cached_file_path.is_some(),
            cache_size_bytes: self.cache_size_bytes,
            play_count: self.play_count,
            last_played_at: self.last_played_at.clone(),
            added_at: self.added_at.clone(),
        }
    }
}

fn track_from_row(r: &Row<'_>) -> rusqlite::Result<InternalTrackRecord> {
    Ok(InternalTrackRecord {
        id: r.get("id")?,
        source_url: r.get("source_url")?,
        source_id: r.get("source_id")?,
        source_site: r.get("source_site")?,
        title: r.get("title")?,
        artist: r.get("artist")?,
        duration_seconds: r.get("duration_seconds")?,
        thumbnail_url: r.get("thumbnail_url")?,
        cached_file_path: r.get("cached_file_path")?,
        cache_size_bytes: r.get("cache_size_bytes")?,
        play_count: r.get("play_count")?,
        last_played_at: r.get("last_played_at")?,
        added_at: r.get("added_at")?,
    })
}

/// A track to insert or refresh. `play_count` and `last_played_at` are never written by an upsert.
#[derive(Debug, Clone, Default)]
pub struct TrackUpsert {
    pub id: String,
    pub source_url: String,
    pub source_id: String,
    pub source_site: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration_seconds: Option<f64>,
    pub thumbnail_url: Option<String>,
    pub cached_file_path: Option<String>,
    pub cache_size_bytes: Option<i64>,
    pub added_at: Option<String>,
}

fn playlist_from_row(r: &Row<'_>) -> rusqlite::Result<MusicPlaylist> {
    let source: String = r.get("source")?;
    Ok(MusicPlaylist {
        id: r.get("id")?,
        name: r.get("name")?,
        source: PlaylistSource::parse(&source),
        track_count: r.get("track_count")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn sort_field_sql(f: MusicSortField) -> &'static str {
    match f {
        MusicSortField::LastPlayedAt => "last_played_at",
        MusicSortField::Title => "title",
        MusicSortField::DurationSeconds => "duration_seconds",
        MusicSortField::AddedAt => "added_at",
    }
}

fn playlist_name(name: &str) -> Result<String> {
    let t = js_trim(name);
    if t.is_empty() {
        return fail("Playlist name cannot be empty");
    }
    Ok(js_truncate(t, 200))
}

impl Database {
    pub fn upsert_track(&self, record: &TrackUpsert) -> Result<InternalTrackRecord> {
        let conn = self.conn();
        let now = now_iso();
        conn.execute(
            "INSERT INTO tracks (id, source_url, source_id, source_site, title, artist, duration_seconds, thumbnail_url, cached_file_path, cache_size_bytes, play_count, last_played_at, added_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?) \
             ON CONFLICT(source_url) DO UPDATE SET \
               title = excluded.title, artist = excluded.artist, \
               duration_seconds = excluded.duration_seconds, thumbnail_url = excluded.thumbnail_url",
            params![
                record.id,
                record.source_url,
                record.source_id,
                record.source_site,
                record.title,
                record.artist,
                record.duration_seconds,
                record.thumbnail_url,
                record.cached_file_path,
                record.cache_size_bytes,
                record.added_at.as_deref().unwrap_or(&now),
            ],
        )?;
        Ok(conn.query_row("SELECT * FROM tracks WHERE source_url = ?", [&record.source_url], track_from_row)?)
    }

    pub fn increment_track_play_count(&self, track_id: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?",
            params![now_iso(), track_id],
        )?;
        Ok(())
    }

    pub fn get_track_by_source_url(&self, source_url: &str) -> Result<Option<InternalTrackRecord>> {
        optional_row(self.conn().query_row("SELECT * FROM tracks WHERE source_url = ?", [source_url], track_from_row))
    }

    pub fn get_track_by_id(&self, track_id: &str) -> Result<Option<InternalTrackRecord>> {
        optional_row(self.conn().query_row("SELECT * FROM tracks WHERE id = ?", [track_id], track_from_row))
    }

    pub fn update_track_cache(&self, track_id: &str, cached_file_path: Option<&str>, cache_size_bytes: Option<i64>) -> Result<()> {
        self.conn().execute(
            "UPDATE tracks SET cached_file_path = ?, cache_size_bytes = ? WHERE id = ?",
            params![cached_file_path, cache_size_bytes, track_id],
        )?;
        Ok(())
    }

    pub fn delete_track(&self, track_id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM tracks WHERE id = ?", [track_id])?;
        Ok(())
    }

    /// Deletes every track. `playlist_tracks` rows cascade, so playlists survive as empty shells.
    pub fn delete_all_tracks(&self) -> Result<()> {
        self.conn().execute("DELETE FROM tracks", [])?;
        Ok(())
    }

    pub fn list_music_tracks(&self, input: &MusicLibraryListInput) -> Result<MusicLibraryListResult> {
        let conn = self.conn();
        let limit = input.limit.unwrap_or(50);
        let offset = input.offset.unwrap_or(0);
        let sort_field = input.sort_field.unwrap_or(MusicSortField::LastPlayedAt);
        let sort_dir = input.sort_dir.unwrap_or(MusicSortDir::Desc);

        let mut conditions: Vec<&str> = vec![];
        let mut params_vec: Vec<Value> = vec![];
        if let Some(search) = &input.search {
            let t = js_trim(search);
            if !t.is_empty() {
                let term = format!("%{t}%");
                conditions.push("(title LIKE ? OR artist LIKE ?)");
                params_vec.push(Value::Text(term.clone()));
                params_vec.push(Value::Text(term));
            }
        }
        if input.cached_only == Some(true) {
            conditions.push("cached_file_path IS NOT NULL");
        }
        let where_clause =
            if conditions.is_empty() { String::new() } else { format!("WHERE {}", conditions.join(" AND ")) };
        let dir = match sort_dir {
            MusicSortDir::Asc => "ASC",
            MusicSortDir::Desc => "DESC",
        };
        let order = format!("ORDER BY {} {dir}, id ASC", sort_field_sql(sort_field));

        let mut page = params_vec.clone();
        page.push(Value::Integer(limit));
        page.push(Value::Integer(offset));
        let mut stmt = conn.prepare(&format!("SELECT * FROM tracks {where_clause} {order} LIMIT ? OFFSET ?"))?;
        let tracks = stmt
            .query_map(params_from_iter(page), track_from_row)?
            .map(|r| r.map(|t| t.to_renderer_track()))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) as count FROM tracks {where_clause}"),
            params_from_iter(params_vec),
            |r| r.get(0),
        )?;
        Ok(MusicLibraryListResult { tracks, total })
    }

    /// `(current_bytes, track_count)` over cached tracks.
    pub fn get_cache_usage(&self) -> Result<(i64, i64)> {
        Ok(self.conn().query_row(
            "SELECT COALESCE(SUM(cache_size_bytes), 0) as total, COUNT(*) as count FROM tracks WHERE cached_file_path IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    pub fn clear_all_cached_tracks(&self) -> Result<()> {
        self.conn().execute("UPDATE tracks SET cached_file_path = NULL, cache_size_bytes = NULL", [])?;
        Ok(())
    }

    pub fn get_eviction_candidates(&self, exclude_track_ids: &[String]) -> Result<Vec<InternalTrackRecord>> {
        let conn = self.conn();
        let rows = if exclude_track_ids.is_empty() {
            let mut stmt = conn
                .prepare("SELECT * FROM tracks WHERE cached_file_path IS NOT NULL ORDER BY last_played_at ASC")?;
            let rows = stmt.query_map([], track_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        } else {
            let mut stmt = conn.prepare(&format!(
                "SELECT * FROM tracks WHERE cached_file_path IS NOT NULL AND id NOT IN ({}) ORDER BY last_played_at ASC",
                placeholders(exclude_track_ids.len())
            ))?;
            let rows = stmt
                .query_map(params_from_iter(exclude_track_ids.iter()), track_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        Ok(rows)
    }

    pub fn get_all_cached_tracks(&self) -> Result<Vec<InternalTrackRecord>> {
        let mut stmt = self.conn().prepare("SELECT * FROM tracks WHERE cached_file_path IS NOT NULL")?;
        let rows = stmt.query_map([], track_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_all_playlist_track_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn().prepare("SELECT DISTINCT track_id FROM playlist_tracks")?;
        let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    }

    // --- Playlists ---

    pub fn create_playlist(&self, name: &str, source: PlaylistSource) -> Result<MusicPlaylist> {
        let now = now_iso();
        let trimmed = playlist_name(name)?;
        self.conn().execute(
            "INSERT INTO playlists (name, source, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![trimmed, source.as_str(), now, now],
        )?;
        let id = self.conn().last_insert_rowid();
        Ok(MusicPlaylist { id, name: trimmed, source, track_count: 0, created_at: now.clone(), updated_at: now })
    }

    pub fn rename_playlist(&self, id: i64, name: &str) -> Result<()> {
        let trimmed = playlist_name(name)?;
        let changes = self.conn().execute(
            "UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?",
            params![trimmed, now_iso(), id],
        )?;
        if changes == 0 {
            return fail(format!("Playlist with id {id} not found"));
        }
        Ok(())
    }

    pub fn delete_playlist(&self, id: i64) -> Result<()> {
        let changes = self.conn().execute("DELETE FROM playlists WHERE id = ?", [id])?;
        if changes == 0 {
            return fail(format!("Playlist with id {id} not found"));
        }
        Ok(())
    }

    pub fn list_playlists(&self) -> Result<Vec<MusicPlaylist>> {
        let mut stmt = self.conn().prepare(
            "SELECT p.id, p.name, p.source, p.created_at, p.updated_at, COUNT(pt.id) as track_count \
             FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id \
             GROUP BY p.id ORDER BY p.created_at DESC",
        )?;
        let rows = stmt.query_map([], playlist_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_playlist_by_id(&self, id: i64) -> Result<Option<MusicPlaylist>> {
        optional_row(self.conn().query_row(
            "SELECT p.id, p.name, p.source, p.created_at, p.updated_at, COUNT(pt.id) as track_count \
             FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id \
             WHERE p.id = ? GROUP BY p.id",
            [id],
            playlist_from_row,
        ))
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> Result<Vec<PlaylistTrack>> {
        let mut stmt = self.conn().prepare(
            "SELECT pt.id AS entry_id, pt.playlist_id, pt.track_id, pt.position, \
                    t.id, t.source_url, t.source_id, t.source_site, t.title, t.artist, \
                    t.duration_seconds, t.thumbnail_url, t.cached_file_path, \
                    t.cache_size_bytes, t.play_count, t.last_played_at, t.added_at \
             FROM playlist_tracks pt INNER JOIN tracks t ON t.id = pt.track_id \
             WHERE pt.playlist_id = ? ORDER BY pt.position ASC",
        )?;
        let rows = stmt
            .query_map([playlist_id], |r| {
                let track = track_from_row(r)?.to_renderer_track();
                Ok(PlaylistTrack {
                    id: r.get("entry_id")?,
                    playlist_id: r.get("playlist_id")?,
                    track_id: r.get("track_id")?,
                    position: r.get("position")?,
                    track,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn add_track_to_playlist(&self, playlist_id: i64, track_id: &str) -> Result<PlaylistTrack> {
        let conn = self.conn();
        let now = now_iso();
        let max_pos: i64 = conn.query_row(
            "SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_tracks WHERE playlist_id = ?",
            [playlist_id],
            |r| r.get(0),
        )?;
        let position = max_pos + 1;
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
            params![playlist_id, track_id, position],
        )?;
        let entry_id = conn.last_insert_rowid();
        conn.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", params![now, playlist_id])?;

        let Some(track) = self.get_track_by_id(track_id)? else {
            return fail(format!("Track not found after insert: {track_id}"));
        };
        Ok(PlaylistTrack {
            id: entry_id,
            playlist_id,
            track_id: track_id.to_string(),
            position,
            track: track.to_renderer_track(),
        })
    }

    pub fn remove_track_from_playlist(&self, playlist_track_id: i64) -> Result<()> {
        let changes = self.conn().execute("DELETE FROM playlist_tracks WHERE id = ?", [playlist_track_id])?;
        if changes == 0 {
            return fail(format!("Playlist track entry with id {playlist_track_id} not found"));
        }
        Ok(())
    }

    pub fn reorder_playlist_track(&self, playlist_id: i64, track_entry_id: i64, to_position: i64) -> Result<()> {
        let conn = self.conn();
        let entry = optional_row(conn.query_row(
            "SELECT id, position FROM playlist_tracks WHERE id = ? AND playlist_id = ?",
            params![track_entry_id, playlist_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        ))?;
        let Some((_, from_position)) = entry else {
            return fail(format!("Track entry {track_entry_id} not found in playlist {playlist_id}"));
        };
        if from_position == to_position {
            return Ok(());
        }

        let tx = conn.unchecked_transaction()?;
        if from_position < to_position {
            tx.execute(
                "UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ? AND position <= ?",
                params![playlist_id, from_position, to_position],
            )?;
        } else {
            tx.execute(
                "UPDATE playlist_tracks SET position = position + 1 WHERE playlist_id = ? AND position >= ? AND position < ?",
                params![playlist_id, to_position, from_position],
            )?;
        }
        tx.execute("UPDATE playlist_tracks SET position = ? WHERE id = ?", params![to_position, track_entry_id])?;
        tx.execute("UPDATE playlists SET updated_at = ? WHERE id = ?", params![now_iso(), playlist_id])?;
        tx.commit()?;
        Ok(())
    }
}
