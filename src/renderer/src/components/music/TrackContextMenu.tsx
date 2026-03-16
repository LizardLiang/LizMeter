// src/renderer/src/components/music/TrackContextMenu.tsx
// Phase 3: "..." context menu for track rows in Library, Queue, and Playlist views.
// Uses a React portal to avoid clipping in scroll containers.
// Menu options: Add to Queue, Play Next, Add to Playlist (submenu), Delete from Library.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MusicPlaylist, MusicTrack } from "../../../../shared/types.ts";
import { useMusicPlayer } from "../../contexts/MusicPlayerContext.tsx";
import styles from "./TrackContextMenu.module.scss";

// ---- Icons ----

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
    </svg>
  );
}

// ---- Delete confirmation dialog ----

interface DeleteDialogProps {
  trackTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteDialog({ trackTitle, onConfirm, onCancel }: DeleteDialogProps) {
  return createPortal(
    <div className={styles.deleteOverlay} onClick={onCancel}>
      <div className={styles.deleteDialog} onClick={(e) => e.stopPropagation()}>
        <p className={styles.deleteDialogTitle}>Delete from Library?</p>
        <p className={styles.deleteDialogText}>
          "{trackTitle}" will be removed from your library. This cannot be undone.
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
    </div>,
    document.body,
  );
}

// ---- Track context menu ----

export interface TrackContextMenuProps {
  track: MusicTrack;
  playlists: MusicPlaylist[];
  onAddToPlaylist?: (playlist: MusicPlaylist) => void;
  onDeleteFromLibrary?: (track: MusicTrack) => void;
  // Extra classes for the button wrapper (e.g., to make button visible on row hover)
  className?: string;
}

export function TrackContextMenu({
  track,
  playlists,
  onAddToPlaylist,
  onDeleteFromLibrary,
  className,
}: TrackContextMenuProps) {
  const ctx = useMusicPlayer();

  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; }>({ top: 0, left: 0 });
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<{ top: number; left: number; }>({ top: 0, left: 0 });
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuItemRef = useRef<HTMLButtonElement>(null);

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();

    // Position below button, right-aligned
    const menuWidth = 180;
    const menuHeight = 160; // estimated
    const left = Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8);
    const top = rect.bottom + 2 + menuHeight > window.innerHeight
      ? rect.top - menuHeight - 2
      : rect.bottom + 2;

    setMenuPos({ top, left: Math.max(8, left) });
    setIsOpen(true);
    setSubmenuOpen(false);
  }, []);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setSubmenuOpen(false);
  }, []);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target)) {
        closeMenu();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, closeMenu]);

  const handleAddToQueue = useCallback(() => {
    ctx.enqueue(track);
    closeMenu();
  }, [track, ctx, closeMenu]);

  const handlePlayNext = useCallback(() => {
    // Enqueue then reorder to be after current index
    ctx.enqueue(track);
    const newIdx = ctx.queue.length; // will be added at end
    const targetIdx = ctx.currentIndex + 1;
    if (newIdx > targetIdx) {
      ctx.reorderQueue(newIdx, targetIdx);
    }
    closeMenu();
  }, [track, ctx, closeMenu]);

  const handlePlaylistSubmenuHover = useCallback(() => {
    const item = submenuItemRef.current;
    if (!item) return;
    const rect = item.getBoundingClientRect();
    const submenuWidth = 160;
    const left = rect.right + 4 + submenuWidth > window.innerWidth
      ? rect.left - submenuWidth - 4
      : rect.right + 4;
    setSubmenuPos({ top: rect.top, left });
    setSubmenuOpen(true);
  }, []);

  const handleAddToPlaylist = useCallback((playlist: MusicPlaylist) => {
    onAddToPlaylist?.(playlist);
    closeMenu();
  }, [onAddToPlaylist, closeMenu]);

  const handleDeleteFromLibrary = useCallback(() => {
    setShowDeleteDialog(true);
    closeMenu();
  }, [closeMenu]);

  const handleDeleteConfirm = useCallback(() => {
    onDeleteFromLibrary?.(track);
    setShowDeleteDialog(false);
  }, [track, onDeleteFromLibrary]);

  return (
    <>
      <button
        ref={btnRef}
        className={`${styles.menuBtn} ${isOpen ? styles.menuBtnVisible : ""} ${className ?? ""}`}
        type="button"
        aria-label="Track options"
        title="Track options"
        onClick={openMenu}
      >
        <DotsIcon />
      </button>

      {isOpen && createPortal(
        <div
          ref={menuRef}
          className={styles.menu}
          style={{ top: menuPos.top, left: menuPos.left }}
          role="menu"
          aria-label="Track options"
        >
          <button className={styles.menuItem} role="menuitem" type="button" onClick={handleAddToQueue}>
            Add to Queue
          </button>
          <button className={styles.menuItem} role="menuitem" type="button" onClick={handlePlayNext}>
            Play Next
          </button>

          <div className={styles.menuDivider} />

          {/* Add to Playlist submenu */}
          {onAddToPlaylist && (
            <button
              ref={submenuItemRef}
              className={styles.submenuItem}
              role="menuitem"
              type="button"
              onMouseEnter={handlePlaylistSubmenuHover}
              onMouseLeave={() => setSubmenuOpen(false)}
              aria-haspopup="true"
              aria-expanded={submenuOpen}
            >
              Add to Playlist
              <span className={styles.submenuArrow}>
                <ChevronRightIcon />
              </span>
            </button>
          )}

          {onDeleteFromLibrary && (
            <>
              <div className={styles.menuDivider} />
              <button
                className={styles.menuItemDanger}
                role="menuitem"
                type="button"
                onClick={handleDeleteFromLibrary}
              >
                Delete from Library
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {/* Playlist submenu */}
      {isOpen && submenuOpen && onAddToPlaylist && createPortal(
        <div
          className={styles.submenu}
          style={{ top: submenuPos.top, left: submenuPos.left }}
          role="menu"
          aria-label="Add to playlist"
          onMouseEnter={() => setSubmenuOpen(true)}
          onMouseLeave={() => setSubmenuOpen(false)}
        >
          {playlists.length === 0
            ? <div className={styles.submenuEmpty}>No playlists</div>
            : playlists.map((playlist) => (
              <button
                key={playlist.id}
                className={styles.menuItem}
                role="menuitem"
                type="button"
                onClick={() => handleAddToPlaylist(playlist)}
              >
                {playlist.name}
              </button>
            ))}
        </div>,
        document.body,
      )}

      {/* Delete confirmation dialog */}
      {showDeleteDialog && (
        <DeleteDialog
          trackTitle={track.title}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setShowDeleteDialog(false)}
        />
      )}
    </>
  );
}
