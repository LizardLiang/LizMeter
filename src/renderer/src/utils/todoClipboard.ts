// Pure formatters behind the todo "copy" actions (Copy id, Copy agent prompt). Kept out of the
// components so the assembled markdown can be tested without rendering a menu, the same way
// todoTree.ts holds the nesting rules. No DOM, no clipboard call, no React here -- callers own
// writing the result to the clipboard.

/** The fields `formatTodoAgentPrompt` needs off the todo itself. */
export interface ClipboardTodo {
  id: number;
  title: string;
  notes: string | null;
}

/** The todo this one sits under, when it has one. */
export interface ClipboardParent {
  id: number;
  title: string;
}

/** One direct sub-issue row (one level, not the whole subtree). */
export interface ClipboardChild {
  id: number;
  title: string;
  stateLabel: string;
  isCompleted: boolean;
}

/** `#<id>`, the exact string the "Copy id" action puts on the clipboard. */
export function formatTodoId(id: number): string {
  return `#${id}`;
}

/**
 * Collapses any run of line breaks -- and the whitespace immediately around it -- to a single
 * space. Shared by two callers that each face the same hazard from a different direction:
 * - `formatTodoAgentPrompt` below, where a newline in the title would break the `# ${title}`
 *   heading. The MCP `todo_add`/`todo_update` schema only describes a single-line title, it does
 *   not enforce one, so an AI-agent write can still put a newline (or several) there.
 * - `TodoDetailPage`'s title field, a `<textarea>` that only wraps visually -- Enter never
 *   inserts a newline, but a paste can still smuggle one in.
 *
 * Lives here rather than in each caller (476f49a duplicated the whole copy-feedback timer this
 * same way, see `useCopyFeedback.ts`'s header comment) -- one regex, one behavior, everywhere a
 * title needs to render or auto-save as a single line.
 */
export function collapseLineBreaks(value: string): string {
  return value.replace(/\s*(?:\r\n|\r|\n)\s*/g, " ");
}

/**
 * True when `text` contains an odd number of ``` fence markers that start a line (leading
 * whitespace of up to 3 spaces still counts, matching how CommonMark itself recognizes an
 * indented fence) -- meaning a fence opened partway through never closes. A ``` that merely
 * appears mid-sentence is not a fence delimiter in markdown either, so it is not counted here.
 */
function hasUnbalancedFence(text: string): boolean {
  const fenceLines = text.split(/\r\n|\r|\n/).filter((line) => /^ {0,3}```/.test(line));
  return fenceLines.length % 2 !== 0;
}

/**
 * Markdown document for "Copy agent prompt": title, notes (verbatim, omitted when empty), the
 * parent (omitted when there is none), direct sub-issues (omitted when there are none), and a
 * trailing hint that always tells the reader how to look this todo up again through the
 * lizmeter-todo MCP server.
 *
 * No metadata header (project/state/priority/labels/due date) by design -- title + notes +
 * parent + sub-issues + the locate hint, nothing else.
 */
export function formatTodoAgentPrompt(
  todo: ClipboardTodo,
  parent: ClipboardParent | null,
  children: ClipboardChild[],
): string {
  const sections: string[] = [`# ${collapseLineBreaks(todo.title)}`];

  const notes = todo.notes?.trim() ?? "";
  if (notes.length > 0) {
    // An odd number of fence markers means a code fence in the notes was left open -- without
    // closing it here, every later section (Parent, Sub-issues, the locate hint) would render as
    // part of that one open code block instead of its own section.
    sections.push(hasUnbalancedFence(notes) ? `${notes}\n\`\`\`` : notes);
  }

  if (parent !== null) {
    sections.push(`## Parent\n${formatTodoId(parent.id)} ${parent.title}`);
  }

  if (children.length > 0) {
    const rows = children
      .map((child) =>
        // `child.stateLabel` can itself contain parens (e.g. "Blocked (external)"). Markdown only
        // gives `)` special meaning directly after a `]` (link syntax) -- outside that, a literal
        // `)` renders as plain text, so this is intentionally left unescaped.
        `- [${child.isCompleted ? "x" : " "}] ${formatTodoId(child.id)} ${child.title} (${child.stateLabel})`
      )
      .join("\n");
    sections.push(`## Sub-issues\n${rows}`);
  }

  sections.push(
    [
      "---",
      `This task is LizMeter todo ${formatTodoId(todo.id)}. Re-read it with the lizmeter-todo MCP server:`,
      `\`todo_list\` with \`id: ${todo.id}\`. List its sub-issues with \`todo_list\` and \`parentId: ${todo.id}\`.`,
      "Mark it done with `todo_complete`, or update it with `todo_update`.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}
