// TaskCheckboxWidget.ts
// A GFM task-list marker (`[ ]` / `[x]`) rendered as a real `<input type="checkbox">` when the
// cursor is off the item's line.
//
// This is the one widget in live preview that edits the document. Every other widget only
// reflects state that already exists in the text; clicking this one writes back to it.

import { WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

export const TASK_CHECKBOX_CLASS = "cm-md-task";

/** A GFM `TaskMarker` is always exactly three characters: `[ ]`, `[x]` or `[X]`. */
const MARKER_LENGTH = 3;

/**
 * Renders a task-list checkbox.
 *
 * `eq` compares only `checked`, the same rule `ImageWidget` follows -- document offsets are not
 * part of a widget's identity, or every edit above a task item would force a rebuild it does not
 * need. The offset the click handler needs to dispatch the toggle is read fresh from the DOM
 * instead (`view.posAtDOM`), for the same reason `ImageWidget.placeCursorOnClick` does: a
 * captured offset goes stale the moment text above the item changes, and a correct `eq` is
 * exactly what keeps CodeMirror reusing the old widget instance when that happens.
 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  /**
   * @param view Supplied by CodeMirror. Optional only so the DOM can be built in a test without
   *             standing up an editor; the click handling below needs a real view.
   */
  override toDOM(view?: EditorView): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = TASK_CHECKBOX_CLASS;
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "Mark task not done" : "Mark task done");
    if (view !== undefined) wireToggle(input, view);
    return input;
  }

  /**
   * True for every event inside this widget. The checkbox's own `mousedown` listener is what
   * lets the click through and toggles the source; without this, CodeMirror would also try to
   * resolve the click into a cursor position, which would land the cursor on the item's line and
   * reveal its raw source out from under the click it was meant to handle.
   */
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Flips `[ ]` to `[x]` or `[x]`/`[X]` back to `[ ]`, in a single dispatch.
 *
 * The toggle itself lives on `click`, not `mousedown`: the checkbox is a real, tabbable
 * `<input>`, so Tab then Space activates it -- a native keyboard interaction that fires `click`
 * (and `change`) with no `mousedown` at all. Wiring the toggle only to `mousedown` left that path
 * flipping the DOM checkbox's own `checked` property without ever touching the document, out of
 * sync until the next unrelated rebuild.
 *
 * `mousedown` keeps its own listener for exactly one job: `preventDefault` so a mouse click does
 * not move focus or disturb the editor's selection. It does not also toggle -- `click` still
 * fires after a `mousedown`/`mouseup` pair regardless of `preventDefault` there, and toggling in
 * both would flip the marker twice on an ordinary mouse click, undoing itself.
 */
function wireToggle(input: HTMLInputElement, view: EditorView): void {
  input.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
  });

  input.addEventListener("click", () => {
    const pos = view.posAtDOM(input);
    if (!Number.isInteger(pos) || pos < 0 || pos + MARKER_LENGTH > view.state.doc.length) return;

    const marker = view.state.doc.sliceString(pos, pos + MARKER_LENGTH);
    const next = marker === "[ ]" ? "[x]" : marker === "[x]" || marker === "[X]" ? "[ ]" : undefined;
    if (next === undefined) return;

    view.dispatch({ changes: { from: pos, to: pos + MARKER_LENGTH, insert: next } });
  });
}
