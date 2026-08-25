import { useCallback, useEffect, useState } from "react";
import type {
  CreateTodoInput,
  CreateTodoStateInput,
  Todo,
  TodoFilter,
  TodoState,
  UpdateTodoInput,
  UpdateTodoStateInput,
} from "../../../shared/types.ts";

interface UseTodosResult {
  todos: Todo[];
  states: TodoState[];
  projects: string[];
  milestones: string[];
  filter: TodoFilter;
  setFilter: (filter: TodoFilter) => void;
  stateFilter: number | null;
  setStateFilter: (stateId: number | null) => void;
  projectFilter: string | null;
  setProjectFilter: (project: string | null) => void;
  loading: boolean;
  error: string | null;
  createTodo: (input: CreateTodoInput) => Promise<void>;
  updateTodo: (input: UpdateTodoInput) => Promise<void>;
  setTodoState: (id: number, stateId: number) => Promise<void>;
  deleteTodo: (id: number) => Promise<void>;
  /** Bulk move. Runs one IPC call per id, then refreshes once. */
  setTodosState: (ids: number[], stateId: number) => Promise<void>;
  /** Bulk delete. Runs one IPC call per id, then refreshes once. */
  deleteTodos: (ids: number[]) => Promise<void>;
  clearCompleted: () => Promise<void>;
  createState: (input: CreateTodoStateInput) => Promise<TodoState>;
  updateState: (input: UpdateTodoStateInput) => Promise<void>;
  deleteState: (id: number, reassignToId: number) => Promise<number>;
  reorderStates: (orderedIds: number[]) => Promise<void>;
  refresh: () => void;
}

export function useTodos(): UseTodosResult {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [states, setStates] = useState<TodoState[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [milestones, setMilestones] = useState<string[]>([]);
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [stateFilter, setStateFilter] = useState<number | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [todoList, stateList, projectList, milestoneList] = await Promise.all([
          window.electronAPI.todo.list({
            filter,
            stateId: stateFilter ?? undefined,
            project: projectFilter ?? undefined,
          }),
          window.electronAPI.todoState.list(),
          window.electronAPI.todo.listProjects(),
          window.electronAPI.todo.listMilestones(),
        ]);
        if (cancelled) return;
        setTodos(todoList);
        setStates(stateList);
        setProjects(projectList);
        setMilestones(milestoneList);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load todos");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [filter, stateFilter, projectFilter, refreshToken]);

  // The MCP server writes through the main process, not the renderer, so the
  // list has to be refreshed on a push event rather than after a local call.
  useEffect(() => {
    const unsubscribe = window.electronAPI.todo.onChanged(() => {
      refresh();
    });
    return unsubscribe;
  }, [refresh]);

  /** Surfaces the main-process error message instead of failing silently. */
  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      const result = await action();
      setError(null);
      refresh();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      throw err;
    }
  }, [refresh]);

  const createTodo = useCallback(async (input: CreateTodoInput) => {
    await run(() => window.electronAPI.todo.create(input));
  }, [run]);

  const updateTodo = useCallback(async (input: UpdateTodoInput) => {
    await run(() => window.electronAPI.todo.update(input));
  }, [run]);

  const setTodoState = useCallback(async (id: number, stateId: number) => {
    await run(() => window.electronAPI.todo.update({ id, stateId }));
  }, [run]);

  const deleteTodo = useCallback(async (id: number) => {
    await run(() => window.electronAPI.todo.delete(id));
  }, [run]);

  /**
   * Like `run`, but leaves refreshing to the caller. Bulk actions loop over the
   * single-item IPC calls, so refreshing per call would reload the list N times.
   */
  const runSilent = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      throw err;
    }
  }, []);

  const setTodosState = useCallback(async (ids: number[], stateId: number) => {
    try {
      for (const id of ids) {
        await runSilent(() => window.electronAPI.todo.update({ id, stateId }));
      }
      setError(null);
    } finally {
      refresh();
    }
  }, [runSilent, refresh]);

  const deleteTodos = useCallback(async (ids: number[]) => {
    try {
      for (const id of ids) {
        await runSilent(() => window.electronAPI.todo.delete(id));
      }
      setError(null);
    } finally {
      refresh();
    }
  }, [runSilent, refresh]);

  const clearCompleted = useCallback(async () => {
    await run(() => window.electronAPI.todo.clearCompleted());
  }, [run]);

  const createState = useCallback(async (input: CreateTodoStateInput) => {
    return run(() => window.electronAPI.todoState.create(input));
  }, [run]);

  const updateState = useCallback(async (input: UpdateTodoStateInput) => {
    await run(() => window.electronAPI.todoState.update(input));
  }, [run]);

  const deleteState = useCallback(async (id: number, reassignToId: number) => {
    return run(() => window.electronAPI.todoState.delete(id, reassignToId));
  }, [run]);

  const reorderStates = useCallback(async (orderedIds: number[]) => {
    await run(() => window.electronAPI.todoState.reorder(orderedIds));
  }, [run]);

  return {
    todos,
    states,
    projects,
    milestones,
    filter,
    setFilter,
    stateFilter,
    setStateFilter,
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
    refresh,
  };
}
