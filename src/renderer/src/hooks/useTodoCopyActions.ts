// src/renderer/src/hooks/useTodoCopyActions.ts
// The impure chain behind "Copy id" and "Copy agent prompt": the clipboard writes, the
// `todo.list({ parentId })` fetch for direct children, and the in-flight guard on the prompt
// fetch. One copy for all three call sites -- TodoRowMenu, TodoDetailPage, and TodosPage's
// `Ctrl+C`/`Shift+C` keymap bindings.
//
// Pairs with `useCopyFeedback`, which owns showing the result of a copy -- this hook owns
// producing that result. The caller supplies `onExpire` and the todo to copy.

import { useCallback, useRef, useState } from "react";
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
   * clipboard. A call that arrives while a previous one is still in flight supersedes it rather
   * than being dropped -- for the same todo or a different one -- so the clipboard always ends up
   * holding whichever todo was requested last, never a stale response that resolves after a newer
   * request already started.
   */
  copyPrompt: (todo: Todo) => void;
}

/** `onExpire` is passed straight through to `useCopyFeedback` -- see that hook for what runs it. */
export function useTodoCopyActions(onExpire?: () => void): UseTodoCopyActionsResult {
  const { feedback, trigger } = useCopyFeedback<TodoCopyAction>(onExpire);
  const [promptPending, setPromptPending] = useState(false);
  /**
   * Tags each `copyPrompt` call so its own async chain can tell, once `todo.list` resolves,
   * whether it is still the most recent request. Bumped on every call regardless of which todo it
   * is for -- comparing todo identity would let two clicks on the same row race each other for no
   * benefit, since a superseded same-todo response carries the identical markdown anyway. Only the
   * chain whose captured id still matches `promptRequestRef.current` may write the clipboard, arm
   * feedback, or clear `promptPending`; an outrun chain's clipboard write and pending-clear are
   * both skipped so it cannot overwrite what the newer chain already produced or is still
   * producing.
   */
  const promptRequestRef = useRef(0);

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
    const requestId = ++promptRequestRef.current;
    setPromptPending(true);
    const parent = todo.parentId !== null
      ? { id: todo.parentId, title: todo.parentTitle ?? formatTodoId(todo.parentId) }
      : null;
    window.electronAPI.todo
      .list({ parentId: todo.id })
      .then((rows) => {
        if (promptRequestRef.current !== requestId) return;
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
      .then(() => {
        if (promptRequestRef.current !== requestId) return;
        trigger("prompt");
      })
      .catch((err: unknown) => {
        if (promptRequestRef.current !== requestId) return;
        console.error("Failed to copy agent prompt", err);
        trigger("prompt", "failed");
      })
      .finally(() => {
        if (promptRequestRef.current !== requestId) return;
        setPromptPending(false);
      });
  }, [trigger]);

  return { feedback, promptPending, copyId, copyPrompt };
}
