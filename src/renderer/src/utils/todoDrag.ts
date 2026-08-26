// Pure helpers behind the todo list's drag-and-drop. Kept out of the component so the
// rules can be tested without simulating a pointer gesture in jsdom.

import type { Todo } from "../../../shared/types.ts";

/** Namespaces group droppables, so a state id can never collide with a todo's draggable id. */
const DROP_PREFIX = "state:";

/** The droppable id for a state's group. */
export function stateDropId(stateId: number): string {
  return `${DROP_PREFIX}${stateId}`;
}

/**
 * Reads a droppable back into its state id. Returns null when the drag was released over
 * nothing, or over anything that is not a group.
 */
export function droppedStateId(over: { id: number | string; } | null | undefined): number | null {
  if (over === null || over === undefined) return null;
  const raw = String(over.id);
  if (!raw.startsWith(DROP_PREFIX)) return null;
  const id = Number(raw.slice(DROP_PREFIX.length));
  return Number.isNaN(id) ? null : id;
}

/**
 * Which of `ids` actually change state when dropped on `targetStateId`. Rows already in the
 * target are skipped, so a drop inside the source group costs nothing. Unknown ids -- a todo
 * deleted mid-drag by the MCP server, say -- are dropped rather than sent to a doomed update.
 */
export function todosToMove(ids: number[], todos: Todo[], targetStateId: number): number[] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  return ids.filter((id) => {
    const todo = byId.get(id);
    return todo !== undefined && todo.state.id !== targetStateId;
  });
}
