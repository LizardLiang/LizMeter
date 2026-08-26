import { useCallback, useEffect, useState } from "react";
import type { TodoAttachment } from "../../../shared/types.ts";

export interface UseTodoAttachmentsReturn {
  attachments: TodoAttachment[];
  isLoading: boolean;
  /** The last failure, in words the user can act on. Null once a later call succeeds. */
  error: string | null;
  /** True while a write is in flight, so the caller can disable its controls. */
  busy: boolean;
  /** Opens the OS picker in the main process. A cancelled picker is not an error. */
  addAttachment: () => Promise<void>;
  removeAttachment: (id: number) => Promise<void>;
  /** Hands the file to the OS default application. */
  openAttachment: (id: number) => Promise<void>;
  reload: () => Promise<void>;
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/**
 * Attachments of one todo, read straight from the main process.
 *
 * `todoId` is null in the dialog's create mode: there is no row to attach to yet, so the hook
 * stays idle and reports an empty list rather than guessing at an id.
 */
export function useTodoAttachments(todoId: number | null): UseTodoAttachmentsReturn {
  const [attachments, setAttachments] = useState<TodoAttachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (todoId === null) {
      setAttachments([]);
      return;
    }
    setIsLoading(true);
    try {
      setAttachments(await window.electronAPI.attachment.list(todoId));
      setError(null);
    } catch {
      // Fixed wording on purpose: a failed read throws an internal message the user cannot act
      // on. Writes are the opposite -- their message comes from the OS and is worth showing.
      setError("Could not load the attachments for this todo.");
    } finally {
      setIsLoading(false);
    }
  }, [todoId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Every write goes through here: run it, reload the strip, keep one error surface. */
  const run = useCallback(
    async (action: () => Promise<boolean>, fallback: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const changed = await action();
        setError(null);
        if (changed) await reload();
      } catch (err) {
        setError(message(err, fallback));
      } finally {
        setBusy(false);
      }
    },
    [busy, reload],
  );

  const addAttachment = useCallback(async () => {
    if (todoId === null) return;
    await run(async () => {
      // Resolves null when the user closes the picker without choosing. Nothing changed.
      const added = await window.electronAPI.attachment.add({ todoId });
      return added !== null;
    }, "Failed to attach the file");
  }, [run, todoId]);

  const removeAttachment = useCallback(
    async (id: number) => {
      await run(async () => {
        await window.electronAPI.attachment.delete(id);
        return true;
      }, "Failed to remove the attachment");
    },
    [run],
  );

  const openAttachment = useCallback(
    async (id: number) => {
      await run(async () => {
        // Resolves with the OS error text, or null when the file opened.
        const failure = await window.electronAPI.attachment.open(id);
        if (failure !== null && failure.length > 0) throw new Error(failure);
        return false;
      }, "Failed to open the attachment");
    },
    [run],
  );

  return {
    attachments,
    isLoading,
    error,
    busy,
    addAttachment,
    removeAttachment,
    openAttachment,
    reload,
  };
}
