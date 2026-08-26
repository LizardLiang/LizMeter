import { useCallback, useEffect, useState } from "react";
import type {
  CreateTodoInput,
  CreateTodoLabelInput,
  CreateTodoProjectInput,
  CreateTodoStateInput,
  Todo,
  TodoFilter,
  TodoLabel,
  TodoProject,
  TodoState,
  UpdateTodoInput,
  UpdateTodoLabelInput,
  UpdateTodoProjectInput,
  UpdateTodoStateInput,
} from "../../../shared/types.ts";

interface UseTodosResult {
  todos: Todo[];
  states: TodoState[];
  projects: TodoProject[];
  labels: TodoLabel[];
  milestones: string[];
  filter: TodoFilter;
  setFilter: (filter: TodoFilter) => void;
  stateFilter: number | null;
  setStateFilter: (stateId: number | null) => void;
  projectFilter: number | null;
  setProjectFilter: (projectId: number | null) => void;
  labelFilter: number | null;
  setLabelFilter: (labelId: number | null) => void;
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
  createProject: (input: CreateTodoProjectInput) => Promise<TodoProject>;
  updateProject: (input: UpdateTodoProjectInput) => Promise<void>;
  /** Clears the project from its todos, then deletes it. Resolves with how many todos changed. */
  deleteProject: (id: number) => Promise<number>;
  reorderProjects: (orderedIds: number[]) => Promise<void>;
  /** Get-or-create by name, so typing a known name in the picker reuses that label. */
  createLabel: (input: CreateTodoLabelInput) => Promise<TodoLabel>;
  updateLabel: (input: UpdateTodoLabelInput) => Promise<void>;
  deleteLabel: (id: number) => Promise<number>;
  /** Adds or removes one label on one todo, leaving the rest of its set alone. */
  toggleTodoLabel: (todo: Todo, labelId: number) => Promise<void>;
  refresh: () => void;
}

export function useTodos(): UseTodosResult {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [states, setStates] = useState<TodoState[]>([]);
  const [projects, setProjects] = useState<TodoProject[]>([]);
  const [labels, setLabels] = useState<TodoLabel[]>([]);
  const [milestones, setMilestones] = useState<string[]>([]);
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [stateFilter, setStateFilter] = useState<number | null>(null);
  const [projectFilter, setProjectFilter] = useState<number | null>(null);
  const [labelFilter, setLabelFilter] = useState<number | null>(null);
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
        const [todoList, stateList, projectList, labelList, milestoneList] = await Promise.all([
          window.electronAPI.todo.list({
            filter,
            stateId: stateFilter ?? undefined,
            projectId: projectFilter ?? undefined,
            labelId: labelFilter ?? undefined,
          }),
          window.electronAPI.todoState.list(),
          window.electronAPI.todoProject.list(),
          window.electronAPI.todoLabel.list(),
          window.electronAPI.todo.listMilestones(),
        ]);
        if (cancelled) return;
        setTodos(todoList);
        setStates(stateList);
        setProjects(projectList);
        setLabels(labelList);
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
  }, [filter, stateFilter, projectFilter, labelFilter, refreshToken]);

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

  const createProject = useCallback(async (input: CreateTodoProjectInput) => {
    return run(() => window.electronAPI.todoProject.create(input));
  }, [run]);

  const updateProject = useCallback(async (input: UpdateTodoProjectInput) => {
    await run(() => window.electronAPI.todoProject.update(input));
  }, [run]);

  const deleteProject = useCallback(async (id: number) => {
    // The filter would otherwise keep pointing at a project that no longer exists,
    // which reads to the user as "all my todos vanished".
    setProjectFilter((current) => (current === id ? null : current));
    return run(() => window.electronAPI.todoProject.delete(id));
  }, [run]);

  const reorderProjects = useCallback(async (orderedIds: number[]) => {
    await run(() => window.electronAPI.todoProject.reorder(orderedIds));
  }, [run]);

  const createLabel = useCallback(async (input: CreateTodoLabelInput) => {
    return run(() => window.electronAPI.todoLabel.create(input));
  }, [run]);

  const updateLabel = useCallback(async (input: UpdateTodoLabelInput) => {
    await run(() => window.electronAPI.todoLabel.update(input));
  }, [run]);

  const deleteLabel = useCallback(async (id: number) => {
    setLabelFilter((current) => (current === id ? null : current));
    return run(() => window.electronAPI.todoLabel.delete(id));
  }, [run]);

  const toggleTodoLabel = useCallback(async (todo: Todo, labelId: number) => {
    // updateTodo replaces the whole set, so the current one is read off the todo
    // rather than tracked separately -- there is no local copy to fall out of date.
    const current = todo.labels.map((l) => l.id);
    const next = current.includes(labelId)
      ? current.filter((id) => id !== labelId)
      : [...current, labelId];
    await run(() => window.electronAPI.todo.update({ id: todo.id, labelIds: next }));
  }, [run]);

  return {
    todos,
    states,
    projects,
    labels,
    milestones,
    filter,
    setFilter,
    stateFilter,
    setStateFilter,
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
    refresh,
  };
}
