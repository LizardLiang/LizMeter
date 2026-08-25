import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TodoState } from "../../../shared/types.ts";
import styles from "./TodoRowMenu.module.scss";

interface Props {
  todoId: number;
  todoTitle: string;
  currentStateId: number;
  states: TodoState[];
  onEdit: () => void;
  onSetState: (stateId: number) => void;
  onDelete: () => void;
}

const MENU_WIDTH = 190;
/** Header + Edit + Delete + one line per state. Only used to decide flip-up vs flip-down. */
const ROW_HEIGHT = 28;

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

/**
 * Per-row "..." menu. Rendered through a portal so the list's overflow does not clip it.
 */
export function TodoRowMenu({ todoId, todoTitle, currentStateId, states, onEdit, onSetState, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const btn = btnRef.current;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const height = (states.length + 4) * ROW_HEIGHT;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
    const top = rect.bottom + 2 + height > window.innerHeight
      ? Math.max(8, rect.top - height - 2)
      : rect.bottom + 2;

    setPos({ top, left });
    setOpen((v) => !v);
  }, [states.length]);

  useEffect(() => {
    if (!open) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, close]);

  function pick(action: () => void) {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      close();
      action();
    };
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={open ? styles.btnOpen : styles.btn}
        onClick={toggle}
        aria-label={`Actions for ${todoTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`todo-menu-${todoId}`}
      >
        <DotsIcon />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className={styles.menu}
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
          role="menu"
        >
          <button className={styles.item} type="button" role="menuitem" onClick={pick(onEdit)}>
            Edit
          </button>

          <div className={styles.divider} />
          <p className={styles.sectionLabel}>Move to</p>
          {states.map((s) => (
            <button
              key={s.id}
              className={s.id === currentStateId ? styles.itemActive : styles.item}
              type="button"
              role="menuitem"
              disabled={s.id === currentStateId}
              onClick={pick(() => onSetState(s.id))}
            >
              <span className={styles.dot} style={{ borderColor: s.color, background: s.color }} />
              {s.label}
            </button>
          ))}

          <div className={styles.divider} />
          <button className={styles.itemDanger} type="button" role="menuitem" onClick={pick(onDelete)}>
            Delete
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
