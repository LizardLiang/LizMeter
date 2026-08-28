// electron/main/attachment-store.ts
// The filesystem half of todo attachments: writing content-addressed blobs into the
// `attachments` folder of the current data directory, and collecting them once nothing
// references them any more.
//
// No `ipcMain` here — the IPC surface lives in ipc-handlers.ts. URL shaping and the
// traversal guard live in attachment-url.ts, which stays free of Electron so it can be tested.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ATTACHMENT_MAX_BYTES } from "../../src/shared/types.ts";
import { attachmentFileName, extFromFileName } from "./attachment-url.ts";
import { ATTACHMENTS_DIR_NAME, getDataDir } from "./data-location.ts";
import { countAttachmentsBySha, listAllAttachmentShas } from "./database.ts";

/** Extensions refused outright. An SVG served from a privileged scheme is a needless surface. */
const BLOCKED_EXTENSIONS = new Set(["svg", "svgz"]);

export interface StoredBlob {
  /** Lower-case hex sha256 of the bytes. Also the on-disk basename. */
  sha256: string;
  /** The normalised extension actually used on disk. */
  ext: string;
  sizeBytes: number;
}

/**
 * The `attachments` folder inside the current data directory, created on first use.
 *
 * Reads the data directory on every call rather than caching it, so the folder follows the user
 * when they move their data. Never write into the data root itself — when the data still sits in
 * userData, Chromium reserves sibling folders there.
 */
export function getAttachmentsDir(): string {
  const dir = path.join(getDataDir(), ATTACHMENTS_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Writes bytes to `<sha256>.<ext>` and returns their identity.
 *
 * Content addressing means storing the same screenshot twice costs one file, and two todos
 * can share it safely. The price is refcounted deletion — see `deleteBlobIfUnreferenced`.
 *
 * Throws when the file is empty, over `ATTACHMENT_MAX_BYTES`, or carries a blocked extension.
 */
export function storeBuffer(data: Buffer, originalName: string): StoredBlob {
  if (data.length === 0) {
    throw new Error("Attachment is empty");
  }
  if (data.length > ATTACHMENT_MAX_BYTES) {
    const limitMb = Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024));
    throw new Error(`Attachment is larger than the ${limitMb} MB limit`);
  }

  const ext = extFromFileName(originalName);
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`${ext.toUpperCase()} attachments are not supported`);
  }

  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const target = path.join(getAttachmentsDir(), attachmentFileName(sha256, ext));
  // Already present means an identical blob — the bytes cannot differ, so skip the write.
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, data);
  }

  return { sha256, ext, sizeBytes: data.length };
}

/** Absolute path of a stored blob. Does not check that the file exists. */
export function attachmentPathFor(sha256: string, ext: string): string {
  return path.join(getAttachmentsDir(), attachmentFileName(sha256, ext));
}

/**
 * Deletes the blob for `sha256` only when no attachment row still references it.
 *
 * `ext` is optional because the callers that garbage-collect after a todo delete only carry
 * shas. Without it, every `<sha256>.*` file is removed instead of one named file.
 */
export function deleteBlobIfUnreferenced(sha256: string, ext?: string): void {
  if (countAttachmentsBySha(sha256) > 0) return;

  const dir = getAttachmentsDir();
  const names = ext === undefined
    ? safeReadDir(dir).filter((name) => name.startsWith(`${sha256}.`))
    : [attachmentFileName(sha256, ext)];

  for (const name of names) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      // A live <img> can hold a Windows file lock. Losing the race leaves an orphan that
      // sweepOrphanBlobs collects on the next start, so this is never worth failing over.
      console.warn("[attachments] could not delete blob", name, err);
    }
  }
}

/** Runs `deleteBlobIfUnreferenced` over a batch, de-duplicated. Used after a todo or bulk delete. */
export function collectAttachmentBlobs(shas: readonly string[]): void {
  for (const sha256 of new Set(shas)) {
    deleteBlobIfUnreferenced(sha256);
  }
}

/**
 * Deletes any file in the attachments folder that no row references.
 *
 * Called once from `app.whenReady()`. It is the only thing that cleans up after a crash
 * between the file write and the row insert.
 */
export function sweepOrphanBlobs(): void {
  let referenced: Set<string>;
  try {
    referenced = new Set(listAllAttachmentShas());
  } catch (err) {
    // A sweep is never worth blocking startup for.
    console.warn("[attachments] orphan sweep skipped:", err);
    return;
  }

  const dir = getAttachmentsDir();
  for (const name of safeReadDir(dir)) {
    const dot = name.indexOf(".");
    const sha = dot === -1 ? name : name.slice(0, dot);
    if (referenced.has(sha)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      console.warn("[attachments] could not sweep orphan", name, err);
    }
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
