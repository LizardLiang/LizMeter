import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, TodoLabel, TodoProject, TodoState, UpdateTodoInput } from "../../../../shared/types.ts";
import { TodosProvider } from "../../contexts/TodosContext.tsx";
import { TodoDetailPage } from "../TodoDetailPage.tsx";
import { TodosPage } from "../TodosPage.tsx";

// jsdom implements no layout, so `Range#getClientRects` is missing. Focusing the notes
// MarkdownEditor (`handleTitleKeyDown`'s Enter path) makes CodeMirror schedule an async measure
// pass on the next animation frame; unlike the synchronous mount-time measure CodeMirror already
// swallows internally, that rAF-scheduled pass throws with nothing left to catch it, and Vitest
// reports it as a genuine unhandled exception rather than the usual stderr noise. Same stub
// `MarkdownEditor.test.tsx` uses -- nothing here asserts on geometry.
beforeAll(() => {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
});

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

const doneState: TodoState = {
  id: 3,
  label: "Done",
  color: "#9ece6a",
  position: 2,
  isCompleted: true,
  isDefault: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const allStates = [todoState, backlogState, doneState];

const infraProject: TodoProject = {
  id: 7,
  name: "Infra",
  color: "#bb9af7",
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

let allProjects: TodoProject[] = [infraProject];

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

function defaultTodos(): Todo[] {
  // Rendered order (grouped by state position, then array order): 152, 100, 162.
  return [
    makeTodo(152, "Old prod to new prod migration", todoState),
    makeTodo(100, "Fix misc code quality issues", todoState, { project: infraProject }),
    makeTodo(162, "Server-side PDF optimization", backlogState),
  ];
}

/** Reassigned, never mutated in place -- a `list()` caller holding an older array reference
 * must never observe a later write (WARNING 7). */
let sampleTodos: Todo[] = defaultTodos();

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

interface ListLikeInput {
  filter?: string;
  stateId?: number;
  projectId?: number;
  labelId?: number;
  parentId?: number;
}

/** Mirrors the main process's own filtering (see `useTodos.ts`'s fetch), so a filtered call and
 * an unfiltered one (`TodoDetailPage`'s BLOCKER-1 fallback lookup) can disagree the same way the
 * real backend would. */
function applyFilter(list: Todo[], input?: ListLikeInput): Todo[] {
  let result = list;
  if (input?.filter === "active") result = result.filter((t) => !t.state.isCompleted);
  else if (input?.filter === "done") result = result.filter((t) => t.state.isCompleted);
  else if (input?.filter === "ai") result = result.filter((t) => t.source === "ai");
  if (input?.stateId !== undefined) result = result.filter((t) => t.state.id === input.stateId);
  if (input?.projectId !== undefined) result = result.filter((t) => t.project?.id === input.projectId);
  if (input?.labelId !== undefined) result = result.filter((t) => t.labels.some((l) => l.id === input.labelId));
  return result;
}

/** Builds a new array rather than mutating `sampleTodos`'s elements in place -- a stale array
 * reference held elsewhere (or by a test) must never see a later write (WARNING 7). */
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
    ...(input.projectId !== undefined
      ? { project: input.projectId === null ? null : allProjects.find((p) => p.id === input.projectId) ?? null }
      : {}),
    ...(input.stateId !== undefined ? { state: allStates.find((s) => s.id === input.stateId) ?? current.state } : {}),
  };
  sampleTodos = sampleTodos.map((t) => (t.id === input.id ? next : t));
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
  mockTodoAPI.list.mockImplementation((input?: ListLikeInput) => {
    if (input?.parentId !== undefined) {
      return Promise.resolve(sampleTodos.filter((t) => t.parentId === input.parentId).map((t) => ({ ...t })));
    }
    return Promise.resolve(applyFilter(sampleTodos, input).map((t) => ({ ...t })));
  });
  mockTodoAPI.listMilestones.mockResolvedValue([]);
  mockTodoAPI.delete.mockResolvedValue(undefined);
  mockTodoAPI.update.mockImplementation((input: UpdateTodoInput) => Promise.resolve(applyUpdate(input)));
  mockTodoAPI.create.mockResolvedValue(sampleTodos[0]);
  mockTodoAPI.onChanged.mockImplementation((cb: () => void) => {
    onChangedCallback = cb;
    return () => {};
  });
  mockTodoStateAPI.list.mockResolvedValue(allStates);
  mockTodoProjectAPI.list.mockImplementation(() => Promise.resolve([...allProjects]));
  mockTodoProjectAPI.create.mockImplementation(({ name }: { name: string; }) => {
    const created = { ...infraProject, id: 8, name };
    allProjects = [...allProjects, created];
    return Promise.resolve(created);
  });
  mockTodoLabelAPI.list.mockResolvedValue([bugLabel]);
  mockTodoLabelAPI.create.mockResolvedValue({ ...bugLabel, id: 12, name: "ui" });
  mockAttachmentAPI.list.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  // Reset the shared fixtures back to their original shape -- individual tests mutate them via
  // `applyUpdate`/`createProject`, the same way a real write would.
  sampleTodos = defaultTodos();
  allProjects = [infraProject];
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

/** Combines the list and the detail page under one shared provider, the way `TomatoClock`
 * switches between the two `NavPage` routes. */
function Harness({ showDetail, todoId = 100 }: { showDetail: boolean; todoId?: number; }) {
  return (
    <TodosProvider>
      {showDetail
        ? <TodoDetailPage todoId={todoId} onBack={mockOnBack} onNavigate={mockOnNavigate} />
        : <TodosPage onOpenDetail={() => {}} />}
    </TodosProvider>
  );
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
    // shared list only learns about the removal via the `onChanged` push event (F19). Both the
    // context's own refetch and the BLOCKER-1 fallback lookup agree the row is genuinely gone.
    sampleTodos = sampleTodos.filter((t) => t.id !== 162);
    onChangedCallback();

    await waitFor(() => expect(mockOnBack).toHaveBeenCalledWith(162));
  });
});

describe("TodoDetailPage notes field", () => {
  it("renders the notes editor frameless, findable by its accessible name, with no expand button", async () => {
    await renderDetail(100);

    // `ariaLabelledBy` lands on `.cm-content`, the textbox CodeMirror mounts -- so the visually
    // hidden "Notes" label still resolves through Testing Library's accessible-name lookup even
    // though nothing reading "Notes" is visible on screen (Linear shows no field label at all).
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open full editor" })).toBeNull();
  });
});

describe("TodoDetailPage stays open when a write moves the row out of the active filter (BLOCKER 1)", () => {
  it("keeps the page open and shows the row as filtered-out, not gone", async () => {
    const { rerender } = render(<Harness showDetail={false} />);
    await screen.findByText("Old prod to new prod migration");

    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    await waitFor(() => expect(mockTodoAPI.list).toHaveBeenCalledWith(expect.objectContaining({ filter: "active" })));

    rerender(<Harness showDetail={true} />);
    await screen.findByLabelText("Title");

    fireEvent.click(screen.getByLabelText("State"));
    fireEvent.click(within(screen.getByRole("listbox", { name: "State" })).getByText("Done"));

    // The write completes and the "active"-filtered refetch no longer includes todo 100 --
    // the page must recognize it only fell out of the filter, not that it was deleted.
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, stateId: doneState.id }));
    await waitFor(() => expect(screen.getByLabelText("State")).toHaveTextContent("Done"));
    expect(screen.getByLabelText("Title")).toHaveValue("Fix misc code quality issues");
    expect(mockOnBack).not.toHaveBeenCalled();
  });
});

describe("TodoDetailPage surfaces write failures (BLOCKER 2)", () => {
  it("shows the error, sends no unhandled rejection, and retries on the next blur", async () => {
    await renderDetail(100);
    mockTodoAPI.update.mockRejectedValueOnce(new Error("Network blip"));

    const input = screen.getByLabelText("Title");
    fireEvent.change(input, { target: { value: "Retry me" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText("Network blip")).toBeInTheDocument());
    expect(mockTodoAPI.update).toHaveBeenCalledTimes(1);

    // No further typing -- only a second blur. The failed commit must have rolled back so this
    // is recognised as still-unsaved, not treated as already written.
    fireEvent.blur(input);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledTimes(2));
    expect(mockTodoAPI.update).toHaveBeenLastCalledWith({ id: 100, title: "Retry me" });
  });

  it("shows a message when the main process rejects a rail write (start after due)", async () => {
    await renderDetail(100);
    mockTodoAPI.update.mockRejectedValueOnce(new Error("Start date must not be after the due date."));

    fireEvent.click(screen.getByLabelText("Start date"));
    const panel = await screen.findByRole("dialog", { name: "Start date" });
    fireEvent.click(within(panel).getByText("15"));

    expect(await screen.findByText("Start date must not be after the due date.")).toBeInTheDocument();
  });

  it("shows a message when delete fails, without an unhandled rejection", async () => {
    await renderDetail(162);
    mockTodoAPI.delete.mockRejectedValueOnce(new Error("Could not delete this todo."));

    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Could not delete this todo.")).toBeInTheDocument();
    expect(mockOnBack).not.toHaveBeenCalled();
  });
});

describe("TodoDetailPage Project/Milestone commit the picked value (BLOCKER 3)", () => {
  it("links to the existing project on ArrowDown+Enter, without creating one", async () => {
    // Todo 152 starts with no project -- picking "Infra" is a real change, unlike todo 100
    // (which already carries it, and would make this a no-op commit either way).
    await renderDetail(152);

    const project = screen.getByLabelText("Project");
    fireEvent.change(project, { target: { value: "Inf" } });
    fireEvent.keyDown(project, { key: "ArrowDown" });
    fireEvent.keyDown(project, { key: "Enter" });

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, projectId: infraProject.id }));
    expect(mockTodoProjectAPI.create).not.toHaveBeenCalled();
  });

  it("creates the typed project at most once even when Enter is followed by a blur", async () => {
    await renderDetail(100);

    const project = screen.getByLabelText("Project");
    fireEvent.change(project, { target: { value: "Billing" } });
    fireEvent.keyDown(project, { key: "Enter" });
    fireEvent.blur(project);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, projectId: 8 }));
    expect(mockTodoProjectAPI.create).toHaveBeenCalledTimes(1);
  });

  it("does not re-commit when a mouse pick moves focus to the field's own listbox", async () => {
    await renderDetail(152);

    const project = screen.getByLabelText("Project");
    fireEvent.change(project, { target: { value: "Inf" } });
    const listbox = await screen.findByRole("listbox", { name: "Project" });
    const option = within(listbox).getByText("Infra");

    // The browser blurs the input as focus moves toward the option being clicked, before the
    // click (and therefore `onCommit`) fires -- reproduced here with an explicit `relatedTarget`
    // rather than relying on jsdom to simulate that transition on its own.
    fireEvent.blur(project, { relatedTarget: option });
    fireEvent.click(option);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, projectId: infraProject.id }));
    expect(mockTodoAPI.update).toHaveBeenCalledTimes(1);
  });

  it("commits the picked milestone value, not a stale draft", async () => {
    mockTodoAPI.listMilestones.mockResolvedValue(["Q1 Launch"]);
    await renderDetail(100);
    await waitFor(() => expect(screen.getByLabelText("Milestone")).toBeInTheDocument());

    const milestone = screen.getByLabelText("Milestone");
    fireEvent.change(milestone, { target: { value: "Q1" } });
    fireEvent.keyDown(milestone, { key: "ArrowDown" });
    fireEvent.keyDown(milestone, { key: "Enter" });

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, milestone: "Q1 Launch" }));
  });

  it("commits a label on blur, not only on Enter or a pick", async () => {
    await renderDetail(100);

    const addLabel = screen.getByLabelText("Add label");
    fireEvent.change(addLabel, { target: { value: "bug" } });
    fireEvent.blur(addLabel);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, labelIds: [bugLabel.id] }));
  });
});

describe("TodoDetailPage adopts an external write on blur (WARNING 4)", () => {
  it("shows the new title after an external rename, and sends no write", async () => {
    await renderDetail(100);
    const input = screen.getByLabelText("Title");

    fireEvent.focus(input);
    sampleTodos = sampleTodos.map((t) => (t.id === 100 ? { ...t, title: "Renamed by the MCP server" } : t));
    onChangedCallback();

    // Wait for the refetch to actually land in context before touching focus at all -- the
    // breadcrumb reads `todo.title` directly (no debounce, no focus gate), so it is a reliable
    // signal that this happened, independent of the field under test.
    await waitFor(() => expect(screen.getByText(/Renamed by the MCP server/)).toBeInTheDocument());
    // The draft stays authoritative while focused, so the rename must not be visible in the
    // field yet -- if it already were, blur below would prove nothing about WARNING 4's fix.
    expect(input).toHaveValue("Fix misc code quality issues");

    fireEvent.blur(input);

    await waitFor(() => expect(input).toHaveValue("Renamed by the MCP server"));
    expect(mockTodoAPI.update).not.toHaveBeenCalled();
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
    sampleTodos = [
      ...sampleTodos,
    ].map((t) => t.id === 100 ? { ...t, parentId: 152, parentTitle: "Old prod to new prod migration" } : t);
    await renderDetail(152);

    const unlink = await screen.findByLabelText("Remove Fix misc code quality issues from this todo");
    fireEvent.click(unlink);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, parentId: null }));
    expect(mockTodoAPI.delete).not.toHaveBeenCalled();
  });

  it("clicking the parent chip body navigates to the parent, without opening the picker", async () => {
    sampleTodos = sampleTodos.map((t) =>
      t.id === 100 ? { ...t, parentId: 152, parentTitle: "Old prod to new prod migration" } : t
    );
    await renderDetail(100);

    fireEvent.click(screen.getByTitle("Go to parent"));

    expect(mockOnNavigate).toHaveBeenCalledWith(152);
    expect(screen.queryByRole("dialog", { name: "Nest this todo under" })).not.toBeInTheDocument();
  });

  it("clicking Change parent opens the picker, without navigating", async () => {
    sampleTodos = sampleTodos.map((t) =>
      t.id === 100 ? { ...t, parentId: 152, parentTitle: "Old prod to new prod migration" } : t
    );
    await renderDetail(100);

    fireEvent.click(screen.getByRole("button", { name: "Change parent" }));

    expect(await screen.findByRole("dialog", { name: "Nest this todo under" })).toBeInTheDocument();
    expect(mockOnNavigate).not.toHaveBeenCalled();
  });

  it("setting a parent from the picker writes immediately, with no save step", async () => {
    await renderDetail(100);

    fireEvent.click(screen.getByRole("button", { name: "+ Set parent" }));
    const picker = await screen.findByRole("dialog", { name: "Nest this todo under" });
    fireEvent.click(within(picker).getByText("Old prod to new prod migration"));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, parentId: 152 }));
  });

  it("refreshes the sub-issues list when an outside change adds a child (WARNING 6)", async () => {
    await renderDetail(152);
    await screen.findByLabelText("New sub-issue title");
    expect(screen.queryByText("Added from outside")).not.toBeInTheDocument();

    // External add: the MCP server files a new sub-issue under 152. The push event only makes
    // the shared `todos` array (and therefore `childCount`) fresh -- `loadChildren`'s own result
    // must be re-derived from that, not stay pinned to the id alone.
    sampleTodos = [
      ...sampleTodos.map((t) => t.id === 152 ? { ...t, childCount: t.childCount + 1 } : t),
      makeTodo(300, "Added from outside", todoState, { parentId: 152, parentTitle: "Old prod to new prod migration" }),
    ];
    onChangedCallback();

    expect(await screen.findByText("Added from outside")).toBeInTheDocument();
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

  it("Enter in the title inserts no newline, commits immediately, and moves focus into notes", async () => {
    await renderDetail(100);

    const title = screen.getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Renamed via Enter" } });
    fireEvent.keyDown(title, { key: "Enter" });

    // No debounce wait -- Enter flushes the same way blur does, not on the 600ms timer.
    expect(title).toHaveValue("Renamed via Enter");
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, title: "Renamed via Enter" }));
    await waitFor(() => expect(screen.getByLabelText("Notes")).toHaveFocus());
  });

  it("collapses a line break typed or pasted into the title into a single space", async () => {
    await renderDetail(100);

    const title = screen.getByLabelText("Title");
    // `fireEvent.change` with an embedded newline stands in for both a typed Enter that somehow
    // reaches the textarea's value and a paste carrying multiple lines -- jsdom cannot synthesize
    // a real OS paste, but the component sanitizes the resulting value identically either way.
    fireEvent.change(title, { target: { value: "Line one\nLine two" } });

    expect(title).toHaveValue("Line one Line two");
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

describe("TodoDetailPage shares state with TodosPage", () => {
  it("keeps the active filter after switching from the list to the detail page and back", async () => {
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
