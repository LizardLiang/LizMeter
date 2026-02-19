// src/shared/types.ts
// Shared TypeScript type definitions used by both main process and renderer

// --- Timer Types ---

export type TimerType = "work" | "short_break" | "long_break";

export type TimerStatus = "idle" | "running" | "paused" | "completed";

// --- Session Types ---

export interface Session {
  id: string; // UUID v4
  title: string; // user-entered title, may be empty string
  timerType: TimerType; // which timer mode was used
  plannedDurationSeconds: number; // configured duration
  actualDurationSeconds: number; // elapsed active time (excludes pauses)
  completedAt: string; // ISO 8601 timestamp
}

export interface SaveSessionInput {
  title: string;
  timerType: TimerType;
  plannedDurationSeconds: number;
  actualDurationSeconds: number;
}

export interface ListSessionsInput {
  limit?: number; // default 50
  offset?: number; // default 0
}

export interface ListSessionsResult {
  sessions: Session[];
  total: number; // total count for pagination
}

// --- Settings Types ---

export interface TimerSettings {
  workDuration: number; // seconds
  shortBreakDuration: number; // seconds
  longBreakDuration: number; // seconds
}

// --- Electron API (exposed via contextBridge) ---

export interface ElectronAPI {
  platform: string;
  session: {
    save: (input: SaveSessionInput) => Promise<Session>;
    list: (input: ListSessionsInput) => Promise<ListSessionsResult>;
    delete: (id: string) => Promise<void>;
  };
  settings: {
    get: () => Promise<TimerSettings>;
    save: (settings: TimerSettings) => Promise<void>;
  };
}
