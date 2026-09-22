// useTodoCopyActions hook tests
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, TodoState } from "../../../../shared/types.ts";
import { useTodoCopyActions } from "../useTodoCopyActions.ts";

const todoState: TodoState = {
  id: 1,
  label: "Todo",
  color: "#7aa2f7",
  position: 0,
  isCompleted: false,
  isDefault: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeTodo(id: number, title: string, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    title,
    notes: null,
    state: todoState,
    project: null,
    labels: [],
    milestone: null,
    priority: 0,
    startDate: null,
    dueDate: null,
    source: "user",
    sourceLabel: null,
    parentId: null,
    parentTitle: null,
    childCount: 0,
    completedChildCount: 0,
    createdAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
    ...extra,
  };
}

const originalClipboard = navigator.clipboard;

beforeEach(() => {
  vi.stubGlobal("electronAPI", { todo: { list: vi.fn().mockResolvedValue([]) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("useTodoCopyActions -- copyId", () => {
  it("writes `#<id>` to the clipboard and arms \"copied\" feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { result } = renderHook(() => useTodoCopyActions());

    act(() => result.current.copyId(1004));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("#1004"));
    await waitFor(() => expect(result.current.feedback).toEqual({ action: "id", status: "copied" }));
  });

  it("logs and arms \"failed\" feedback when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useTodoCopyActions());

    act(() => result.current.copyId(1004));

    await waitFor(() => expect(result.current.feedback).toEqual({ action: "id", status: "failed" }));
    expect(consoleError).toHaveBeenCalledWith("Failed to copy todo id", expect.any(Error));
    consoleError.mockRestore();
  });
});

describe("useTodoCopyActions -- copyPrompt", () => {
  it("fetches the todo's direct children and writes the assembled markdown to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    vi.stubGlobal("electronAPI", {
      todo: {
        list: vi.fn().mockResolvedValue([
          { id: 5, title: "Sub-issue", state: { label: "Done", isCompleted: true } },
        ]),
      },
    });
    const { result } = renderHook(() => useTodoCopyActions());
    const todo = makeTodo(100, "Parent todo");

    act(() => result.current.copyPrompt(todo));

    await waitFor(() => expect(window.electronAPI.todo.list).toHaveBeenCalledWith({ parentId: 100 }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const prompt = writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("# Parent todo");
    expect(prompt).toContain("## Sub-issues");
    expect(prompt).toContain("#5 Sub-issue");
    await waitFor(() => expect(result.current.feedback).toEqual({ action: "prompt", status: "copied" }));
  });

  it(
    "supersedes a call for the same todo still in flight, so only the later call's fetch reaches the clipboard",
    async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      const resolvers: Array<(rows: unknown[]) => void> = [];
      const list = vi.fn().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
      vi.stubGlobal("electronAPI", { todo: { list } });
      const { result } = renderHook(() => useTodoCopyActions());
      const todo = makeTodo(100, "Parent todo");

      // Two separate `act()` calls, not one wrapping both -- a render must land between them for
      // the second call to read the just-armed `promptPending` closure, the same way two
      // separate `fireEvent.click` calls do at the component call sites.
      act(() => result.current.copyPrompt(todo));
      act(() => result.current.copyPrompt(todo));

      expect(list).toHaveBeenCalledTimes(2);
      expect(result.current.promptPending).toBe(true);

      // The FIRST call's fetch resolves first -- its response is stale and must not reach the
      // clipboard or clear `promptPending`, since a second call already started.
      await act(async () => {
        resolvers[0]?.([{ id: 1, title: "Stale child", state: { label: "Todo", isCompleted: false } }]);
        await Promise.resolve();
      });
      expect(writeText).not.toHaveBeenCalled();
      expect(result.current.promptPending).toBe(true);

      await act(async () => {
        resolvers[1]?.([]);
        await Promise.resolve();
      });

      await waitFor(() => expect(result.current.promptPending).toBe(false));
      expect(writeText).toHaveBeenCalledTimes(1);
      const prompt = writeText.mock.calls[0]?.[0] as string;
      expect(prompt).not.toContain("Stale child");
      await waitFor(() => expect(result.current.feedback).toEqual({ action: "prompt", status: "copied" }));
    },
  );

  it(
    "supersedes an in-flight call for a different todo, so the clipboard gets the later todo's markdown, not the earlier one's",
    async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      stubClipboard(writeText);
      const resolvers: Array<(rows: unknown[]) => void> = [];
      const list = vi.fn().mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
      vi.stubGlobal("electronAPI", { todo: { list } });
      const { result } = renderHook(() => useTodoCopyActions());
      const rowA = makeTodo(100, "Row A");
      const rowB = makeTodo(200, "Row B");

      act(() => result.current.copyPrompt(rowA));
      act(() => result.current.copyPrompt(rowB));

      expect(list).toHaveBeenNthCalledWith(1, { parentId: 100 });
      expect(list).toHaveBeenNthCalledWith(2, { parentId: 200 });

      // Row A's fetch resolves after row B's call already started -- row A's response must lose.
      await act(async () => {
        resolvers[0]?.([]);
        await Promise.resolve();
      });
      expect(writeText).not.toHaveBeenCalled();

      await act(async () => {
        resolvers[1]?.([]);
        await Promise.resolve();
      });

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const prompt = writeText.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("# Row B");
      expect(prompt).not.toContain("# Row A");
      await waitFor(() => expect(result.current.feedback).toEqual({ action: "prompt", status: "copied" }));
    },
  );

  it("logs and arms \"failed\" feedback when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    vi.stubGlobal("electronAPI", { todo: { list: vi.fn().mockResolvedValue([]) } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useTodoCopyActions());

    act(() => result.current.copyPrompt(makeTodo(100, "Parent todo")));

    await waitFor(() => expect(result.current.feedback).toEqual({ action: "prompt", status: "failed" }));
    expect(consoleError).toHaveBeenCalledWith("Failed to copy agent prompt", expect.any(Error));
    consoleError.mockRestore();
  });

  it("clears `promptPending` once the chain settles, even on failure", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    vi.stubGlobal("electronAPI", { todo: { list: vi.fn().mockResolvedValue([]) } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useTodoCopyActions());

    act(() => result.current.copyPrompt(makeTodo(100, "Parent todo")));
    expect(result.current.promptPending).toBe(true);

    await waitFor(() => expect(result.current.promptPending).toBe(false));
  });
});
