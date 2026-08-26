// Pure helpers behind todo nesting. Kept out of the components so the linking rules can be
// tested without rendering a dialog, the same way todoDrag.ts holds the drag rules.

import type { Todo } from "../../../shared/types.ts";

/**
 * Every todo below `rootId`, at any depth. `found` doubles as the visited guard, so a cycle
 * that somehow reached the renderer cannot spin the walk forever.
 */
export function descendantIds(todos: Todo[], rootId: number): Set<number> {
  const byParent = new Map<number, number[]>();
  for (const todo of todos) {
    if (todo.parentId === null) continue;
    const siblings = byParent.get(todo.parentId);
    if (siblings) siblings.push(todo.id);
    else byParent.set(todo.parentId, [todo.id]);
  }

  const found = new Set<number>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop() as number;
    for (const childId of byParent.get(current) ?? []) {
      if (found.has(childId)) continue;
      found.add(childId);
      queue.push(childId);
    }
  }
  return found;
}

/** Every todo above `startId`, nearest first. Bounded by the same visited guard. */
export function ancestorIds(todos: Todo[], startId: number): Set<number> {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const found = new Set<number>();

  let cursor = byId.get(startId)?.parentId ?? null;
  while (cursor !== null && !found.has(cursor)) {
    found.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return found;
}

/**
 * True when filing `childId` under `parentId` would put a todo inside its own subtree.
 * The main process runs the same check and is the authority -- this one only keeps
 * impossible options out of the picker.
 */
export function wouldCycle(todos: Todo[], childId: number, parentId: number): boolean {
  if (childId === parentId) return true;
  return descendantIds(todos, childId).has(parentId);
}

/** The direct children of `parentId`, in whatever order the list already sorts them. */
export function childrenOf(todos: Todo[], parentId: number): Todo[] {
  return todos.filter((todo) => todo.parentId === parentId);
}

/**
 * Todos that `childId` could be nested under: not itself, nothing already in its subtree, and
 * not the parent it already has. `childId` is null while creating, where nothing is excluded yet.
 */
export function linkableParents(todos: Todo[], childId: number | null, currentParentId: number | null): Todo[] {
  const blocked = childId === null ? new Set<number>() : descendantIds(todos, childId);
  return todos.filter((todo) => todo.id !== childId && todo.id !== currentParentId && !blocked.has(todo.id));
}

/**
 * Todos that could become a sub-issue of `parentId`: not itself, not one already filed there,
 * and none of its ancestors. Moving a grandchild up to be a direct child is allowed -- that
 * shortens the chain rather than closing a loop.
 */
export function linkableChildren(todos: Todo[], parentId: number): Todo[] {
  const blocked = ancestorIds(todos, parentId);
  return todos.filter((todo) => todo.id !== parentId && todo.parentId !== parentId && !blocked.has(todo.id));
}
