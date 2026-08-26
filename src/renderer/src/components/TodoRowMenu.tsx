import { useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { Todo, TodoState } from "../../../shared/types.ts";
import styles from "./TodoRowMenu.module.scss";

/** The single-key menus the page already owns. An item here just hands off to one of them. */
export type QuickMenuKind = "state" | "priority" | "due" | "project";

/** Where a menu hangs. `top`/`bottom` bracket the trigger so the panel can flip above it. */
export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
}

interface MenuProps {
  todo: Todo;
  states: TodoState[];
  anchor: MenuAnchor;
  onEdit: () => void;
  onQuickMenu: (kind: QuickMenuKind) => void;
  onAddSubIssue: () => void;
  onLinkChild: () => void;
  onSetParent: () => void;
  onClearParent: () => void;
  onSetState: (stateId: number) => void;
  onDelete: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 216;
/** Only feeds the flip-up decision, so an estimate from the row count is close enough. */
const ROW_HEIGHT = 26;
/** The fixed items plus the three section labels and the dividers between them. */
const FIXED_ROWS = 13;

/**
 * Electron reports the real platform, so this is the modifier the user actually presses.
 * Kept in step with the same constant in `TodoShortcutsOverlay`.
 */
const MOD = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";

/**
 * Every action a row supports, in one panel, opened by right-clicking the row.
 *
 * There is exactly one of these on the page rather than one per row: the panel is transient and
 * only ever hangs off a pointer, so a row does not need to carry a trigger -- which is why the
 * list has no "..." button crowding every title. Portalled, because the list's overflow and the
 * panel's backdrop-filter would both otherwise clip it.
 *
 * Items whose value needs filtering or free text (priority, due date, project) do not try to
 * inline themselves here; they hand off to `TodoQuickMenu`, which is what the matching single-key
 * shortcut opens too.
 */
export function TodoActionMenu(props: MenuProps) {
  const { todo, states, anchor, onClose } = props;
  const { onEdit, onQuickMenu, onAddSubIssue, onLinkChild, onSetParent, onClearParent, onSetState, onDelete } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const hasParent = todo.parentId !== null;

  const pos = useMemo(() => {
    const height = (states.length + FIXED_ROWS) * ROW_HEIGHT;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
    const top = anchor.bottom + 2 + height > window.innerHeight
      ? Math.max(8, anchor.top - height - 2)
      : anchor.bottom + 2;
    return { top, left };
  }, [anchor, states.length]);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
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
  }, [close]);

  function pick(action: () => void) {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      close();
      action();
    };
  }

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
      // Right-clicking inside the panel would otherwise re-open it over the row beneath.
      onContextMenu={(e) => e.preventDefault()}
      role="menu"
      aria-label={`Actions for ${todo.title}`}
    >
      <button className={styles.item} type="button" role="menuitem" onClick={pick(onEdit)}>
        Edit
        <Hint keys={["Enter"]} />
      </button>

      <div className={styles.divider} />
      <p className={styles.sectionLabel}>Properties</p>
      <button className={styles.item} type="button" role="menuitem" onClick={pick(() => onQuickMenu("priority"))}>
        Priority...
        <Hint keys={["P"]} />
      </button>
      <button className={styles.item} type="button" role="menuitem" onClick={pick(() => onQuickMenu("due"))}>
        Due date...
        <Hint keys={["D"]} />
      </button>
      <button className={styles.item} type="button" role="menuitem" onClick={pick(() => onQuickMenu("project"))}>
        Project...
        <Hint keys={["⇧", "P"]} />
      </button>

      <div className={styles.divider} />
      <p className={styles.sectionLabel}>Nesting</p>
      <button className={styles.item} type="button" role="menuitem" onClick={pick(onAddSubIssue)}>
        Add sub-issue
        <Hint keys={[MOD, "⇧", "O"]} />
      </button>
      <button className={styles.item} type="button" role="menuitem" onClick={pick(onLinkChild)}>
        Add existing sub-issue...
        <Hint keys={["L"]} />
      </button>
      <button className={styles.item} type="button" role="menuitem" onClick={pick(onSetParent)}>
        {hasParent ? "Change parent..." : "Make sub-issue of..."}
        <Hint keys={["⇧", "L"]} />
      </button>
      {hasParent && (
        <button className={styles.item} type="button" role="menuitem" onClick={pick(onClearParent)}>
          Remove from parent
        </button>
      )}

      <div className={styles.divider} />
      <p className={styles.sectionLabel}>
        Move to
        <Hint keys={["S"]} />
      </p>
      {states.map((s) => (
        <button
          key={s.id}
          className={s.id === todo.state.id ? styles.itemActive : styles.item}
          type="button"
          role="menuitem"
          disabled={s.id === todo.state.id}
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
  );
}

/**
 * The matching keyboard shortcut, right-aligned.
 *
 * Hidden from the accessibility tree on purpose: a menu item's name is the action, and folding
 * the key caps into it would read out "Change parent... Shift L".
 */
function Hint({ keys }: { keys: string[]; }) {
  return (
    <span className={styles.hint} aria-hidden="true">
      {keys.map((key) => <kbd key={key} className={styles.kbd}>{key}</kbd>)}
    </span>
  );
}
