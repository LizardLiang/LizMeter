// src/renderer/src/components/music/PlaylistManager.tsx
// Phase 3: Playlist management tab content for MusicPage.
// Left sidebar: list of playlists with new/rename/delete.
// Right panel: tracks for selected playlist with drag-and-drop reorder + add-by-URL.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicPlaylist, PlaylistTrack } from "../../../../shared/types.ts";
import { useMusicPlayer } from "../../contexts/MusicPlayerContext.tsx";
import { usePlaylists } from "../../hooks/usePlaylists.ts";
import styles from "./PlaylistManager.module.scss";

// ---- Icons ----

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={styles.dragHandleIcon}
    >
      <path d="M8 6h2v2H8zm0 4h2v2H8zm0 4h2v2H8zm6-8h2v2h-2zm0 4h2v2h-2zm0 4h2v2h-2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
  );
}

// ---- Format duration ----

function formatDuration(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---- Track thumbnail ----

function TrackThumb({ thumbnailUrl, title }: { thumbnailUrl: string | null; title: string; }) {
  if (thumbnailUrl) {
    return <img src={thumbnailUrl} alt={title} className={styles.thumb} loading="lazy" />;
  }
  return (
    <div className={styles.thumbPlaceholder} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
    </div>
  );
}

// ---- Delete playlist confirmation dialog ----

interface DeleteDialogProps {
  playlistName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteDialog({ playlistName, onConfirm, onCancel }: DeleteDialogProps) {
  return (
    <div className={styles.deleteOverlay} onClick={onCancel}>
      <div className={styles.deleteDialog} onClick={(e) => e.stopPropagation()}>
        <p className={styles.deleteDialogTitle}>Delete "{playlistName}"?</p>
        <p className={styles.deleteDialogText}>
          This will remove the playlist. Your tracks will remain in the library.
        </p>
        <div className={styles.deleteDialogActions}>
          <button className={styles.deleteCancelBtn} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className={styles.deleteConfirmBtn} onClick={onConfirm} type="button">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Sortable playlist track row ----

interface SortablePlaylistTrackProps {
  entry: PlaylistTrack;
  onRemove: (playlistTrackId: number) => void;
  onPlay: (entry: PlaylistTrack) => void;
}

function SortablePlaylistTrack({ entry, onRemove, onPlay }: SortablePlaylistTrackProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className={styles.trackRow}>
      <button
        className={styles.dragHandle}
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        tabIndex={-1}
        type="button"
      >
        <DragHandleIcon />
      </button>

      <button
        className={styles.trackInfo}
        onClick={() => onPlay(entry)}
        type="button"
        title={`Play: ${entry.track.title}`}
      >
        <TrackThumb thumbnailUrl={entry.track.thumbnailUrl} title={entry.track.title} />
        <div className={styles.trackText}>
          <span className={styles.trackTitle}>{entry.track.title}</span>
          {entry.track.artist && <span className={styles.trackArtist}>{entry.track.artist}</span>}
        </div>
        <span className={styles.trackDuration}>{formatDuration(entry.track.durationSeconds)}</span>
      </button>

      <button
        className={styles.removeTrackBtn}
        onClick={() => onRemove(entry.id)}
        type="button"
        aria-label={`Remove ${entry.track.title} from playlist`}
        title="Remove from playlist"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

// ---- PlaylistManager (exported) ----

export function PlaylistManager() {
  const playlists = usePlaylists();
  const ctx = useMusicPlayer();

  // New playlist creation
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLoading, setNewLoading] = useState(false);
  const newInputRef = useRef<HTMLInputElement>(null);

  // Rename state
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deletingPlaylist, setDeletingPlaylist] = useState<MusicPlaylist | null>(null);

  // URL add to playlist
  const [addUrlValue, setAddUrlValue] = useState("");
  const [addUrlLoading, setAddUrlLoading] = useState(false);
  const [addUrlError, setAddUrlError] = useState<string | null>(null);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Focus new playlist input when it shows
  useEffect(() => {
    if (showNewForm) {
      setTimeout(() => newInputRef.current?.focus(), 30);
    }
  }, [showNewForm]);

  // Focus rename input when renaming
  useEffect(() => {
    if (renamingId !== null) {
      setTimeout(() => renameInputRef.current?.focus(), 30);
    }
  }, [renamingId]);

  const handleCreatePlaylist = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setNewLoading(true);
    try {
      const created = await playlists.createPlaylist(name);
      setNewName("");
      setShowNewForm(false);
      playlists.selectPlaylist(created.id);
    } catch {
      // Non-fatal
    } finally {
      setNewLoading(false);
    }
  }, [newName, playlists]);

  const handleRenameConfirm = useCallback(async () => {
    const name = renameValue.trim();
    if (!name || renamingId === null) return;
    try {
      await playlists.renamePlaylist(renamingId, name);
    } finally {
      setRenamingId(null);
      setRenameValue("");
    }
  }, [renameValue, renamingId, playlists]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deletingPlaylist) return;
    try {
      await playlists.deletePlaylist(deletingPlaylist.id);
    } finally {
      setDeletingPlaylist(null);
    }
  }, [deletingPlaylist, playlists]);

  const handleAddUrl = useCallback(async () => {
    const url = addUrlValue.trim();
    if (!url || playlists.selectedPlaylistId === null) return;
    try {
      new URL(url);
    } catch {
      setAddUrlError("Invalid URL");
      return;
    }
    setAddUrlError(null);
    setAddUrlLoading(true);
    try {
      await playlists.addUrlToPlaylist(playlists.selectedPlaylistId, url);
      setAddUrlValue("");
    } catch (err) {
      setAddUrlError(err instanceof Error ? err.message : "Failed to add track");
    } finally {
      setAddUrlLoading(false);
    }
  }, [addUrlValue, playlists]);

  const handlePlayPlaylist = useCallback(() => {
    const tracks = playlists.selectedPlaylistTracks.map((pt) => pt.track);
    if (tracks.length === 0) return;
    ctx.clearQueue();
    ctx.enqueueBulk(tracks, playlists.selectedPlaylistId ?? undefined);
    void ctx.play(tracks[0]!.sourceUrl).catch(() => {});
  }, [playlists, ctx]);

  const handlePlayTrack = useCallback((entry: PlaylistTrack) => {
    void ctx.play(entry.track.sourceUrl).catch(() => {});
  }, [ctx]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || playlists.selectedPlaylistId === null) return;
    const tracks = playlists.selectedPlaylistTracks;
    const fromEntry = tracks.find((t) => t.id === active.id);
    const toEntry = tracks.find((t) => t.id === over.id);
    if (!fromEntry || !toEntry) return;
    void playlists.reorderPlaylistTrack(
      playlists.selectedPlaylistId,
      fromEntry.id,
      toEntry.position,
    ).catch(() => {});
  }, [playlists]);

  const selectedPlaylist = playlists.playlists.find((p) => p.id === playlists.selectedPlaylistId) ?? null;

  return (
    <div className={styles.container}>
      {/* Left sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarLabel}>Playlists</span>
          <button
            className={styles.newPlaylistBtn}
            type="button"
            title="New playlist"
            aria-label="Create new playlist"
            onClick={() => {
              setShowNewForm(true);
              setNewName("");
            }}
          >
            <PlusIcon />
          </button>
        </div>

        {/* New playlist input */}
        {showNewForm && (
          <div className={styles.newPlaylistForm}>
            <input
              ref={newInputRef}
              className={styles.newPlaylistInput}
              type="text"
              placeholder="Playlist name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreatePlaylist();
                if (e.key === "Escape") {
                  setShowNewForm(false);
                  setNewName("");
                }
              }}
              disabled={newLoading}
            />
            <button
              className={styles.newPlaylistConfirmBtn}
              type="button"
              onClick={() => void handleCreatePlaylist()}
              disabled={newLoading || !newName.trim()}
            >
              {newLoading ? <span className={styles.spinner} aria-hidden="true" /> : "Add"}
            </button>
            <button
              className={styles.newPlaylistCancelBtn}
              type="button"
              onClick={() => {
                setShowNewForm(false);
                setNewName("");
              }}
            >
              <CloseIcon />
            </button>
          </div>
        )}

        <div className={styles.playlistList}>
          {playlists.playlists.length === 0 && !playlists.isLoading && (
            <div className={styles.emptyPlaylists}>No playlists yet</div>
          )}
          {playlists.playlists.map((playlist) => (
            <button
              key={playlist.id}
              className={`${styles.playlistItem} ${
                playlists.selectedPlaylistId === playlist.id ? styles.playlistItemActive : ""
              }`}
              type="button"
              onClick={() => playlists.selectPlaylist(playlist.id)}
              title={playlist.name}
            >
              <span className={styles.playlistName}>{playlist.name}</span>
              <span className={styles.playlistCount}>{playlist.trackCount}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Right track panel */}
      <div className={styles.trackPanel}>
        {selectedPlaylist === null
          ? (
            <div className={styles.selectPrompt}>
              <p className={styles.selectPromptText}>Select a playlist to view tracks</p>
              <p className={styles.selectPromptHint}>Or create a new playlist using the + button</p>
            </div>
          )
          : (
            <>
              <div className={styles.trackPanelHeader}>
                {renamingId === selectedPlaylist.id
                  ? (
                    <div className={styles.renameForm}>
                      <input
                        ref={renameInputRef}
                        className={styles.renameInput}
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleRenameConfirm();
                          if (e.key === "Escape") {
                            setRenamingId(null);
                            setRenameValue("");
                          }
                        }}
                      />
                      <button
                        className={styles.renameConfirmBtn}
                        type="button"
                        onClick={() => void handleRenameConfirm()}
                      >
                        Save
                      </button>
                      <button
                        className={styles.renameCancelBtn}
                        type="button"
                        onClick={() => {
                          setRenamingId(null);
                          setRenameValue("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )
                  : (
                    <span className={styles.trackPanelTitle} title={selectedPlaylist.name}>
                      {selectedPlaylist.name}
                    </span>
                  )}
                <div className={styles.trackPanelActions}>
                  {selectedPlaylist.trackCount > 0 && (
                    <button
                      className={styles.playlistActionBtn}
                      type="button"
                      onClick={handlePlayPlaylist}
                      title="Load playlist into queue and play"
                    >
                      <PlayIcon />
                      Play
                    </button>
                  )}
                  <button
                    className={styles.renameBtn}
                    type="button"
                    title="Rename playlist"
                    aria-label="Rename playlist"
                    onClick={() => {
                      setRenamingId(selectedPlaylist.id);
                      setRenameValue(selectedPlaylist.name);
                    }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className={styles.deletePlaylistBtn}
                    type="button"
                    title="Delete playlist"
                    aria-label="Delete playlist"
                    onClick={() => setDeletingPlaylist(selectedPlaylist)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>

              {/* Track list */}
              <div className={styles.trackList}>
                {playlists.isTracksLoading
                  ? (
                    <div className={styles.emptyTracks}>
                      <span className={styles.spinner} aria-hidden="true" />
                    </div>
                  )
                  : playlists.selectedPlaylistTracks.length === 0
                  ? (
                    <div className={styles.emptyTracks}>
                      <p className={styles.emptyTracksText}>No tracks in this playlist</p>
                      <p className={styles.emptyTracksHint}>Paste a URL below to add a track</p>
                    </div>
                  )
                  : (
                    <DndContext
                      sensors={sensors}
                      collisionDetection={closestCenter}
                      onDragEnd={handleDragEnd}
                    >
                      <SortableContext
                        items={playlists.selectedPlaylistTracks.map((t) => t.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {playlists.selectedPlaylistTracks.map((entry) => (
                          <SortablePlaylistTrack
                            key={entry.id}
                            entry={entry}
                            onRemove={(ptId) => void playlists.removeTrackFromPlaylist(ptId).catch(() => {})}
                            onPlay={handlePlayTrack}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  )}
              </div>

              {/* Add URL section */}
              <div className={styles.addUrlSection}>
                <div className={styles.addUrlRow}>
                  <input
                    className={styles.addUrlInput}
                    type="text"
                    placeholder="Paste URL to add track..."
                    value={addUrlValue}
                    onChange={(e) => {
                      setAddUrlValue(e.target.value);
                      setAddUrlError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleAddUrl();
                    }}
                    disabled={addUrlLoading}
                    aria-label="Add track URL"
                  />
                  <button
                    className={styles.addUrlBtn}
                    type="button"
                    onClick={() => void handleAddUrl()}
                    disabled={addUrlLoading || !addUrlValue.trim()}
                  >
                    {addUrlLoading ? <span className={styles.spinner} aria-hidden="true" /> : "Add"}
                  </button>
                </div>
                {addUrlError && <div className={styles.errorText}>{addUrlError}</div>}
              </div>
            </>
          )}
      </div>

      {/* Delete confirmation dialog */}
      {deletingPlaylist !== null && (
        <DeleteDialog
          playlistName={deletingPlaylist.name}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setDeletingPlaylist(null)}
        />
      )}
    </div>
  );
}
