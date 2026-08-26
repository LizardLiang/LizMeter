/**
 * Strips markdown syntax from `md` and returns a flattened, single-line plain-text summary.
 *
 * Used for HTML `title` tooltips where the raw markdown source (image embeds, links, emphasis
 * marks, etc.) would otherwise leak through verbatim, for example
 * `![screenshot](app-media://attachments/<64 hex chars>.png)` on a todo row hover.
 *
 * Pure string transformation, no DOM access, no dependencies. Degrades gracefully on malformed
 * markdown: it never throws, it simply leaves whatever it cannot confidently parse in place
 * before the final whitespace collapse.
 */
export function toPlainSummary(md: string, maxLen = 200): string {
  let text = md;

  // Fenced code blocks: keep the code text, drop the fence markers and an optional
  // language tag on the opening fence line (```js\ncode\n``` -> "code\n").
  text = text.replace(/```([\s\S]*?)```/g, (_match, inner: string) => {
    const newlineIndex = inner.indexOf("\n");
    if (newlineIndex === -1) return inner;
    const firstLine = inner.slice(0, newlineIndex);
    if (/^[A-Za-z0-9_+-]*$/.test(firstLine)) {
      return inner.slice(newlineIndex + 1);
    }
    return inner;
  });

  // Image embeds: ![alt](url) -> alt text, or nothing at all when alt is empty.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => alt);

  // Links: [text](url) -> text.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, (_match, label: string) => label);

  // Any remaining backticks (inline code, or an unclosed fence): drop the markers, keep the text.
  text = text.replace(/`+/g, "");

  // Heading prefixes, blockquote prefixes, and list markers, evaluated per line.
  text = text.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
  text = text.replace(/^[ \t]*(?:>[ \t]*)+/gm, "");
  text = text.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "");

  // Horizontal rules: a line made up entirely of 3+ -, *, or _ characters.
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");

  // Emphasis / strikethrough marks. Longest tokens first so `***x***` doesn't leave a stray `*`.
  text = text.replace(/(\*\*\*|___|\*\*|__|~~|\*|_)/g, "");

  // Collapse all whitespace runs (including newlines) to single spaces.
  text = text.replace(/\s+/g, " ").trim();

  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}
