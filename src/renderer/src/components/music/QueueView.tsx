// src/renderer/src/components/music/QueueView.tsx
// Queue tab content for MusicPage (Phase 2).
// Displays the current playback queue with drag-and-drop reordering (dnd-kit),
// per-track remove button, current track highlight, and click-to-jump.

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
import type { MusicQueueItem } from "../../../../shared/types.ts";
import { useMusicPlayer } from "../../contexts/MusicPlayerContext.tsx";
import styles from "./QueueView.module.scss";

// ---- Track thumbnail placeholder ----

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

// ---- Format duration ----

function formatDuration(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---- Drag handle icon ----

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

// ---- Sortable queue item ----

interface SortableQueueItemProps {
  item: MusicQueueItem;
  index: number;
  isCurrentTrack: boolean;
  onJumpTo: (index: number) => void;
  onRemove: (index: number) => void;
}

function SortableQueueItem({ item, index, isCurrentTrack, onJumpTo, onRemove }: SortableQueueItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.queueId,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`${styles.trackRow} ${isCurrentTrack ? styles.trackRowActive : ""}`}
      aria-current={isCurrentTrack ? "true" : undefined}
    >
      {/* Drag handle */}
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

      {/* Track info (clickable area) */}
      <button
        className={styles.trackInfo}
        onClick={() => onJumpTo(index)}
        type="button"
        title={`Play: ${item.track.title}`}
      >
        <TrackThumb thumbnailUrl={item.track.thumbnailUrl} title={item.track.title} />
        <div className={styles.trackText}>
          <span className={styles.trackTitle}>{item.track.title}</span>
          {item.track.artist && <span className={styles.trackArtist}>{item.track.artist}</span>}
        </div>
        <div className={styles.trackMeta}>
          <span className={styles.trackDuration}>{formatDuration(item.track.durationSeconds)}</span>
          {item.track.isCached && (
            <span className={styles.cachedBadge} title="Available offline">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
              </svg>
            </span>
          )}
        </div>
      </button>

      {/* Remove button */}
      <button
        className={styles.removeBtn}
        onClick={() => onRemove(index)}
        type="button"
        aria-label={`Remove ${item.track.title} from queue`}
        title="Remove from queue"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>
  );
}

// ---- QueueView (exported) ----

export function QueueView() {
  const ctx = useMusicPlayer();
  const { queue, currentIndex, reorderQueue, dequeueAt, jumpTo } = ctx;

  // Save queue as playlist
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savePlaylistName, setSavePlaylistName] = useState("");
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const saveInputRef = useRef<HTMLInputElement | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        // Require 5px of movement before starting drag to allow normal clicks
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const fromIndex = queue.findIndex((item) => item.queueId === active.id);
    const toIndex = queue.findIndex((item) => item.queueId === over.id);

    if (fromIndex !== -1 && toIndex !== -1) {
      reorderQueue(fromIndex, toIndex);
    }
  }, [queue, reorderQueue]);

  // Focus save input when form opens
  useEffect(() => {
    if (showSaveForm) {
      setTimeout(() => saveInputRef.current?.focus(), 30);
    }
  }, [showSaveForm]);

  const handleSaveQueue = useCallback(async () => {
    const name = savePlaylistName.trim();
    if (!name || queue.length === 0) return;
    setSaveLoading(true);
    try {
      const trackIds = queue.map((item) => item.track.id);
      await window.electronAPI.music.playlistCreate({ name, trackIds });
      setSavePlaylistName("");
      setShowSaveForm(false);
      setSaveToast(`Queue saved as "${name}"`);
      setTimeout(() => setSaveToast(null), 3000);
    } catch {
      // Non-fatal — toast is skipped
    } finally {
      setSaveLoading(false);
    }
  }, [savePlaylistName, queue]);

  if (queue.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon} aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
            <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
          </svg>
        </span>
        <p className={styles.emptyText}>Your queue is empty.</p>
        <p className={styles.emptyHint}>Paste a URL above or browse your library.</p>
      </div>
    );
  }

  return (
    <div className={styles.queueContainer}>
      <div className={styles.queueHeader}>
        <span className={styles.queueCount}>{queue.length} track{queue.length !== 1 ? "s" : ""}</span>
        {!showSaveForm && (
          <button
            className={styles.saveQueueBtn}
            type="button"
            title="Save queue as playlist"
            onClick={() => {
              setSavePlaylistName("");
              setShowSaveForm(true);
            }}
          >
            Save as Playlist
          </button>
        )}
      </div>

      {/* Save queue form */}
      {showSaveForm && (
        <div className={styles.saveQueueForm}>
          <input
            ref={saveInputRef}
            className={styles.saveQueueInput}
            type="text"
            placeholder="Playlist name"
            value={savePlaylistName}
            onChange={(e) => setSavePlaylistName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSaveQueue();
              if (e.key === "Escape") setShowSaveForm(false);
            }}
            disabled={saveLoading}
          />
          <button
            className={styles.saveQueueConfirmBtn}
            type="button"
            onClick={() => void handleSaveQueue()}
            disabled={saveLoading || !savePlaylistName.trim()}
          >
            {saveLoading ? "Saving..." : "Save"}
          </button>
          <button
            className={styles.saveQueueCancelBtn}
            type="button"
            onClick={() => setShowSaveForm(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Toast */}
      {saveToast && <div className={styles.saveToast}>{saveToast}</div>}

      <div className={styles.trackList}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={queue.map((item) => item.queueId)}
            strategy={verticalListSortingStrategy}
          >
            {queue.map((item, index) => (
              <SortableQueueItem
                key={item.queueId}
                item={item}
                index={index}
                isCurrentTrack={index === currentIndex}
                onJumpTo={jumpTo}
                onRemove={dequeueAt}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
