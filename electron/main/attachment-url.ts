// electron/main/attachment-url.ts
// The app-media:// URL seam: building attachment URLs and turning a request URL back
// into an absolute path on disk.
//
// Deliberately free of Electron imports so the traversal guard is unit-testable in Vitest.
// `node:path` only — no filesystem access either, so this module never touches the disk.

import path from "node:path";
import { ATTACHMENT_IMAGE_EXTENSIONS } from "../../src/shared/types.ts";
import type { TodoAttachmentKind } from "../../src/shared/types.ts";

/** Scheme name as `registerSchemesAsPrivileged` and `protocol.handle` want it — no colon. */
export const ATTACHMENT_SCHEME_NAME = "app-media";

/** The same scheme as `URL.protocol` reports it — with the colon. */
export const ATTACHMENT_SCHEME = `${ATTACHMENT_SCHEME_NAME}:`;

/**
 * The host segment of every attachment URL.
 *
 * With `standard: true` the URL parses as `app-media://<host>/<path>`, so this is the HOST,
 * not the first path segment. Reading it as a path segment is the classic bug here.
 */
export const ATTACHMENT_HOST = "attachments";

/** Used when the original file name carries no extension we are willing to serve. */
export const ATTACHMENT_FALLBACK_EXT = "bin";

/**
 * The only basenames the protocol handler will serve: a 64-character lower-case sha256
 * followed by a short lower-case extension. This allowlist is the strong guard; the
 * baseDir prefix check in `resolveAttachmentPath` is the backstop.
 */
const BASENAME_PATTERN = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

const EXT_PATTERN = /^[a-z0-9]{1,8}$/;

const IMAGE_EXTENSIONS = new Set<string>(ATTACHMENT_IMAGE_EXTENSIONS);

/**
 * Normalises the extension of a user-supplied file name into the suffix used on disk.
 *
 * Falls back to `bin` for anything the basename allowlist would refuse — no extension,
 * a trailing dot, a dotfile, non-ASCII, or an implausibly long suffix. Both the store and
 * the database row builder go through here, so the on-disk name and the URL always agree.
 */
export function extFromFileName(fileName: string): string {
  const raw = path.extname(fileName).replace(/^\./, "").toLowerCase();
  return EXT_PATTERN.test(raw) ? raw : ATTACHMENT_FALLBACK_EXT;
}

/** Whether an attachment renders inline as an image or as a document row. */
export function attachmentKindForExt(ext: string): TodoAttachmentKind {
  return IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
}

/** `app-media://attachments/<sha256>.<ext>` — ready for an `<img src>` or a markdown embed. */
export function attachmentUrl(sha256: string, ext: string): string {
  const normalised = ext.replace(/^\./, "").toLowerCase();
  return `${ATTACHMENT_SCHEME}//${ATTACHMENT_HOST}/${sha256}.${normalised}`;
}

/** The on-disk basename for a stored blob. Content-addressed, so the user's name never reaches a path. */
export function attachmentFileName(sha256: string, ext: string): string {
  return `${sha256}.${ext.replace(/^\./, "").toLowerCase()}`;
}

/**
 * Resolves an `app-media://` request URL to an absolute path inside `baseDir`, or `null`.
 *
 * Returns `null` unless every one of these holds:
 * 1. the scheme is `app-media:`;
 * 2. the host is exactly `attachments`;
 * 3. the decoded path is a single basename matching `<64 hex>.<ext>`;
 * 4. the resolved absolute path still sits under `baseDir`.
 *
 * The decode in step 3 is what makes `%2e%2e%2f` and `%2f` dangerous, which is exactly why
 * the allowlist is applied after decoding rather than before.
 */
export function resolveAttachmentPath(requestUrl: string, baseDir: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  if (url.protocol !== ATTACHMENT_SCHEME) return null;
  if (url.host !== ATTACHMENT_HOST) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent escape. Nothing legitimate produces one.
    return null;
  }

  const name = decoded.replace(/^\/+/, "");
  if (!BASENAME_PATTERN.test(name)) return null;

  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(root + path.sep)) return null;

  return resolved;
}
