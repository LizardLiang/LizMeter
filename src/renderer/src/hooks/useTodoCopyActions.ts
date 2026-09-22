// src/renderer/src/hooks/useTodoCopyActions.ts
// The impure chain behind "Copy id" and "Copy agent prompt": the clipboard writes, the
// `todo.list({ parentId })` fetch for direct children, and the in-flight guard on the prompt
// fetch. Extracted out of TodoRowMenu and TodoDetailPage, which each carried a byte-identical
// copy of this chain, and backs TodosPage's `Ctrl+C`/`Shift+C` keymap bindings too.
//
// Pairs with `useCopyFeedback`, which owns showing the result of a copy -- this hook only owns
// producing that result. The caller still supplies `onExpire` and the todo to copy; see
// `useCopyFeedback.ts`'s header for why that split exists.

import { useCallback, useState } from "react";
import type { Todo } from "../../../shared/types.ts";
import { formatTodoAgentPrompt, formatTodoId } from "../utils/todoClipboard.ts";
import { type CopyFeedbackState, useCopyFeedback } from "./useCopyFeedback.ts";

export type TodoCopyAction = "id" | "prompt";

export interface UseTodoCopyActionsResult {
  /** The action currently showing feedback, and whether it succeeded -- `null` when nothing is. */
  feedback: CopyFeedbackState<TodoCopyAction> | null;
  /** True while a `copyPrompt` fetch-then-copy chain is in flight. */
  promptPending: boolean;
  /** Writes `#<id>` to the clipboard and arms feedback for it. */
  copyId: (id: number) => void;
  /**
   * Fetches `todo`'s direct children, builds the agent-prompt markdown, and writes it to the
   * clipboard. A call that arrives while a previous one is still in flight is dropped -- without
   * this, whichever `todo.list` response lands last would silently win the clipboard over
   * whichever call was last (476f49a).
   */
  copyPrompt: (todo: Todo) => void;
}

/** `onExpire` is passed straight through to `useCopyFeedback` -- see that hook for what runs it. */
export function useTodoCopyActions(onExpire?: () => void): UseTodoCopyActionsResult {
  const { feedback, trigger } = useCopyFeedback<TodoCopyAction>(onExpire);
  const [promptPending, setPromptPending] = useState(false);

  const copyId = useCallback((id: number) => {
    navigator.clipboard
      .writeText(formatTodoId(id))
      .then(() => trigger("id"))
      .catch((err: unknown) => {
        console.error("Failed to copy todo id", err);
        trigger("id", "failed");
      });
  }, [trigger]);

  const copyPrompt = useCallback((todo: Todo) => {
    if (promptPending) return;
    setPromptPending(true);
    const parent = todo.parentId !== null
      ? { id: todo.parentId, title: todo.parentTitle ?? formatTodoId(todo.parentId) }
      : null;
    window.electronAPI.todo
      .list({ parentId: todo.id })
      .then((rows) => {
        const prompt = formatTodoAgentPrompt(
          todo,
          parent,
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            stateLabel: row.state.label,
            isCompleted: row.state.isCompleted,
          })),
        );
        return navigator.clipboard.writeText(prompt);
      })
      .then(() => trigger("prompt"))
      .catch((err: unknown) => {
        console.error("Failed to copy agent prompt", err);
        trigger("prompt", "failed");
      })
      .finally(() => setPromptPending(false));
  }, [promptPending, trigger]);

  return { feedback, promptPending, copyId, copyPrompt };
}
