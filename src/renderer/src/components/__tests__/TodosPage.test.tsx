import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, TodoLabel, TodoProject, TodoState } from "../../../../shared/types.ts";
import styles from "../TodosPage.module.scss";
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

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("electronAPI", {
    todo: mockTodoAPI,
    todoState: mockTodoStateAPI,
    todoProject: mockTodoProjectAPI,
    todoLabel: mockTodoLabelAPI,
  });
  mockTodoAPI.list.mockResolvedValue(sampleTodos);
  mockTodoAPI.listMilestones.mockResolvedValue([]);
  mockTodoAPI.delete.mockResolvedValue(undefined);
  mockTodoAPI.update.mockResolvedValue(sampleTodos[0]);
  mockTodoAPI.create.mockResolvedValue(sampleTodos[0]);
  mockTodoAPI.onChanged.mockReturnValue(() => {});
  mockTodoStateAPI.list.mockResolvedValue([todoState, backlogState]);
  mockTodoProjectAPI.list.mockResolvedValue([infraProject]);
  mockTodoProjectAPI.create.mockResolvedValue({ ...infraProject, id: 8, name: "Billing" });
  mockTodoLabelAPI.list.mockResolvedValue([bugLabel]);
  mockTodoLabelAPI.create.mockResolvedValue({ ...bugLabel, id: 12, name: "ui" });
});

afterEach(() => {
  // The suite runs without `globals: true`, so RTL's auto-cleanup never registers.
  cleanup();
  vi.clearAllMocks();
});

/** Waits past the initial IPC load so the panel is populated. */
async function renderPage() {
  render(<TodosPage />);
  await screen.findByText("Old prod to new prod migration");
}

/** Right-click is the only opener: the rows carry no trigger of their own. */
function openRowMenu(title: string) {
  fireEvent.contextMenu(screen.getByLabelText(`Edit ${title}`));
}

describe("TodosPage grouping", () => {
  it("renders one band per state, ordered by position, with per-group counts", async () => {
    await renderPage();

    const bands = screen.getAllByRole("button", { name: /^Collapse / });
    expect(bands.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Collapse Todo",
      "Collapse Backlog",
    ]);

    expect(screen.getByText("Todo").parentElement).toHaveTextContent("Todo2");
    expect(screen.getByText("Backlog").parentElement).toHaveTextContent("Backlog1");
  });

  it("collapsing a group hides its rows and persists to localStorage", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Todo" }));

    expect(screen.queryByText("Old prod to new prod migration")).not.toBeInTheDocument();
    // The other group is untouched.
    expect(screen.getByText("Server-side PDF optimization")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("lizmeter.todos.collapsedStates") ?? "[]")).toEqual([1]);
  });
});

describe("TodosPage create shortcut", () => {
  it("opens the create dialog on `c`", async () => {
    await renderPage();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "c" });

    expect(await screen.findByRole("dialog", { name: "New todo" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New Todo" })).toBeInTheDocument();
  });

  it("ignores `c` while the caret is in a text field", async () => {
    await renderPage();

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "c" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    input.remove();
  });

  it("ignores `c` when it is part of a shortcut such as Ctrl+C", async () => {
    await renderPage();

    fireEvent.keyDown(document.body, { key: "c", ctrlKey: true });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a group's + opens the dialog preset to that group's state", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Add todo to Backlog" }));

    const dialog = await screen.findByRole("dialog", { name: "New todo" });
    expect(within(dialog).getByLabelText("State")).toHaveTextContent("Backlog");
  });
});

describe("TodosPage selection", () => {
  it("deletes every selected todo and then clears the selection", async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText("Select Old prod to new prod migration"));
    fireEvent.click(screen.getByLabelText("Select Fix misc code quality issues"));

    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockTodoAPI.delete).toHaveBeenCalledTimes(2));
    expect(mockTodoAPI.delete).toHaveBeenCalledWith(152);
    expect(mockTodoAPI.delete).toHaveBeenCalledWith(100);
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
  });

  it("moves every selected todo to the chosen state", async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText("Select Old prod to new prod migration"));

    // Custom dropdown: open the trigger, then pick from the portalled listbox.
    fireEvent.click(screen.getByLabelText("Move selected to state"));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Backlog"));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, stateId: 2 }));
  });

  it("Escape clears the selection", async () => {
    await renderPage();

    fireEvent.click(screen.getByLabelText("Select Old prod to new prod migration"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });
});

describe("TodosPage drag and drop", () => {
  it("registers each row body as a draggable", async () => {
    await renderPage();

    const row = screen.getByRole("button", { name: "Edit Old prod to new prod migration" });
    expect(row).toHaveAttribute("aria-roledescription", "draggable");
  });

  // The pointer gesture itself belongs to E2E -- jsdom reports every rect as 0x0, so dnd-kit
  // collision detection cannot resolve a group. What is guarded here is the wiring around it.
  it("leaves the checkbox and the row menu outside the drag grip", async () => {
    await renderPage();

    expect(screen.getByLabelText("Select Old prod to new prod migration"))
      .not.toHaveAttribute("aria-roledescription");
  });

  it("still opens the editor on a plain click, which the drag guard must not swallow", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Edit Old prod to new prod migration" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("TodosPage nesting", () => {
  //  200 Ship v1.14
  //    └─ 201 Write the migration
  //  202 Unrelated chore
  const nestedTodos: Todo[] = [
    makeTodo(200, "Ship v1.14", todoState, { childCount: 1 }),
    makeTodo(201, "Write the migration", todoState, { parentId: 200, parentTitle: "Ship v1.14" }),
    makeTodo(202, "Unrelated chore", backlogState),
  ];

  async function renderNested() {
    mockTodoAPI.list.mockResolvedValue(nestedTodos);
    render(<TodosPage />);
    await screen.findByText("Ship v1.14");
  }

  it("draws the parent title as a breadcrumb on a sub-issue row", async () => {
    await renderNested();

    expect(screen.getByTitle("Sub-issue of Ship v1.14")).toHaveTextContent("Ship v1.14");
  });

  it("draws sub-issue progress on a row that has children", async () => {
    await renderNested();

    expect(screen.getByTitle("0 of 1 sub-issue done")).toHaveTextContent("0/1");
  });

  it("reads the ring as complete once every sub-issue is done", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(210, "Cut the release", todoState, { childCount: 2, completedChildCount: 2 }),
    ]);
    render(<TodosPage />);
    await screen.findByText("Cut the release");

    expect(screen.getByTitle("2 of 2 sub-issues done")).toHaveTextContent("2/2");
  });

  it("keeps sub-issues as ordinary rows in their own state group", async () => {
    await renderNested();

    // Flat list: the child sits beside its parent under Todo, not indented inside it.
    expect(screen.getByText("Todo").parentElement).toHaveTextContent("Todo2");
    expect(screen.getByLabelText("Select Write the migration")).toBeInTheDocument();
  });

  it("offers 'Remove from parent' only on a row that has one", async () => {
    await renderNested();

    openRowMenu("Write the migration");
    expect(screen.getByRole("menuitem", { name: "Remove from parent" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Change parent..." })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    openRowMenu("Ship v1.14");
    expect(screen.queryByRole("menuitem", { name: "Remove from parent" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Make sub-issue of..." })).toBeInTheDocument();
  });

  it("'Remove from parent' lifts the todo to the top level", async () => {
    await renderNested();

    openRowMenu("Write the migration");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from parent" }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 201, parentId: null }));
  });

  it("picking a parent from the row menu writes the new link", async () => {
    await renderNested();

    openRowMenu("Ship v1.14");
    fireEvent.click(screen.getByRole("menuitem", { name: "Make sub-issue of..." }));

    const picker = await screen.findByRole("dialog", { name: /Nest #200/ });
    fireEvent.click(within(picker).getByText("Unrelated chore"));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 200, parentId: 202 }));
  });

  it("keeps a todo's own subtree out of the parent picker", async () => {
    await renderNested();

    openRowMenu("Ship v1.14");
    fireEvent.click(screen.getByRole("menuitem", { name: "Make sub-issue of..." }));

    const picker = await screen.findByRole("dialog", { name: /Nest #200/ });
    // 201 is its child and 200 is itself, so only the unrelated todo can be offered.
    expect(within(picker).queryByText("Write the migration")).not.toBeInTheDocument();
    expect(within(picker).queryByText("Ship v1.14")).not.toBeInTheDocument();
    expect(within(picker).getByText("Unrelated chore")).toBeInTheDocument();
  });

  it("shows the sub-issue block in the edit dialog", async () => {
    await renderNested();
    mockTodoAPI.list.mockResolvedValue([nestedTodos[1]!]);

    fireEvent.click(screen.getByLabelText("Edit Ship v1.14"));

    const dialog = await screen.findByRole("dialog", { name: "Edit todo" });
    const block = within(dialog).getByLabelText("Sub-issues");
    await waitFor(() => expect(block).toHaveTextContent("Write the migration"));
    expect(within(block).getByLabelText("New sub-issue title")).toBeInTheDocument();
  });

  it("adds a sub-issue from the edit dialog under the open todo", async () => {
    await renderNested();

    fireEvent.click(screen.getByLabelText("Edit Ship v1.14"));
    const dialog = await screen.findByRole("dialog", { name: "Edit todo" });

    const input = within(dialog).getByLabelText("New sub-issue title");
    fireEvent.change(input, { target: { value: "Back up the database" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mockTodoAPI.create).toHaveBeenCalledWith({
        title: "Back up the database",
        parentId: 200,
        source: "user",
      })
    );
  });

  it("unlinking a sub-issue from the dialog clears its parent rather than deleting it", async () => {
    await renderNested();
    mockTodoAPI.list.mockResolvedValue([nestedTodos[1]!]);

    fireEvent.click(screen.getByLabelText("Edit Ship v1.14"));
    const dialog = await screen.findByRole("dialog", { name: "Edit todo" });

    const unlink = await within(dialog).findByLabelText("Remove Write the migration from this todo");
    fireEvent.click(unlink);

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 201, parentId: null }));
    expect(mockTodoAPI.delete).not.toHaveBeenCalled();
  });

  it("saving the dialog carries the parent it was opened with", async () => {
    await renderNested();

    fireEvent.click(screen.getByLabelText("Edit Write the migration"));
    const dialog = await screen.findByRole("dialog", { name: "Edit todo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockTodoAPI.update).toHaveBeenCalledWith(expect.objectContaining({ id: 201, parentId: 200 }))
    );
  });
});

describe("TodosPage notes editor", () => {
  async function openNotesEditor() {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Edit Old prod to new prod migration"));
    const dialog = await screen.findByRole("dialog", { name: "Edit todo" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open full editor" }));
    return await screen.findByRole("dialog", { name: "Edit Notes" });
  }

  it("expands the notes field into a surface of its own", async () => {
    const modal = await openNotesEditor();

    expect(within(modal).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("closes only the expanded editor on Escape, leaving the todo dialog open", async () => {
    const modal = await openNotesEditor();

    fireEvent.keyDown(modal, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Notes" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Edit todo" })).toBeInTheDocument();
  });

  it("holds that layering even when the Escape targets document itself", async () => {
    // The other case: nothing focused, so the key event's target is `document` rather than an
    // element inside the modal. Both Escape layers are exercised here -- drop either the
    // modal's capture-phase listener or the dialog's `notesExpanded` guard and this still
    // passes; drop both and the todo dialog closes with the editor.
    await openNotesEditor();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Notes" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Edit todo" })).toBeInTheDocument();
  });
});

// Rendered order is Todo (position 0) then Backlog, so the cursor walks 152 -> 100 -> 162.
describe("TodosPage keyboard navigation", () => {
  /** Moves the cursor down `steps` rows from nothing, leaving it on the intended todo. */
  function cursorTo(steps: number) {
    for (let i = 0; i < steps; i++) fireEvent.keyDown(document.body, { key: "ArrowDown" });
  }

  it("`s` opens the state menu for the row under the cursor and writes the pick", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "s" });

    const menu = await screen.findByRole("dialog", { name: "Move to state" });
    fireEvent.click(within(menu).getByRole("button", { name: /Backlog/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, stateId: 2 }));
  });

  it("`p` sets the priority of the second row, not the first", async () => {
    await renderPage();
    cursorTo(2);

    fireEvent.keyDown(document.body, { key: "p" });

    const menu = await screen.findByRole("dialog", { name: "Set priority" });
    fireEvent.click(within(menu).getByRole("button", { name: /Urgent/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, priority: 1 }));
  });

  it("`d` writes today's date from the relative shortcut", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "d" });
    const menu = await screen.findByRole("dialog", { name: "Set due date" });
    fireEvent.click(within(menu).getByRole("button", { name: /^Today/ }));

    const today = new Date();
    const iso = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, dueDate: iso }));
  });

  it("`d` takes a typed date, picked with Enter", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "d" });
    const menu = await screen.findByRole("dialog", { name: "Set due date" });

    // Typing resets the highlight to the top, which is the typed date itself.
    fireEvent.change(within(menu).getByLabelText("Set due date"), { target: { value: "2026-09-01" } });
    fireEvent.keyDown(within(menu).getByLabelText("Set due date"), { key: "Enter" });

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, dueDate: "2026-09-01" }));
  });

  it("`d` rejects a date that only looks well-formed", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "d" });
    const menu = await screen.findByRole("dialog", { name: "Set due date" });
    fireEvent.change(within(menu).getByLabelText("Set due date"), { target: { value: "2026-02-30" } });

    // February 30th matches the shape but rolls into March, so it is never offered.
    expect(within(menu).queryByRole("button", { name: "2026-02-30" })).not.toBeInTheDocument();
  });

  it("`⇧P` offers the existing projects and writes the pick", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "P", shiftKey: true });

    const menu = await screen.findByRole("dialog", { name: "Set project" });
    fireEvent.click(within(menu).getByRole("button", { name: /^Infra/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, projectId: infraProject.id }));
  });

  it("`⇧P` creates a project from a typed name, then files the todo under it", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "P", shiftKey: true });
    const menu = await screen.findByRole("dialog", { name: "Set project" });
    fireEvent.change(within(menu).getByLabelText("Set project"), { target: { value: "Billing" } });

    fireEvent.click(within(menu).getByRole("button", { name: /Create "Billing"/ }));

    await waitFor(() => expect(mockTodoProjectAPI.create).toHaveBeenCalledWith({ name: "Billing" }));
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, projectId: 8 }));
  });

  it("`t` toggles a label on without closing the menu", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "t" });
    const menu = await screen.findByRole("dialog", { name: "Toggle labels" });
    fireEvent.click(within(menu).getByRole("button", { name: /^bug/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, labelIds: [bugLabel.id] }));
    // Several labels are usually set in one visit, so the menu stays up after a pick.
    expect(screen.getByRole("dialog", { name: "Toggle labels" })).toBeInTheDocument();
  });

  it("`t` toggles an attached label back off", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, { labels: [bugLabel] }),
    ]);
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "t" });
    const menu = await screen.findByRole("dialog", { name: "Toggle labels" });
    fireEvent.click(within(menu).getByRole("button", { name: /^bug/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, labelIds: [] }));
  });

  it("`t` keeps earlier picks when several labels are toggled in one visit", async () => {
    const uiLabel = { ...bugLabel, id: 12, name: "ui" };
    mockTodoLabelAPI.list.mockResolvedValue([bugLabel, uiLabel]);

    const withBug = makeTodo(152, "Old prod to new prod migration", todoState, { labels: [bugLabel] });
    // The list reloads after the first toggle, so the second pick must read the refreshed
    // todo. Reading the one captured when the menu opened would send [ui] and lose "bug".
    mockTodoAPI.list
      .mockResolvedValueOnce([makeTodo(152, "Old prod to new prod migration", todoState)])
      .mockResolvedValue([withBug]);

    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "t" });
    const menu = await screen.findByRole("dialog", { name: "Toggle labels" });

    fireEvent.click(within(menu).getByRole("button", { name: /^bug/ }));
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, labelIds: [bugLabel.id] }));

    // Wait for the refreshed row before the second pick, so the menu is reading live data.
    await waitFor(() => expect(screen.getByText("bug")).toBeInTheDocument());
    fireEvent.click(within(menu).getByRole("button", { name: /^ui/ }));

    await waitFor(() =>
      expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, labelIds: [bugLabel.id, uiLabel.id] })
    );
  });

  it("`t` creates a label from a typed name, then attaches it", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "t" });
    const menu = await screen.findByRole("dialog", { name: "Toggle labels" });
    fireEvent.change(within(menu).getByLabelText("Toggle labels"), { target: { value: "ui" } });
    fireEvent.click(within(menu).getByRole("button", { name: /Create "ui"/ }));

    await waitFor(() => expect(mockTodoLabelAPI.create).toHaveBeenCalledWith({ name: "ui" }));
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, labelIds: [12] }));
  });

  it("`l` opens the sub-issue picker on the cursor's row", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "l" });

    const picker = await screen.findByRole("dialog", { name: /File an existing todo under #152/ });
    fireEvent.click(await within(picker).findByRole("button", { name: /Fix misc code quality issues/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, parentId: 152 }));
  });

  it("`L` opens the parent picker on the cursor's row", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "L", shiftKey: true });

    const picker = await screen.findByRole("dialog", { name: /Nest #152/ });
    fireEvent.click(await within(picker).findByRole("button", { name: /Server-side PDF optimization/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, parentId: 162 }));
  });

  it("Ctrl+Shift+O opens the create dialog already filed under the cursor's row", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "O", ctrlKey: true, shiftKey: true });

    const dialog = await screen.findByRole("dialog", { name: "New todo" });
    expect(within(dialog).getByTitle("Change parent")).toHaveTextContent("Old prod to new prod migration");
  });

  it("does nothing on `s` until the cursor has been placed", async () => {
    await renderPage();

    fireEvent.keyDown(document.body, { key: "s" });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("ArrowUp stops at the top rather than wrapping to the end", async () => {
    await renderPage();
    cursorTo(1);
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    fireEvent.keyDown(document.body, { key: "ArrowUp" });

    fireEvent.keyDown(document.body, { key: "s" });
    const menu = await screen.findByRole("dialog", { name: "Move to state" });
    fireEvent.click(within(menu).getByRole("button", { name: /Backlog/ }));

    // Still the first row, not the last one it would have wrapped onto.
    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, stateId: 2 }));
  });

  it("keeps the page bindings quiet while a quick menu is open", async () => {
    await renderPage();
    cursorTo(1);
    fireEvent.keyDown(document.body, { key: "s" });
    await screen.findByRole("dialog", { name: "Move to state" });

    // `c` would otherwise stack the create dialog on top of the open menu.
    fireEvent.keyDown(document.body, { key: "c" });

    expect(screen.queryByRole("dialog", { name: "New todo" })).not.toBeInTheDocument();
  });

  it("Escape clears the selection first, then the cursor", async () => {
    await renderPage();
    cursorTo(1);
    fireEvent.click(screen.getByLabelText("Select Old prod to new prod migration"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    // Awaited rather than asserted outright: the keydown listener is rebuilt in an effect, and
    // under full-suite load React has not always flushed it before the next key is fired.
    await waitFor(() => expect(screen.queryByText("1 selected")).not.toBeInTheDocument());

    // The cursor survived that press, so `s` still has a row to act on.
    fireEvent.keyDown(document.body, { key: "s" });
    await screen.findByRole("dialog", { name: "Move to state" });
  });

  it("a second Escape drops the cursor as well", async () => {
    await renderPage();
    cursorTo(1);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("1 selected")).not.toBeInTheDocument());

    fireEvent.keyDown(document.body, { key: "s" });
    expect(screen.queryByRole("dialog", { name: "Move to state" })).not.toBeInTheDocument();
  });
});

describe("TodosPage priority", () => {
  it("labels the priority glyph on every row, set or not", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, { priority: 1 }),
      makeTodo(100, "Fix misc code quality issues", todoState),
    ]);
    await renderPage();

    expect(screen.getByLabelText("Urgent")).toBeInTheDocument();
    expect(screen.getByLabelText("No priority")).toBeInTheDocument();
  });
});

describe("TodosPage source icon", () => {
  it("marks a user-created todo as added by you", async () => {
    // makeTodo defaults to source: "user", sourceLabel: null.
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState),
    ]);
    await renderPage();

    expect(screen.getByLabelText("Added by you")).toBeInTheDocument();
  });

  it("names the specific agent for an AI-created todo that carries a source label", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, { source: "ai", sourceLabel: "claude-code" }),
    ]);
    await renderPage();

    expect(screen.getByLabelText("Added by claude-code")).toBeInTheDocument();
  });

  it("falls back to a generic AI label when no source label was recorded", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, { source: "ai", sourceLabel: null }),
    ]);
    await renderPage();

    expect(screen.getByLabelText("Added by AI")).toBeInTheDocument();
  });

  it.each([
    ["claude-code", styles.sourceIconClaude],
    ["claude", styles.sourceIconClaude],
    ["Claude", styles.sourceIconClaude],
    ["codex", styles.sourceIconCodex],
    ["openai", styles.sourceIconCodex],
    ["gpt-5", styles.sourceIconCodex],
  ])("resolves sourceLabel %s to its brand glyph, not the generic one", async (sourceLabel, expectedClass) => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, { source: "ai", sourceLabel }),
    ]);
    await renderPage();

    const icon = screen.getByLabelText(`Added by ${sourceLabel}`);
    expect(icon.className).toBe(expectedClass);
    expect(icon.className).not.toBe(styles.sourceIconAi);
  });

  it("falls back to the generic AI glyph for an unrecognized source label", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, { source: "ai", sourceLabel: "some-other-bot" }),
    ]);
    await renderPage();

    const icon = screen.getByLabelText("Added by some-other-bot");
    expect(icon.className).toBe(styles.sourceIconAi);
  });

  it("leaves the user glyph untouched by brand resolution", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState),
    ]);
    await renderPage();

    const icon = screen.getByLabelText("Added by you");
    expect(icon.className).toBe(styles.sourceIconUser);
  });
});

describe("TodosPage row context menu", () => {
  it("leaves no trigger on the row -- right-click is the only way in", async () => {
    await renderPage();

    expect(screen.queryByRole("button", { name: /^Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("right-clicking a row opens a menu carrying every row action", async () => {
    await renderPage();

    openRowMenu("Old prod to new prod migration");

    const menu = await screen.findByRole("menu", { name: "Actions for Old prod to new prod migration" });
    for (const name of ["Edit", "Priority...", "Due date...", "Project...", "Labels...", "Add sub-issue", "Delete"]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeInTheDocument();
    }
    // The row's own state is listed but not offered, so "move to" never means "stay put".
    expect(within(menu).getByRole("menuitem", { name: "Todo" })).toBeDisabled();
  });

  it("picking a state from the menu moves the row", async () => {
    await renderPage();

    openRowMenu("Old prod to new prod migration");
    fireEvent.click(screen.getByRole("menuitem", { name: "Backlog" }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 152, stateId: 2 }));
  });

  it("hands the value-shaped actions off to the same quick menu the shortcut opens", async () => {
    await renderPage();

    openRowMenu("Fix misc code quality issues");
    fireEvent.click(screen.getByRole("menuitem", { name: "Priority..." }));

    const quick = await screen.findByRole("dialog", { name: "Set priority" });
    fireEvent.click(within(quick).getByRole("button", { name: /Urgent/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 100, priority: 1 }));
  });

  it("deletes from the menu", async () => {
    await renderPage();

    openRowMenu("Server-side PDF optimization");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(mockTodoAPI.delete).toHaveBeenCalledWith(162));
  });

  it("closes on Escape without touching the todo", async () => {
    await renderPage();

    openRowMenu("Old prod to new prod migration");
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(mockTodoAPI.update).not.toHaveBeenCalled();
  });

  it("moves the keyboard cursor to the row it opened on", async () => {
    await renderPage();

    // Aiming at the third row and dismissing the menu leaves the cursor there, so `s` acts on it.
    openRowMenu("Server-side PDF optimization");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "s" });

    const quick = await screen.findByRole("dialog", { name: "Move to state" });
    fireEvent.click(within(quick).getByRole("button", { name: /Todo/ }));

    await waitFor(() => expect(mockTodoAPI.update).toHaveBeenCalledWith({ id: 162, stateId: 1 }));
  });
});

describe("TodosPage shortcut hints", () => {
  it("opens the cheat sheet on `?` and lists the row shortcuts", async () => {
    await renderPage();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).getByText("Set priority")).toBeInTheDocument();
    expect(within(sheet).getByText("Link a parent")).toBeInTheDocument();
    expect(within(sheet).getByText("New sub-issue of the todo under the cursor")).toBeInTheDocument();
  });

  it("opens from the toolbar too, for anyone who never presses `?`", async () => {
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));

    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("closes on Escape without disturbing the cursor", async () => {
    await renderPage();
    fireEvent.keyDown(document.body, { key: "ArrowDown" });

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());

    // Escape was swallowed by the sheet, so the cursor it was explaining is still there.
    fireEvent.keyDown(document.body, { key: "s" });
    await screen.findByRole("dialog", { name: "Move to state" });
  });

  it("needs no cursor, unlike the shortcuts it documents", async () => {
    await renderPage();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("keeps the page bindings quiet while it is open", async () => {
    await renderPage();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    fireEvent.keyDown(document.body, { key: "c" });

    expect(screen.queryByRole("dialog", { name: "New todo" })).not.toBeInTheDocument();
  });
});

// --- Projects and labels on the row -----------------------------------------

describe("project and label chips", () => {
  it("draws the project by name", async () => {
    await renderPage();
    expect(screen.getByText("Infra")).toBeInTheDocument();
  });

  it("draws every label a todo carries", async () => {
    mockTodoAPI.list.mockResolvedValue([
      makeTodo(152, "Old prod to new prod migration", todoState, {
        labels: [bugLabel, { ...bugLabel, id: 12, name: "ui" }],
      }),
    ]);
    await renderPage();

    expect(screen.getByText("bug")).toBeInTheDocument();
    expect(screen.getByText("ui")).toBeInTheDocument();
  });

  /** `Select` is a custom combobox, not a native <select>: open it, then pick the option. */
  async function pickFromSelect(ariaLabel: string, optionName: RegExp) {
    fireEvent.click(screen.getByRole("combobox", { name: ariaLabel }));
    const list = await screen.findByRole("listbox", { name: ariaLabel });
    fireEvent.click(within(list).getByRole("option", { name: optionName }));
  }

  it("filters the list by project id", async () => {
    await renderPage();

    await pickFromSelect("Filter by project", /^Infra/);

    await waitFor(() =>
      expect(mockTodoAPI.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: infraProject.id }))
    );
  });

  it("filters the list by label id", async () => {
    await renderPage();

    await pickFromSelect("Filter by label", /^bug/);

    await waitFor(() =>
      expect(mockTodoAPI.list).toHaveBeenCalledWith(expect.objectContaining({ labelId: bugLabel.id }))
    );
  });
});

// --- The Manage dialog -------------------------------------------------------

describe("the Manage dialog", () => {
  async function openManage() {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    return screen.findByRole("dialog", { name: /Manage todo states/ });
  }

  it("opens on the States tab", async () => {
    const dialog = await openManage();
    expect(within(dialog).getByRole("tab", { name: "States" })).toHaveAttribute("aria-selected", "true");
  });

  it("creates a project from the Projects tab", async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Projects" }));

    fireEvent.change(within(dialog).getByLabelText("New project name"), { target: { value: "Billing" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockTodoProjectAPI.create).toHaveBeenCalledWith({ name: "Billing", color: "#7aa2f7" }));
  });

  it("renames a project on blur", async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Projects" }));

    const input = within(dialog).getByLabelText("Rename Infra");
    fireEvent.change(input, { target: { value: "Platform" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(mockTodoProjectAPI.update).toHaveBeenCalledWith({ id: infraProject.id, name: "Platform" })
    );
  });

  it("says the todos survive before deleting a project", async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Projects" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Infra" }));

    expect(within(dialog).getByText(/The todos themselves are kept/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(mockTodoProjectAPI.delete).toHaveBeenCalledWith(infraProject.id));
  });

  it("creates a label from the Labels tab", async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Labels" }));

    fireEvent.change(within(dialog).getByLabelText("New label name"), { target: { value: "chore" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mockTodoLabelAPI.create).toHaveBeenCalledWith({ name: "chore", color: "#7aa2f7" }));
  });

  it("recolors a label from the palette", async () => {
    const dialog = await openManage();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Labels" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Set bug to #9ece6a" }));

    await waitFor(() => expect(mockTodoLabelAPI.update).toHaveBeenCalledWith({ id: bugLabel.id, color: "#9ece6a" }));
  });
});

describe("TodosPage highlight-on-navigate", () => {
  it("flashes the highlighted row and clears it once the flash animation ends, not via a timer", async () => {
    const onHighlightConsumed = vi.fn();
    render(<TodosPage highlightTodoId={100} onHighlightConsumed={onHighlightConsumed} />);
    await screen.findByText("Fix misc code quality issues");

    await waitFor(() => expect(onHighlightConsumed).toHaveBeenCalledTimes(1));

    const row = document.querySelector(`[data-todo-row="100"]`) as HTMLElement;
    expect(row.className).toContain(styles.rowFlashed);

    // React resolves the native animation-end event name via CSS feature detection, which lands
    // on the unprefixed "animationend" in a real browser but on a vendor-prefixed variant in this
    // jsdom test environment -- firing both keeps the test correct regardless of which one React
    // is actually listening for here; `onFlashEnd` is idempotent, so the redundant one is a no-op.
    fireEvent.animationEnd(row);
    fireEvent(row, new Event("webkitAnimationEnd", { bubbles: true }));

    expect(row.className).not.toContain(styles.rowFlashed);
  });

  it("consumes a highlight for a todo that cannot be found, without expanding or persisting a collapsed group", async () => {
    // Group 1 ("Todo") starts collapsed -- a not-found lookup must never force it open or save
    // that as if the user had asked for it.
    localStorage.setItem("lizmeter.todos.collapsedStates", JSON.stringify([1]));
    const onHighlightConsumed = vi.fn();

    render(<TodosPage highlightTodoId={9999} onHighlightConsumed={onHighlightConsumed} />);
    await screen.findByText("Server-side PDF optimization");

    await waitFor(() => expect(onHighlightConsumed).toHaveBeenCalledTimes(1));

    expect(screen.queryByText("Old prod to new prod migration")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("lizmeter.todos.collapsedStates") ?? "[]")).toEqual([1]);
  });

  it("waits for the todo list to finish loading before deciding a highlighted id is missing", async () => {
    let resolveList: (todos: Todo[]) => void = () => {};
    mockTodoAPI.list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    const onHighlightConsumed = vi.fn();

    render(<TodosPage highlightTodoId={9999} onHighlightConsumed={onHighlightConsumed} />);

    // Still loading -- must not be mistaken for "not found" yet.
    expect(onHighlightConsumed).not.toHaveBeenCalled();

    resolveList(sampleTodos);
    await waitFor(() => expect(onHighlightConsumed).toHaveBeenCalledTimes(1));
  });
});
