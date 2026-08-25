import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./DatePicker.module.scss";
import triggerStyles from "./Select.module.scss";

interface Props {
  /** "YYYY-MM-DD", or "" for no date. */
  value: string;
  onChange: (value: string) => void;
  /** Also the accessible name. */
  ariaLabel: string;
  placeholder?: string;
  className?: string;
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const PANEL_WIDTH = 248;
const PANEL_HEIGHT = 316;

/**
 * Builds the wire format from local calendar parts. Going through `toISOString()`
 * would shift the day in any timezone behind UTC.
 */
function toIso({ y, m, d }: Ymd): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseIso(iso: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

function todayYmd(): Ymd {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
}

function sameDay(a: Ymd, b: Ymd): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

/** Dates are rendered at UTC noon so a date-only value cannot slip a day either way. */
function formatDisplay(ymd: Ymd): string {
  return new Date(Date.UTC(ymd.y, ymd.m, ymd.d, 12)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function monthLabel(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 1, 12)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

// 2024-01-07 is a Sunday, so this yields locale-narrow names in Sunday-first order.
const WEEKDAYS = Array.from(
  { length: 7 },
  (_, i) =>
    new Date(Date.UTC(2024, 0, 7 + i, 12)).toLocaleDateString(undefined, {
      weekday: "narrow",
      timeZone: "UTC",
    }),
);

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function addMonths({ y, m, d }: Ymd, delta: number): Ymd {
  const total = y * 12 + m + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) };
}

function addDays(ymd: Ymd, delta: number): Ymd {
  const shifted = new Date(Date.UTC(ymd.y, ymd.m, ymd.d + delta, 12));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

function CalendarIcon() {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="2" />
      <path d="M2.25 6.5h11.5M5.5 2v2.5M10.5 2v2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Tokyo Night date field. Replaces <input type="date">, whose calendar popup is drawn
 * by Chromium in the OS light theme and cannot be styled.
 */
export function DatePicker({ value, onChange, ariaLabel, placeholder = "No date", className }: Props) {
  const selected = parseIso(value);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<Ymd>(() => selected ?? todayYmd());
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const flipped = rect.bottom + 4 + PANEL_HEIGHT > window.innerHeight;
    setPos({
      top: flipped ? Math.max(8, rect.top - PANEL_HEIGHT - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    panelRef.current?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
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

  const commit = useCallback((ymd: Ymd) => {
    onChange(toIso(ymd));
    setOpen(false);
    triggerRef.current?.focus();
  }, [onChange]);

  function openPanel() {
    setCursor(selected ?? todayYmd());
    setOpen(true);
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // The dialog and the Todos page both listen for Escape; this one is handled here.
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }

    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const move = moves[e.key];
    if (move !== undefined) {
      e.preventDefault();
      setCursor((c) => addDays(c, move));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setCursor((c) => addMonths(c, -1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setCursor((c) => addMonths(c, 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commit(cursor);
    }
  }

  const today = todayYmd();
  const leading = new Date(Date.UTC(cursor.y, cursor.m, 1, 12)).getUTCDay();
  const total = daysInMonth(cursor.y, cursor.m);
  const cells: Array<Ymd | null> = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: total }, (_, i) => ({ y: cursor.y, m: cursor.m, d: i + 1 })),
  ];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className ? `${triggerStyles.trigger} ${className}` : triggerStyles.trigger}
        onClick={() => (open ? setOpen(false) : openPanel())}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={selected ? triggerStyles.value : triggerStyles.placeholder}>
          {selected ? formatDisplay(selected) : placeholder}
        </span>
        <CalendarIcon />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className={styles.panel}
          style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
          role="dialog"
          aria-label={ariaLabel}
          tabIndex={-1}
          // A portal bubbles through the React tree, so this keeps the click from
          // reaching the edit dialog's overlay and closing it.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onPanelKeyDown}
        >
          <div className={styles.header}>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => setCursor((c) => addMonths(c, -1))}
              aria-label="Previous month"
            >
              ‹
            </button>
            <span className={styles.monthLabel}>{monthLabel(cursor.y, cursor.m)}</span>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => setCursor((c) => addMonths(c, 1))}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className={styles.weekdays}>
            {WEEKDAYS.map((label, i) => <span key={i} className={styles.weekday}>{label}</span>)}
          </div>

          <div className={styles.grid}>
            {cells.map((cell, i) =>
              cell === null ? <span key={`pad-${i}`} /> : (
                <button
                  key={toIso(cell)}
                  type="button"
                  className={[
                    styles.day,
                    selected && sameDay(cell, selected) ? styles.daySelected : "",
                    sameDay(cell, today) ? styles.dayToday : "",
                    sameDay(cell, cursor) ? styles.dayCursor : "",
                  ].filter(Boolean).join(" ")}
                  aria-pressed={selected ? sameDay(cell, selected) : false}
                  onClick={() => commit(cell)}
                >
                  {cell.d}
                </button>
              )
            )}
          </div>

          <div className={styles.footer}>
            <button type="button" className={styles.footerBtn} onClick={() => commit(today)}>
              Today
            </button>
            <button
              type="button"
              className={styles.footerClear}
              onClick={() => {
                onChange("");
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              Clear
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
