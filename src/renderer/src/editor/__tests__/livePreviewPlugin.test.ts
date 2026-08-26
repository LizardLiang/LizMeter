// The plugin holds no markdown knowledge, so there is little here worth asserting -- except
// the one thing that can throw at runtime on a document nobody tested by hand.
//
// `Decoration.set` rejects ranges that arrive out of order, and nesting is where the order
// goes wrong: a bold run inside a heading, a fence marker inside a whole-fence mark, a quote
// marker inside a whole-blockquote mark. `previewDecorations` takes an `EditorState`, not an
// `EditorView`, so that hazard is testable without layout. What the result LOOKS like is not
// assertable in jsdom and is on the manual checklist instead.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { ImageWidget } from "../ImageWidget.ts";
import { previewDecorations, PreviewTextWidget } from "../livePreviewPlugin.ts";
import { livePreviewRanges } from "../livePreviewRanges.ts";

/** One of every construct the walker handles, nested where nesting is possible. */
const KITCHEN_SINK = [
  "# Heading with **bold** and `code`",
  "",
  "Paragraph with *italic*, ~~strike~~ and a [link](https://example.com).",
  "",
  "> A quote with **bold** in it",
  "> and a second line",
  "",
  "- bullet one",
  "- bullet two with `code`",
  "",
  "1. first",
  "2. second",
  "",
  "---",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "![alt](app-media://attachments/a.png)",
  "",
  "[![alt](app-media://attachments/b.png)](https://example.com)",
  "",
  "[unsafe](javascript:alert(1))",
  "",
  "tail",
].join("\n");

function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, codeLanguages: [] })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

describe("previewDecorations", () => {
  it("builds a decoration set for a document using every supported construct", () => {
    const state = stateOf(KITCHEN_SINK);

    const built = previewDecorations(state, [EditorSelection.cursor(state.doc.length)]);

    expect(built.decorations.size).toBeGreaterThan(0);
  });

  it("keeps mark decorations out of the atomic set", () => {
    // Atomic ranges are what a cursor steps over. Feeding it the marks as well would make an
    // arrow key jump the whole heading text, not just the hidden hashes.
    const state = stateOf(KITCHEN_SINK);
    const selection = [EditorSelection.cursor(state.doc.length)];
    const previews = livePreviewRanges(state, selection);

    const built = previewDecorations(state, selection);

    const collapsed = previews.filter((range) => range.kind !== "mark").length;
    expect(collapsed).toBeGreaterThan(0);
    expect(built.atomic.size).toBe(collapsed);
    expect(built.decorations.size).toBe(previews.length);
  });

  it("builds an empty set for an empty document", () => {
    const built = previewDecorations(stateOf(""), [EditorSelection.cursor(0)]);

    expect(built.decorations.size).toBe(0);
    expect(built.atomic.size).toBe(0);
  });

  it("honours the visible window", () => {
    const doc = "**a**\n**b**\n**c**\n\ntail";
    const state = stateOf(doc);
    const selection = [EditorSelection.cursor(doc.length)];

    const whole = previewDecorations(state, selection);
    const window = previewDecorations(state, selection, [{ from: 6, to: 11 }]);

    expect(window.decorations.size).toBeLessThan(whole.decorations.size);
  });
});

/** Every widget instance the decoration set carries, in document order. */
function widgetsOf(state: EditorState): unknown[] {
  const built = previewDecorations(state, [EditorSelection.cursor(state.doc.length)]);
  const found: unknown[] = [];
  built.decorations.between(0, state.doc.length, (_from, _to, value: Decoration) => {
    const widget = (value.spec as { widget?: unknown; }).widget;
    if (widget !== undefined) found.push(widget);
  });
  return found;
}

describe("image decorations", () => {
  it("builds an image widget for an allowed destination", () => {
    const state = stateOf("![shot](app-media://attachments/a.png)\n\ntail");

    const images = widgetsOf(state).filter((widget) => widget instanceof ImageWidget);

    expect(images).toEqual([new ImageWidget("app-media://attachments/a.png", "shot")]);
  });

  it("builds no widget at all for a javascript: destination", () => {
    const state = stateOf("![shot](javascript:alert(1))\n\ntail");

    expect(widgetsOf(state)).toEqual([]);
  });

  it("puts the image widget in the atomic set so an arrow key steps over it", () => {
    const state = stateOf("![shot](app-media://attachments/a.png)\n\ntail");

    const built = previewDecorations(state, [EditorSelection.cursor(state.doc.length)]);

    expect(built.atomic.size).toBe(1);
  });

  it("survives an image nested inside a link", () => {
    // The nesting hazard this file exists for: the link's `mark` and the image's `replace`
    // cover the same range, and an out-of-order set throws inside `Decoration.set`.
    const state = stateOf("[![shot](app-media://attachments/a.png)](https://example.com)\n\ntail");

    expect(() => previewDecorations(state, [EditorSelection.cursor(state.doc.length)])).not.toThrow();
  });
});

describe("PreviewTextWidget", () => {
  it("compares equal to a widget with the same text and class", () => {
    // Without this, every keystroke destroys and recreates the widget DOM. Phase 8's image
    // widget inherits the consequence: a visible flicker and a discarded decode.
    expect(new PreviewTextWidget("•", "cm-md-bullet").eq(new PreviewTextWidget("•", "cm-md-bullet")))
      .toBe(true);
  });

  it("compares unequal when the text or the class differs", () => {
    expect(new PreviewTextWidget("•", "cm-md-bullet").eq(new PreviewTextWidget("-", "cm-md-bullet"))).toBe(false);
    expect(new PreviewTextWidget("", "cm-md-hr").eq(new PreviewTextWidget("", "cm-md-bullet"))).toBe(false);
  });

  it("renders its text into a span carrying its class", () => {
    const dom = new PreviewTextWidget("•", "cm-md-bullet").toDOM();

    expect(dom.tagName).toBe("SPAN");
    expect(dom.className).toBe("cm-md-bullet");
    expect(dom.textContent).toBe("•");
  });

  it("lets the editor handle events that land on it", () => {
    // True would leave a click on a rendered bullet doing nothing at all.
    expect(new PreviewTextWidget("•", "cm-md-bullet").ignoreEvent()).toBe(false);
  });
});
