// src/renderer/src/hooks/useMusicQueue.ts
// Re-exports queue state and operations from MusicPlayerContext.
//
// Architecture note: the queue is managed inside MusicPlayerContext (T1.8),
// not as a standalone hook, because it is deeply coupled to playback state
// (currentIndex, shuffle order, auto-advance on ended). This file provides
// a convenience re-export so components can import from useMusicQueue without
// depending directly on MusicPlayerContext.
//
// This hook must be used within a MusicPlayerProvider.

import type { MusicQueueItem } from "../../../shared/types.ts";
import { useMusicPlayer } from "../contexts/MusicPlayerContext.tsx";

export interface UseMusicQueueReturn {
  tracks: MusicQueueItem[];
  currentIndex: number;
  shuffleEnabled: boolean;
  enqueue: (track: import("../../../shared/types.ts").MusicTrack, playlistId?: number) => void;
  enqueueBulk: (tracks: import("../../../shared/types.ts").MusicTrack[], playlistId?: number) => void;
  dequeueAt: (index: number) => void;
  reorderQueue: (from: number, to: number) => void;
  jumpTo: (index: number) => void;
  clearQueue: () => void;
  setShuffleEnabled: (s: boolean) => void;
}

export function useMusicQueue(): UseMusicQueueReturn {
  const ctx = useMusicPlayer();
  return {
    tracks: ctx.queue,
    currentIndex: ctx.currentIndex,
    shuffleEnabled: ctx.shuffleEnabled,
    enqueue: ctx.enqueue,
    enqueueBulk: ctx.enqueueBulk,
    dequeueAt: ctx.dequeueAt,
    reorderQueue: ctx.reorderQueue,
    jumpTo: ctx.jumpTo,
    clearQueue: ctx.clearQueue,
    setShuffleEnabled: ctx.setShuffleEnabled,
  };
}
