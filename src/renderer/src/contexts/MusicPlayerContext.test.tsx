import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicPlayResult } from "../../../shared/types.ts";
import type { MusicTrack } from "../../../shared/types.ts";
import { MusicPlayerProvider, useMusicPlayer } from "./MusicPlayerContext.tsx";

class MockAudio {
  preload = "";
  src = "";
  currentTime = 0;
  duration = 300;
  volume = 1;
  muted = false;
  playbackRate = 1;
  paused = true;
  ended = false;
  buffered = { length: 0, end: () => 0, start: () => 0 } as TimeRanges;
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  dispatch(type: string) {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makeTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "track-1",
    sourceUrl: "https://example.com/track-1",
    sourceId: "track-1",
    sourceSite: "youtube",
    title: "Track 1",
    artist: "Artist",
    durationSeconds: 300,
    thumbnailUrl: null,
    isCached: true,
    cacheSizeBytes: 1024,
    playCount: 0,
    lastPlayedAt: null,
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePlayResult(track: MusicTrack, streamUrl = `http://127.0.0.1/audio/${track.id}`): MusicPlayResult {
  return {
    streamUrl,
    track,
    fromCache: track.isCached,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness() {
  const player = useMusicPlayer();
  const track1 = makeTrack();
  const track2 = makeTrack({
    id: "track-2",
    sourceUrl: "https://example.com/track-2",
    sourceId: "track-2",
    title: "Track 2",
  });

  return (
    <>
      <button onClick={() => void player.play(track1.sourceUrl, track1)}>play-first</button>
      <button onClick={() => void player.play(track2.sourceUrl, track2)}>play-second</button>
      <button onClick={() => player.enqueueBulk([track1, track2])}>seed-queue</button>
      <button onClick={() => void player.jumpTo(0)}>jump-first</button>
      <button onClick={() => player.next()}>next</button>
      <div data-testid="playback-state">{player.playbackState}</div>
      <div data-testid="track-title">{player.currentTrack?.title ?? "none"}</div>
      <div data-testid="current-index">{player.currentIndex}</div>
      <div data-testid="duration">{player.duration}</div>
    </>
  );
}

describe("MusicPlayerContext", () => {
  const audioInstances: MockAudio[] = [];
  const playMock = vi.fn();
  const integrityRepairMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    audioInstances.length = 0;

    vi.stubGlobal("Audio", function AudioMock() {
      const audio = new MockAudio();
      audioInstances.push(audio);
      return audio;
    });

    playMock.mockReset();
    integrityRepairMock.mockReset();

    playMock.mockImplementation(async ({ url }: { url: string; }) => {
      const track = url.endsWith("track-2")
        ? makeTrack({
          id: "track-2",
          sourceUrl: url,
          sourceId: "track-2",
          title: "Track 2",
          isCached: false,
        })
        : makeTrack({ sourceUrl: url });
      return makePlayResult(track);
    });

    integrityRepairMock.mockResolvedValue(1);

    vi.stubGlobal("electronAPI", {
      settings: {
        getValue: vi.fn().mockResolvedValue(null),
        setValue: vi.fn().mockResolvedValue(undefined),
      },
      music: {
        play: playMock,
        stop: vi.fn().mockResolvedValue(undefined),
        binaryStatus: vi.fn().mockResolvedValue({
          ytDlpInstalled: true,
          ffmpegInstalled: true,
          ytDlpVersion: "test",
        }),
        integrityRepair: integrityRepairMock,
        onImportProgress: vi.fn().mockReturnValue(() => {}),
        onStreamCached: vi.fn().mockReturnValue(() => {}),
        onMediaKey: vi.fn().mockReturnValue(() => {}),
        onPlaylistImported: vi.fn().mockReturnValue(() => {}),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("repairs and retries a cached track that stalls in buffering", async () => {
    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("play-first"));
      await Promise.resolve();
    });

    expect(playMock).toHaveBeenCalledTimes(1);

    const audio = audioInstances[0];
    expect(audio).toBeDefined();
    if (!audio) {
      throw new Error("Expected audio instance");
    }

    await act(async () => {
      audio.currentTime = 270;
      audio.dispatch("timeupdate");
    });

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(integrityRepairMock).toHaveBeenCalledWith(["track-1"]);
    expect(playMock).toHaveBeenCalledTimes(2);
  });

  it("shows the clicked track immediately while playback is loading", async () => {
    const deferred = createDeferred<MusicPlayResult>();
    playMock.mockImplementation(() => deferred.promise);

    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("play-first"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track 1");
    expect(screen.getByTestId("playback-state").textContent).toBe("buffering");
    expect(screen.getByTestId("current-index").textContent).toBe("0");

    await act(async () => {
      deferred.resolve(makePlayResult(makeTrack()));
      await deferred.promise;
    });
  });

  it("ignores stale playback responses when tracks are clicked quickly", async () => {
    const firstDeferred = createDeferred<MusicPlayResult>();
    const secondDeferred = createDeferred<MusicPlayResult>();
    playMock.mockImplementation(({ url }: { url: string; }) => {
      return url.endsWith("track-2") ? secondDeferred.promise : firstDeferred.promise;
    });

    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("play-first"));
      fireEvent.click(screen.getByText("play-second"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track 2");
    expect(screen.getByTestId("playback-state").textContent).toBe("buffering");

    await act(async () => {
      firstDeferred.resolve(makePlayResult(makeTrack()));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track 2");
    expect(screen.getByTestId("playback-state").textContent).toBe("buffering");

    await act(async () => {
      secondDeferred.resolve(makePlayResult(makeTrack({
        id: "track-2",
        sourceUrl: "https://example.com/track-2",
        sourceId: "track-2",
        title: "Track 2",
      })));
      await secondDeferred.promise;
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track 2");
  });

  it("rolls back to the previous track when next track loading fails", async () => {
    const firstTrack = makeTrack();
    const secondTrack = makeTrack({
      id: "track-2",
      sourceUrl: "https://example.com/track-2",
      sourceId: "track-2",
      title: "Track 2",
      isCached: false,
    });

    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("track-2")) {
        return Promise.reject(new Error("Track 2 failed"));
      }
      return Promise.resolve(makePlayResult(url.endsWith("track-1") ? firstTrack : secondTrack));
    });

    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-queue"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-first"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track 1");

    await act(async () => {
      fireEvent.click(screen.getByText("next"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track 1");
    expect(screen.getByTestId("current-index").textContent).toBe("0");
  });

  it("falls back to durationSeconds when audio element duration is unknown", async () => {
    playMock.mockImplementation(async () => {
      return makePlayResult(makeTrack({ durationSeconds: 240, isCached: false }));
    });

    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("play-first"));
      await Promise.resolve();
    });

    const audio = audioInstances[0]!;
    // Simulate a chunked stream: browser sets duration to Infinity, hook clamps to 0
    audio.duration = Infinity;
    await act(async () => {
      audio.dispatch("durationchange");
    });

    expect(screen.getByTestId("duration").textContent).toBe("240");
  });

  it("does not auto-repair a streamed track near end of its known duration", async () => {
    playMock.mockImplementation(async () => {
      return makePlayResult(makeTrack({ durationSeconds: 300, isCached: true }));
    });

    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("play-first"));
      await Promise.resolve();
    });

    const audio = audioInstances[0]!;
    // Stream: browser has no Content-Length → duration stays Infinity → clamped to 0
    audio.duration = Infinity;
    await act(async () => {
      audio.dispatch("durationchange");
    });

    // Simulate playback near the end (within 2s of durationSeconds)
    await act(async () => {
      audio.currentTime = 299;
      audio.dispatch("timeupdate");
    });

    // Advance past stall threshold
    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(integrityRepairMock).not.toHaveBeenCalled();
  });

  it("does not auto-repair when no duration info is available at all", async () => {
    playMock.mockImplementation(async () => {
      return makePlayResult(makeTrack({ durationSeconds: null, isCached: true }));
    });

    render(
      <MusicPlayerProvider>
        <Harness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("play-first"));
      await Promise.resolve();
    });

    const audio = audioInstances[0]!;
    audio.duration = Infinity;
    await act(async () => {
      audio.dispatch("durationchange");
    });

    // Mid-playback position — stall detector should still skip (no duration to compare)
    await act(async () => {
      audio.currentTime = 50;
      audio.dispatch("timeupdate");
    });

    await act(async () => {
      vi.advanceTimersByTime(6000);
      await Promise.resolve();
    });

    expect(integrityRepairMock).not.toHaveBeenCalled();
  });
});
