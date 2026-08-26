// livePreviewPlugin.ts
// A thin adapter. It owns no markdown knowledge: it asks `livePreviewRanges` what should
// render, turns the answer into CodeMirror decorations, and manages the three things that can
// only be decided against a live `EditorView` -- the visible window, IME composition, and
// which ranges the cursor must step over.

import type { EditorState, Range, SelectionRange } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { ImageWidget } from "./ImageWidget.ts";
import { livePreviewRanges } from "./livePreviewRanges.ts";
import type { DocRange, PreviewRange } from "./livePreviewRanges.ts";

/**
 * Replaces a range with a short piece of text (a list bullet) or with nothing at all (a
 * horizontal rule, which `.cm-md-hr` draws in CSS).
 *
 * `eq` is the load-bearing method and is why this class exists rather than an inline widget
 * literal. Decorations are rebuilt on every keystroke; without a correct `eq`, CodeMirror
 * cannot tell the new widget from the old one, so it destroys and recreates the DOM each time.
 * For a bullet that is invisible waste. For the Phase 8 image widget it is a visible flicker
 * and a lost decode, which is why the plan asks for this now rather than then.
 */
export class PreviewTextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) {
    super();
  }

  override eq(other: PreviewTextWidget): boolean {
    return other.text === this.text && other.className === this.className;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }

  /**
   * False lets the editor handle events that land on the widget, so clicking a rendered
   * bullet places the cursor in the source rather than doing nothing.
   */
  override ignoreEvent(): boolean {
    return false;
  }
}

export interface BuiltDecorations {
  /** Everything the editor should render. */
  decorations: DecorationSet;
  /**
   * Only the ranges that collapse to nothing or to a widget. Feeding the full set to
   * `atomicRanges` would make arrow keys skip whole headings and bold runs, because the
   * `mark` ranges cover the visible text rather than the hidden syntax.
   */
  atomic: DecorationSet;
}

/**
 * Turns the descriptors into decoration sets. Takes an `EditorState` rather than an
 * `EditorView` so the ordering hazard below can be tested without a DOM.
 */
export function previewDecorations(
  state: EditorState,
  ranges: readonly SelectionRange[],
  visible?: readonly DocRange[],
): BuiltDecorations {
  const previews = livePreviewRanges(state, ranges, visible);
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];

  for (const preview of previews) {
    if (preview.kind === "mark") {
      if (preview.markClass === undefined) continue;
      decorations.push(Decoration.mark({ class: preview.markClass }).range(preview.from, preview.to));
      continue;
    }

    // `block: false` keeps an image inline with the text around it. A block widget would take
    // the whole line, so `text ![a](x) tail` would break into three.
    const decoration = preview.kind === "widget"
      ? Decoration.replace({ widget: widgetFor(preview), block: false })
      : Decoration.replace({});
    const range = decoration.range(preview.from, preview.to);
    decorations.push(range);
    atomic.push(range);
  }

  // `Decoration.set(.., true)` sorts by start position *and* decoration side. A RangeSetBuilder
  // would need that ordering supplied by hand, and getting it wrong throws at runtime on
  // whatever markdown happens to nest first.
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

/**
 * A destination is the only thing that separates the two widgets, and `livePreviewRanges` sets
 * one only after the URL has passed the scheme allowlist. Nothing here re-checks it, and
 * nothing here may construct an `ImageWidget` from any other source.
 */
function widgetFor(preview: PreviewRange): WidgetType {
  if (preview.widgetSrc !== undefined) return new ImageWidget(preview.widgetSrc, preview.widgetText ?? "");
  return new PreviewTextWidget(preview.widgetText ?? "", preview.markClass ?? "");
}

function build(view: EditorView): BuiltDecorations {
  // `view.visibleRanges`, never the whole document. A 32,000-character note re-walked on every
  // keystroke janks visibly, and that is the usual reason live preview "ships and feels slow".
  return previewDecorations(view.state, view.state.selection.ranges, view.visibleRanges);
}

/**
 * Renders markdown in place, revealing the raw source of whatever line the cursor is on.
 *
 * Undo is free: nothing here is a document change, so an undo only moves text and the
 * decorations recompute from the new state.
 */
export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;
    /** True once a composition has been seen, until the rebuild that follows it. */
    private deferred = false;

    constructor(view: EditorView) {
      const built = build(view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }

    update(update: ViewUpdate): void {
      // Swapping decorations mid-composition drops characters in CJK input, and this app's
      // user types Chinese. The set is mapped through the changes instead so its positions
      // stay valid against the growing document, and the real rebuild waits for the update
      // where `composing` turns false.
      if (update.view.composing) {
        this.deferred = true;
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
          this.atomic = this.atomic.map(update.changes);
        }
        return;
      }

      if (!this.deferred && !update.docChanged && !update.selectionSet && !update.viewportChanged) return;

      this.deferred = false;
      const built = build(update.view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }
  },
  {
    decorations: (value) => value.decorations,
    // One arrow-key press then steps over a collapsed range instead of landing inside
    // characters that are no longer on screen.
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
);
