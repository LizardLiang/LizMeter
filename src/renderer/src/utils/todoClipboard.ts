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
  const sections: string[] = [`# ${todo.title}`];

  const notes = todo.notes?.trim() ?? "";
  if (notes.length > 0) {
    sections.push(notes);
  }

  if (parent !== null) {
    sections.push(`## Parent\n${formatTodoId(parent.id)} ${parent.title}`);
  }

  if (children.length > 0) {
    const rows = children
      .map((child) =>
        `- [${child.isCompleted ? "x" : " "}] ${formatTodoId(child.id)} ${child.title} (${child.stateLabel})`
      )
      .join("\n");
    sections.push(`## Sub-issues\n${rows}`);
  }

  sections.push(
    [
      "---",
      `This task is LizMeter todo ${formatTodoId(todo.id)}. To re-read it or check its sub-issues,`,
      `call the lizmeter-todo MCP server: \`todo_list\` with \`id: ${todo.id}\`.`,
      "Mark it done with `todo_complete`, or update it with `todo_update`.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}
