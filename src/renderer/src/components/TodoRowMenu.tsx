import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Todo, TodoState } from "../../../shared/types.ts";
import { formatTodoAgentPrompt, formatTodoId } from "../utils/todoClipboard.ts";
import styles from "./TodoRowMenu.module.scss";

/** The single-key menus the page already owns. An item here just hands off to one of them. */
export type QuickMenuKind = "state" | "priority" | "due" | "project" | "label";

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
/** The fixed items plus the four section labels and the dividers between them. */
const FIXED_ROWS = 17;
/** "Copied ✓" shows on the clicked item for this long, then the menu closes. */
const COPIED_FEEDBACK_MS = 1200;

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
  /** Which "Copy" item (if either) currently reads "Copied ✓" instead of its normal label. */
  const [copiedItem, setCopiedItem] = useState<"id" | "prompt" | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  /** Flipped false by the unmount cleanup below so a copy chain that resolves after the menu is
   * gone (Escape or an outside click fired while `navigator.clipboard.writeText` was still
   * pending) can tell it is too late to arm a timer or call `close()`. */
  const aliveRef = useRef(true);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
      // A stale timer must never fire `close()` -- and never touch state -- on a menu that is
      // already gone (the row menu is unmounted, not merely hidden, once `onClose` fires).
      if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

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

  /**
   * `pick()` closes the menu the instant it is clicked, which would hide the "Copied ✓" feedback
   * before it ever showed -- so the two copy items go around it: copy, flip the label, then close
   * on a delay instead of immediately.
   */
  function finishCopy(item: "id" | "prompt") {
    // The clipboard write is async -- by the time it resolves the menu may already be unmounted
    // (Escape / outside click), so this must never touch state or arm a timer for a menu that is
    // gone.
    if (!aliveRef.current) return;
    setCopiedItem(item);
    // Clear any timer still armed from a previous copy click before replacing the ref, or that
    // first timer becomes unreachable and fires late, closing whatever menu (possibly a different
    // row's) happens to be open when it does.
    if (copyTimeoutRef.current !== null) window.clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = window.setTimeout(() => {
      copyTimeoutRef.current = null;
      if (!aliveRef.current) return;
      close();
    }, COPIED_FEEDBACK_MS);
  }

  function handleCopyId(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard
      .writeText(formatTodoId(todo.id))
      .then(() => finishCopy("id"))
      .catch((err: unknown) => {
        console.error("Failed to copy todo id", err);
      });
  }

  function handleCopyPrompt(e: React.MouseEvent) {
    e.stopPropagation();
    const parent = todo.parentId !== null
      ? { id: todo.parentId, title: todo.parentTitle ?? `#${todo.parentId}` }
      : null;
    // `todo` here only carries `childCount`, not the child rows themselves, and the list's own
    // `todos` array is filtered by the active view -- so the direct children are fetched fresh
    // through the same IPC call `TodoDetailPage` already uses, and only right now, not on every
    // render of this menu.
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
      .then(() => finishCopy("prompt"))
      .catch((err: unknown) => {
        console.error("Failed to copy agent prompt", err);
      });
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

      {
        /* No `<Hint>` on either item below: the natural key for "Copy id" would be the plain "C"
        TodosPage's global keymap already binds to "New todo" (see the `case "c"` there), so
        pairing it with "⇧C" for the prompt would half-steal a binding rather than add a clean
        one -- both items go keyless instead. */
      }
      <div className={styles.divider} />
      <p className={styles.sectionLabel}>Copy</p>
      <button className={styles.item} type="button" role="menuitem" onClick={handleCopyId}>
        {copiedItem === "id" ? "Copied ✓" : "Copy id"}
      </button>
      <button className={styles.item} type="button" role="menuitem" onClick={handleCopyPrompt}>
        {copiedItem === "prompt" ? "Copied ✓" : "Copy agent prompt"}
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
      <button className={styles.item} type="button" role="menuitem" onClick={pick(() => onQuickMenu("label"))}>
        Labels...
        <Hint keys={["T"]} />
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
