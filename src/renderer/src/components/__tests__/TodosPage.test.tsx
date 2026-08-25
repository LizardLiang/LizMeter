import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Todo, TodoState } from "../../../../shared/types.ts";
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

function makeTodo(id: number, title: string, state: TodoState, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    title,
    notes: null,
    state,
    project: null,
    milestone: null,
    startDate: null,
    dueDate: null,
    source: "user",
    sourceLabel: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    completedAt: null,
    ...extra,
  };
}

const sampleTodos: Todo[] = [
  makeTodo(152, "Old prod to new prod migration", todoState),
  makeTodo(100, "Fix misc code quality issues", todoState, { project: "Infra" }),
  makeTodo(162, "Server-side PDF optimization", backlogState),
];

const mockTodoAPI = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  clearCompleted: vi.fn(),
  listProjects: vi.fn(),
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

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("electronAPI", { todo: mockTodoAPI, todoState: mockTodoStateAPI });
  mockTodoAPI.list.mockResolvedValue(sampleTodos);
  mockTodoAPI.listProjects.mockResolvedValue(["Infra"]);
  mockTodoAPI.listMilestones.mockResolvedValue([]);
  mockTodoAPI.delete.mockResolvedValue(undefined);
  mockTodoAPI.update.mockResolvedValue(sampleTodos[0]);
  mockTodoAPI.create.mockResolvedValue(sampleTodos[0]);
  mockTodoAPI.onChanged.mockReturnValue(() => {});
  mockTodoStateAPI.list.mockResolvedValue([todoState, backlogState]);
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
