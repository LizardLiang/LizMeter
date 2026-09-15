// src/renderer/src/contexts/TodosContext.tsx
// Shared todos state above both TodosPage and TodoDetailPage.
//
// `.Arena/conventions/react.md` says not to add a context for state a hook can already own.
// This is the documented exception: state that must survive a page switch. The detail page is a
// real `NavPage` route (F1), so opening it unmounts `TodosPage` -- and the detail page's
// prev/next has to walk the exact row order the list showed. Lifting the filters, the grouped
// order and the keyboard cursor up here is what makes that possible without a second
// `todo.list` fetch (F23). Mounted once at `TomatoClock`'s top level, above the page switch, so
// it also survives navigating away to Timer and back.

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { Todo, TodoState } from "../../../shared/types.ts";
import { useTodos } from "../hooks/useTodos.ts";

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

export interface TodoGroup {
  state: TodoState;
  items: Todo[];
}

export interface TodosContextValue extends ReturnType<typeof useTodos> {
  collapsed: Set<number>;
  toggleCollapsed: (stateId: number) => void;
  /** Idempotent expand -- unlike `toggleCollapsed`, safe to call without checking `collapsed` first. */
  expandGroup: (stateId: number) => void;
  /** Todos grouped by state, ordered by the state's position -- the list's rendered order. */
  groups: TodoGroup[];
  /** Row order as rendered, flattened across groups, skipping collapsed ones. */
  visibleIds: number[];
  /** The keyboard cursor. Lives here, not in `TodosPage`, so it survives the page switch. */
  focusedId: number | null;
  focusedTodo: Todo | null;
  /** The raw `useState` setter, so a caller can compute the next id off the current one. */
  setFocusedId: Dispatch<SetStateAction<number | null>>;
  countsByState: Record<number, number>;
  countsByProject: Record<number, number>;
  countsByLabel: Record<number, number>;
}

const TodosContext = createContext<TodosContextValue | null>(null);

interface TodosProviderProps {
  children: ReactNode;
}

export function TodosProvider({ children }: TodosProviderProps) {
  const todosApi = useTodos();
  const { todos, states } = todosApi;

  const [collapsed, setCollapsed] = useState<Set<number>>(loadCollapsed);
  const [focusedIdRaw, setFocusedIdRaw] = useState<number | null>(null);

  const toggleCollapsed = useCallback((stateId: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stateId)) next.delete(stateId);
      else next.add(stateId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const expandGroup = useCallback((stateId: number) => {
    setCollapsed((prev) => {
      if (!prev.has(stateId)) return prev;
      const next = new Set(prev);
      next.delete(stateId);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const groups = useMemo<TodoGroup[]>(() => {
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

  /** Row order as rendered, so prev/next can walk exactly what the list showed. */
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

  // Both counts are of the todos currently loaded, so a narrowing filter narrows them too.
  const countsByState = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const todo of todos) counts[todo.state.id] = (counts[todo.state.id] ?? 0) + 1;
    return counts;
  }, [todos]);

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

  const value = useMemo<TodosContextValue>(
    () => ({
      ...todosApi,
      collapsed,
      toggleCollapsed,
      expandGroup,
      groups,
      visibleIds,
      focusedId,
      focusedTodo,
      setFocusedId: setFocusedIdRaw,
      countsByState,
      countsByProject,
      countsByLabel,
    }),
    [
      todosApi,
      collapsed,
      toggleCollapsed,
      expandGroup,
      groups,
      visibleIds,
      focusedId,
      focusedTodo,
      countsByState,
      countsByProject,
      countsByLabel,
    ],
  );

  return <TodosContext.Provider value={value}>{children}</TodosContext.Provider>;
}

export function useTodosContext(): TodosContextValue {
  const ctx = useContext(TodosContext);
  if (ctx === null) {
    throw new Error("useTodosContext must be used within a TodosProvider");
  }
  return ctx;
}
