// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTrackToPlaylist,
  closeDatabase,
  createPlaylist,
  deleteAllTracks,
  deleteTrack,
  getPlaylistById,
  getTrackById,
  initDatabase,
  listMusicTracks,
  listPlaylists,
  upsertTrack,
} from "../database.ts";

// The sql.js test shim's Statement.run() doesn't return { lastInsertRowid },
// so createPlaylist()'s returned `id` is undefined under Vitest even though the
// row is inserted correctly. Look the real id up via listPlaylists() instead.
function createPlaylistAndGetId(name: string): number {
  createPlaylist(name);
  const created = listPlaylists().find((p) => p.name === name);
  if (!created) throw new Error(`Playlist "${name}" not found after creation`);
  return created.id;
}

beforeEach(() => {
  initDatabase(":memory:");
});

afterEach(() => {
  closeDatabase();
});

function seedTrack(id: string, sourceUrl: string) {
  return upsertTrack({
    id,
    source_url: sourceUrl,
    source_id: id,
    source_site: "youtube",
    title: `Track ${id}`,
    artist: null,
    duration_seconds: 180,
    thumbnail_url: null,
    cached_file_path: `/cache/${id}.m4a`,
    cache_size_bytes: 1024,
    added_at: new Date().toISOString(),
  });
}

describe("deleteAllTracks (music:library:clear support)", () => {
  it("removes every track row", () => {
    seedTrack("t1", "https://example.com/t1");
    seedTrack("t2", "https://example.com/t2");
    expect(listMusicTracks({}).total).toBe(2);

    deleteAllTracks();

    expect(listMusicTracks({}).total).toBe(0);
    expect(getTrackById("t1")).toBeNull();
    expect(getTrackById("t2")).toBeNull();
  });

  it("cascades to playlist_tracks but leaves playlists as empty shells", () => {
    seedTrack("t1", "https://example.com/t1");
    seedTrack("t2", "https://example.com/t2");
    const playlistId = createPlaylistAndGetId("My Mix");
    addTrackToPlaylist(playlistId, "t1");
    addTrackToPlaylist(playlistId, "t2");

    const beforeClear = getPlaylistById(playlistId);
    expect(beforeClear?.trackCount).toBe(2);

    deleteAllTracks();

    const afterClear = getPlaylistById(playlistId);
    expect(afterClear).not.toBeNull();
    expect(afterClear?.trackCount).toBe(0);
    expect(afterClear?.name).toBe("My Mix");
  });

  it("is a no-op on an already-empty library", () => {
    expect(listMusicTracks({}).total).toBe(0);
    expect(() => deleteAllTracks()).not.toThrow();
    expect(listMusicTracks({}).total).toBe(0);
  });
});

describe("deleteTrack (single track delete, for comparison)", () => {
  it("removes only the targeted track and cascades its own playlist entries", () => {
    seedTrack("t1", "https://example.com/t1");
    seedTrack("t2", "https://example.com/t2");
    const playlistId = createPlaylistAndGetId("My Mix");
    addTrackToPlaylist(playlistId, "t1");
    addTrackToPlaylist(playlistId, "t2");

    deleteTrack("t1");

    expect(getTrackById("t1")).toBeNull();
    expect(getTrackById("t2")).not.toBeNull();
    expect(getPlaylistById(playlistId)?.trackCount).toBe(1);
  });
});
