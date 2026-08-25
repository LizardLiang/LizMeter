import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./Combobox.module.scss";
import listStyles from "./Select.module.scss";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Existing values offered as suggestions. Typing a new one is still allowed. */
  options: string[];
  /** Also the accessible name. */
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  maxLength?: number;
}

const MIN_WIDTH = 160;
const MAX_HEIGHT = 220;

function ChevronIcon() {
  return (
    <svg
      className={listStyles.chevron}
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
 * Free-text field with themed suggestions -- the editable sibling of `Select`.
 * A native <input list> hands its popup to the OS renderer, which ignores the theme.
 */
export function Combobox({ value, onChange, options, ariaLabel, placeholder, className, maxLength }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ top: 0, left: 0, width: MIN_WIDTH });
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const query = value.trim().toLowerCase();
  // While typing, narrow to matches; an exact match still shows the full list so the
  // field does not collapse to the single value already entered.
  const matches = query.length === 0 || options.some((o) => o.toLowerCase() === query)
    ? options
    : options.filter((o) => o.toLowerCase().includes(query));

  const place = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const rect = wrap.getBoundingClientRect();
    const width = Math.max(rect.width, MIN_WIDTH);
    const height = Math.min(matches.length * 30 + 8, MAX_HEIGHT);
    const flipped = rect.bottom + 4 + height > window.innerHeight;

    setPos({
      top: flipped ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
    });
  }, [matches.length]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, value]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || wrapRef.current?.contains(target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);

    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const pick = useCallback((next: string) => {
    onChange(next);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }, [onChange]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && active >= 0) {
      // Only swallow Enter when a suggestion is highlighted, so the form can still submit.
      e.preventDefault();
      const match = matches[active];
      if (match) pick(match);
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <>
      <div className={className ? `${styles.wrap} ${className}` : styles.wrap} ref={wrapRef}>
        <input
          ref={inputRef}
          className={styles.input}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(-1);
            if (options.length > 0) setOpen(true);
          }}
          onFocus={() => options.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
        />
        {options.length > 0 && (
          <button
            type="button"
            className={styles.toggle}
            tabIndex={-1}
            aria-label={`Show ${ariaLabel} suggestions`}
            onClick={() => {
              setOpen((v) => !v);
              inputRef.current?.focus();
            }}
          >
            <ChevronIcon />
          </button>
        )}
      </div>

      {open && matches.length > 0 && createPortal(
        <div
          ref={listRef}
          className={listStyles.list}
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: MAX_HEIGHT }}
          role="listbox"
          aria-label={ariaLabel}
          // A portal bubbles through the React tree, so this stops the click from
          // reaching the dialog overlay and closing it.
          onClick={(e) => e.stopPropagation()}
        >
          {matches.map((option, index) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              className={index === active ? listStyles.optionActive : listStyles.option}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              <span className={listStyles.optionLabel}>{option}</span>
              {option === value && <span className={listStyles.check}>✓</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
