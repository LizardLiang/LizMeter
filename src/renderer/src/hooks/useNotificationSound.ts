// src/renderer/src/hooks/useNotificationSound.ts
// Generates and plays a gentle chime sound using the Web Audio API.
// No audio files required — the chime is synthesised at runtime.

import { useCallback, useEffect, useRef, useState } from "react";

const SETTINGS_KEY = "notification_sound_enabled";

/**
 * Plays a three-note ascending chime: E5 → G#5 → B5.
 * Each note uses a sine oscillator with a soft envelope (quick attack, long decay).
 * Total duration is approximately 1.8 seconds.
 */
function playChime(ctx: AudioContext): void {
  // Three notes in sequence (millisecond offsets from now)
  const notes: Array<{ freq: number; startMs: number; durationMs: number; peakGain: number; }> = [
    { freq: 659.25, startMs: 0, durationMs: 1200, peakGain: 0.22 }, // E5
    { freq: 830.61, startMs: 220, durationMs: 1100, peakGain: 0.18 }, // G#5
    { freq: 987.77, startMs: 440, durationMs: 1400, peakGain: 0.15 }, // B5
  ];

  const now = ctx.currentTime;

  for (const note of notes) {
    const startAt = now + note.startMs / 1000;

    // Oscillator
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(note.freq, startAt);

    // Gain envelope: attack 0.008s, then exponential decay to near-silence
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.linearRampToValueAtTime(note.peakGain, startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.durationMs / 1000);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startAt);
    osc.stop(startAt + note.durationMs / 1000);
  }
}

export interface UseNotificationSoundReturn {
  /** Play the chime immediately (no-op if sound is disabled, loading, or AudioContext unavailable). */
  playSound: () => void;
  /** Whether the notification sound is enabled. */
  soundEnabled: boolean;
  /** Toggle or explicitly set the sound enabled state. Persists the preference. */
  setSoundEnabled: (enabled: boolean) => void;
}

export function useNotificationSound(): UseNotificationSoundReturn {
  const [soundEnabled, setSoundEnabledState] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Load persisted preference on mount
  useEffect(() => {
    window.electronAPI.settings
      .getValue(SETTINGS_KEY)
      .then((val) => {
        setSoundEnabledState(val !== "false");
      })
      .catch(() => {
        // On error, keep default (enabled)
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  // Clean up AudioContext on unmount
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSoundEnabledState(enabled);
    window.electronAPI.settings
      .setValue(SETTINGS_KEY, enabled ? "true" : "false")
      .catch(() => {
        // Non-fatal — preference not persisted but state is updated in memory
      });
  }, []);

  const playSound = useCallback(() => {
    if (isLoading || !soundEnabled) return;

    try {
      // Lazily create (or resume) the AudioContext on first use.
      // AudioContext must be created/resumed after a user gesture in some browsers,
      // but Electron's Chromium renderer is permissive enough for programmatic use.
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;

      // Resume if suspended (e.g., auto-suspended by browser policy)
      if (ctx.state === "suspended") {
        ctx.resume().then(() => playChime(ctx)).catch(() => {});
      } else {
        playChime(ctx);
      }
    } catch {
      // Non-fatal — sound failure must never break the timer
    }
  }, [isLoading, soundEnabled]);

  return { playSound, soundEnabled, setSoundEnabled };
}
