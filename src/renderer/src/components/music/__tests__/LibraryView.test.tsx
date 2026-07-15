import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicTrack } from "../../../../shared/types.ts";
import { MusicPlayerProvider } from "../../../contexts/MusicPlayerContext.tsx";
import { LibraryView } from "../LibraryView.tsx";

function makeTrack(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    id: "track-1",
    sourceUrl: "https://example.com/track-1",
    sourceId: "track-1",
    sourceSite: "youtube",
    title: "Track 1",
    artist: "Artist",
    durationSeconds: 180,
    thumbnailUrl: null,
    isCached: true,
    cacheSizeBytes: 1024,
    playCount: 0,
    lastPlayedAt: null,
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("LibraryView", () => {
  const libraryDeleteMock = vi.fn().mockResolvedValue(undefined);
  const libraryClearMock = vi.fn().mockResolvedValue(undefined);
  const libraryListMock = vi.fn();

  beforeEach(() => {
    // jsdom has no IntersectionObserver — LibraryView's infinite-scroll sentinel needs a stub.
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    libraryDeleteMock.mockClear();
    libraryClearMock.mockClear();
    libraryListMock.mockReset();

    vi.stubGlobal("electronAPI", {
      settings: {
        getValue: vi.fn().mockResolvedValue(null),
        setValue: vi.fn().mockResolvedValue(undefined),
      },
      music: {
        play: vi.fn().mockResolvedValue({ streamUrl: "", track: makeTrack(), fromCache: false }),
        stop: vi.fn().mockResolvedValue(undefined),
        binaryStatus: vi.fn().mockResolvedValue({
          ytDlpInstalled: true,
          ffmpegInstalled: true,
          ytDlpVersion: "test",
        }),
        integrityRepair: vi.fn().mockResolvedValue(0),
        integrityCheck: vi.fn().mockResolvedValue({ damaged: [], checked: 0, error: null }),
        libraryList: libraryListMock,
        libraryDelete: libraryDeleteMock,
        libraryClear: libraryClearMock,
        playlistList: vi.fn().mockResolvedValue([]),
        playlistAddTrack: vi.fn().mockResolvedValue({}),
        playlistTracks: vi.fn().mockResolvedValue([]),
        onImportProgress: vi.fn().mockReturnValue(() => {}),
        onStreamCached: vi.fn().mockReturnValue(() => {}),
        onMediaKey: vi.fn().mockReturnValue(() => {}),
        onPlaylistImported: vi.fn().mockReturnValue(() => {}),
        onIntegrityProgress: vi.fn().mockReturnValue(() => {}),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("deletes a track from the library via the track context menu", async () => {
    const track = makeTrack();
    libraryListMock.mockResolvedValue({ tracks: [track], total: 1 });

    render(
      <MusicPlayerProvider>
        <LibraryView />
      </MusicPlayerProvider>,
    );

    await waitFor(() => expect(screen.getByText("Track 1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Track options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete from Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(libraryDeleteMock).toHaveBeenCalledWith("track-1"));
    // Called once on initial mount, once again after the delete triggers lib.refresh().
    await waitFor(() => expect(libraryListMock).toHaveBeenCalledTimes(2));
  });

  it("clears the entire library via the Clear Library confirmation dialog", async () => {
    const track = makeTrack();
    libraryListMock.mockResolvedValue({ tracks: [track], total: 1 });

    render(
      <MusicPlayerProvider>
        <LibraryView />
      </MusicPlayerProvider>,
    );

    await waitFor(() => expect(screen.getByText("Track 1")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("Delete all tracks and cached files"));

    const clearButtons = screen.getAllByRole("button", { name: "Clear Library" });
    // Index 0 is the trigger button in the controls row; index 1 is the dialog's
    // confirm button (both share the same label by design).
    fireEvent.click(clearButtons[1]!);

    await waitFor(() => expect(libraryClearMock).toHaveBeenCalledTimes(1));
    // Called once on initial mount, once again after the clear triggers lib.refresh().
    await waitFor(() => expect(libraryListMock).toHaveBeenCalledTimes(2));
  });
});
