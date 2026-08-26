// livePreviewRanges.ts
// The testable seam of the live-preview editor, and the reason the feature is tractable.
//
// Every decision live preview makes -- which markdown syntax disappears, which text gets a
// class, and above all when the cursor "owns" a construct and reveals its raw source -- is
// made here, in a module that never imports `EditorView`. `EditorState` is headless, so this
// runs in Vitest without a DOM. `livePreviewPlugin.ts` is a thin adapter that turns the plain
// descriptors below into CodeMirror decorations and nothing more.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, SelectionRange } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { isAllowedUrl } from "./urlSchemes.ts";

/**
 * - `hide` collapses the range to nothing (`Decoration.replace({})`).
 * - `mark` wraps the range in a span carrying `markClass` (`Decoration.mark`).
 * - `widget` swaps the range for `widgetText` inside a span carrying `markClass`, or for an
 *   image when `widgetSrc` is set.
 */
export type PreviewRangeKind = "hide" | "mark" | "widget";

export interface PreviewRange {
  from: number;
  to: number;
  kind: PreviewRangeKind;
  /** Set for `mark` and `widget`. */
  markClass?: string;
  /** Set for `widget`. Empty means the widget is drawn purely by CSS, as the rule is. */
  widgetText?: string;
  /**
   * Set only for an image `widget`, and carrying its destination. Its presence is what makes
   * the plugin build an `<img>` instead of a text widget, so an image needs no separate kind
   * and inherits every rule the existing widgets already follow -- above all its place in
   * `atomicRanges`. The URL has passed `isAllowedUrl` before it is set here.
   */
  widgetSrc?: string;
}

/** A half-open document window. Matches the shape of `EditorView.visibleRanges` entries. */
export interface DocRange {
  from: number;
  to: number;
}

/**
 * Longest block a construct may span and still be replaced.
 *
 * An unterminated ``` makes lezer treat everything after it as one `FencedCode` node. Without
 * this cap, typing three backticks would visibly swallow the rest of the note into a code
 * block. Past the cap the block renders as raw source instead.
 */
export const MAX_BLOCK_LINES = 200;

const HEADING_PREFIX = "ATXHeading";

/** Constructs shaped `<mark>content<mark>`, which is most of Tier 1. */
const INLINE_DELIMITED: Record<string, { markName: string; className: string; } | undefined> = {
  StrongEmphasis: { markName: "EmphasisMark", className: "cm-md-strong" },
  Emphasis: { markName: "EmphasisMark", className: "cm-md-em" },
  InlineCode: { markName: "CodeMark", className: "cm-md-code" },
  Strikethrough: { markName: "StrikethroughMark", className: "cm-md-strike" },
};

/** An inclusive run of line numbers, 1-based to match `Line.number`. */
interface LineSpan {
  first: number;
  last: number;
}

interface WalkContext {
  state: EditorState;
  revealed: LineSpan[];
  out: PreviewRange[];
}

/**
 * Describes how the document should render around the given selection.
 *
 * @param state  Any `EditorState` carrying a markdown language. GFM is expected: without it
 *               there is no `Strikethrough` node and `~~gone~~` is never decorated.
 * @param ranges The selection ranges. Every line they touch renders as raw source.
 * @param visible Windows to walk, normally `EditorView.visibleRanges`. Defaults to the whole
 *               document, which is correct but is not what the plugin passes -- re-walking a
 *               32,000-character note on every keystroke is what makes live preview feel slow.
 */
export function livePreviewRanges(
  state: EditorState,
  ranges: readonly SelectionRange[],
  visible?: readonly DocRange[],
): PreviewRange[] {
  const length = state.doc.length;
  if (length === 0) return [];

  const ctx: WalkContext = { state, revealed: revealedLines(state, ranges), out: [] };
  const tree = syntaxTree(state);
  const windows = visible === undefined || visible.length === 0 ? [{ from: 0, to: length }] : visible;

  for (const window of windows) {
    const from = clamp(window.from, 0, length);
    const to = clamp(window.to, from, length);
    if (to <= from) continue;
    tree.iterate({ from, to, enter: (node) => enterNode(ctx, node) });
  }

  ctx.out.sort((a, b) => a.from - b.from || a.to - b.to);
  return dropRepeats(ctx.out);
}

// ── The walk ──

function enterNode(ctx: WalkContext, ref: SyntaxNodeRef): boolean {
  const name = ref.name;

  // GFM tables are cut from v1 and stay as raw source.
  if (name === "Table") return false;

  // Never descend into an image. Its alt text is about to be replaced wholesale, so decorating
  // emphasis inside it is wasted, and the link handler would otherwise treat the image's own
  // `](url)` tail as a link of its own.
  if (name === "Image") {
    image(ctx, ref.node);
    return false;
  }

  if (name === "FencedCode") {
    fencedCode(ctx, ref.node);
    return false;
  }
  if (name === "HorizontalRule") {
    horizontalRule(ctx, ref);
    return false;
  }
  if (name === "Blockquote") {
    blockquote(ctx, ref);
    return true;
  }
  if (name === "QuoteMark") {
    quoteMark(ctx, ref.node);
    return false;
  }
  if (name === "ListMark") {
    listMark(ctx, ref.node);
    return false;
  }
  if (name === "Link") {
    link(ctx, ref.node);
    return true;
  }
  if (name.startsWith(HEADING_PREFIX)) {
    heading(ctx, ref.node, name);
    return true;
  }

  const delimited = INLINE_DELIMITED[name];
  if (delimited !== undefined) inlineDelimited(ctx, ref.node, delimited.markName, delimited.className);
  return true;
}

// ── Tier 1: inline constructs ──

function inlineDelimited(ctx: WalkContext, node: SyntaxNode, markName: string, className: string): void {
  if (ownedByCursor(ctx, node.from, node.to)) return;

  const marks = childrenNamed(node, markName);
  if (marks.length < 2) return;
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (open === undefined || close === undefined || close.from <= open.to) return;

  for (const mark of marks) push(ctx, { from: mark.from, to: mark.to, kind: "hide" });
  push(ctx, { from: open.to, to: close.from, kind: "mark", markClass: className });
}

function heading(ctx: WalkContext, node: SyntaxNode, name: string): void {
  if (ownedByCursor(ctx, node.from, node.to)) return;

  const level = Number(name.slice(HEADING_PREFIX.length));
  if (!Number.isInteger(level) || level < 1 || level > 6) return;

  const marks = childrenNamed(node, "HeaderMark");
  const open = marks[0];
  if (open === undefined) return;

  // The space after the hashes goes with them, or the heading renders with a leading indent.
  const contentFrom = withTrailingSpace(ctx.state, open.to);
  push(ctx, { from: open.from, to: contentFrom, kind: "hide" });

  let contentTo = node.to;
  const close = marks.length > 1 ? marks[marks.length - 1] : undefined;
  if (close !== undefined) {
    // `## Closed heading ##` -- swallow the trailing hashes and the space before them.
    contentTo = close.from;
    while (contentTo > contentFrom && ctx.state.doc.sliceString(contentTo - 1, contentTo) === " ") contentTo -= 1;
    push(ctx, { from: contentTo, to: close.to, kind: "hide" });
  }

  push(ctx, { from: contentFrom, to: contentTo, kind: "mark", markClass: `cm-md-h${level}` });
}

function link(ctx: WalkContext, node: SyntaxNode): void {
  if (ownedByCursor(ctx, node.from, node.to)) return;
  // CommonMark allows a newline between `](` and the destination. The closing hide would then
  // cross a line break and be dropped, leaving `[` hidden and `](\nurl)` on screen. All or
  // nothing is the better render.
  if (!onOneLine(ctx.state, node.from, node.to)) return;

  // Reference and shortcut links (`[label][ref]`, `[label]`) carry no destination to check
  // here, so they stay raw rather than being rendered against an unverified target.
  const url = childrenNamed(node, "URL")[0];
  if (url === undefined) return;
  if (!isAllowedUrl(ctx.state.doc.sliceString(url.from, url.to))) return;

  const marks = childrenNamed(node, "LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (open === undefined || close === undefined) return;
  // `[](url)` has no label, so hiding every mark would erase the construct from the screen.
  if (close.from <= open.to) return;

  push(ctx, { from: open.from, to: open.to, kind: "hide" });
  push(ctx, { from: open.to, to: close.from, kind: "mark", markClass: "cm-md-link" });
  push(ctx, { from: close.from, to: node.to, kind: "hide" });
}

/**
 * Replaces the whole of `![alt](url)` with an image.
 *
 * The construct goes as a unit -- there is no half-rendered image the way a link keeps its
 * label -- so a destination this module will not vouch for leaves the entire source on screen
 * rather than rendering an image with the address stripped off.
 *
 * A destination spanning a line break (`![alt](\nurl)`, legal CommonMark) is dropped by `push`,
 * because a replace decoration from a view plugin may not cross one. Raw source is the render.
 */
function image(ctx: WalkContext, node: SyntaxNode): void {
  if (ownedByCursor(ctx, node.from, node.to)) return;

  // Reference (`![alt][ref]`) and empty (`![alt]()`) images carry no destination to check.
  // The second shape is also the in-flight upload placeholder, whose text is the whole point.
  const url = childrenNamed(node, "URL")[0];
  if (url === undefined) return;

  const destination = destinationOf(ctx.state, url);
  if (!isAllowedUrl(destination)) return;

  // Everything between `![` and `]`. Taken as raw source rather than from the child nodes,
  // because `![a **b**](url)` has an alt of `a **b**` and an `<img alt>` is plain text.
  const marks = childrenNamed(node, "LinkMark");
  const open = marks[0];
  const closeLabel = marks[1];
  const alt = open !== undefined && closeLabel !== undefined && closeLabel.from >= open.to
    ? ctx.state.doc.sliceString(open.to, closeLabel.from)
    : "";

  push(ctx, {
    from: node.from,
    to: node.to,
    kind: "widget",
    markClass: "cm-md-image",
    widgetText: alt,
    widgetSrc: destination,
  });
}

/**
 * The address inside a `URL` node.
 *
 * CommonMark allows `](<dest with spaces>)`, and lezer keeps the angle brackets inside the
 * node, so they have to come off before the text is used as an `src`. A title is a separate
 * `LinkTitle` node and is already excluded.
 */
function destinationOf(state: EditorState, url: SyntaxNode): string {
  const raw = state.doc.sliceString(url.from, url.to).trim();
  return raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
}

// ── Tier 2: block constructs ──

function fencedCode(ctx: WalkContext, node: SyntaxNode): void {
  const span = lineSpanOf(ctx.state, node.from, node.to);
  if (span.last - span.first + 1 > MAX_BLOCK_LINES) return;
  if (touchesRevealed(ctx, span)) return;

  for (const mark of childrenNamed(node, "CodeMark")) {
    push(ctx, { from: mark.from, to: mark.to, kind: "hide" });
  }
  // The whole block, not per line: per-line toggling inside a fence tears visually. The info
  // string stays visible and inherits this class, which reads as the language label.
  push(ctx, { from: node.from, to: node.to, kind: "mark", markClass: "cm-md-fence" });
}

function blockquote(ctx: WalkContext, ref: SyntaxNodeRef): void {
  if (ownedByCursor(ctx, ref.from, ref.to)) return;
  push(ctx, { from: ref.from, to: ref.to, kind: "mark", markClass: "cm-md-quote" });
}

function quoteMark(ctx: WalkContext, node: SyntaxNode): void {
  // Ownership belongs to the enclosing block, so the cursor on any quoted line reveals the
  // markers on all of them rather than leaving a half-rendered quote.
  const owner = ancestorNamed(node, "Blockquote") ?? node;
  if (ownedByCursor(ctx, owner.from, owner.to)) return;
  push(ctx, { from: node.from, to: withTrailingSpace(ctx.state, node.to), kind: "hide" });
}

function listMark(ctx: WalkContext, node: SyntaxNode): void {
  const owner = ancestorNamed(node, "ListItem") ?? node;
  if (ownedByCursor(ctx, owner.from, owner.to)) return;

  const text = ctx.state.doc.sliceString(node.from, node.to);
  if (text === "-" || text === "*" || text === "+") {
    push(ctx, { from: node.from, to: node.to, kind: "widget", markClass: "cm-md-bullet", widgetText: "•" });
    return;
  }
  // An ordered marker is data the user typed. Styling it is the most that may be done to it.
  push(ctx, { from: node.from, to: node.to, kind: "mark", markClass: "cm-md-list-mark" });
}

function horizontalRule(ctx: WalkContext, ref: SyntaxNodeRef): void {
  if (ownedByCursor(ctx, ref.from, ref.to)) return;
  push(ctx, { from: ref.from, to: ref.to, kind: "widget", markClass: "cm-md-hr", widgetText: "" });
}

// ── Cursor ownership ──

/**
 * Ownership is line-level (assumption A-4, matching Obsidian): a construct reveals its raw
 * source when the selection touches any line it spans, not merely its own `[from, to]`. With
 * node-level ownership `**bold** and *italic*` reveals only one of the two and the line
 * visibly jitters as the cursor crosses it. For a multi-line block the same rule reads as
 * block-level ownership, which is exactly what fences and blockquotes need.
 */
function ownedByCursor(ctx: WalkContext, from: number, to: number): boolean {
  return touchesRevealed(ctx, lineSpanOf(ctx.state, from, to));
}

function touchesRevealed(ctx: WalkContext, span: LineSpan): boolean {
  for (const revealed of ctx.revealed) {
    // `revealed` is sorted, so once a run starts past this span nothing later can overlap.
    if (revealed.first > span.last) return false;
    if (revealed.last >= span.first) return true;
  }
  return false;
}

/** The selection's line runs, sorted and merged so `touchesRevealed` can stop early. */
function revealedLines(state: EditorState, ranges: readonly SelectionRange[]): LineSpan[] {
  const spans = ranges.map((range) => lineSpanOf(state, range.from, range.to));
  spans.sort((a, b) => a.first - b.first);

  const merged: LineSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && span.first <= previous.last + 1) {
      previous.last = Math.max(previous.last, span.last);
      continue;
    }
    merged.push({ first: span.first, last: span.last });
  }
  return merged;
}

function lineSpanOf(state: EditorState, from: number, to: number): LineSpan {
  const length = state.doc.length;
  return {
    first: state.doc.lineAt(clamp(from, 0, length)).number,
    last: state.doc.lineAt(clamp(to, 0, length)).number,
  };
}

// ── Small helpers ──

function childrenNamed(node: SyntaxNode, name: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) found.push(child);
  }
  return found;
}

function ancestorNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.name === name) return current;
  }
  return null;
}

function withTrailingSpace(state: EditorState, pos: number): number {
  return state.doc.sliceString(pos, pos + 1) === " " ? pos + 1 : pos;
}

function push(ctx: WalkContext, range: PreviewRange): void {
  if (range.to <= range.from) return;
  // CodeMirror refuses a replace decoration that spans a line break when it comes from a view
  // plugin, and throws rather than dropping it. `mark` has no such restriction, which is what
  // lets a fence or a blockquote carry one span across its whole block.
  if (range.kind !== "mark" && !onOneLine(ctx.state, range.from, range.to)) return;
  ctx.out.push(range);
}

function onOneLine(state: EditorState, from: number, to: number): boolean {
  const span = lineSpanOf(state, from, to);
  return span.first === span.last;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/** Two overlapping visible windows visit a straddling node twice. Sorted, the copies adjoin. */
function dropRepeats(ranges: PreviewRange[]): PreviewRange[] {
  const unique: PreviewRange[] = [];
  for (const range of ranges) {
    const previous = unique[unique.length - 1];
    if (previous !== undefined && isSameRange(previous, range)) continue;
    unique.push(range);
  }
  return unique;
}

function isSameRange(a: PreviewRange, b: PreviewRange): boolean {
  return a.from === b.from
    && a.to === b.to
    && a.kind === b.kind
    && a.markClass === b.markClass
    && a.widgetText === b.widgetText
    && a.widgetSrc === b.widgetSrc;
}
