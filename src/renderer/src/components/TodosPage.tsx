import { useCallback, useEffect, useMemo, useState } from "react";
import type { Todo, TodoFilter, TodoState } from "../../../shared/types.ts";
import { useTodos } from "../hooks/useTodos.ts";
import { Select } from "./Select.tsx";
import { TodoEditDialog } from "./TodoEditDialog.tsx";
import { TodoRowMenu } from "./TodoRowMenu.tsx";
import styles from "./TodosPage.module.scss";
import { TodoStateManager } from "./TodoStateManager.tsx";

const FILTERS: Array<{ id: TodoFilter; label: string; }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "ai", label: "From AI" },
];

/** Collapsed groups outlive the page, which unmounts whenever you navigate away. */
const COLLAPSED_KEY = "lizmeter.todos.collapsedStates";

function loadCollapsed(): Set<number> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is number => typeof v === "number"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<number>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage being unavailable only costs the collapse memory, so it is not worth surfacing.
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDay(iso: string): string {
  // Parsed as UTC noon so a date-only string cannot slip a day in a negative timezone.
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A project reads as a box, the way Linear draws one. A coloured dot would say "label". */
function ProjectIcon() {
  return (
    <svg
      className={styles.projectIcon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 1.6 14 5v6l-6 3.4L2 11V5l6-3.4Z" />
      <path d="M2 5l6 3.4L14 5" />
      <path d="M8 8.4v6" />
    </svg>
  );
}

function StateDot({ state }: { state: TodoState; }) {
  return (
    <span
      className={styles.dot}
      style={{ borderColor: state.color, background: state.isCompleted ? state.color : "transparent" }}
      aria-hidden="true"
    />
  );
}

// ---- Row ----

interface RowProps {
  todo: Todo;
  states: TodoState[];
  selected: boolean;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
  onEdit: (todo: Todo) => void;
  onSetState: (id: number, stateId: number) => void;
  onDelete: (id: number) => void;
}

function TodoRow({ todo, states, selected, onToggleSelect, onEdit, onSetState, onDelete }: RowProps) {
  const overdue = todo.dueDate !== null && !todo.state.isCompleted && todo.dueDate < todayIso();
  const dateIso = todo.dueDate ?? todo.createdAt.slice(0, 10);

  return (
    <li className={selected ? styles.rowSelected : styles.row}>
      <input
        type="checkbox"
        className={styles.check}
        checked={selected}
        onChange={() => {}}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(todo.id, e.shiftKey);
        }}
        aria-label={`Select ${todo.title}`}
      />

      <span className={styles.menuSlot}>
        <TodoRowMenu
          todoId={todo.id}
          todoTitle={todo.title}
          currentStateId={todo.state.id}
          states={states}
          onEdit={() => onEdit(todo)}
          onSetState={(stateId) => onSetState(todo.id, stateId)}
          onDelete={() => onDelete(todo.id)}
        />
      </span>

      <button
        className={styles.rowBody}
        onClick={() => onEdit(todo)}
        title={todo.notes ?? undefined}
        aria-label={`Edit ${todo.title}`}
      >
        <span className={styles.id}>#{todo.id}</span>
        <StateDot state={todo.state} />
        <span className={todo.state.isCompleted ? styles.titleDone : styles.title}>{todo.title}</span>
        {todo.milestone && <span className={styles.crumb}>&rsaquo; {todo.milestone}</span>}

        <span className={styles.spacer} />

        {todo.project && (
          <span className={styles.project}>
            <ProjectIcon />
            {todo.project}
          </span>
        )}
        {todo.source === "ai" && (
          <span className={styles.aiBadge} title={todo.sourceLabel ?? "Added by AI"}>
            {todo.sourceLabel ?? "AI"}
          </span>
        )}
        <span className={overdue ? styles.dateOverdue : styles.date}>{formatDay(dateIso)}</span>
      </button>
    </li>
  );
}

// ---- Page ----

export function TodosPage() {
  const {
    todos,
    states,
    projects,
    milestones,
    filter,
    setFilter,
    projectFilter,
    setProjectFilter,
    loading,
    error,
    createTodo,
    updateTodo,
    setTodoState,
    deleteTodo,
    setTodosState,
    deleteTodos,
    clearCompleted,
    createState,
    updateState,
    deleteState,
    reorderStates,
  } = useTodos();

  const [editing, setEditing] = useState<Todo | null>(null);
  /** Non-null while the create dialog is open. `stateId` is the group whose "+" was clicked. */
  const [creating, setCreating] = useState<{ stateId: number | null; } | null>(null);
  const [managingStates, setManagingStates] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(loadCollapsed);
  const [selectedRaw, setSelectedRaw] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  // A todo removed elsewhere (bulk delete, the MCP server) must drop out of the selection.
  // Deriving that here rather than pruning in an effect keeps the render the single source.
  const selected = useMemo(() => {
    if (selectedRaw.size === 0) return selectedRaw;
    const live = new Set(todos.map((t) => t.id));
    const next = new Set([...selectedRaw].filter((id) => live.has(id)));
    return next.size === selectedRaw.size ? selectedRaw : next;
  }, [selectedRaw, todos]);

  const dialogOpen = editing !== null || creating !== null || managingStates;
  const doneCount = todos.filter((todo) => todo.state.isCompleted).length;

  const countsByState = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const todo of todos) counts[todo.state.id] = (counts[todo.state.id] ?? 0) + 1;
    return counts;
  }, [todos]);

  const groups = useMemo(() => {
    const byState = new Map<number, Todo[]>();
    for (const todo of todos) {
      const list = byState.get(todo.state.id);
      if (list) list.push(todo);
      else byState.set(todo.state.id, [todo]);
    }
    return [...states]
      .sort((a, b) => a.position - b.position)
      .map((state) => ({ state, items: byState.get(state.id) ?? [] }));
  }, [todos, states]);

  /** Row order as rendered, so shift-click can select a contiguous range across groups. */
  const visibleIds = useMemo(
    () => groups.flatMap((g) => collapsed.has(g.state.id) ? [] : g.items.map((t) => t.id)),
    [groups, collapsed],
  );

  const toggleCollapsed = useCallback((stateId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stateId)) next.delete(stateId);
      else next.add(stateId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((id: number, shiftKey: boolean) => {
    setSelectedRaw((prev) => {
      const next = new Set(prev);
      if (shiftKey && anchor !== null) {
        const from = visibleIds.indexOf(anchor);
        const to = visibleIds.indexOf(id);
        if (from !== -1 && to !== -1) {
          for (const vid of visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(vid);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  }, [anchor, visibleIds]);

  // `c` opens the create dialog, Escape drops the selection -- both are Linear bindings.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

      if (event.key === "c" && !dialogOpen) {
        event.preventDefault();
        setCreating({ stateId: null });
      } else if (event.key === "Escape" && !dialogOpen && selected.size > 0) {
        setSelectedRaw(new Set());
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialogOpen, selected.size]);

  const selectedIds = useMemo(() => [...selected], [selected]);

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {FILTERS.map(({ id, label }) => (
            <button
              key={id}
              className={filter === id ? styles.tabActive : styles.tab}
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={styles.toolbarRight}>
          <Select
            ariaLabel="Filter by project"
            className={styles.filterSelect}
            value={projectFilter ?? ""}
            options={[
              { value: "", label: "Any project" },
              ...projects.map((p) => ({ value: p, label: p })),
            ]}
            onChange={(next) => setProjectFilter(next === "" ? null : next)}
          />

          <button className={styles.ghostBtn} onClick={() => setManagingStates(true)}>States</button>
          {doneCount > 0 && (
            <button className={styles.ghostBtn} onClick={() => void clearCompleted()}>
              Clear {doneCount} done
            </button>
          )}
          <button className={styles.newBtn} onClick={() => setCreating({ stateId: null })}>
            New<kbd className={styles.kbd}>c</kbd>
          </button>
        </div>
      </div>

      {error && <p className={styles.errorMsg}>{error}</p>}

      {loading
        ? <p className={styles.stateMsg}>Loading...</p>
        : (
          <div className={styles.panel}>
            {groups.map(({ state, items }) => {
              const isCollapsed = collapsed.has(state.id);
              return (
                <section key={state.id} className={styles.group}>
                  <div className={styles.groupBand}>
                    <button
                      className={styles.chevBtn}
                      onClick={() => toggleCollapsed(state.id)}
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${state.label}`}
                    >
                      <span className={isCollapsed ? styles.chev : styles.chevOpen}>&#9654;</span>
                    </button>
                    <StateDot state={state} />
                    <span className={styles.groupName}>{state.label}</span>
                    <span className={styles.groupCount}>{items.length}</span>
                    <button
                      className={styles.groupAdd}
                      onClick={() => setCreating({ stateId: state.id })}
                      aria-label={`Add todo to ${state.label}`}
                    >
                      +
                    </button>
                  </div>

                  {!isCollapsed && items.length > 0 && (
                    <ul className={styles.rows}>
                      {items.map((todo) => (
                        <TodoRow
                          key={todo.id}
                          todo={todo}
                          states={states}
                          selected={selected.has(todo.id)}
                          onToggleSelect={toggleSelect}
                          onEdit={setEditing}
                          onSetState={(id, sid) => void setTodoState(id, sid)}
                          onDelete={(id) => void deleteTodo(id)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}

            {groups.length === 0 && <p className={styles.stateMsg}>Nothing here yet.</p>}
          </div>
        )}

      {selected.size > 0 && (
        <div className={styles.bulkBar} role="region" aria-label="Selection actions">
          <span className={styles.bulkCount}>{selected.size} selected</span>
          <Select
            ariaLabel="Move selected to state"
            className={styles.bulkSelect}
            placeholder="Move to..."
            value=""
            options={states.map((s) => ({ value: String(s.id), label: s.label, color: s.color }))}
            onChange={(next) => {
              void setTodosState(selectedIds, Number(next));
              setSelectedRaw(new Set());
            }}
          />
          <button
            className={styles.bulkDelete}
            onClick={() => {
              void deleteTodos(selectedIds);
              setSelectedRaw(new Set());
            }}
          >
            Delete
          </button>
          <button className={styles.bulkClear} onClick={() => setSelectedRaw(new Set())}>Clear</button>
        </div>
      )}

      {(editing !== null || creating !== null) && (
        <TodoEditDialog
          key={editing ? `edit-${editing.id}` : `new-${creating?.stateId ?? "default"}`}
          todo={editing}
          defaultStateId={creating?.stateId ?? undefined}
          states={states}
          projects={projects}
          milestones={milestones}
          onSave={updateTodo}
          onCreate={createTodo}
          onDelete={deleteTodo}
          onClose={() => {
            setEditing(null);
            setCreating(null);
          }}
        />
      )}

      {managingStates && (
        <TodoStateManager
          states={states}
          countsByState={countsByState}
          onCreate={createState}
          onUpdate={updateState}
          onDelete={deleteState}
          onReorder={reorderStates}
          onClose={() => setManagingStates(false)}
        />
      )}
    </div>
  );
}
