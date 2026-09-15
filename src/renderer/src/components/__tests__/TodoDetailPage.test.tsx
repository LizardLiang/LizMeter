import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, TodoLabel, TodoProject, TodoState, UpdateTodoInput } from "../../../../shared/types.ts";
import { TodosProvider } from "../../contexts/TodosContext.tsx";
import { TodoDetailPage } from "../TodoDetailPage.tsx";
import { TodosPage } from "../TodosPage.tsx";

const todoState: TodoState = {
  id: 1,
  label: "Todo",
  color: "#7aa2f7",
  position: 0,
  isCompleted: false,
  isDefault: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const backlogState: TodoState = {
  id: 2,
  label: "Backlog",
  color: "#565f89",
  position: 1,
  isCompleted: false,
  isDefault: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const infraProject: TodoProject = {
  id: 7,
  name: "Infra",
  color: "#bb9af7",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const bugLabel: TodoLabel = {
  id: 11,
  name: "bug",
  color: "#f7768e",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeTodo(id: number, title: string, state: TodoState, extra: Partial<Todo> = {}): Todo {
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
    createdAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
    ...extra,
  };
}

// Rendered order (grouped by state position, then array order): 152, 100, 162.
const sampleTodos: Todo[] = [
  makeTodo(152, "Old prod to new prod migration", todoState),
  makeTodo(100, "Fix misc code quality issues", todoState, { project: infraProject }),
  makeTodo(162, "Server-side PDF optimization", backlogState),
];

const mockTodoAPI = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  clearCompleted: vi.fn(),
  listMilestones: vi.fn(),
  onChanged: vi.fn(),
};

const mockTodoStateAPI = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
};

const mockTodoProjectAPI = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  reorder: vi.fn(),
};

const mockTodoLabelAPI = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const mockAttachmentAPI = {
  list: vi.fn(),
  add: vi.fn(),
  addBuffer: vi.fn(),
  delete: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
};

let onChangedCallback: () => void = () => {};

const mockOnBack = vi.fn();
const mockOnNavigate = vi.fn();

/** Merges the write into the matching sample row, the way the real main process would. */
function applyUpdate(input: UpdateTodoInput): Todo {
  const current = sampleTodos.find((t) => t.id === input.id)!;
  const next: Todo = {
    ...current,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.milestone !== undefined ? { milestone: input.milestone } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    ...(input.stateId !== undefined ? { state: input.stateId === 2 ? backlogState : todoState } : {}),
  };
  const index = sampleTodos.findIndex((t) => t.id === input.id);
  sampleTodos[index] = next;
  return next;
}

beforeEach(() => {
  vi.stubGlobal("electronAPI", {
    todo: mockTodoAPI,
    todoState: mockTodoStateAPI,
    todoProject: mockTodoProjectAPI,
    todoLabel: mockTodoLabelAPI,
    attachment: mockAttachmentAPI,
  });
  mockTodoAPI.list.mockImplementation((input?: { parentId?: number; }) => {
    if (input?.parentId !== undefined) {
      return Promise.resolve(sampleTodos.filter((t) => t.parentId === input.parentId));
    }
    return Promise.resolve(sampleTodos);
  });
  mockTodoAPI.listMilestones.mockResolvedValue([]);
  mockTodoAPI.delete.mockResolvedValue(undefined);
  mockTodoAPI.update.mockImplementation((input: UpdateTodoInput) => Promise.resolve(applyUpdate(input)));
  mockTodoAPI.create.mockResolvedValue(sampleTodos[0]);
  mockTodoAPI.onChanged.mockImplementation((cb: () => void) => {
    onChangedCallback = cb;
    return () => {};
  });
  mockTodoStateAPI.list.mockResolvedValue([todoState, backlogState]);
  mockTodoProjectAPI.list.mockResolvedValue([infraProject]);
  mockTodoProjectAPI.create.mockResolvedValue({ ...infraProject, id: 8, name: "Billing" });
  mockTodoLabelAPI.list.mockResolvedValue([bugLabel]);
  mockTodoLabelAPI.create.mockResolvedValue({ ...bugLabel, id: 12, name: "ui" });
  mockAttachmentAPI.list.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  // Reset the shared fixture back to its original shape -- individual tests mutate it via
  // `applyUpdate`, the same way a real write would.
  sampleTodos[0] = makeTodo(152, "Old prod to new prod migration", todoState);
  sampleTodos[1] = makeTodo(100, "Fix misc code quality issues", todoState, { project: infraProject });
  sampleTodos[2] = makeTodo(162, "Server-side PDF optimization", backlogState);
});

async function renderDetail(todoId: number) {
  const utils = render(
    <TodosProvider>
      <TodoDetailPage todoId={todoId} onBack={mockOnBack} onNavigate={mockOnNavigate} />
    </TodosProvider>,
  );
  await screen.findByLabelText("Title");
  return utils;
}

describe("TodoDetailPage fields", () => {
  it("fills the title, state, and priority from the todo", async () => {
    await renderDetail(100);

    expect(screen.getByLabelText("Title")).toHaveValue("Fix misc code quality issues");
    expect(screen.getByLabelText("State")).toHaveTextContent("Todo");
    expect(screen.getByLabelText("Priority")).toHaveTextContent("No priority");
  });

  it("navigates back when the todo cannot be found once the list has loaded", async () => {
    render(
      <TodosProvider>
        <TodoDetailPage todoId={9999} onBack={mockOnBack} onNavigate={mockOnNavigate} />
      </TodosProvider>,
    );

    await waitFor(() => expect(mockOnBack).toHaveBeenCalledWith(9999));
  });

  it("navigates back when an external change (sync, the MCP server) removes the open todo", async () => {
    await renderDetail(162);

    // The MCP server and a sync merge write through the main process, not the renderer, so the
    // shared list only learns about the removal via the `onChanged` push event (F19).
    mockTodoAPI.list.mockResolvedValue(sampleTodos.filter((t) => t.id !== 162));
    onChangedCallback();

    await waitFor(() => expect(mockOnBack).toHaveBeenCalledWith(162));
  });
});

describe("TodoDetailPage auto-save", () => {
  it("writes the title 600ms after typing stops, with no other action", async () => {
    await renderDetail(100);
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed title" } });
    expect(mockTodoAPI.update).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);

    expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, title: "Renamed title" });
  });

  it("flushes the title write on blur, without waiting for the debounce", async () => {
    await renderDetail(100);

    const input = screen.getByLabelText("Title");
    fireEvent.change(input, { target: { value: "Renamed on blur" } });
    fireEvent.blur(input);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, title: "Renamed on blur" }));
  });

  it("flushes a pending title write on unmount, so navigating away never loses it", async () => {
    const { unmount } = await renderDetail(100);
    // Freezes the clock so the 600ms debounce timer can never fire on its own -- without this,
    // real time passing while a later assertion polls would let the ordinary debounce cover for
    // a missing unmount flush, and the test would pass for the wrong reason.
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed then closed" } });
    // No blur, and the clock never advances -- only the unmount cleanup can flush this.
    unmount();

    // Asserted synchronously, with no waiting: the unmount cleanup calls `updateTodoQuiet`
    // (and therefore `electronAPI.todo.update`) inline, not through a timer.
    expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, title: "Renamed then closed" });
  });

  it("does not write an empty title", async () => {
    await renderDetail(100);
    vi.useFakeTimers();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    await vi.advanceTimersByTimeAsync(600);

    expect(mockTodoAPI.update).not.toHaveBeenCalled();
  });

  it("writes state, priority, and dates immediately, not on a debounce", async () => {
    await renderDetail(100);

    fireEvent.click(screen.getByLabelText("Priority"));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Priority" })).getByText("Urgent"));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, priority: 1 }));
  });
});

describe("TodoDetailPage prev/next", () => {
  it("steps through the same order the list shows, and shows the position", async () => {
    await renderDetail(100);

    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Previous todo"));
    expect(mockOnNavigate).toHaveBeenCalledWith(152);

    fireEvent.click(screen.getByLabelText("Next todo"));
    expect(mockOnNavigate).toHaveBeenCalledWith(162);
  });

  it("disables Previous on the first row", async () => {
    await renderDetail(152);
    expect(screen.getByLabelText("Previous todo")).toBeDisabled();
  });

  it("disables Next on the last row", async () => {
    await renderDetail(162);
    expect(screen.getByLabelText("Next todo")).toBeDisabled();
  });
});

describe("TodoDetailPage delete", () => {
  it("deletes from the overflow menu and navigates back to the list", async () => {
    await renderDetail(162);

    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(mockTodoAPI.delete).toHaveBeenCalledWith(162));
    await waitFor(() => expect(mockOnBack).toHaveBeenCalledWith(162));
  });
});

describe("TodoDetailPage keyboard", () => {
  it("Escape returns to the list", async () => {
    await renderDetail(100);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(mockOnBack).toHaveBeenCalledWith(100);
  });
});

describe("TodoDetailPage sub-issues", () => {
  it("adds a sub-issue, writing immediately", async () => {
    await renderDetail(152);

    const input = screen.getByLabelText("New sub-issue title");
    fireEvent.change(input, { target: { value: "Back up the database" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockTodoAPI.create).toHaveBeenCalledWith({
        title: "Back up the database",
        parentId: 152,
        source: "user",
      })
    );
  });

  it("unlinking a sub-issue clears its parent rather than deleting it", async () => {
    mockTodoAPI.list.mockImplementation((input?: { parentId?: number; }) => {
      if (input?.parentId === 152) return Promise.resolve([makeTodo(100, "Fix misc code quality issues", todoState)]);
      if (input?.parentId !== undefined) return Promise.resolve([]);
      return Promise.resolve(sampleTodos);
    });
    await renderDetail(152);

    const unlink = await screen.findByLabelText("Remove Fix misc code quality issues from this todo");
    fireEvent.click(unlink);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, parentId: null }));
    expect(mockTodoAPI.delete).not.toHaveBeenCalled();
  });

  it("setting a parent from the picker writes immediately, with no save step", async () => {
    await renderDetail(100);

    fireEvent.click(screen.getByRole("button", { name: "+ Set parent" }));
    const picker = await screen.findByRole("dialog", { name: "Nest this todo under" });
    fireEvent.click(within(picker).getByText("Old prod to new prod migration"));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, parentId: 152 }));
  });
});

describe("TodoDetailPage shares state with TodosPage", () => {
  it("keeps the active filter after switching from the list to the detail page and back", async () => {
    function Harness({ showDetail }: { showDetail: boolean; }) {
      return (
        <TodosProvider>
          {showDetail
            ? <TodoDetailPage todoId={100} onBack={mockOnBack} onNavigate={mockOnNavigate} />
            : <TodosPage onOpenDetail={() => {}} />}
        </TodosProvider>
      );
    }

    const { rerender } = render(<Harness showDetail={false} />);
    await screen.findByText("Old prod to new prod migration");

    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => expect(mockTodoAPI.list).toHaveBeenCalledWith(expect.objectContaining({ filter: "active" })));

    // "Navigate" to the detail page -- TodosPage unmounts, TodoDetailPage mounts, same provider.
    rerender(<Harness showDetail={true} />);
    await screen.findByLabelText("Title");

    // Back to the list -- the filter tab is still the one the user picked, not reset to "All".
    rerender(<Harness showDetail={false} />);
    await screen.findByText("Old prod to new prod migration");
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a title edited on the detail page in the list, without a second fetch (F25)", async () => {
    function Harness({ showDetail }: { showDetail: boolean; }) {
      return (
        <TodosProvider>
          {showDetail
            ? <TodoDetailPage todoId={100} onBack={mockOnBack} onNavigate={mockOnNavigate} />
            : <TodosPage onOpenDetail={() => {}} />}
        </TodosProvider>
      );
    }

    const { rerender } = render(<Harness showDetail={true} />);
    await screen.findByLabelText("Title");
    const listCallsBeforeEdit = mockTodoAPI.list.mock.calls.length;

    // `updateTodoQuiet` never calls `refresh()` -- if it also skipped patching the local `todos`
    // array, the list below would still read the pre-edit title once shared through one
    // `useTodos` instance (the regression the inversion premortem in the tactical plan calls
    // F25: "going back remounts and refetches, so a quiet write is safe" becomes false the
    // moment the context shares one hook between the two pages).
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed via quiet write" } });
    fireEvent.blur(screen.getByLabelText("Title"));
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, title: "Renamed via quiet write" }));

    // No refetch was triggered by the quiet write.
    expect(mockTodoAPI.list.mock.calls.length).toBe(listCallsBeforeEdit);

    // Back to the list, sharing the same `TodosProvider` -- the row already carries the new
    // title because `updateTodoQuiet` patched the local array, not because of a reload.
    rerender(<Harness showDetail={false} />);
    expect(await screen.findByText("Renamed via quiet write")).toBeInTheDocument();
    expect(screen.queryByText("Fix misc code quality issues")).not.toBeInTheDocument();
    expect(mockTodoAPI.list.mock.calls.length).toBe(listCallsBeforeEdit);
  });
});
