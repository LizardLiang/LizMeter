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

// Flushes chained promise .then/.catch continuations (e.g. the auto-skip retry
// chain, which recurses through several microtask hops per failed attempt).
async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// ---- Fixtures for the multi-track auto-skip / dequeue / interrupt tests ----

const trackA = makeTrack({ id: "a", sourceUrl: "https://example.com/a", sourceId: "a", title: "Track A" });
const trackB = makeTrack({
  id: "b",
  sourceUrl: "https://example.com/b",
  sourceId: "b",
  title: "Track B",
  isCached: false,
});
const trackC = makeTrack({
  id: "c",
  sourceUrl: "https://example.com/c",
  sourceId: "c",
  title: "Track C",
  isCached: false,
});
const trackD = makeTrack({ id: "d", sourceUrl: "https://example.com/d", sourceId: "d", title: "Track D" });
const trackDup = makeTrack({ id: "dup", sourceUrl: "https://example.com/dup", sourceId: "dup", title: "Dup Track" });
const trackDupCopy = makeTrack({
  id: "dup-copy",
  sourceUrl: "https://example.com/dup",
  sourceId: "dup",
  title: "Dup Track Copy",
});
const trackE = makeTrack({ id: "e", sourceUrl: "https://example.com/e", sourceId: "e", title: "Track E" });
const trackTransient = makeTrack({
  id: "transient",
  sourceUrl: "https://example.com/transient",
  sourceId: "transient",
  title: "Transient Track",
});

function MultiHarness() {
  const player = useMusicPlayer();
  return (
    <>
      <button onClick={() => player.enqueueBulk([trackA, trackB, trackC, trackD])}>seed-4</button>
      <button onClick={() => player.enqueueBulk([trackA, trackB, trackC, trackD, trackE])}>seed-5</button>
      <button onClick={() => player.enqueueBulk([trackA, trackB])}>seed-2</button>
      <button onClick={() => player.enqueueBulk([trackDup, trackDupCopy, trackE])}>seed-dup</button>
      <button onClick={() => void player.jumpTo(0)}>jump-0</button>
      <button onClick={() => void player.jumpTo(2)}>jump-2</button>
      <button onClick={() => player.next()}>next</button>
      <button onClick={() => player.dequeueAt(0)}>dequeue-0</button>
      <button onClick={() => player.dequeueAt(1)}>dequeue-1</button>
      <button onClick={() => player.removeTrackFromQueue("dup")}>remove-dup</button>
      <button onClick={() => player.removeTrackFromQueue("c")}>remove-c</button>
      <button onClick={() => player.setShuffleEnabled(true)}>shuffle-on</button>
      <button onClick={() => void player.play(trackTransient.sourceUrl, trackTransient)}>play-transient</button>
      <div data-testid="track-title">{player.currentTrack?.title ?? "none"}</div>
      <div data-testid="current-index">{player.currentIndex}</div>
      <div data-testid="playback-state">{player.playbackState}</div>
      <div data-testid="queue-length">{player.queueLength}</div>
      <div data-testid="consecutive-failures">{player.consecutiveFailures}</div>
      <div data-testid="last-error">{player.lastError ?? "none"}</div>
    </>
  );
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

  it("auto-skips past a failed next track instead of snapping back to the previous one", async () => {
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
      await flushMicrotasks();
    });

    // Track 2 was the last (and only) remaining track to try — the chain gives up
    // with Track 2 (and its error) visible, rather than reverting to Track 1.
    expect(screen.getByTestId("track-title").textContent).toBe("Track 2");
    expect(screen.getByTestId("current-index").textContent).toBe("1");
    expect(screen.getByTestId("playback-state").textContent).toBe("stopped");
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

  it("auto-skips through consecutive failures until a track plays successfully", async () => {
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/a")) return Promise.resolve(makePlayResult(trackA));
      if (url.endsWith("/b")) return Promise.reject(new Error("b failed"));
      if (url.endsWith("/c")) return Promise.reject(new Error("c failed"));
      if (url.endsWith("/d")) return Promise.resolve(makePlayResult(trackD));
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-4"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-0"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track A");

    await act(async () => {
      fireEvent.click(screen.getByText("next"));
      await flushMicrotasks();
    });

    // Skips the two failing tracks (B, C) and lands on the third attempt (D).
    expect(screen.getByTestId("track-title").textContent).toBe("Track D");
    expect(screen.getByTestId("current-index").textContent).toBe("3");
    expect(screen.getByTestId("consecutive-failures").textContent).toBe("0");
    expect(screen.getByTestId("last-error").textContent).toBe("none");
  });

  it("stops after 3 consecutive failures instead of looping or snapping back", async () => {
    // 5 tracks seeded (A succeeds, B/C/D fail, E would succeed) so the test can
    // actually distinguish a cap of 3 from a cap of 4: with only 3 failing
    // candidates (B, C, D) available, the chain would stop at D regardless of
    // whether the cap is 3 or 4 (queue exhaustion vs. cap enforcement look
    // identical). Track E proves it's the cap — not exhaustion — that stops
    // the chain: if the cap were ever 4, E would be attempted and would
    // succeed, changing the final track-title.
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/a")) return Promise.resolve(makePlayResult(trackA));
      if (url.endsWith("/b")) return Promise.reject(new Error("b failed"));
      if (url.endsWith("/c")) return Promise.reject(new Error("c failed"));
      if (url.endsWith("/d")) return Promise.reject(new Error("d failed"));
      if (url.endsWith("/e")) return Promise.resolve(makePlayResult(trackE));
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-5"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-0"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track A");

    await act(async () => {
      fireEvent.click(screen.getByText("next"));
      await flushMicrotasks();
    });

    // Gives up after 3 consecutive failures (B, C, D) — stays on the last
    // attempted track with the error surfaced, rather than reverting to Track A
    // or continuing on to Track E.
    expect(screen.getByTestId("track-title").textContent).toBe("Track D");
    expect(screen.getByTestId("current-index").textContent).toBe("3");
    expect(screen.getByTestId("consecutive-failures").textContent).toBe("3");
    expect(screen.getByTestId("last-error").textContent).toBe("d failed");
    expect(screen.getByTestId("playback-state").textContent).toBe("stopped");
    expect(playMock).not.toHaveBeenCalledWith({ url: trackE.sourceUrl });
  });

  it("caps total attempts at 3 (not 4) when the currently playing track errors mid-playback", async () => {
    // Regression test for the failure-cap bug: handleAudioError used to
    // increment consecutiveFailures for the errored track and then call
    // handleNext(), which reseeds the auto-skip chain at failureCount=0 —
    // letting it attempt 3 MORE tracks on top of the one that just errored (4
    // total). Track A errors mid-playback (counts as attempt #1), then B and C
    // must fail (attempts #2 and #3) before the chain gives up — Track D must
    // never be attempted even though it would succeed if reached.
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/a")) return Promise.resolve(makePlayResult(trackA));
      if (url.endsWith("/b")) return Promise.reject(new Error("b failed"));
      if (url.endsWith("/c")) return Promise.reject(new Error("c failed"));
      if (url.endsWith("/d")) return Promise.resolve(makePlayResult(trackD));
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-4"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-0"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track A");
    expect(screen.getByTestId("consecutive-failures").textContent).toBe("0");

    const audio = audioInstances[0];
    expect(audio).toBeDefined();
    if (!audio) {
      throw new Error("Expected audio instance");
    }

    await act(async () => {
      audio.dispatch("error");
      await flushMicrotasks();
    });

    // Total attempts across the whole chain: A (errored) + B (failed) + C
    // (failed) = 3. D is never attempted.
    expect(screen.getByTestId("track-title").textContent).toBe("Track C");
    expect(screen.getByTestId("current-index").textContent).toBe("2");
    expect(screen.getByTestId("consecutive-failures").textContent).toBe("3");
    expect(screen.getByTestId("last-error").textContent).toBe("c failed");
    expect(screen.getByTestId("playback-state").textContent).toBe("stopped");
    expect(playMock).not.toHaveBeenCalledWith({ url: trackD.sourceUrl });
  });

  it("dequeueAt of the current track discards a late-resolving play", async () => {
    const deferred = createDeferred<MusicPlayResult>();
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/b")) return deferred.promise;
      return Promise.resolve(makePlayResult(trackA));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-2"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-0"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track A");

    await act(async () => {
      fireEvent.click(screen.getByText("next"));
      await Promise.resolve();
    });

    // Optimistic switch to Track B (index 1) while its play() call is pending.
    expect(screen.getByTestId("current-index").textContent).toBe("1");

    await act(async () => {
      fireEvent.click(screen.getByText("dequeue-1"));
    });

    expect(screen.getByTestId("track-title").textContent).toBe("none");
    expect(screen.getByTestId("current-index").textContent).toBe("-1");
    expect(screen.getByTestId("queue-length").textContent).toBe("1");

    await act(async () => {
      deferred.resolve(makePlayResult(trackB));
      await flushMicrotasks();
    });

    // The late resolution must not resurrect Track B after it was dequeued.
    expect(screen.getByTestId("track-title").textContent).toBe("none");
    expect(screen.getByTestId("current-index").textContent).toBe("-1");
  });

  it("dequeueAt before the current index does not revert the index once an in-flight play resolves", async () => {
    // Regression test: dequeueAt of an item BEFORE the current index doesn't
    // invalidate the in-flight play request for the current track (only
    // removing the current item itself does that), so when the request
    // resolves, commitPlaybackResult must recompute the index against the live
    // (post-removal) queue instead of trusting the stale pre-removal index it
    // captured when the request began — otherwise it overwrites the correctly
    // decremented currentIndex and produces an off-by-one highlight.
    const deferred = createDeferred<MusicPlayResult>();
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/c")) return deferred.promise;
      if (url.endsWith("/a")) return Promise.resolve(makePlayResult(trackA));
      if (url.endsWith("/b")) return Promise.resolve(makePlayResult(trackB));
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-4"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-2"));
      await Promise.resolve();
    });

    // Track C (index 2) is optimistically shown while its play() call is
    // pending (deferred).
    expect(screen.getByTestId("current-index").textContent).toBe("2");

    await act(async () => {
      fireEvent.click(screen.getByText("dequeue-0"));
    });

    // Track A (index 0, before the current index) was removed — the current
    // index shifts down to 1, while the in-flight request for Track C remains
    // valid (it was never invalidated).
    expect(screen.getByTestId("current-index").textContent).toBe("1");
    expect(screen.getByTestId("queue-length").textContent).toBe("3");

    await act(async () => {
      deferred.resolve(makePlayResult(trackC));
      await flushMicrotasks();
    });

    // The late-resolving commit must respect the shifted index, not revert to
    // the stale captured index (2).
    expect(screen.getByTestId("track-title").textContent).toBe("Track C");
    expect(screen.getByTestId("current-index").textContent).toBe("1");
  });

  it("play() interrupts the queue instead of silently enqueueing", async () => {
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/a")) return Promise.resolve(makePlayResult(trackA));
      if (url.endsWith("/b")) return Promise.resolve(makePlayResult(trackB));
      if (url.endsWith("/transient")) return Promise.resolve(makePlayResult(trackTransient));
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-2"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-0"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Track A");
    expect(screen.getByTestId("queue-length").textContent).toBe("2");

    await act(async () => {
      fireEvent.click(screen.getByText("play-transient"));
      await Promise.resolve();
    });

    // Inserted right after the current track and switched to immediately —
    // not silently appended to the end of the queue.
    expect(screen.getByTestId("track-title").textContent).toBe("Transient Track");
    expect(screen.getByTestId("current-index").textContent).toBe("1");
    expect(screen.getByTestId("queue-length").textContent).toBe("3");
  });

  it("removeTrackFromQueue purges duplicate entries and stops+advances past the current track", async () => {
    playMock.mockImplementation(({ url }: { url: string; }) => {
      if (url.endsWith("/dup")) return Promise.resolve(makePlayResult(trackDup));
      if (url.endsWith("/e")) return Promise.resolve(makePlayResult(trackE));
      return Promise.reject(new Error(`unexpected url: ${url}`));
    });

    render(
      <MusicPlayerProvider>
        <MultiHarness />
      </MusicPlayerProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("seed-dup"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("jump-0"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("track-title").textContent).toBe("Dup Track");
    expect(screen.getByTestId("queue-length").textContent).toBe("3");

    await act(async () => {
      fireEvent.click(screen.getByText("remove-dup"));
      await flushMicrotasks();
    });

    // Both the playing entry (id "dup") and its pre-upsert duplicate (same
    // sourceUrl, different id) are purged; only Track E remains and playback
    // advances to it instead of going idle.
    expect(screen.getByTestId("queue-length").textContent).toBe("1");
    expect(screen.getByTestId("track-title").textContent).toBe("Track E");
    expect(screen.getByTestId("current-index").textContent).toBe("0");
  });

  it("removeTrackFromQueue while shuffle is on advances to a valid remaining track when the current track is deleted", async () => {
    // Regression test: removeTrackFromQueue synced queueRef/currentIndexRef
    // synchronously but relied on a useEffect (one render later) to sync
    // shuffleOrderRef. advanceFromRef is invoked in the very same tick, so it
    // used to read the STALE pre-removal shuffle order — producing an
    // out-of-bounds index (silent no-op / idle player) or the wrong track.
    // Math.random is pinned to 0 so buildShuffleOrder's Fisher-Yates output is
    // deterministic and the assertions below are exact, not just "some valid
    // track".
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      playMock.mockImplementation(({ url }: { url: string; }) => {
        if (url.endsWith("/a")) return Promise.resolve(makePlayResult(trackA));
        if (url.endsWith("/c")) return Promise.resolve(makePlayResult(trackC));
        return Promise.reject(new Error(`unexpected url: ${url}`));
      });

      render(
        <MusicPlayerProvider>
          <MultiHarness />
        </MusicPlayerProvider>,
      );

      await act(async () => {
        fireEvent.click(screen.getByText("seed-4"));
        await Promise.resolve();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("jump-2"));
        await Promise.resolve();
      });

      expect(screen.getByTestId("track-title").textContent).toBe("Track C");

      await act(async () => {
        fireEvent.click(screen.getByText("shuffle-on"));
      });

      await act(async () => {
        fireEvent.click(screen.getByText("remove-c"));
        await flushMicrotasks();
      });

      // Track C (currently playing, index 2) is removed. The player must land
      // on a valid remaining track (deterministically Track A here, given the
      // pinned Math.random) rather than going idle or picking an out-of-bounds
      // index from the stale shuffle order.
      expect(screen.getByTestId("queue-length").textContent).toBe("3");
      expect(screen.getByTestId("track-title").textContent).toBe("Track A");
      expect(screen.getByTestId("current-index").textContent).toBe("0");
      expect(screen.getByTestId("playback-state").textContent).not.toBe("stopped");
    } finally {
      randomSpy.mockRestore();
    }
  });
});
