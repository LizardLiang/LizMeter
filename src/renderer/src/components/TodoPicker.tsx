import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Todo } from "../../../shared/types.ts";
import { linkableChildren, linkableParents } from "../utils/todoTree.ts";
import styles from "./TodoPicker.module.scss";

export type PickerMode =
  /** Choosing a parent for `todoId`. Null while the todo is still being created. */
  | { kind: "parent"; todoId: number | null; currentParentId: number | null; }
  /** Choosing an existing todo to file under `todoId`. */
  | { kind: "child"; todoId: number; };

interface Props {
  heading: string;
  mode: PickerMode;
  onPick: (todo: Todo) => void;
  onClose: () => void;
}

/**
 * Searchable list of todos that may legally be linked, over a portal so it can sit above the
 * edit dialog.
 *
 * It loads the full, unfiltered list itself rather than taking the page's `todos`: the page is
 * narrowed by the active filter, and a candidate must not disappear just because "Active" is on.
 */
export function TodoPicker({ heading, mode, onPick, onClose }: Props) {
  const [all, setAll] = useState<Todo[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.todo.list({})
      .then((todos) => {
        if (!cancelled) setAll(todos);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load todos");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = useMemo(() => {
    if (all === null) return [];
    return mode.kind === "parent"
      ? linkableParents(all, mode.todoId, mode.currentParentId)
      : linkableChildren(all, mode.todoId);
  }, [all, mode]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return candidates;
    // `#12` is how the rows label themselves, so let the id be searchable the same way.
    const byId = needle.replace(/^#/, "");
    return candidates.filter((todo) =>
      todo.title.toLowerCase().includes(needle)
      || (byId.length > 0 && String(todo.id).startsWith(byId))
    );
  }, [candidates, query]);

  const pick = useCallback((todo: Todo) => {
    onPick(todo);
    onClose();
  }, [onPick, onClose]);

  function onKeyDown(event: React.KeyboardEvent) {
    // Portalled, but React still bubbles to whatever rendered this -- usually the edit dialog,
    // which submits on Ctrl+Enter and closes on Escape. Every key handled here stops here.
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.stopPropagation();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const todo = matches[active];
      if (todo) pick(todo);
    }
  }

  useEffect(() => {
    listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return createPortal(
    <div
      className={styles.overlay}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="presentation"
    >
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
      >
        <p className={styles.heading}>{heading}</p>

        <input
          className={styles.search}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // A shorter result list must not leave the highlight past its end.
            setActive(0);
          }}
          placeholder="Search by title or #id"
          aria-label="Search todos"
          autoFocus
        />

        {error !== null && <p className={styles.empty}>{error}</p>}
        {error === null && all === null && <p className={styles.empty}>Loading...</p>}
        {error === null && all !== null && matches.length === 0 && (
          <p className={styles.empty}>
            {candidates.length === 0 ? "No todo can be linked here." : "Nothing matches that search."}
          </p>
        )}

        {matches.length > 0 && (
          <ul className={styles.list} ref={listRef}>
            {matches.map((todo, index) => (
              <li key={todo.id}>
                <button
                  type="button"
                  className={index === active ? styles.itemActive : styles.item}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(todo)}
                >
                  <span className={styles.id}>#{todo.id}</span>
                  <span
                    className={styles.dot}
                    style={{
                      borderColor: todo.state.color,
                      background: todo.state.isCompleted ? todo.state.color : "transparent",
                    }}
                    aria-hidden="true"
                  />
                  <span className={styles.title}>{todo.title}</span>
                  {todo.parentTitle !== null && <span className={styles.crumb}>in {todo.parentTitle}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
