// useTodoLiveInfo hook tests
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, TodoState } from "../../../../../shared/types.ts";
import { useTodoLiveInfo } from "../useTodoLiveInfo.ts";

function makeState(overrides: Partial<TodoState> = {}): TodoState {
  return {
    id: 1,
    label: "Todo",
    color: "#7aa2f7",
    position: 0,
    isCompleted: false,
    isDefault: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTodo(id: number, title: string, state: TodoState = makeState()): Todo {
  return {
    id,
    title,
    notes: null,
    state,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
}

const mockElectronAPI = {
  todo: {
    list: vi.fn(),
  },
};

beforeEach(() => {
  vi.stubGlobal("electronAPI", mockElectronAPI);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTodoLiveInfo", () => {
  it("starts in \"loading\" status before the IPC call resolves", () => {
    mockElectronAPI.todo.list.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useTodoLiveInfo("42", "todo"));
    expect(result.current.status).toBe("loading");
  });

  it("resolves to \"found\" with the live title and state when the lookup succeeds", async () => {
    mockElectronAPI.todo.list.mockResolvedValue([
      makeTodo(42, "Buy oat milk", makeState({ id: 2, label: "Done", color: "#9ece6a", isCompleted: true })),
    ]);
    const { result } = renderHook(() => useTodoLiveInfo("42", "todo"));

    await waitFor(() => expect(result.current.status).toBe("found"));
    expect(result.current).toEqual({
      status: "found",
      info: { title: "Buy oat milk", isCompleted: true, stateColor: "#9ece6a" },
    });
  });

  it("resolves to \"missing\" when the lookup finds nothing (deleted or not yet synced)", async () => {
    mockElectronAPI.todo.list.mockResolvedValue([makeTodo(1, "Some other todo")]);
    const { result } = renderHook(() => useTodoLiveInfo("999", "todo"));

    await waitFor(() => expect(result.current.status).toBe("missing"));
  });

  it("resolves to \"missing\" without calling the IPC when the provider is not \"todo\"", () => {
    const { result } = renderHook(() => useTodoLiveInfo("42", "github"));
    expect(result.current.status).toBe("missing");
    expect(mockElectronAPI.todo.list).not.toHaveBeenCalled();
  });

  it(
    "resets to \"loading\" synchronously when the id changes on a mounted instance, instead of keeping the previous todo's info",
    async () => {
      let resolveSecond: (todos: Todo[]) => void = () => {};
      mockElectronAPI.todo.list
        .mockResolvedValueOnce([makeTodo(1, "First todo")])
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
        );

      const { result, rerender } = renderHook(
        ({ issueId }: { issueId: string; }) => useTodoLiveInfo(issueId, "todo"),
        { initialProps: { issueId: "1" } },
      );

      await waitFor(() => expect(result.current.status).toBe("found"));
      expect(result.current.status === "found" && result.current.info.title).toBe("First todo");

      rerender({ issueId: "2" });

      // The second fetch has not resolved yet -- must not still show todo 1's info next to id 2.
      expect(result.current.status).toBe("loading");

      resolveSecond([makeTodo(2, "Second todo")]);
      await waitFor(() => expect(result.current.status).toBe("found"));
      expect(result.current.status === "found" && result.current.info.title).toBe("Second todo");
    },
  );
});
