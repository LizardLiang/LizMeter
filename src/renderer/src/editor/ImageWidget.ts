// ImageWidget.ts
// The inline image of the live-preview editor: what `![alt](app-media://...)` becomes when the
// cursor is not on its line.
//
// The widget is deliberately self-contained. Its styling is inline rather than in a stylesheet
// because the editor's styles live in a CSS module, and a class name emitted from a widget
// cannot be reached by a hashed module class without a `:global` escape hatch. Inline styles
// also mean the widget renders correctly the moment it is constructed, in any host.

import { WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

/** Class hooks. Nothing here depends on them -- they exist for styling and for tests. */
export const IMAGE_WIDGET_CLASS = "cm-md-image";
export const IMAGE_MISSING_CLASS = "cm-md-image-missing";

/**
 * Tallest an inline image may render. Without a cap, one screenshot pushes the rest of the
 * note off screen and the editor stops looking like a text field.
 */
export const IMAGE_MAX_HEIGHT_PX = 320;

/**
 * Renders a markdown image inline.
 *
 * Only ever built for a destination that has already passed `isAllowedUrl`. This class does not
 * re-check the scheme -- a second copy of that predicate is how `javascript:` eventually gets
 * through -- so it must not be constructed from an unchecked string.
 */
export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }

  /**
   * The single most load-bearing method in the widget.
   *
   * Decorations are rebuilt on every keystroke. Without this, CodeMirror cannot tell the new
   * widget from the old one, so it destroys and recreates the `<img>` each time: the image
   * visibly flickers, the decode is thrown away, and a large attachment re-reads from disk
   * while the user types. Comparing `src` and `alt` is exactly the widget's identity -- the
   * document offsets are not part of it, and must not be, or every edit above the image would
   * force a rebuild it does not need.
   */
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  /**
   * @param view Supplied by CodeMirror. Optional only so the DOM can be built in a test
   *             without standing up an editor; the click handling below needs a real view.
   */
  override toDOM(view?: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = IMAGE_WIDGET_CLASS;
    wrapper.style.display = "inline-block";
    wrapper.style.maxWidth = "100%";
    wrapper.style.verticalAlign = "text-bottom";

    const image = document.createElement("img");
    image.src = this.src;
    // Doubles as the failure text a browser paints when the file is gone, and as the
    // accessible name.
    image.alt = this.alt;
    // Set as an attribute rather than through the IDL property: jsdom implements no reflection
    // for `loading`, so the property assignment would leave nothing an assertion can see.
    image.setAttribute("loading", "lazy");
    // An image dragged out of the editor would arrive back at the paste/drop handler as a
    // second copy of a file that is already stored.
    image.draggable = false;
    image.style.display = "block";
    image.style.maxWidth = "100%";
    image.style.maxHeight = `${IMAGE_MAX_HEIGHT_PX}px`;
    image.style.borderRadius = "8px";
    image.style.cursor = "default";
    // Attachments live in `userData` and can be deleted by hand, so a broken blob is a normal
    // state rather than an error. A bare broken-image glyph reads as a bug in the editor.
    image.addEventListener("error", () => wrapper.replaceChildren(missingPlaceholder(this.alt)));

    wrapper.appendChild(image);
    if (view !== undefined) placeCursorOnClick(wrapper, view);
    return wrapper;
  }

  /**
   * False, so a click on the image reaches the editor instead of falling into a hole. The
   * widget sits inside an atomic range, so without this a click on it would leave the cursor
   * wherever it already was.
   */
  override ignoreEvent(): boolean {
    return false;
  }
}

/** The broken-attachment state. Shaped like the image it replaces, so the line does not jump. */
function missingPlaceholder(alt: string): HTMLElement {
  const box = document.createElement("span");
  box.className = IMAGE_MISSING_CLASS;
  box.textContent = alt.trim().length > 0 ? `Missing image: ${alt}` : "Missing image";
  box.style.display = "inline-block";
  box.style.padding = "6px 10px";
  box.style.borderRadius = "8px";
  box.style.border = "1px dashed var(--tn-red, #f7768e)";
  box.style.color = "var(--tn-comment, #565f89)";
  box.style.fontSize = "0.85em";
  return box;
}

/**
 * Puts the cursor at the widget's own document offset when it is clicked.
 *
 * The position is read from the DOM at click time rather than captured when the widget is
 * built. A captured offset would go stale the moment text above the image changed, because
 * `eq` compares `src` and `alt` only and CodeMirror reuses the existing widget instance.
 */
function placeCursorOnClick(dom: HTMLElement, view: EditorView): void {
  dom.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;

    const pos = view.posAtDOM(dom);
    if (!Number.isInteger(pos) || pos < 0 || pos > view.state.doc.length) return;

    // Owning the event keeps CodeMirror from also resolving a position from coordinates, which
    // for a replaced range lands on whichever half of the image was clicked.
    event.preventDefault();
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  });
}
