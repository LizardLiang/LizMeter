// urlSchemes.ts
// The one place that decides whether a markdown destination is safe to turn into a live
// element. Phase 3 uses it for `[text](url)`; Phase 8 reuses it for `![alt](url)` image
// widgets. Keeping it here rather than inline in the walker is deliberate -- a second copy of
// this predicate is how `[click](javascript:...)` eventually becomes clickable.

/**
 * Schemes a markdown destination may carry and still be rendered.
 *
 * `app-media:` is this app's own attachment scheme. `data:` is absent on purpose: a data URL
 * can carry an SVG document, and an SVG rendered from a privileged surface is script.
 */
export const ALLOWED_URL_SCHEMES = ["http:", "https:", "mailto:", "app-media:"] as const;

const ALLOWED = new Set<string>(ALLOWED_URL_SCHEMES);

/** RFC 3986 scheme grammar: an ASCII letter, then letters, digits, `+`, `-` or `.`. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

const SPACE = 0x20;
const DELETE = 0x7f;

/**
 * Drops control characters and whitespace. Browsers strip these before resolving a URL, which
 * is what makes `java\nscript:alert(1)` execute, so the scheme test has to strip them too or
 * the allowlist is bypassed by a single tab. Written as a loop rather than a character-class
 * regex so no literal control byte has to live in this file.
 */
function stripIgnored(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= SPACE || code === DELETE) continue;
    out += ch;
  }
  return out;
}

/**
 * True when a markdown link or image destination may be rendered as a live element.
 *
 * Relative references (`./notes.md`, `#anchor`) carry no scheme and cannot execute, so they
 * pass. Protocol-relative `//host/path` does not: it inherits the page's scheme, and inside a
 * packaged Electron renderer that scheme is `file:`.
 */
export function isAllowedUrl(raw: string): boolean {
  let candidate = raw.trim();
  // CommonMark allows `[x](<dest with spaces>)`, and lezer keeps the angle brackets in the URL
  // node, so they have to come off before the scheme is read.
  if (candidate.startsWith("<") && candidate.endsWith(">")) candidate = candidate.slice(1, -1);
  candidate = stripIgnored(candidate);

  if (candidate.length === 0) return false;
  if (candidate.startsWith("//")) return false;

  const match = SCHEME.exec(candidate);
  const scheme = match?.[1];
  // No scheme means a relative reference, which carries nothing that can execute.
  if (scheme === undefined) return true;
  return ALLOWED.has(`${scheme.toLowerCase()}:`);
}
