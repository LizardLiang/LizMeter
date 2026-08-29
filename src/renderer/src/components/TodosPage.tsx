import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Todo, TodoFilter, TodoState } from "../../../shared/types.ts";
import { TODO_PRIORITY_LABELS, todoPriorityLabel } from "../../../shared/types.ts";
import { useTodos } from "../hooks/useTodos.ts";
import { toPlainSummary } from "../utils/markdownPlain.ts";
import { droppedStateId, stateDropId, todosToMove } from "../utils/todoDrag.ts";
import { Select } from "./Select.tsx";
import { TodoEditDialog } from "./TodoEditDialog.tsx";
import { TodoManageDialog } from "./TodoManageDialog.tsx";
import { TodoPicker } from "./TodoPicker.tsx";
import { type QuickMenuItem, TodoQuickMenu } from "./TodoQuickMenu.tsx";
import { type MenuAnchor, type QuickMenuKind, TodoActionMenu } from "./TodoRowMenu.tsx";
import { TodoShortcutsOverlay } from "./TodoShortcutsOverlay.tsx";
import styles from "./TodosPage.module.scss";

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

/** Local calendar arithmetic: going through `toISOString()` would shift the day behind UTC. */
function isoPlusDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Well-formed is not enough: 2026-02-30 matches the shape but rolls forward when parsed. */
function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

interface QuickMenuConfig {
  heading: string;
  placeholder: string;
  items: QuickMenuItem[];
  acceptQuery?: (query: string) => QuickMenuItem | null;
  /** Only the label menu sets this: several labels can be toggled without reopening. */
  multi?: boolean;
  onPick: (value: string) => void;
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

/**
 * How far a parent's sub-issues have got, as a ring that fills clockwise from 12 o'clock.
 * It replaces the old elbow-arrow glyph, which could only say "this row has work filed under
 * it" -- the ring says that and how much of it is done, without costing more width.
 */
function SubProgressRing({ done, total }: { done: number; total: number; }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;

  return (
    <svg
      className={done >= total ? styles.subRingDone : styles.subRing}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r={radius} stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      {
        /* Skipped at zero on purpose: a round cap on a zero-length dash still paints a dot,
          which would read as "one done". */
      }
      {ratio > 0 && (
        <circle
          cx="7"
          cy="7"
          r={radius}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}

/**
 * Linear's priority glyph: three ascending bars, filled up to the level. Urgent breaks the
 * pattern with a solid block, because "most urgent" should not read as merely "one bar taller".
 *
 * Drawn for priority 0 too, dimmed, so the icon holds a fixed column and the titles below it
 * stay aligned whether or not a row has a priority.
 */
function PriorityIcon({ priority }: { priority: number; }) {
  const filled = (level: number) => (priority > 0 && priority <= level ? 1 : 0.28);

  return (
    <span
      className={styles.priorityIcon}
      data-priority={priority}
      title={todoPriorityLabel(priority)}
      aria-label={todoPriorityLabel(priority)}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {priority === 1
          ? (
            <>
              <rect x="6.4" y="1.5" width="3.2" height="8.4" rx="1.4" />
              <rect x="6.4" y="11.6" width="3.2" height="3" rx="1.4" />
            </>
          )
          : (
            <>
              {/* High fills all three, Medium the first two, Low only the first. */}
              <rect x="1" y="9.5" width="3.6" height="5" rx="1" opacity={filled(4)} />
              <rect x="6.2" y="6" width="3.6" height="8.5" rx="1" opacity={filled(3)} />
              <rect x="11.4" y="2.5" width="3.6" height="12" rx="1" opacity={filled(2)} />
            </>
          )}
      </svg>
    </span>
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
  selected: boolean;
  /** The keyboard cursor sits here. Separate from `selected`, which is the checkbox. */
  focused: boolean;
  /** Dimmed while this row is one of the rows in flight. */
  dragging: boolean;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
  onEdit: (todo: Todo) => void;
  onOpenMenu: (todo: Todo, anchor: MenuAnchor) => void;
  /** True for the click a browser fires at the end of a drag -- that one must not open the editor. */
  wasJustDragged: () => boolean;
}

function TodoRow(props: RowProps) {
  const { todo, selected, focused, dragging, onToggleSelect, onEdit, onOpenMenu, wasJustDragged } = props;
  const { attributes, listeners, setNodeRef } = useDraggable({ id: todo.id });

  const overdue = todo.dueDate !== null && !todo.state.isCompleted && todo.dueDate < todayIso();
  const dateIso = todo.dueDate ?? todo.createdAt.slice(0, 10);

  let rowClass = styles.row;
  if (dragging) rowClass = styles.rowDragging;
  else if (selected) rowClass = styles.rowSelected;
  // Appended rather than swapped in: a row can be both selected and under the cursor.
  if (focused) rowClass = `${rowClass} ${styles.rowFocused}`;

  return (
    // The page reads this back to scroll the cursor into view and to anchor its quick menus,
    // which keeps it from having to thread a ref through every group.
    <li
      ref={setNodeRef}
      className={rowClass}
      data-todo-row={todo.id}
      onContextMenu={(e) => {
        e.preventDefault();
        // A pointer has no height of its own, so it brackets itself: the panel drops from the
        // cursor, or flips up off the same point when there is no room below.
        onOpenMenu(todo, { top: e.clientY, bottom: e.clientY, left: e.clientX });
      }}
    >
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

      {
        /* The row body doubles as the drag grip. The checkbox keeps working because the drag
          listeners never reach it. */
      }
      <button
        className={styles.rowBody}
        {...attributes}
        {...listeners}
        onClick={() => {
          if (wasJustDragged()) return;
          onEdit(todo);
        }}
        title={todo.notes ? toPlainSummary(todo.notes) : undefined}
        aria-label={`Edit ${todo.title}`}
      >
        <PriorityIcon priority={todo.priority} />
        <span className={styles.id}>#{todo.id}</span>
        <StateDot state={todo.state} />
        {todo.parentTitle !== null && (
          <span className={styles.parentCrumb} title={`Sub-issue of ${todo.parentTitle}`}>
            {todo.parentTitle} &rsaquo;
          </span>
        )}
        <span className={todo.state.isCompleted ? styles.titleDone : styles.title}>{todo.title}</span>
        {todo.childCount > 0 && (
          <span
            className={styles.subCount}
            title={`${todo.completedChildCount} of ${todo.childCount} sub-issue${
              todo.childCount === 1 ? "" : "s"
            } done`}
          >
            <SubProgressRing done={todo.completedChildCount} total={todo.childCount} />
            {todo.completedChildCount}/{todo.childCount}
          </span>
        )}
        {todo.milestone && <span className={styles.crumb}>&rsaquo; {todo.milestone}</span>}

        <span className={styles.spacer} />

        {todo.labels.map((label) => (
          <span
            key={label.id}
            className={styles.label}
            style={{ borderColor: `${label.color}55`, color: label.color, background: `${label.color}1a` }}
          >
            {label.name}
          </span>
        ))}
        {todo.project && (
          <span className={styles.project} style={{ color: todo.project.color }}>
            <ProjectIcon />
            {todo.project.name}
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

/** What follows the cursor during a drag. Smaller than a row on purpose, so the target stays visible. */
function DragGhost({ todo, count }: { todo: Todo; count: number; }) {
  return (
    <div className={styles.ghost}>
      <StateDot state={todo.state} />
      <span className={styles.ghostTitle}>{todo.title}</span>
      {count > 1 && <span className={styles.ghostCount}>+{count - 1}</span>}
    </div>
  );
}

// ---- Group ----

interface GroupProps {
  state: TodoState;
  items: Todo[];
  collapsed: boolean;
  /** A drag is in flight somewhere on the page. */
  dragActive: boolean;
  draggingIds: Set<number>;
  selected: Set<number>;
  /** The one row carrying the keyboard cursor, if it falls inside this group. */
  focusedId: number | null;
  onToggleCollapsed: (stateId: number) => void;
  onAdd: (stateId: number) => void;
  onToggleSelect: (id: number, shiftKey: boolean) => void;
  onEdit: (todo: Todo) => void;
  onOpenMenu: (todo: Todo, anchor: MenuAnchor) => void;
  wasJustDragged: () => boolean;
}

function TodoGroup(props: GroupProps) {
  const {
    state,
    items,
    collapsed,
    dragActive,
    draggingIds,
    selected,
    focusedId,
    onToggleCollapsed,
    onAdd,
    onToggleSelect,
    onEdit,
    onOpenMenu,
    wasJustDragged,
  } = props;

  // The whole group is the drop target -- band included, so a collapsed group still takes a drop.
  const { setNodeRef, isOver } = useDroppable({ id: stateDropId(state.id) });
  const highlighted = dragActive && isOver;

  return (
    <section ref={setNodeRef} className={highlighted ? styles.groupOver : styles.group}>
      <div className={styles.groupBand}>
        <button
          className={styles.chevBtn}
          onClick={() => onToggleCollapsed(state.id)}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${state.label}`}
        >
          <span className={collapsed ? styles.chev : styles.chevOpen}>&#9654;</span>
        </button>
        <StateDot state={state} />
        <span className={styles.groupName}>{state.label}</span>
        <span className={styles.groupCount}>{items.length}</span>
        <button
          className={styles.groupAdd}
          onClick={() => onAdd(state.id)}
          aria-label={`Add todo to ${state.label}`}
        >
          +
        </button>
      </div>

      {!collapsed && items.length > 0 && (
        <ul className={styles.rows}>
          {items.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              selected={selected.has(todo.id)}
              focused={focusedId === todo.id}
              dragging={draggingIds.has(todo.id)}
              onToggleSelect={onToggleSelect}
              onEdit={onEdit}
              onOpenMenu={onOpenMenu}
              wasJustDragged={wasJustDragged}
            />
          ))}
        </ul>
      )}

      {/* An empty group is a 34px band, which is a mean target. Give it a strip while dragging. */}
      {!collapsed && items.length === 0 && dragActive && <p className={styles.emptyDrop}>Drop here</p>}
    </section>
  );
}

// ---- Page ----

export function TodosPage() {
  const {
    todos,
    states,
    projects,
    labels,
    milestones,
    filter,
    setFilter,
    projectFilter,
    setProjectFilter,
    labelFilter,
    setLabelFilter,
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
    createProject,
    updateProject,
    deleteProject,
    reorderProjects,
    createLabel,
    updateLabel,
    deleteLabel,
    toggleTodoLabel,
  } = useTodos();

  /**
   * The open edit dialog is tracked by id and the row is looked up fresh on every render, rather
   * than holding the `Todo` object the dialog was opened with. A sync merge can renumber todos
   * (merge-engine.ts's `reconcileTodoIds`) or delete one out from under an open dialog, and a
   * captured snapshot would go on saving against a number that by then means a different todo --
   * or none. Deriving means the dialog follows the row, and closes by itself once it is gone.
   */
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = editingId === null ? null : todos.find((t) => t.id === editingId) ?? null;
  const setEditing = useCallback((todo: Todo | null) => setEditingId(todo === null ? null : todo.id), []);
  /**
   * Non-null while the create dialog is open. `stateId` is the group whose "+" was clicked;
   * `parent` is set by Ctrl+Shift+O, which creates the new todo as a sub-issue.
   */
  const [creating, setCreating] = useState<
    { stateId: number | null; parent?: { id: number; title: string; }; } | null
  >(null);
  /** The States / Projects / Labels dialog. */
  const [managing, setManaging] = useState(false);
  /** The todo whose parent is being chosen from the row menu or by `L`. */
  const [reparenting, setReparenting] = useState<Todo | null>(null);
  /** The todo an existing sub-issue is being filed under, from `l`. */
  const [linkingChild, setLinkingChild] = useState<Todo | null>(null);
  /** The `?` cheat sheet. */
  const [showingShortcuts, setShowingShortcuts] = useState(false);
  /** The keyboard cursor. Independent of the checkbox selection, the way Linear splits them. */
  const [focusedIdRaw, setFocusedIdRaw] = useState<number | null>(null);
  /** Which single-key menu is open over the cursor, and the row rect it hangs off. */
  const [quickMenu, setQuickMenu] = useState<
    | { kind: QuickMenuKind; todo: Todo; anchor: MenuAnchor; }
    | null
  >(null);
  /** The right-click action menu: which row it acts on, and the pointer it hangs off. */
  const [actionMenu, setActionMenu] = useState<{ todo: Todo; anchor: MenuAnchor; } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(loadCollapsed);
  const [selectedRaw, setSelectedRaw] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  /** Non-null while a row is in flight. `ids` is every todo the drop will move. */
  const [dragging, setDragging] = useState<{ todo: Todo; ids: number[]; } | null>(null);

  // A todo removed elsewhere (bulk delete, the MCP server) must drop out of the selection.
  // Deriving that here rather than pruning in an effect keeps the render the single source.
  const selected = useMemo(() => {
    if (selectedRaw.size === 0) return selectedRaw;
    const live = new Set(todos.map((t) => t.id));
    const next = new Set([...selectedRaw].filter((id) => live.has(id)));
    return next.size === selectedRaw.size ? selectedRaw : next;
  }, [selectedRaw, todos]);

  // Anything that owns the keyboard. While one of these is up the page's own bindings stand down,
  // or `d` typed into a search box would fall through and open the due-date menu behind it.
  const dialogOpen = editing !== null || creating !== null || managing
    || reparenting !== null || linkingChild !== null || quickMenu !== null || showingShortcuts
    || actionMenu !== null;
  const doneCount = todos.filter((todo) => todo.state.isCompleted).length;

  const countsByState = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const todo of todos) counts[todo.state.id] = (counts[todo.state.id] ?? 0) + 1;
    return counts;
  }, [todos]);

  // Both counts are of the todos currently loaded, so a narrowing filter narrows them too.
  // The manage dialog says so, and the delete confirm reads the authoritative count from
  // the main process anyway.
  const countsByProject = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const todo of todos) {
      if (todo.project) counts[todo.project.id] = (counts[todo.project.id] ?? 0) + 1;
    }
    return counts;
  }, [todos]);

  const countsByLabel = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const todo of todos) {
      for (const label of todo.labels) counts[label.id] = (counts[label.id] ?? 0) + 1;
    }
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

  // Collapsing a group, changing the filter, or a delete elsewhere can all take the cursor's row
  // away. Deriving it against the rendered order means the cursor can never point at nothing.
  const focusedId = useMemo(
    () => (focusedIdRaw !== null && visibleIds.includes(focusedIdRaw) ? focusedIdRaw : null),
    [focusedIdRaw, visibleIds],
  );
  const focusedTodo = useMemo(
    () => (focusedId === null ? null : todos.find((t) => t.id === focusedId) ?? null),
    [focusedId, todos],
  );

  useEffect(() => {
    if (focusedId === null) return;
    // Optional call, not just optional lookup: environments without layout (jsdom) leave
    // scrollIntoView undefined, and keeping the cursor visible must never break moving it.
    document.querySelector(`[data-todo-row="${focusedId}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [focusedId]);

  /** Where a quick menu hangs: under the cursor's row, indented past the checkbox and "..." . */
  const rowAnchor = useCallback((id: number) => {
    const rect = document.querySelector(`[data-todo-row="${id}"]`)?.getBoundingClientRect();
    if (rect === undefined) return { top: 120, bottom: 148, left: 160 };
    return { top: rect.top, bottom: rect.bottom, left: rect.left + 56 };
  }, []);

  /**
   * Row order read back from the DOM rather than from `visibleIds`.
   *
   * They agree on what they describe, but not on when. The DOM is written at commit time, while
   * a closure over `visibleIds` is only refreshed when an effect runs -- so a key pressed between
   * the commit that painted the rows and the effect that re-read them would navigate an empty
   * list. The rendered order is the thing being navigated, so read it from where it is rendered.
   */
  const renderedIds = useCallback(
    () =>
      [...document.querySelectorAll("[data-todo-row]")]
        .map((el) => Number(el.getAttribute("data-todo-row")))
        .filter((id) => !Number.isNaN(id)),
    [],
  );

  const moveFocus = useCallback((delta: number) => {
    const ids = renderedIds();
    if (ids.length === 0) return;

    setFocusedIdRaw((current) => {
      const at = current === null ? -1 : ids.indexOf(current);
      // No cursor yet: ArrowDown starts at the top of the list, ArrowUp at the bottom.
      if (at === -1) return delta > 0 ? ids[0]! : ids[ids.length - 1]!;
      return ids[Math.min(ids.length - 1, Math.max(0, at + delta))]!;
    });
  }, [renderedIds]);

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

  // ---- Drag and drop ----

  // 5px of travel before a drag starts, so a plain click still opens the editor.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const dragEndedAtRef = useRef(0);

  /**
   * A browser still fires `click` on the element a drag started from. Without this guard the
   * drop would immediately open the edit dialog for the row you just moved.
   */
  const wasJustDragged = useCallback(() => performance.now() - dragEndedAtRef.current < 250, []);

  const draggingIds = useMemo(() => new Set(dragging?.ids ?? []), [dragging]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const id = Number(event.active.id);
    const todo = todos.find((t) => t.id === id);
    if (todo === undefined) return;
    // Dragging a row that is already selected moves the whole selection, like the bulk bar does.
    setDragging({ todo, ids: selected.has(id) ? [...selected] : [id] });
  }, [todos, selected]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const stateId = droppedStateId(event.over);
    // Hovering a collapsed group opens it, so you can see where the rows land.
    if (stateId !== null && collapsed.has(stateId)) toggleCollapsed(stateId);
  }, [collapsed, toggleCollapsed]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    dragEndedAtRef.current = performance.now();
    const inFlight = dragging;
    setDragging(null);

    const stateId = droppedStateId(event.over);
    if (stateId === null || inFlight === null) return;

    const moving = todosToMove(inFlight.ids, todos, stateId);
    if (moving.length === 0) return;

    if (moving.length === 1) void setTodoState(moving[0]!, stateId);
    else void setTodosState(moving, stateId);
  }, [dragging, todos, setTodoState, setTodosState]);

  const handleDragCancel = useCallback(() => {
    dragEndedAtRef.current = performance.now();
    setDragging(null);
  }, []);

  /**
   * The page keymap, following Linear: arrows move a cursor, and a single letter acts on the row
   * under it. Every binding here is deliberately unmodified except Ctrl+Shift+O, so the guards
   * below have to let that one through before rejecting the modifier keys.
   */
  // Attached once, reading through a ref, rather than re-subscribed whenever the cursor or the
  // selection changes. Re-subscribing leaves a window where React has committed a render but not
  // yet run the effect, and a key pressed in that window is handled by the previous closure --
  // an ArrowDown landing while `visibleIds` was still empty would silently place no cursor.
  const keymap = useRef({ dialogOpen, focusedTodo, selectedSize: selected.size, moveFocus, rowAnchor });

  useEffect(() => {
    keymap.current = { dialogOpen, focusedTodo, selectedSize: selected.size, moveFocus, rowAnchor };
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const { dialogOpen, focusedTodo, selectedSize, moveFocus, rowAnchor } = keymap.current;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      // A dialog or quick menu owns the keyboard while it is up.
      if (dialogOpen) return;

      // Ctrl/Cmd+Shift+O: a brand new todo, filed under the cursor's row.
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (focusedTodo !== null) {
          setCreating({ stateId: null, parent: { id: focusedTodo.id, title: focusedTodo.title } });
        }
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        // Otherwise the panel scrolls out from under the cursor it is meant to be following.
        event.preventDefault();
        moveFocus(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (event.key === "c") {
        event.preventDefault();
        setCreating({ stateId: null });
        return;
      }

      // Above the cursor check on purpose: the sheet is what tells you a cursor is needed.
      if (event.key === "?") {
        event.preventDefault();
        setShowingShortcuts(true);
        return;
      }

      if (event.key === "Escape") {
        // The selection is the louder state, so it clears first; a second press drops the cursor.
        if (selectedSize > 0) setSelectedRaw(new Set());
        else setFocusedIdRaw(null);
        return;
      }

      // Everything below acts on the cursor, so without one there is nothing to act on.
      if (focusedTodo === null) return;

      switch (event.key) {
        case "s":
          event.preventDefault();
          setQuickMenu({ kind: "state", todo: focusedTodo, anchor: rowAnchor(focusedTodo.id) });
          break;
        case "p":
          event.preventDefault();
          setQuickMenu({ kind: "priority", todo: focusedTodo, anchor: rowAnchor(focusedTodo.id) });
          break;
        case "d":
          event.preventDefault();
          setQuickMenu({ kind: "due", todo: focusedTodo, anchor: rowAnchor(focusedTodo.id) });
          break;
        case "P":
          event.preventDefault();
          setQuickMenu({ kind: "project", todo: focusedTodo, anchor: rowAnchor(focusedTodo.id) });
          break;
        case "t":
          event.preventDefault();
          setQuickMenu({ kind: "label", todo: focusedTodo, anchor: rowAnchor(focusedTodo.id) });
          break;
        case "l":
          event.preventDefault();
          setLinkingChild(focusedTodo);
          break;
        case "L":
          event.preventDefault();
          setReparenting(focusedTodo);
          break;
        case "Enter":
          event.preventDefault();
          setEditing(focusedTodo);
          break;
        default:
          break;
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // `setEditing` is a stable useCallback with no dependencies of its own, so listing it here
    // keeps the shortcut handler bound exactly once, as before.
  }, [setEditing]);

  const selectedIds = useMemo(() => [...selected], [selected]);

  const handleAdd = useCallback((stateId: number) => setCreating({ stateId }), []);
  const handleSetState = useCallback((id: number, stateId: number) => void setTodoState(id, stateId), [setTodoState]);
  const handleDelete = useCallback((id: number) => void deleteTodo(id), [deleteTodo]);
  const handleClearParent = useCallback(
    (id: number) => void updateTodo({ id, parentId: null }),
    [updateTodo],
  );

  const handleOpenMenu = useCallback((todo: Todo, anchor: MenuAnchor) => {
    // Right-clicking a row is also a way of pointing at it, so the cursor follows the menu --
    // the shortcuts the menu advertises then act on the row you just aimed at.
    setFocusedIdRaw(todo.id);
    setActionMenu({ todo, anchor });
  }, []);

  /**
   * The menu holds a snapshot of the row it opened on, which a write from the MCP server or a
   * bulk action can outdate underneath it. Re-reading the live todo keeps "Remove from parent"
   * and the current-state tick honest, and closes the menu if the row is gone.
   */
  const actionMenuTodo = useMemo(
    () => (actionMenu === null ? null : todos.find((t) => t.id === actionMenu.todo.id) ?? null),
    [actionMenu, todos],
  );

  /** The rows, and the write behind them, for whichever single-key menu is open. */
  const quickMenuConfig = useMemo<QuickMenuConfig | null>(() => {
    if (quickMenu === null) return null;
    const { kind } = quickMenu;
    // Re-read from the live list rather than using the todo captured when the menu opened.
    // The label menu stays open across picks, so a second toggle computed from the stale
    // copy would drop the label the first one just added.
    const todo = todos.find((t) => t.id === quickMenu.todo.id) ?? quickMenu.todo;

    if (kind === "state") {
      return {
        heading: "Move to state",
        placeholder: "Change state to...",
        items: states.map((s) => ({
          value: String(s.id),
          label: s.label,
          color: s.color,
          current: s.id === todo.state.id,
        })),
        onPick: (value) => void setTodoState(todo.id, Number(value)),
      };
    }

    if (kind === "priority") {
      return {
        heading: "Set priority",
        placeholder: "Set priority to...",
        items: TODO_PRIORITY_LABELS.map((label, value) => ({
          value: String(value),
          label,
          current: value === todo.priority,
        })),
        onPick: (value) => void updateTodo({ id: todo.id, priority: Number(value) }),
      };
    }

    if (kind === "due") {
      const relative = [
        { label: "Today", iso: isoPlusDays(0) },
        { label: "Tomorrow", iso: isoPlusDays(1) },
        { label: "Next week", iso: isoPlusDays(7) },
      ];
      const items: QuickMenuItem[] = relative.map(({ label, iso }) => ({
        value: iso,
        label,
        hint: formatDay(iso),
        current: todo.dueDate === iso,
      }));
      items.push({ value: "", label: "No due date", current: todo.dueDate === null });

      return {
        heading: "Set due date",
        placeholder: "Or type YYYY-MM-DD",
        items,
        // Any date the three shortcuts do not cover is typed in full.
        acceptQuery: (query) => (isRealIsoDate(query) ? { value: query, label: query, hint: formatDay(query) } : null),
        onPick: (value) => void updateTodo({ id: todo.id, dueDate: value.length > 0 ? value : null }),
      };
    }

    if (kind === "label") {
      const items: QuickMenuItem[] = labels.map((l) => ({
        value: String(l.id),
        label: l.name,
        color: l.color,
        current: todo.labels.some((attached) => attached.id === l.id),
      }));

      return {
        heading: "Toggle labels",
        placeholder: "Filter, or name a new one",
        items,
        multi: true,
        // Typing an unlisted name creates the label and attaches it in one step, which is
        // what makes the pool grow from ordinary use rather than from a setup screen.
        acceptQuery: (query) => ({ value: `new:${query}`, label: `Create "${query}"`, hint: "New" }),
        onPick: (value) => {
          if (value.startsWith("new:")) {
            const name = value.slice(4);
            void createLabel({ name }).then((created) => toggleTodoLabel(todo, created.id));
            return;
          }
          void toggleTodoLabel(todo, Number(value));
        },
      };
    }

    const items: QuickMenuItem[] = projects.map((p) => ({
      value: String(p.id),
      label: p.name,
      color: p.color,
      current: todo.project?.id === p.id,
    }));
    items.push({ value: "", label: "No project", current: todo.project === null });

    return {
      heading: "Set project",
      placeholder: "Filter, or name a new one",
      items,
      // Typing an unlisted name creates the project, then moves the todo onto it. Projects are
      // rows now, so this is a real insert rather than the free text it used to write.
      acceptQuery: (query) => ({ value: `new:${query}`, label: `Create "${query}"`, hint: "New" }),
      onPick: (value) => {
        if (value.startsWith("new:")) {
          const name = value.slice(4);
          void createProject({ name }).then((created) => updateTodo({ id: todo.id, projectId: created.id }));
          return;
        }
        void updateTodo({ id: todo.id, projectId: value.length > 0 ? Number(value) : null });
      },
    };
  }, [
    quickMenu,
    todos,
    states,
    projects,
    labels,
    setTodoState,
    updateTodo,
    createProject,
    createLabel,
    toggleTodoLabel,
  ]);

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
            value={projectFilter === null ? "" : String(projectFilter)}
            options={[
              { value: "", label: "Any project" },
              ...projects.map((p) => ({ value: String(p.id), label: p.name, color: p.color })),
            ]}
            onChange={(next) => setProjectFilter(next === "" ? null : Number(next))}
          />

          <Select
            ariaLabel="Filter by label"
            className={styles.filterSelect}
            value={labelFilter === null ? "" : String(labelFilter)}
            options={[
              { value: "", label: "Any label" },
              ...labels.map((l) => ({ value: String(l.id), label: l.name, color: l.color })),
            ]}
            onChange={(next) => setLabelFilter(next === "" ? null : Number(next))}
          />

          <button
            className={styles.helpBtn}
            onClick={() => setShowingShortcuts(true)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
          <button className={styles.ghostBtn} onClick={() => setManaging(true)}>Manage</button>
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
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            // A hovered group can expand mid-drag, so every rect has to be re-read as it moves.
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className={styles.panel}>
              {groups.map(({ state, items }) => (
                <TodoGroup
                  key={state.id}
                  state={state}
                  items={items}
                  collapsed={collapsed.has(state.id)}
                  dragActive={dragging !== null}
                  draggingIds={draggingIds}
                  selected={selected}
                  focusedId={focusedId}
                  onToggleCollapsed={toggleCollapsed}
                  onAdd={handleAdd}
                  onToggleSelect={toggleSelect}
                  onEdit={setEditing}
                  onOpenMenu={handleOpenMenu}
                  wasJustDragged={wasJustDragged}
                />
              ))}

              {groups.length === 0 && <p className={styles.stateMsg}>Nothing here yet.</p>}
            </div>

            {
              /* Portaled: the panel's backdrop-filter would otherwise become the containing block
                for the fixed-position overlay and trap the ghost inside the list. */
            }
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {dragging !== null && <DragGhost todo={dragging.todo} count={dragging.ids.length} />}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
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
          key={editing
            ? `edit-${editing.id}`
            : `new-${creating?.stateId ?? "default"}-${creating?.parent?.id ?? "top"}`}
          todo={editing}
          defaultStateId={creating?.stateId ?? undefined}
          defaultParent={creating?.parent}
          states={states}
          projects={projects}
          labels={labels}
          milestones={milestones}
          onCreateProject={createProject}
          onCreateLabel={createLabel}
          onSave={updateTodo}
          onCreate={createTodo}
          onDelete={deleteTodo}
          onClose={() => {
            setEditing(null);
            setCreating(null);
          }}
        />
      )}

      {reparenting !== null && (
        <TodoPicker
          heading={`Nest #${reparenting.id} ${reparenting.title} under`}
          mode={{ kind: "parent", todoId: reparenting.id, currentParentId: reparenting.parentId }}
          onPick={(picked) => void updateTodo({ id: reparenting.id, parentId: picked.id })}
          onClose={() => setReparenting(null)}
        />
      )}

      {linkingChild !== null && (
        <TodoPicker
          heading={`File an existing todo under #${linkingChild.id} ${linkingChild.title}`}
          mode={{ kind: "child", todoId: linkingChild.id }}
          onPick={(picked) => void updateTodo({ id: picked.id, parentId: linkingChild.id })}
          onClose={() => setLinkingChild(null)}
        />
      )}

      {showingShortcuts && <TodoShortcutsOverlay onClose={() => setShowingShortcuts(false)} />}

      {actionMenu !== null && actionMenuTodo !== null && (
        <TodoActionMenu
          key={actionMenuTodo.id}
          todo={actionMenuTodo}
          states={states}
          anchor={actionMenu.anchor}
          onEdit={() => setEditing(actionMenuTodo)}
          onQuickMenu={(kind) => setQuickMenu({ kind, todo: actionMenuTodo, anchor: rowAnchor(actionMenuTodo.id) })}
          onAddSubIssue={() =>
            setCreating({ stateId: null, parent: { id: actionMenuTodo.id, title: actionMenuTodo.title } })}
          onLinkChild={() => setLinkingChild(actionMenuTodo)}
          onSetParent={() => setReparenting(actionMenuTodo)}
          onClearParent={() => handleClearParent(actionMenuTodo.id)}
          onSetState={(stateId) => handleSetState(actionMenuTodo.id, stateId)}
          onDelete={() => handleDelete(actionMenuTodo.id)}
          onClose={() => setActionMenu(null)}
        />
      )}

      {quickMenu !== null && quickMenuConfig !== null && (
        <TodoQuickMenu
          key={`${quickMenu.kind}-${quickMenu.todo.id}`}
          heading={quickMenuConfig.heading}
          placeholder={quickMenuConfig.placeholder}
          items={quickMenuConfig.items}
          anchor={quickMenu.anchor}
          acceptQuery={quickMenuConfig.acceptQuery}
          multi={quickMenuConfig.multi}
          onPick={quickMenuConfig.onPick}
          onClose={() => setQuickMenu(null)}
        />
      )}

      {managing && (
        <TodoManageDialog
          states={states}
          projects={projects}
          labels={labels}
          countsByState={countsByState}
          countsByProject={countsByProject}
          countsByLabel={countsByLabel}
          onCreateState={createState}
          onUpdateState={updateState}
          onDeleteState={deleteState}
          onReorderStates={reorderStates}
          onCreateProject={createProject}
          onUpdateProject={updateProject}
          onDeleteProject={deleteProject}
          onReorderProjects={reorderProjects}
          onCreateLabel={createLabel}
          onUpdateLabel={updateLabel}
          onDeleteLabel={deleteLabel}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  );
}
