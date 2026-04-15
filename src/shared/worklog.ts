import type { Session, TimerType } from "./types.ts";

const BULK_GAP_TOLERANCE_MS = 1000;

export interface WorklogMergeBlock {
  sessionIds: string[];
  uploadableSessionIds: string[];
  breakSessionIds: string[];
  startTime: string;
  endTime: string;
  durationSeconds: number;
  breakSeconds: number;
}

export interface WorklogMergeSummary {
  blocks: WorklogMergeBlock[];
  uploadableSessionIds: string[];
  breakSessionIds: string[];
  totalDurationSeconds: number;
  totalBreakSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
}

interface TimedSession {
  session: Session;
  startMs: number;
  endMs: number;
}

interface MutableWorklogMergeBlock {
  sessionIds: string[];
  uploadableSessionIds: string[];
  breakSessionIds: string[];
  startMs: number;
  endMs: number;
  breakSeconds: number;
}

export function isUploadableTimerType(timerType: TimerType): boolean {
  return timerType === "work" || timerType === "stopwatch";
}

export function isBreakTimerType(timerType: TimerType): boolean {
  return timerType === "short_break" || timerType === "long_break";
}

export function isUploadableSession(session: Pick<Session, "timerType">): boolean {
  return isUploadableTimerType(session.timerType);
}

export function isBreakSession(session: Pick<Session, "timerType">): boolean {
  return isBreakTimerType(session.timerType);
}

export function getSessionTimes(session: Pick<Session, "completedAt" | "actualDurationSeconds">): {
  startMs: number;
  endMs: number;
} {
  const endMs = new Date(session.completedAt).getTime();
  return {
    startMs: endMs - session.actualDurationSeconds * 1000,
    endMs,
  };
}

function toTimedSessions(sessions: Session[]): TimedSession[] {
  return sessions
    .map((session) => {
      const { startMs, endMs } = getSessionTimes(session);
      return { session, startMs, endMs };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function createBlock(timedSession: TimedSession): MutableWorklogMergeBlock {
  return {
    sessionIds: [timedSession.session.id],
    uploadableSessionIds: [timedSession.session.id],
    breakSessionIds: [],
    startMs: timedSession.startMs,
    endMs: timedSession.endMs,
    breakSeconds: 0,
  };
}

function appendBreak(block: MutableWorklogMergeBlock, timedSession: TimedSession): void {
  block.sessionIds.push(timedSession.session.id);
  block.breakSessionIds.push(timedSession.session.id);
  block.endMs = Math.max(block.endMs, timedSession.endMs);
  block.breakSeconds += timedSession.session.actualDurationSeconds;
}

function appendUploadable(block: MutableWorklogMergeBlock, timedSession: TimedSession): void {
  block.sessionIds.push(timedSession.session.id);
  block.uploadableSessionIds.push(timedSession.session.id);
  block.endMs = Math.max(block.endMs, timedSession.endMs);
}

function finalizeBlock(block: MutableWorklogMergeBlock): WorklogMergeBlock {
  return {
    sessionIds: block.sessionIds,
    uploadableSessionIds: block.uploadableSessionIds,
    breakSessionIds: block.breakSessionIds,
    startTime: new Date(block.startMs).toISOString(),
    endTime: new Date(block.endMs).toISOString(),
    durationSeconds: Math.max(0, Math.round((block.endMs - block.startMs) / 1000)),
    breakSeconds: block.breakSeconds,
  };
}

export function buildMergedWorklogBlocks(sessions: Session[]): WorklogMergeBlock[] {
  const timedSessions = toTimedSessions(sessions);
  const blocks: WorklogMergeBlock[] = [];

  let currentBlock: MutableWorklogMergeBlock | null = null;
  let pendingBreaks: TimedSession[] = [];

  for (const timedSession of timedSessions) {
    if (isUploadableSession(timedSession.session)) {
      if (!currentBlock) {
        currentBlock = createBlock(timedSession);
        pendingBreaks = [];
        continue;
      }

      const isContinuous = timedSession.startMs - currentBlock.endMs <= BULK_GAP_TOLERANCE_MS;
      if (pendingBreaks.length === 0 && !isContinuous) {
        blocks.push(finalizeBlock(currentBlock));
        currentBlock = createBlock(timedSession);
        continue;
      }

      for (const pendingBreak of pendingBreaks) {
        appendBreak(currentBlock, pendingBreak);
      }
      pendingBreaks = [];
      appendUploadable(currentBlock, timedSession);
      continue;
    }

    if (isBreakSession(timedSession.session) && currentBlock) {
      pendingBreaks.push(timedSession);
    }
  }

  if (currentBlock) {
    blocks.push(finalizeBlock(currentBlock));
  }

  return blocks;
}

export function summarizeMergedWorklogSessions(sessions: Session[]): WorklogMergeSummary {
  const blocks = buildMergedWorklogBlocks(sessions);
  const uploadableSessionIds = blocks.flatMap((block) => block.uploadableSessionIds);
  const breakSessionIds = blocks.flatMap((block) => block.breakSessionIds);

  return {
    blocks,
    uploadableSessionIds,
    breakSessionIds,
    totalDurationSeconds: blocks.reduce((sum, block) => sum + block.durationSeconds, 0),
    totalBreakSeconds: blocks.reduce((sum, block) => sum + block.breakSeconds, 0),
    startedAt: blocks[0]?.startTime ?? null,
    endedAt: blocks.at(-1)?.endTime ?? null,
  };
}
