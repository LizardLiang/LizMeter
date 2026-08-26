// This is where the real coverage for live preview lives.
//
// `livePreviewRanges` is pure and takes an `EditorState`, which is headless, so every decision
// the feature makes is testable here without a DOM. The companion `MarkdownEditor.test.tsx`
// deliberately asserts nothing about decorations: jsdom performs no layout, so the CodeMirror
// viewport measures as zero height and any "the bold markers are hidden in the DOM" assertion
// is either flaky or vacuously true. Test the decisions, not the pixels.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { SelectionRange } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { livePreviewRanges, MAX_BLOCK_LINES } from "../livePreviewRanges.ts";
import type { DocRange, PreviewRange } from "../livePreviewRanges.ts";

/**
 * `base: markdownLanguage` is GFM. The commonmark default that `markdown()` falls back to has
 * no `Strikethrough` node at all, so `~~gone~~` would never reach the walker.
 */
function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, codeLanguages: [] })],
  });
  // A bare `syntaxTree()` can hand back a tree parsed only as far as the first viewport, which
  // silently produces "no ranges" for anything below it. This forces the full parse first.
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

interface Analysis {
  ranges: PreviewRange[];
  /** Source text of every `hide` range, in document order. */
  hidden: string[];
  /** `<class>:<source text>` for every `mark` range, in document order. */
  marked: string[];
  /** `<class>:<widget text>@<replaced source>` for every `widget` range, in document order. */
  widgets: string[];
  /** `<src>|<alt>` for every widget carrying an image source, in document order. */
  images: string[];
}

function analyse(doc: string, selection: readonly SelectionRange[], visible?: readonly DocRange[]): Analysis {
  const ranges = livePreviewRanges(stateOf(doc), selection, visible);
  return {
    ranges,
    hidden: ranges.filter((r) => r.kind === "hide").map((r) => doc.slice(r.from, r.to)),
    marked: ranges.filter((r) => r.kind === "mark").map((r) => `${r.markClass}:${doc.slice(r.from, r.to)}`),
    widgets: ranges
      .filter((r) => r.kind === "widget")
      .map((r) => `${r.markClass}:${r.widgetText}@${doc.slice(r.from, r.to)}`),
    images: ranges.filter((r) => r.widgetSrc !== undefined).map((r) => `${r.widgetSrc}|${r.widgetText}`),
  };
}

function cursor(pos: number): SelectionRange[] {
  return [EditorSelection.cursor(pos)];
}

function selection(from: number, to: number): SelectionRange[] {
  return [EditorSelection.range(from, to)];
}

/** Parks the cursor on the last line, which every fixture below keeps free of markdown. */
function parked(doc: string): SelectionRange[] {
  return cursor(doc.length);
}

describe("livePreviewRanges", () => {
  it("returns nothing for an empty document", () => {
    expect(analyse("", cursor(0)).ranges).toEqual([]);
  });

  it("returns nothing for a document with no markdown constructs", () => {
    const doc = "just prose, nothing to hide\nand a second line";
    expect(analyse(doc, parked(doc)).ranges).toEqual([]);
  });

  describe("inline constructs, cursor off the line", () => {
    it("hides the delimiters of bold text and marks the content", () => {
      const doc = "**bold**\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["**", "**"]);
      expect(out.marked).toEqual(["cm-md-strong:bold"]);
    });

    it("hides the delimiters of italic text", () => {
      const doc = "*slanted*\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["*", "*"]);
      expect(out.marked).toEqual(["cm-md-em:slanted"]);
    });

    it("hides the backticks of inline code", () => {
      const doc = "`code`\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["`", "`"]);
      expect(out.marked).toEqual(["cm-md-code:code"]);
    });

    it("hides the tildes of strikethrough text", () => {
      // Proves GFM is the active dialect. Under commonmark there is no Strikethrough node and
      // this returns an empty array.
      const doc = "~~gone~~\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["~~", "~~"]);
      expect(out.marked).toEqual(["cm-md-strike:gone"]);
    });

    it("hides the hashes of an ATX heading, including the space after them", () => {
      const doc = "# Title\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["# "]);
      expect(out.marked).toEqual(["cm-md-h1:Title"]);
    });

    it("marks a level-three heading with its own class", () => {
      const doc = "### Third\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["### "]);
      expect(out.marked).toEqual(["cm-md-h3:Third"]);
    });

    it("decorates a construct nested inside a heading", () => {
      const doc = "### H3 with **bold**\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["### ", "**", "**"]);
      expect(out.marked).toEqual(["cm-md-h3:H3 with **bold**", "cm-md-strong:bold"]);
    });

    it("hides the bracket and destination of a link, leaving the label", () => {
      const doc = "[text](https://x.com)\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["[", "](https://x.com)"]);
      expect(out.marked).toEqual(["cm-md-link:text"]);
    });
  });

  describe("URL scheme allowlist", () => {
    it("leaves a javascript: link as raw source", () => {
      const doc = "[click](javascript:alert(1))\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("leaves a data: link as raw source", () => {
      const doc = "[click](data:text/html;base64,PHN2Zz4=)\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("renders a mailto: link", () => {
      const doc = "[mail](mailto:a@b.com)\n\ntail";

      expect(analyse(doc, parked(doc)).marked).toEqual(["cm-md-link:mail"]);
    });

    it("renders an app-media: link", () => {
      const doc = "[file](app-media://attachments/a.pdf)\n\ntail";

      expect(analyse(doc, parked(doc)).marked).toEqual(["cm-md-link:file"]);
    });
  });

  describe("cursor ownership is line-level", () => {
    it("reveals a construct when the cursor sits inside it", () => {
      const doc = "**bold**\n\ntail";

      expect(analyse(doc, cursor(3)).ranges).toEqual([]);
    });

    it("reveals a construct when the cursor is elsewhere on the same line", () => {
      // Node-level ownership would keep this decorated, and the line would visibly jitter as
      // the cursor crossed each construct. Line-level is what Obsidian does.
      const doc = "**bold** and more\n\ntail";

      expect(analyse(doc, cursor(14)).ranges).toEqual([]);
    });

    it("reveals both constructs on a line the cursor touches", () => {
      const doc = "**bold** and *italic*\n\ntail";

      expect(analyse(doc, cursor(0)).ranges).toEqual([]);
    });

    it("decorates both constructs on a line the cursor does not touch", () => {
      const doc = "**bold** and *italic*\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["**", "**", "*", "*"]);
      expect(out.marked).toEqual(["cm-md-strong:bold", "cm-md-em:italic"]);
    });

    it("reveals every line a multi-line selection spans", () => {
      const doc = "**a**\n**b**\n**c**\n\ntail";

      // From inside line 1 to inside line 3.
      expect(analyse(doc, selection(2, 14)).ranges).toEqual([]);
    });

    it("leaves lines outside the selection decorated", () => {
      const doc = "**a**\n**b**\n**c**\n\ntail";
      const out = analyse(doc, selection(2, 8));

      expect(out.marked).toEqual(["cm-md-strong:c"]);
    });

    it("reveals every line touched by several cursors", () => {
      const doc = "**a**\n**b**\n**c**\n\ntail";
      const out = analyse(doc, [EditorSelection.cursor(2), EditorSelection.cursor(14)]);

      expect(out.marked).toEqual(["cm-md-strong:b"]);
    });
  });

  describe("malformed input", () => {
    it("returns nothing for an unclosed bold run", () => {
      const doc = "**unclosed and then some\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("returns nothing for an empty link label", () => {
      // Hiding every mark here would erase the construct from the screen entirely.
      const doc = "[](https://x.com)\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("returns nothing for a reference-style link with no destination", () => {
      const doc = "[label]\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });
  });

  describe("images", () => {
    it("replaces the whole image with an image widget when the cursor is off its line", () => {
      const doc = "![shot](app-media://attachments/a.png)\n\ntail";

      const out = analyse(doc, parked(doc));

      expect(out.ranges).toEqual([{
        from: 0,
        to: doc.indexOf("\n"),
        kind: "widget",
        markClass: "cm-md-image",
        widgetText: "shot",
        widgetSrc: "app-media://attachments/a.png",
      }]);
    });

    it("reveals the raw source when the cursor is on the image line", () => {
      const doc = "![shot](app-media://attachments/a.png)\n\ntail";

      expect(analyse(doc, cursor(3)).ranges).toEqual([]);
    });

    it("renders an https image", () => {
      const doc = "![shot](https://example.com/a.png)\n\ntail";

      expect(analyse(doc, parked(doc)).images).toEqual(["https://example.com/a.png|shot"]);
    });

    it("renders an image with no alt text", () => {
      const doc = "![](app-media://attachments/a.png)\n\ntail";

      expect(analyse(doc, parked(doc)).images).toEqual(["app-media://attachments/a.png|"]);
    });

    it("renders every image on a line", () => {
      const doc = "![a](https://x.com/1.png) and ![b](https://x.com/2.png)\n\ntail";

      expect(analyse(doc, parked(doc)).images).toEqual([
        "https://x.com/1.png|a",
        "https://x.com/2.png|b",
      ]);
    });

    it("leaves a javascript: image as raw source", () => {
      // The one case that must never become a live element.
      const doc = "![shot](javascript:alert(1))\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("leaves a data: image as raw source", () => {
      // A data URL can carry an SVG document, and an SVG rendered from a privileged surface is
      // script. `urlSchemes.ts` excludes the scheme for that reason; this pins the consequence.
      const doc = "![shot](data:image/svg+xml;base64,PHN2Zz4=)\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("leaves a reference-style image as raw source", () => {
      // `![alt][ref]` carries no destination to check, so there is nothing safe to render.
      const doc = "![shot][ref]\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("leaves an image with an empty destination as raw source", () => {
      // This is the shape of the in-flight upload placeholder, and its text is the point.
      const doc = "![uploading a.png...]()\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("keeps the title out of the source", () => {
      const doc = "![shot](https://x.com/a.png \"a title\")\n\ntail";

      expect(analyse(doc, parked(doc)).images).toEqual(["https://x.com/a.png|shot"]);
    });

    it("strips the angle brackets of a bracketed destination", () => {
      // lezer keeps `<>` inside the URL node, and they are not part of the address.
      const doc = "![shot](<https://x.com/a b.png>)\n\ntail";

      expect(analyse(doc, parked(doc)).images).toEqual(["https://x.com/a b.png|shot"]);
    });

    it("does not decorate markdown inside the alt text", () => {
      // Descending into the image would hide the emphasis marks of text that is about to be
      // replaced wholesale, and would hand the image's own `](url)` tail to the link handler.
      const doc = "![a **b**](https://x.com/a.png)\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual([]);
      expect(out.marked).toEqual([]);
      expect(out.images).toEqual(["https://x.com/a.png|a **b**"]);
    });

    it("leaves an image whose destination is on the next line as raw source", () => {
      // `![alt](\nurl)` is legal CommonMark. A replace decoration may not span a line break,
      // and CodeMirror throws rather than dropping it, so this must produce nothing at all.
      const doc = "![shot](\nhttps://x.com/a.png)\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });

    it("renders an image inside a list item next to its bullet", () => {
      const doc = "- ![shot](https://x.com/a.png)\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.images).toEqual(["https://x.com/a.png|shot"]);
      expect(out.widgets).toEqual([
        "cm-md-bullet:•@-",
        "cm-md-image:shot@![shot](https://x.com/a.png)",
      ]);
    });
  });

  describe("constructs deferred to a later phase", () => {
    it("leaves a GFM table as raw source", () => {
      const doc = "| a | b |\n| - | - |\n| 1 | 2 |\n\ntail";

      expect(analyse(doc, parked(doc)).ranges).toEqual([]);
    });
  });

  describe("visible ranges", () => {
    it("walks the whole document when no window is given", () => {
      const doc = "**a**\n**b**\n**c**\n\ntail";

      expect(analyse(doc, parked(doc)).marked).toEqual([
        "cm-md-strong:a",
        "cm-md-strong:b",
        "cm-md-strong:c",
      ]);
    });

    it("walks only the given window", () => {
      // The plugin passes `view.visibleRanges`. A 32,000-character note re-walked per keystroke
      // is the single most likely cause of "it shipped and it feels slow".
      const doc = "**a**\n**b**\n**c**\n\ntail";

      expect(analyse(doc, parked(doc), [{ from: 6, to: 11 }]).marked).toEqual(["cm-md-strong:b"]);
    });

    it("emits each range once when two windows overlap", () => {
      const doc = "**a**\n**b**\n**c**\n\ntail";

      expect(analyse(doc, parked(doc), [{ from: 0, to: 11 }, { from: 6, to: 17 }]).marked).toEqual([
        "cm-md-strong:a",
        "cm-md-strong:b",
        "cm-md-strong:c",
      ]);
    });
  });

  describe("block constructs", () => {
    it("hides both fence markers and marks the whole fenced block", () => {
      const doc = "```ts\nconst a = 1;\n```\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["```", "```"]);
      expect(out.ranges.filter((r) => r.kind === "mark")).toEqual([
        { from: 0, to: 22, kind: "mark", markClass: "cm-md-fence" },
      ]);
    });

    it("reveals the whole fence when the cursor is on a line inside it", () => {
      // Per-line toggling inside a fence tears visually, so the block toggles as one unit.
      const doc = "```ts\nconst a = 1;\n```\n\ntail";

      expect(analyse(doc, cursor(10)).ranges).toEqual([]);
    });

    it("reveals the whole fence when the cursor is on the closing marker", () => {
      const doc = "```ts\nconst a = 1;\n```\n\ntail";

      expect(analyse(doc, cursor(20)).ranges).toEqual([]);
    });

    it("still decorates an unclosed fence that stays under the line cap", () => {
      const doc = `intro\n\n\`\`\`ts\n${"x\n".repeat(20)}`;
      const out = analyse(doc, cursor(0));

      expect(out.hidden).toEqual(["```"]);
      expect(out.marked.map((m) => m.split(":")[0])).toEqual(["cm-md-fence"]);
    });

    it("leaves an unclosed fence as raw source once it swallows more than the line cap", () => {
      // An unterminated ``` makes lezer treat the rest of the document as one FencedCode node.
      // Collapsing that would hide everything the user wrote below it.
      const doc = `intro\n\n\`\`\`ts\n${"x\n".repeat(MAX_BLOCK_LINES + 10)}`;

      expect(analyse(doc, cursor(0)).ranges).toEqual([]);
    });

    it("hides every quote marker and marks the whole blockquote", () => {
      const doc = "> quoted\n> more\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["> ", "> "]);
      expect(out.ranges.filter((r) => r.kind === "mark")).toEqual([
        { from: 0, to: 15, kind: "mark", markClass: "cm-md-quote" },
      ]);
    });

    it("reveals the whole blockquote when the cursor is on any of its lines", () => {
      const doc = "> quoted\n> more\n\ntail";

      expect(analyse(doc, cursor(12)).ranges).toEqual([]);
    });

    it("replaces a bullet marker with a bullet glyph", () => {
      const doc = "- one\n- two\n\ntail";

      expect(analyse(doc, parked(doc)).widgets).toEqual([
        "cm-md-bullet:•@-",
        "cm-md-bullet:•@-",
      ]);
    });

    it("reveals only the list item the cursor is on", () => {
      const doc = "- one\n- two\n\ntail";
      const out = analyse(doc, cursor(8));

      expect(out.widgets).toEqual(["cm-md-bullet:•@-"]);
      expect(out.ranges[0]?.from).toBe(0);
    });

    it("marks an ordered list marker instead of replacing it", () => {
      // Replacing "1." would throw away the number the user typed.
      const doc = "1. one\n2. two\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.widgets).toEqual([]);
      expect(out.marked).toEqual(["cm-md-list-mark:1.", "cm-md-list-mark:2."]);
    });

    it("replaces a horizontal rule with a rule widget", () => {
      const doc = "para\n\n---\n\ntail";

      expect(analyse(doc, parked(doc)).widgets).toEqual(["cm-md-hr:@---"]);
    });

    it("reveals a horizontal rule when the cursor is on it", () => {
      const doc = "para\n\n---\n\ntail";

      expect(analyse(doc, cursor(7)).ranges).toEqual([]);
    });
  });

  describe("output shape", () => {
    it("returns ranges sorted by start position", () => {
      const doc = "# Title\n\n**bold** and `code`\n\n> quoted\n\ntail";
      const { ranges } = analyse(doc, parked(doc));

      expect(ranges.length).toBeGreaterThan(0);
      for (let i = 1; i < ranges.length; i += 1) {
        expect(ranges[i]!.from).toBeGreaterThanOrEqual(ranges[i - 1]!.from);
      }
    });

    it("never hides or replaces a range that crosses a line break", () => {
      // A view plugin may not supply a replace decoration spanning a line break -- CodeMirror
      // throws rather than dropping it. CommonMark lets a link destination sit on the next
      // line, which is enough to reach that throw.
      const doc = "[text](\nhttps://x.com) and **a\nb** and > not a quote\n\ntail";
      const state = stateOf(doc);

      for (const range of livePreviewRanges(state, cursor(doc.length))) {
        if (range.kind === "mark") continue;
        expect(state.doc.lineAt(range.from).number).toBe(state.doc.lineAt(range.to).number);
      }
    });

    it("still decorates emphasis that wraps across a soft line break", () => {
      // The delimiters are each on one line, so only the `mark` between them spans the break.
      const doc = "**a\nb**\n\ntail";
      const out = analyse(doc, parked(doc));

      expect(out.hidden).toEqual(["**", "**"]);
      expect(out.marked).toEqual(["cm-md-strong:a\nb"]);
    });

    it("never emits an empty range", () => {
      const doc = "# Title\n\n**bold** and `code`\n\n> quoted\n\ntail";

      for (const range of analyse(doc, parked(doc)).ranges) {
        expect(range.to).toBeGreaterThan(range.from);
      }
    });
  });
});
