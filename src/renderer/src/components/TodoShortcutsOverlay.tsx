import { useEffect } from "react";
import { createPortal } from "react-dom";
import styles from "./TodoShortcutsOverlay.module.scss";

interface Props {
  onClose: () => void;
}

interface Shortcut {
  /** Each entry is drawn as its own key cap, so "Ctrl" and "O" do not share a border. */
  keys: string[];
  label: string;
}

/**
 * Electron reports the real platform here, so this is the modifier the user actually presses
 * rather than a guess from the bundle target.
 */
const MOD = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";

const SECTIONS: Array<{ title: string; shortcuts: Shortcut[]; }> = [
  {
    title: "Move around",
    shortcuts: [
      { keys: ["↑"], label: "Move the cursor up" },
      { keys: ["↓"], label: "Move the cursor down" },
      { keys: ["Enter"], label: "Open the todo under the cursor" },
      { keys: ["Esc"], label: "Clear the selection, then the cursor" },
    ],
  },
  {
    title: "Change the todo under the cursor",
    shortcuts: [
      { keys: ["S"], label: "Set state" },
      { keys: ["P"], label: "Set priority" },
      { keys: ["D"], label: "Set due date" },
      { keys: ["Shift", "P"], label: "Set project" },
      { keys: ["T"], label: "Toggle labels" },
      { keys: ["L"], label: "Link an existing todo as a sub-issue" },
      { keys: ["Shift", "L"], label: "Link a parent" },
    ],
  },
  {
    title: "Create",
    shortcuts: [
      { keys: ["C"], label: "New todo" },
      { keys: [MOD, "Shift", "O"], label: "New sub-issue of the todo under the cursor" },
    ],
  },
];

/**
 * The `?` cheat sheet. Every binding on this page is invisible until something says it exists,
 * and a row of hints in the toolbar would crowd out the filters.
 */
export function TodoShortcutsOverlay({ onClose }: Props) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Anything typed while the sheet is up dismisses it rather than reaching the page beneath,
      // so a second `?` closes it as readily as Escape.
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }

    // Capture phase: the page keymap listens on the same target and would otherwise see the key.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className={styles.header}>
          <h2 className={styles.heading}>Keyboard shortcuts</h2>
          <button className={styles.closeBtn} type="button" onClick={onClose} aria-label="Close">x</button>
        </div>

        <div className={styles.columns}>
          {SECTIONS.map((section) => (
            <section key={section.title} className={styles.section}>
              <p className={styles.sectionLabel}>{section.title}</p>
              <ul className={styles.list}>
                {section.shortcuts.map((shortcut) => (
                  <li key={shortcut.label} className={styles.row}>
                    <span className={styles.keys}>
                      {shortcut.keys.map((key) => <kbd key={key} className={styles.kbd}>{key}</kbd>)}
                    </span>
                    <span className={styles.label}>{shortcut.label}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className={styles.footer}>
          Shortcuts other than <kbd className={styles.kbd}>C</kbd> need a cursor. Press{" "}
          <kbd className={styles.kbd}>&#8595;</kbd>{" "}
          to place one, or right-click a row to reach the same actions from a menu.
        </p>
      </div>
    </div>,
    document.body,
  );
}
