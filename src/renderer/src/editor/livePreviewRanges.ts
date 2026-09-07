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
 * - `line` attaches `markClass` to the whole line at `from` (`Decoration.line`). Layout only --
 *   nothing about it is hidden syntax, so unlike every other kind it applies regardless of
 *   cursor ownership, and its `to` carries no meaning (always equal to `from`).
 * - `widget` swaps the range for `widgetText` inside a span carrying `markClass`, for an image
 *   when `widgetSrc` is set, for a checkbox when `widgetChecked` is set, or for a whole table
 *   when `widgetTable` is set.
 */
export type PreviewRangeKind = "hide" | "mark" | "line" | "widget";

export interface PreviewRange {
  from: number;
  to: number;
  kind: PreviewRangeKind;
  /** Set for `mark`, `line` and `widget`. */
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
  /**
   * Set only for a task-list checkbox `widget`, carrying its checked state. The plugin builds
   * the one widget in this feature that edits the document from this field.
   */
  widgetChecked?: boolean;
  /**
   * Set only for a table `widget`, replacing the whole `Table` node. Parsed from lezer's own
   * `TableHeader` / `TableDelimiter` / `TableRow` / `TableCell` nodes, never by regex over the
   * raw text -- the one exception is the alignment delimiter row, which lezer hands back as a
   * single opaque node with no per-cell breakdown, so splitting that one row's own text is the
   * only lezer-respecting option there is. Its presence is also what tells the plugin to use a
   * block-shaped replace decoration, since a table may span several lines.
   */
  widgetTable?: PreviewTable;
}

/** The parsed shape of a GFM table, ready for `TableWidget` to render as a real `<table>`. */
export interface PreviewTable {
  header: string[];
  align: Array<"left" | "center" | "right" | null>;
  rows: string[][];
}

/** A half-open document window. Matches the shape of `EditorView.visibleRanges` entries. */
export interface DocRange {
  from: number;
  to: number;
}

/**
 * Longest block a construct may span and still be replaced. Applies to fenced code and to
 * tables.
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

  if (name === "Table") {
    table(ctx, ref.node);
    // Never descend: a table's cells are rendered as plain text by `TableWidget`, not
    // re-decorated inline, and there is no half-rendered table the way a link keeps its label.
    return false;
  }

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
  if (name === "ListItem") {
    listItemIndent(ctx, ref.node);
    return true;
  }
  if (name === "Task") {
    task(ctx, ref.node);
    // Continues descending: the GFM parser hands the item's remaining text back through the
    // normal inline parsers, so `**bold**` after a checkbox still needs its own pass here.
    return true;
  }
  if (name === "TaskMarker") {
    // Already consumed by `task()`, as part of its parent -- it has no children of its own.
    return false;
  }
  if (name === "Link") {
    link(ctx, ref.node);
    return true;
  }
  if (name === "Autolink") {
    // `<https://x.com>` -- GFM's bracketed autolink, which (unlike the bare form below) is a
    // real node of its own, sharing its shape with the generic HTML-tag parser: LinkMark, URL,
    // LinkMark. Verified against the real parser output before writing this, not assumed.
    bracketedAutolink(ctx, ref.node);
    return false;
  }
  if (name === "URL") {
    // The bare form (`https://x.com`, `www.x.com`) parses as a lone URL node with no wrapping
    // "Autolink" node at all -- confirmed by reading `@lezer/markdown`'s GFM Autolink extension,
    // which only ever calls `cx.addElement(elt("URL", ...))`. A URL that is a direct child of
    // Link or Image is a different thing entirely (the destination of `[text](url)`), already
    // fully handled by `link()`/`image()`, and must not be touched again here.
    const parent = ref.node.parent;
    if (parent !== null && (parent.name === "Link" || parent.name === "Image")) return true;
    bareAutolink(ctx, ref.node);
    return false;
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

/** `<https://x.com>` -- hides the angle brackets, marks the URL between them. */
function bracketedAutolink(ctx: WalkContext, node: SyntaxNode): void {
  if (ownedByCursor(ctx, node.from, node.to)) return;

  const url = childrenNamed(node, "URL")[0];
  if (url === undefined) return;
  if (!isAllowedUrl(ctx.state.doc.sliceString(url.from, url.to))) return;

  const marks = childrenNamed(node, "LinkMark");
  const open = marks[0];
  const close = marks[1];
  if (open === undefined || close === undefined) return;

  push(ctx, { from: open.from, to: open.to, kind: "hide" });
  push(ctx, { from: open.to, to: close.from, kind: "mark", markClass: "cm-md-link" });
  push(ctx, { from: close.from, to: close.to, kind: "hide" });
}

/**
 * `https://x.com`, `www.x.com` -- bare, unbracketed. The URL is its own label, so there is
 * nothing to hide; only the allowlist stands between this and a live `javascript:` link, except
 * that GFM's bare-autolink grammar only ever matches `www.`/`http(s)://`/`mailto:`/`xmpp:`/an
 * email address in the first place, so a bare `javascript:` never reaches this function at all --
 * only the bracketed form above can carry an arbitrary scheme.
 */
function bareAutolink(ctx: WalkContext, node: SyntaxNode): void {
  if (ownedByCursor(ctx, node.from, node.to)) return;
  if (!isAllowedUrl(ctx.state.doc.sliceString(node.from, node.to))) return;
  push(ctx, { from: node.from, to: node.to, kind: "mark", markClass: "cm-md-link" });
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

/**
 * A GFM table, replaced whole by `TableWidget` when the cursor is off every one of its lines.
 *
 * The shape lezer hands back: a `TableHeader` (per-cell `TableDelimiter`/`TableCell` pairs), one
 * raw `TableDelimiter` node carrying the entire alignment row as opaque text, then zero or more
 * `TableRow` nodes shaped like the header. Verified against the real parser output before
 * writing this, not assumed.
 */
function table(ctx: WalkContext, node: SyntaxNode): void {
  const span = lineSpanOf(ctx.state, node.from, node.to);
  if (span.last - span.first + 1 > MAX_BLOCK_LINES) return;
  if (touchesRevealed(ctx, span)) return;

  const headerNode = node.firstChild;
  if (headerNode === null || headerNode.name !== "TableHeader") return;
  const header = cellsOf(ctx.state, headerNode);

  const delimiterNode = headerNode.nextSibling;
  const align = delimiterNode !== null && delimiterNode.name === "TableDelimiter"
    ? tableAlignment(ctx.state.doc.sliceString(delimiterNode.from, delimiterNode.to))
    : header.map(() => null);

  const rows: string[][] = [];
  for (let child = delimiterNode?.nextSibling ?? null; child !== null; child = child.nextSibling) {
    if (child.name === "TableRow") rows.push(normalizeRow(cellsOf(ctx.state, child), align.length));
  }

  push(ctx, {
    from: tableRangeFrom(ctx.state, node),
    to: node.to,
    kind: "widget",
    markClass: "cm-md-table",
    widgetTable: { header, align, rows },
  });
}

/**
 * `Table.from` starts right after any leading indentation, which otherwise leaves an orphan raw
 * line above the rendered table -- the line's own whitespace with nothing visibly attached to
 * it. Only widen when that gap is pure whitespace: a blockquoted table's gap is `"> "`, already
 * hidden by `quoteMark()`'s own range, and widening here too would start at the same position
 * and collide with it.
 */
function tableRangeFrom(state: EditorState, node: SyntaxNode): number {
  const line = state.doc.lineAt(node.from);
  if (line.from === node.from) return node.from;
  const prefix = state.doc.sliceString(line.from, node.from);
  return /^\s*$/.test(prefix) ? line.from : node.from;
}

/**
 * The text of every column in a `TableHeader` or `TableRow`, rebuilt positionally.
 *
 * lezer emits no `TableCell` node for an empty cell -- two adjacent `TableDelimiter` nodes with
 * nothing between them -- so collecting only `TableCell` children (as a plain `childrenNamed`
 * call would) silently drops it and every later column shifts one to the left of where
 * `tableAlignment` puts it. Walking the row's own children in document order and emitting `""`
 * whenever a delimiter directly follows another delimiter -- which also catches a leading or a
 * trailing gap, not just one in the middle -- keeps the cell count in agreement with the
 * alignment row's. Verified against the real parser output before writing this, not assumed.
 */
function cellsOf(state: EditorState, row: SyntaxNode): string[] {
  const cells: string[] = [];
  let previousWasDelimiter = false;
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableDelimiter") {
      if (previousWasDelimiter) cells.push("");
      previousWasDelimiter = true;
      continue;
    }
    if (child.name === "TableCell") {
      cells.push(unescapePipe(state.doc.sliceString(child.from, child.to).trim()));
      previousWasDelimiter = false;
    }
  }
  return cells;
}

/**
 * `x \| y` -- GFM lets a pipe be escaped so it does not end the cell there; the backslash itself
 * is never part of the rendered text.
 */
function unescapePipe(text: string): string {
  return text.replace(/\\\|/g, "|");
}

/** Pads a short body row with empty cells, or drops a long row's extra ones -- the GFM rule for
 * a row whose column count does not match the header's. */
function normalizeRow(cells: string[], length: number): string[] {
  if (cells.length === length) return cells;
  if (cells.length > length) return cells.slice(0, length);
  return cells.concat(new Array<string>(length - cells.length).fill(""));
}

/**
 * Column alignment from the raw text of the delimiter row (`| :- | :-: | -: |`).
 *
 * lezer hands this row back as one opaque node with no per-cell children, unlike every other
 * table row -- splitting its own text by `|` is the only option that respects lezer's own node
 * boundaries rather than re-parsing markdown by hand. The syntax has no escaping to worry about:
 * a delimiter cell is only ever `-`, `:` and whitespace.
 */
function tableAlignment(raw: string): Array<"left" | "center" | "right" | null> {
  const trimmed = raw.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailingPipe = body.endsWith("|") ? body.slice(0, -1) : body;

  return withoutTrailingPipe.split("|").map((cell) => {
    const value = cell.trim();
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
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

/** Deepest nesting level that still gets its own class; anything past this reuses the last one. */
const MAX_LIST_DEPTH = 6;

/**
 * Hanging indent for a nested list item: one `cm-md-li-depth-N` line class per line the item
 * owns directly, not counting a nested sublist's own lines (that sublist's `ListItem`s get their
 * own, deeper classes when the walk reaches them).
 *
 * Unlike everything else in this file, this applies regardless of cursor ownership. Every other
 * "reveal raw on the cursor's line" rule exists to un-hide collapsed *syntax* -- indentation is
 * layout, not syntax, so hiding it while the cursor sits on the line would make the line jump
 * sideways on every keystroke, which is worse than always showing it.
 */
function listItemIndent(ctx: WalkContext, node: SyntaxNode): void {
  const depth = Math.min(listDepth(node), MAX_LIST_DEPTH);
  const first = ctx.state.doc.lineAt(node.from).number;

  // A nested sublist always opens at the start of its own line -- a list marker cannot begin
  // mid-line -- so that whole line belongs to the sublist, never to this item's own content,
  // even though the marker itself sits a few indent columns in. Excluding it by line number
  // rather than by character offset is what keeps that line from also being pushed as this
  // item's own last line and getting double-counted at two depths.
  const nestedFrom = firstNestedListFrom(node);
  const last = nestedFrom !== undefined
    ? ctx.state.doc.lineAt(nestedFrom).number - 1
    : ctx.state.doc.lineAt(clamp(node.to - 1, node.from, node.to)).number;
  if (last < first) return;

  for (let n = first; n <= last; n++) {
    const line = ctx.state.doc.line(n);
    push(ctx, { from: line.from, to: line.from, kind: "line", markClass: `cm-md-li-depth-${depth}` });
  }
}

/** How many `BulletList`/`OrderedList` ancestors (inclusive of none) own this item. */
function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let current: SyntaxNode | null = node; current !== null; current = current.parent) {
    if (current.name === "BulletList" || current.name === "OrderedList") depth += 1;
  }
  return depth;
}

/** The start of the item's first direct child sublist, if it has one. */
function firstNestedListFrom(node: SyntaxNode): number | undefined {
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "BulletList" || child.name === "OrderedList") return child.from;
  }
  return undefined;
}

/**
 * A GFM task-list item: `- [ ] text` or `- [x] text`.
 *
 * The marker itself becomes a real `<input type="checkbox">` -- the one widget in this feature
 * that edits the document, wired up in `TaskCheckboxWidget`. A checked item's remaining text
 * gets `cm-md-task-done` so it reads as struck through; this module only decides that it should,
 * never how it looks.
 */
function task(ctx: WalkContext, node: SyntaxNode): void {
  const owner = ancestorNamed(node, "ListItem") ?? node;
  if (ownedByCursor(ctx, owner.from, owner.to)) return;

  const marker = childrenNamed(node, "TaskMarker")[0];
  if (marker === undefined) return;

  const markerText = ctx.state.doc.sliceString(marker.from, marker.to);
  const checked = markerText === "[x]" || markerText === "[X]";

  // The space after the marker goes with it, or the item text renders with a leading indent --
  // the same rule `heading()` follows for the space after `#`.
  const contentFrom = withTrailingSpace(ctx.state, marker.to);
  push(ctx, { from: marker.from, to: contentFrom, kind: "widget", markClass: "cm-md-task", widgetChecked: checked });

  if (checked && contentFrom < node.to) {
    push(ctx, { from: contentFrom, to: node.to, kind: "mark", markClass: "cm-md-task-done" });
  }
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
  // A `line` range is a point at the line's start, not a span -- `to` carries no meaning for it,
  // so the "must be non-empty" and "must not cross a line break" rules below do not apply.
  if (range.kind === "line") {
    ctx.out.push(range);
    return;
  }

  if (range.to <= range.from) return;
  // CodeMirror refuses an INLINE replace decoration that spans a line break, and throws rather
  // than dropping it. `mark` has no such restriction, which is what lets a fence or a
  // blockquote carry one span across its whole block -- and neither does a BLOCK replace, which
  // is what a table becomes in the plugin precisely so it can cross one here.
  const crossesLinesOk = range.kind === "mark" || range.widgetTable !== undefined;
  if (!crossesLinesOk && !onOneLine(ctx.state, range.from, range.to)) return;
  ctx.out.push(range);
}

function onOneLine(state: EditorState, from: number, to: number): boolean {
  const span = lineSpanOf(state, from, to);
  return span.first === span.last;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/**
 * Two overlapping visible windows visit a straddling node twice. Sorted, the copies adjoin.
 * Exported for direct testing of `isSameRange`'s field coverage, which is otherwise only
 * reachable by engineering a real overlapping-window walk.
 */
export function dropRepeats(ranges: PreviewRange[]): PreviewRange[] {
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
    && a.widgetSrc === b.widgetSrc
    && a.widgetChecked === b.widgetChecked
    && sameTable(a.widgetTable, b.widgetTable);
}

/**
 * Structural comparison, not `===` -- two straddling visible windows build two distinct
 * `PreviewTable` objects for the same table, and without this `dropRepeats` would keep both.
 * Exported so `TableWidget.eq` shares the one implementation rather than a second copy that
 * could drift from it.
 */
export function sameTable(a: PreviewTable | undefined, b: PreviewTable | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return sameArray(a.header, b.header)
    && sameArray(a.align, b.align)
    && a.rows.length === b.rows.length
    && a.rows.every((row, index) => sameArray(row, b.rows[index] ?? []));
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
