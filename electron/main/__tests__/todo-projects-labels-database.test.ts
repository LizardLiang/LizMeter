// Tests for todo projects and labels in database.ts, plus the migration that promotes the
// old free-text `todos.project` column to rows.
// Uses in-memory database (sql.js shim via vitest alias)

import { beforeEach, describe, expect, it } from "vitest";
import {
  createTodo,
  createTodoLabel,
  createTodoProject,
  deleteTodo,
  deleteTodoLabel,
  deleteTodoProject,
  findTodoLabelByName,
  findTodoProjectByName,
  getDb,
  initDatabase,
  listTodoLabels,
  listTodoProjects,
  listTodos,
  migrateTodosToStatesNow,
  reorderTodoProjects,
  updateTodo,
  updateTodoLabel,
  updateTodoProject,
} from "../database.ts";

beforeEach(() => {
  initDatabase(":memory:");
});

// --- Projects ----------------------------------------------------------------

describe("todo projects", () => {
  it("creates one with a default colour and an appended position", () => {
    const first = createTodoProject({ name: "LizMeter" });
    const second = createTodoProject({ name: "Vital" });

    expect(first.name).toBe("LizMeter");
    expect(first.color).toBe("#7aa2f7");
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
  });

  it("trims the name", () => {
    expect(createTodoProject({ name: "  LizMeter  " }).name).toBe("LizMeter");
  });

  it("rejects a duplicate name regardless of case", () => {
    createTodoProject({ name: "LizMeter" });
    expect(() => createTodoProject({ name: "lizmeter" })).toThrow(/already exists/);
  });

  it("rejects a colour outside the palette", () => {
    expect(() => createTodoProject({ name: "x", color: "#123456" })).toThrow(/Invalid project color/);
  });

  it("finds one by name, case-insensitively", () => {
    const created = createTodoProject({ name: "LizMeter" });
    expect(findTodoProjectByName("lizmeter")?.id).toBe(created.id);
    expect(findTodoProjectByName("nope")).toBeNull();
  });

  it("renames without touching the todos that point at it", () => {
    const project = createTodoProject({ name: "LizMeter" });
    const todo = createTodo({ title: "x", projectId: project.id });

    updateTodoProject({ id: project.id, name: "Liz Meter" });

    // The whole point of the foreign key: the todo follows the rename for free.
    expect(listTodos().find((t) => t.id === todo.id)?.project?.name).toBe("Liz Meter");
  });

  it("rejects a rename onto another project's name", () => {
    createTodoProject({ name: "LizMeter" });
    const other = createTodoProject({ name: "Vital" });
    expect(() => updateTodoProject({ id: other.id, name: "lizmeter" })).toThrow(/already exists/);
  });

  it("keeps the todos when the project is deleted, and clears their project", () => {
    const project = createTodoProject({ name: "LizMeter" });
    createTodo({ title: "a", projectId: project.id });
    createTodo({ title: "b", projectId: project.id });

    expect(deleteTodoProject(project.id)).toBe(2);

    const todos = listTodos();
    expect(todos).toHaveLength(2);
    expect(todos.every((t) => t.project === null)).toBe(true);
    expect(listTodoProjects()).toHaveLength(0);
  });

  it("keeps positions contiguous after a delete", () => {
    const a = createTodoProject({ name: "a" });
    createTodoProject({ name: "b" });
    createTodoProject({ name: "c" });

    deleteTodoProject(a.id);

    expect(listTodoProjects().map((p) => p.position)).toEqual([0, 1]);
  });

  it("reorders to the given order", () => {
    const a = createTodoProject({ name: "a" });
    const b = createTodoProject({ name: "b" });
    const c = createTodoProject({ name: "c" });

    reorderTodoProjects([c.id, a.id, b.id]);

    expect(listTodoProjects().map((p) => p.name)).toEqual(["c", "a", "b"]);
  });
});

// --- Labels ------------------------------------------------------------------

describe("todo labels", () => {
  it("returns the existing label instead of failing on a duplicate name", () => {
    const first = createTodoLabel({ name: "bug" });
    const again = createTodoLabel({ name: "BUG" });

    // Get-or-create, unlike projects: typing a known name in the picker means "use that one".
    expect(again.id).toBe(first.id);
    expect(listTodoLabels()).toHaveLength(1);
  });

  it("lists name-ordered rather than creation-ordered", () => {
    createTodoLabel({ name: "ui" });
    createTodoLabel({ name: "bug" });
    createTodoLabel({ name: "chore" });

    expect(listTodoLabels().map((l) => l.name)).toEqual(["bug", "chore", "ui"]);
  });

  it("finds one by name, case-insensitively", () => {
    const created = createTodoLabel({ name: "bug" });
    expect(findTodoLabelByName("BUG")?.id).toBe(created.id);
    expect(findTodoLabelByName("nope")).toBeNull();
  });

  it("attaches several to a todo, name-ordered", () => {
    const ui = createTodoLabel({ name: "ui" });
    const bug = createTodoLabel({ name: "bug" });
    const todo = createTodo({ title: "x", labelIds: [ui.id, bug.id] });

    expect(todo.labels.map((l) => l.name)).toEqual(["bug", "ui"]);
  });

  it("replaces the whole set on update, and clears it with an empty array", () => {
    const bug = createTodoLabel({ name: "bug" });
    const ui = createTodoLabel({ name: "ui" });
    const todo = createTodo({ title: "x", labelIds: [bug.id] });

    expect(updateTodo({ id: todo.id, labelIds: [ui.id] }).labels.map((l) => l.name)).toEqual(["ui"]);
    expect(updateTodo({ id: todo.id, labelIds: [] }).labels).toEqual([]);
  });

  it("leaves the set alone when labelIds is absent from an update", () => {
    const bug = createTodoLabel({ name: "bug" });
    const todo = createTodo({ title: "x", labelIds: [bug.id] });

    expect(updateTodo({ id: todo.id, title: "y" }).labels.map((l) => l.name)).toEqual(["bug"]);
  });

  it("ignores a repeated id rather than linking twice", () => {
    const bug = createTodoLabel({ name: "bug" });
    const todo = createTodo({ title: "x", labelIds: [bug.id, bug.id] });

    expect(todo.labels).toHaveLength(1);
  });

  it("rejects an unknown label id without writing anything", () => {
    const bug = createTodoLabel({ name: "bug" });
    const todo = createTodo({ title: "x", labelIds: [bug.id] });

    expect(() => updateTodo({ id: todo.id, labelIds: [bug.id, 9999] })).toThrow(/not found/);
    // The pre-check runs before the delete, so the original set survives the rejection.
    expect(listTodos().find((t) => t.id === todo.id)?.labels.map((l) => l.name)).toEqual(["bug"]);
  });

  it("renames across every todo carrying it", () => {
    const bug = createTodoLabel({ name: "bug" });
    createTodo({ title: "a", labelIds: [bug.id] });
    createTodo({ title: "b", labelIds: [bug.id] });

    updateTodoLabel({ id: bug.id, name: "defect" });

    expect(listTodos().every((t) => t.labels[0]?.name === "defect")).toBe(true);
  });

  it("keeps the todos when the label is deleted", () => {
    const bug = createTodoLabel({ name: "bug" });
    createTodo({ title: "a", labelIds: [bug.id] });
    createTodo({ title: "b", labelIds: [bug.id] });

    expect(deleteTodoLabel(bug.id)).toBe(2);

    expect(listTodos()).toHaveLength(2);
    expect(listTodos().every((t) => t.labels.length === 0)).toBe(true);
  });

  it("drops the links when the todo itself is deleted", () => {
    const bug = createTodoLabel({ name: "bug" });
    const todo = createTodo({ title: "a", labelIds: [bug.id] });

    deleteTodo(todo.id);

    const { count } = getDb()
      .prepare("SELECT COUNT(*) AS count FROM todo_label_links WHERE todo_id = ?")
      .get(todo.id) as { count: number };
    expect(count).toBe(0);
  });
});

// --- Migration ---------------------------------------------------------------

describe("migrating the free-text project column to rows", () => {
  /** Rebuilds the pre-migration shape: a `project` TEXT column and no `project_id`. */
  function makeLegacyProjectColumn(): void {
    const db = getDb();
    db.exec("DROP INDEX IF EXISTS idx_todos_project_id");
    db.exec("ALTER TABLE todos DROP COLUMN project_id");
    db.exec("ALTER TABLE todos ADD COLUMN project TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project)");
  }

  function setLegacyProject(todoId: number, project: string | null): void {
    getDb().prepare("UPDATE todos SET project = ? WHERE id = ?").run(project, todoId);
  }

  it("turns each distinct spelling into one project and repoints the todos", () => {
    const a = createTodo({ title: "a" });
    const b = createTodo({ title: "b" });
    makeLegacyProjectColumn();
    setLegacyProject(a.id, "LizMeter");
    setLegacyProject(b.id, "Vital");

    migrateTodosToStatesNow();

    expect(listTodoProjects().map((p) => p.name).sort()).toEqual(["LizMeter", "Vital"]);
    const byTitle = Object.fromEntries(listTodos().map((t) => [t.title, t.project?.name ?? null]));
    expect(byTitle).toEqual({ a: "LizMeter", b: "Vital" });
  });

  it("collapses spellings that differ only by case into a single project", () => {
    const a = createTodo({ title: "a" });
    const b = createTodo({ title: "b" });
    makeLegacyProjectColumn();
    setLegacyProject(a.id, "LizMeter");
    setLegacyProject(b.id, "lizmeter");

    migrateTodosToStatesNow();

    expect(listTodoProjects()).toHaveLength(1);
    expect(listTodos().every((t) => t.project !== null)).toBe(true);
  });

  it("trims surrounding whitespace and skips blank values", () => {
    const a = createTodo({ title: "a" });
    const b = createTodo({ title: "b" });
    makeLegacyProjectColumn();
    setLegacyProject(a.id, "  LizMeter  ");
    setLegacyProject(b.id, "   ");

    migrateTodosToStatesNow();

    expect(listTodoProjects().map((p) => p.name)).toEqual(["LizMeter"]);
    expect(listTodos().find((t) => t.title === "b")?.project).toBeNull();
  });

  it("drops the old text column once the rows are repointed", () => {
    createTodo({ title: "a" });
    makeLegacyProjectColumn();

    migrateTodosToStatesNow();

    const columns = (getDb().prepare("PRAGMA table_info(todos)").all() as Array<{ name: string; }>)
      .map((c) => c.name);
    expect(columns).toContain("project_id");
    expect(columns).not.toContain("project");
  });

  it("is a no-op when run again", () => {
    const a = createTodo({ title: "a" });
    makeLegacyProjectColumn();
    setLegacyProject(a.id, "LizMeter");

    migrateTodosToStatesNow();
    migrateTodosToStatesNow();

    expect(listTodoProjects()).toHaveLength(1);
    expect(listTodos()[0]?.project?.name).toBe("LizMeter");
  });
});
