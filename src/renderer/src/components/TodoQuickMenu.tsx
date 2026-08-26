import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./TodoQuickMenu.module.scss";

export interface QuickMenuItem {
  /** Stable per menu. Handed back to `onPick`. */
  value: string;
  label: string;
  /** Drawn as a dot before the label. Used for state colours. */
  color?: string;
  /** Right-aligned detail, e.g. the date a relative option resolves to. */
  hint?: string;
  /** Marked as the current value, and where the highlight starts. */
  current?: boolean;
}

interface Props {
  heading: string;
  items: QuickMenuItem[];
  /** Where to anchor. Usually the focused row's bounding rect. */
  anchor: { top: number; bottom: number; left: number; };
  placeholder?: string;
  /**
   * Lets the typed query itself be submitted when nothing matches -- how a new project name or an
   * arbitrary YYYY-MM-DD gets in. Returning null rejects the query and keeps the menu open.
   */
  acceptQuery?: (query: string) => QuickMenuItem | null;
  onPick: (value: string) => void;
  onClose: () => void;
}

const MENU_WIDTH = 244;
const MAX_HEIGHT = 320;
/** Heading plus the search box plus padding. Only feeds the flip-up decision. */
const CHROME_HEIGHT = 82;
const ROW_HEIGHT = 30;

/**
 * A small anchored command menu driven entirely from the keyboard: type to filter, arrows to move,
 * Enter to pick, Escape to dismiss.
 *
 * It exists because the row's "..." menu is mouse-only -- the `s` / `p` / `d` / `P` shortcuts need
 * somewhere to land that never steals focus away from the list for longer than one choice.
 * Portalled, so the panel's backdrop-filter cannot clip it or trap its fixed positioning.
 */
export function TodoQuickMenu({ heading, items, anchor, placeholder, acceptQuery, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((i) => i.current === true)));
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return items;
    return items.filter((item) => item.label.toLowerCase().includes(needle));
  }, [items, query]);

  /** The typed value, offered as its own row when it matches nothing already listed. */
  const fromQuery = useMemo(() => {
    if (acceptQuery === undefined) return null;
    const trimmed = query.trim();
    if (trimmed.length === 0) return null;
    if (matches.some((item) => item.label.toLowerCase() === trimmed.toLowerCase())) return null;
    return acceptQuery(trimmed);
  }, [acceptQuery, query, matches]);

  const rows = useMemo(() => (fromQuery === null ? matches : [fromQuery, ...matches]), [fromQuery, matches]);

  // Estimated from the row count rather than measured, the same way TodoRowMenu places itself.
  // Measuring would mean writing state from a layout effect for a decision that only has to be
  // close enough to keep the menu on screen.
  const pos = useMemo(() => {
    const height = Math.min(CHROME_HEIGHT + rows.length * ROW_HEIGHT, MAX_HEIGHT);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
    const top = anchor.bottom + 4 + height > window.innerHeight
      ? Math.max(8, anchor.top - height - 4)
      : anchor.bottom + 4;
    return { top, left };
  }, [anchor, rows.length]);

  useEffect(() => {
    // Optional call: jsdom leaves scrollIntoView undefined, and keeping the highlight in view
    // must never break moving it.
    listRef.current?.querySelector("[data-active='true']")?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function handleKeyDown(event: React.KeyboardEvent) {
    // The page listens for the same single letters that open this menu, so nothing typed in
    // here may reach it. Every branch below stops the event, Escape included.
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = rows[active];
      if (item) {
        onPick(item.value);
        onClose();
      }
    }
  }

  return createPortal(
    <div className={styles.overlay} onMouseDown={onClose} role="presentation">
      <div
        className={styles.menu}
        style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
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
            // A shorter list must not leave the highlight past its end.
            setActive(0);
          }}
          placeholder={placeholder ?? "Type to filter"}
          aria-label={heading}
          autoFocus
        />

        {rows.length === 0 && <p className={styles.empty}>Nothing matches that.</p>}

        {rows.length > 0 && (
          <ul className={styles.list} ref={listRef}>
            {rows.map((item, index) => (
              <li key={item.value}>
                <button
                  type="button"
                  className={index === active ? styles.itemActive : styles.item}
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    onPick(item.value);
                    onClose();
                  }}
                >
                  {item.color !== undefined && (
                    <span
                      className={styles.dot}
                      style={{ borderColor: item.color, background: item.color }}
                      aria-hidden="true"
                    />
                  )}
                  <span className={styles.label}>{item.label}</span>
                  {item.hint !== undefined && <span className={styles.hint}>{item.hint}</span>}
                  {item.current === true && <span className={styles.check} aria-label="Current">&#10003;</span>}
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
