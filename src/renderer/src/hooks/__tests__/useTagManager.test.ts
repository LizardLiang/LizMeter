import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tag } from "../../../../shared/types.ts";
import { useTagManager } from "../useTagManager.ts";

const makeTag = (id: number, name: string): Tag => ({
  id,
  name,
  color: "#7aa2f7",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const sampleTags = [makeTag(1, "bug"), makeTag(2, "feature")];

const mockTag = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  assign: vi.fn(),
  unassign: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", { tag: mockTag });
  mockTag.list.mockResolvedValue(sampleTags);
  mockTag.create.mockResolvedValue(makeTag(3, "docs"));
  mockTag.update.mockResolvedValue(makeTag(1, "BUG"));
  mockTag.delete.mockResolvedValue(undefined);
  mockTag.assign.mockResolvedValue(undefined);
  mockTag.unassign.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useTagManager — initial load", () => {
  it("starts with isLoading=true, then loads tags", async () => {
    const { result } = renderHook(() => useTagManager());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockTag.list).toHaveBeenCalledOnce();
    expect(result.current.tags).toEqual(sampleTags);
    expect(result.current.error).toBeNull();
  });

  it("sets error when list() rejects", async () => {
    mockTag.list.mockRejectedValueOnce(new Error("DB error"));

    const { result } = renderHook(() => useTagManager());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("DB error");
    expect(result.current.tags).toEqual([]);
  });

  it("sets generic error message for non-Error rejection", async () => {
    mockTag.list.mockRejectedValueOnce("plain string error");

    const { result } = renderHook(() => useTagManager());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe("Failed to load tags");
  });
});

describe("useTagManager — createTag", () => {
  it("calls tag.create and reloads tags, returns created tag", async () => {
    const { result } = renderHook(() => useTagManager());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const created = makeTag(3, "docs");
    mockTag.create.mockResolvedValueOnce(created);
    // After create, list returns updated tags
    mockTag.list.mockResolvedValueOnce([...sampleTags, created]);

    let returnedTag: Tag | undefined;
    await act(async () => {
      returnedTag = await result.current.createTag({ name: "docs", color: "#7aa2f7" });
    });

    expect(mockTag.create).toHaveBeenCalledWith({ name: "docs", color: "#7aa2f7" });
    expect(mockTag.list).toHaveBeenCalledTimes(2); // initial + after create
    expect(returnedTag).toEqual(created);
  });
});

describe("useTagManager — updateTag", () => {
  it("calls tag.update and reloads tags, returns updated tag", async () => {
    const { result } = renderHook(() => useTagManager());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const updated = makeTag(1, "BUG");
    mockTag.update.mockResolvedValueOnce(updated);

    let returnedTag: Tag | undefined;
    await act(async () => {
      returnedTag = await result.current.updateTag({ id: 1, name: "BUG", color: "#7aa2f7" });
    });

    expect(mockTag.update).toHaveBeenCalledWith({ id: 1, name: "BUG", color: "#7aa2f7" });
    expect(mockTag.list).toHaveBeenCalledTimes(2);
    expect(returnedTag).toEqual(updated);
  });
});

describe("useTagManager — deleteTag", () => {
  it("calls tag.delete with the id and reloads tags", async () => {
    const { result } = renderHook(() => useTagManager());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.deleteTag(2);
    });

    expect(mockTag.delete).toHaveBeenCalledWith(2);
    expect(mockTag.list).toHaveBeenCalledTimes(2);
  });
});

describe("useTagManager — assignTag", () => {
  it("calls tag.assign with sessionId and tagId", async () => {
    const { result } = renderHook(() => useTagManager());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.assignTag("session-abc", 1);
    });

    expect(mockTag.assign).toHaveBeenCalledWith({ sessionId: "session-abc", tagId: 1 });
    // assignTag does NOT reload tags
    expect(mockTag.list).toHaveBeenCalledTimes(1);
  });
});

describe("useTagManager — unassignTag", () => {
  it("calls tag.unassign with sessionId and tagId", async () => {
    const { result } = renderHook(() => useTagManager());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.unassignTag("session-abc", 2);
    });

    expect(mockTag.unassign).toHaveBeenCalledWith({ sessionId: "session-abc", tagId: 2 });
    expect(mockTag.list).toHaveBeenCalledTimes(1);
  });
});
