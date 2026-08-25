import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Select.module.scss";

export interface SelectOption {
  value: string;
  label: string;
  /** Renders a leading dot, used for workflow states. */
  color?: string;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Also the accessible name -- these triggers are buttons, so a wrapping <label> would not bind. */
  ariaLabel: string;
  /** Shown when `value` matches no option, e.g. a bulk "Move to..." action. */
  placeholder?: string;
  className?: string;
}

const MIN_WIDTH = 160;
const MAX_HEIGHT = 280;

function ChevronIcon() {
  return (
    <svg
      className={styles.chevron}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M4 6.5 8 10.5 12 6.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Tokyo Night dropdown. A native <select> paints its option list with the OS
 * renderer, which ignores the theme entirely and flashes white on this dark UI.
 */
export function Select({ value, options, onChange, ariaLabel, placeholder, className }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: MIN_WIDTH, flipped: false });
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex === -1 ? undefined : options[selectedIndex];

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, MIN_WIDTH);
    const height = Math.min(options.length * 30 + 8, MAX_HEIGHT);
    const flipped = rect.bottom + 4 + height > window.innerHeight;

    setPos({
      top: flipped ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      flipped,
    });
  }, [options.length]);

  const openList = useCallback(() => {
    place();
    setActive(selectedIndex === -1 ? 0 : selectedIndex);
    setOpen(true);
  }, [place, selectedIndex]);

  const commit = useCallback((next: string) => {
    setOpen(false);
    onChange(next);
    triggerRef.current?.focus();
  }, [onChange]);

  // Re-measure before paint so the list never shows at a stale position.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    listRef.current?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScrollOrResize = () => setOpen(false);

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onScrollOrResize);
    // Capture phase so scrolling any ancestor container closes it too.
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open]);

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    }
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // The Todos page and the dialogs both watch Escape; this one is spoken for.
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = options[active];
      if (option) commit(option.value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className ? `${styles.trigger} ${className}` : styles.trigger}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        role="combobox"
      >
        {selected?.color && <span className={styles.dot} style={{ background: selected.color }} />}
        <span className={selected ? styles.value : styles.placeholder}>
          {selected?.label ?? placeholder ?? ""}
        </span>
        <ChevronIcon />
      </button>

      {open && createPortal(
        <div
          ref={listRef}
          className={styles.list}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: MAX_HEIGHT }}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          // A portal still bubbles through the React tree, so without this the
          // click would reach an ancestor overlay and close the whole dialog.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={index === active ? styles.optionActive : styles.option}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(option.value)}
            >
              {option.color && <span className={styles.dot} style={{ background: option.color }} />}
              <span className={styles.optionLabel}>{option.label}</span>
              {option.value === value && <span className={styles.check}>✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
