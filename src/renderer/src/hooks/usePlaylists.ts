// src/renderer/src/hooks/usePlaylists.ts
// Playlist data management hook.
// Manages: playlists list, selected playlist tracks, loading state.
// Refresh via token counter pattern (same as useSessionHistory).

import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicPlaylist, MusicTrack, PlaylistTrack } from "../../../shared/types.ts";

export interface UsePlaylistsReturn {
  playlists: MusicPlaylist[];
  selectedPlaylistTracks: PlaylistTrack[];
  selectedPlaylistId: number | null;
  isLoading: boolean;
  isTracksLoading: boolean;

  // Playlist CRUD
  createPlaylist: (name: string, trackIds?: string[]) => Promise<MusicPlaylist>;
  renamePlaylist: (id: number, name: string) => Promise<void>;
  deletePlaylist: (id: number) => Promise<void>;

  // Track management
  addTrackToPlaylist: (playlistId: number, trackId: string) => Promise<void>;
  addUrlToPlaylist: (playlistId: number, url: string) => Promise<void>;
  removeTrackFromPlaylist: (playlistTrackId: number) => Promise<void>;
  reorderPlaylistTrack: (playlistId: number, trackEntryId: number, toPosition: number) => Promise<void>;

  // Selection
  selectPlaylist: (id: number | null) => void;

  // Load a playlist into the queue (returns tracks in order)
  getPlaylistTrackList: (playlistId: number) => MusicTrack[];

  // Refresh
  refresh: () => void;
}

export function usePlaylists(): UsePlaylistsReturn {
  const [playlists, setPlaylists] = useState<MusicPlaylist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);
  const [selectedPlaylistTracks, setSelectedPlaylistTracks] = useState<PlaylistTrack[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isTracksLoading, setIsTracksLoading] = useState(false);

  // Token counter: incrementing forces a full reload
  const [refreshToken, setRefreshToken] = useState(0);
  // Track token for playlist tracks reload
  const [tracksRefreshToken, setTracksRefreshToken] = useState(0);

  const selectedPlaylistIdRef = useRef(selectedPlaylistId);
  useEffect(() => {
    selectedPlaylistIdRef.current = selectedPlaylistId;
  }, [selectedPlaylistId]);

  // Load playlists when refreshToken changes
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const result = await window.electronAPI.music.playlistList();
        if (!cancelled) {
          setPlaylists(result);
          // If selected playlist was deleted, deselect
          if (selectedPlaylistIdRef.current !== null) {
            const still = result.find((p) => p.id === selectedPlaylistIdRef.current);
            if (!still) {
              setSelectedPlaylistId(null);
              setSelectedPlaylistTracks([]);
            }
          }
        }
      } catch {
        // Non-fatal
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Load tracks for selected playlist when it changes or tracksRefreshToken changes
  useEffect(() => {
    if (selectedPlaylistId === null) {
      setSelectedPlaylistTracks([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setIsTracksLoading(true);
      try {
        const tracks = await window.electronAPI.music.playlistTracks(selectedPlaylistId);
        if (!cancelled) {
          setSelectedPlaylistTracks(tracks);
        }
      } catch {
        if (!cancelled) {
          setSelectedPlaylistTracks([]);
        }
      } finally {
        if (!cancelled) {
          setIsTracksLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedPlaylistId, tracksRefreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

  const refreshTracks = useCallback(() => {
    setTracksRefreshToken((t) => t + 1);
  }, []);

  const createPlaylist = useCallback(async (name: string, trackIds?: string[]): Promise<MusicPlaylist> => {
    const playlist = await window.electronAPI.music.playlistCreate({ name, trackIds });
    setRefreshToken((t) => t + 1);
    return playlist;
  }, []);

  const renamePlaylist = useCallback(async (id: number, name: string): Promise<void> => {
    await window.electronAPI.music.playlistRename({ id, name });
    setRefreshToken((t) => t + 1);
  }, []);

  const deletePlaylist = useCallback(async (id: number): Promise<void> => {
    await window.electronAPI.music.playlistDelete(id);
    setRefreshToken((t) => t + 1);
    if (selectedPlaylistIdRef.current === id) {
      setSelectedPlaylistId(null);
      setSelectedPlaylistTracks([]);
    }
  }, []);

  const addTrackToPlaylist = useCallback(async (playlistId: number, trackId: string): Promise<void> => {
    await window.electronAPI.music.playlistAddTrack({ playlistId, trackId });
    setRefreshToken((t) => t + 1);
    if (selectedPlaylistIdRef.current === playlistId) {
      refreshTracks();
    }
  }, [refreshTracks]);

  const addUrlToPlaylist = useCallback(async (playlistId: number, url: string): Promise<void> => {
    await window.electronAPI.music.playlistAddTrack({ playlistId, url });
    setRefreshToken((t) => t + 1);
    if (selectedPlaylistIdRef.current === playlistId) {
      refreshTracks();
    }
  }, [refreshTracks]);

  const removeTrackFromPlaylist = useCallback(async (playlistTrackId: number): Promise<void> => {
    await window.electronAPI.music.playlistRemoveTrack(playlistTrackId);
    setRefreshToken((t) => t + 1);
    refreshTracks();
  }, [refreshTracks]);

  const reorderPlaylistTrack = useCallback(
    async (playlistId: number, trackEntryId: number, toPosition: number): Promise<void> => {
      await window.electronAPI.music.playlistReorder({ playlistId, trackEntryId, toPosition });
      refreshTracks();
    },
    [refreshTracks],
  );

  const selectPlaylist = useCallback((id: number | null) => {
    setSelectedPlaylistId(id);
  }, []);

  const getPlaylistTrackList = useCallback(
    (playlistId: number): MusicTrack[] => {
      if (playlistId === selectedPlaylistId) {
        return selectedPlaylistTracks.map((pt) => pt.track);
      }
      return [];
    },
    [selectedPlaylistId, selectedPlaylistTracks],
  );

  return {
    playlists,
    selectedPlaylistTracks,
    selectedPlaylistId,
    isLoading,
    isTracksLoading,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    addUrlToPlaylist,
    removeTrackFromPlaylist,
    reorderPlaylistTrack,
    selectPlaylist,
    getPlaylistTrackList,
    refresh,
  };
}
