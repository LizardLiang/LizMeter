// Tests for the app-media:// URL seam.
// Pure module — no Electron, no database, no filesystem.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentUrl, extFromFileName, resolveAttachmentPath } from "../attachment-url.ts";

const SHA = "a".repeat(64);
const BASE_DIR = path.join(path.sep === "\\" ? "C:\\Users\\test\\AppData\\LizMeter" : "/home/test/LizMeter", "attachments");

// --- attachmentUrl ----------------------------------------------------------

describe("attachmentUrl", () => {
  it("puts `attachments` in the host position", () => {
    const url = attachmentUrl(SHA, "png");
    expect(url).toBe(`app-media://attachments/${SHA}.png`);
    expect(new URL(url).host).toBe("attachments");
  });

  it("normalises a leading dot and upper case in the extension", () => {
    expect(attachmentUrl(SHA, ".PNG")).toBe(`app-media://attachments/${SHA}.png`);
  });
});

// --- extFromFileName --------------------------------------------------------

describe("extFromFileName", () => {
  it("lower-cases the extension", () => {
    expect(extFromFileName("Screenshot.PNG")).toBe("png");
  });

  it("falls back to bin when there is no usable extension", () => {
    expect(extFromFileName("screenshot")).toBe("bin");
    expect(extFromFileName("archive.")).toBe("bin");
    expect(extFromFileName(".gitignore")).toBe("bin");
    expect(extFromFileName("weird.名前")).toBe("bin");
    expect(extFromFileName("long.extensionlonger")).toBe("bin");
  });

  it("keeps a normal document extension", () => {
    expect(extFromFileName("design notes (final).pdf")).toBe("pdf");
  });
});

// --- resolveAttachmentPath: rejections --------------------------------------

describe("resolveAttachmentPath rejections", () => {
  it("returns null for a wrong host", () => {
    expect(resolveAttachmentPath(`app-media://evil/${SHA}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null when `attachments` is a path segment instead of the host", () => {
    // The classic bug: with standard:true this parses as host `` and path `/attachments/...`.
    expect(resolveAttachmentPath(`app-media:///attachments/${SHA}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for a `../` traversal", () => {
    expect(resolveAttachmentPath("app-media://attachments/../../secret.png", BASE_DIR)).toBeNull();
  });

  it("returns null for a URL-encoded `%2e%2e%2f` traversal", () => {
    expect(resolveAttachmentPath("app-media://attachments/%2e%2e%2f%2e%2e%2fsecret.png", BASE_DIR)).toBeNull();
  });

  it("returns null for an encoded-slash subdirectory", () => {
    expect(resolveAttachmentPath(`app-media://attachments/sub%2f${SHA}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for a non-hex basename", () => {
    expect(resolveAttachmentPath(`app-media://attachments/${"z".repeat(64)}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for an upper-case hex basename", () => {
    expect(resolveAttachmentPath(`app-media://attachments/${"A".repeat(64)}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for a too-short hex basename", () => {
    expect(resolveAttachmentPath(`app-media://attachments/${"a".repeat(63)}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for a missing extension", () => {
    expect(resolveAttachmentPath(`app-media://attachments/${SHA}`, BASE_DIR)).toBeNull();
    expect(resolveAttachmentPath(`app-media://attachments/${SHA}.`, BASE_DIR)).toBeNull();
  });

  it("returns null for an absolute Windows path", () => {
    expect(resolveAttachmentPath("app-media://attachments/C:/Windows/win.ini", BASE_DIR)).toBeNull();
    expect(resolveAttachmentPath("app-media://attachments/C%3A%5CWindows%5Cwin.ini", BASE_DIR)).toBeNull();
  });

  it("returns null for a backslash traversal", () => {
    expect(resolveAttachmentPath(`app-media://attachments/..%5C..%5C${SHA}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for a foreign scheme", () => {
    expect(resolveAttachmentPath(`file://attachments/${SHA}.png`, BASE_DIR)).toBeNull();
    expect(resolveAttachmentPath(`https://attachments/${SHA}.png`, BASE_DIR)).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(resolveAttachmentPath("not a url at all", BASE_DIR)).toBeNull();
  });

  it("returns null for a malformed percent escape", () => {
    expect(resolveAttachmentPath(`app-media://attachments/%E0%A4%A${SHA}.png`, BASE_DIR)).toBeNull();
  });
});

// --- resolveAttachmentPath: acceptance --------------------------------------

describe("resolveAttachmentPath acceptance", () => {
  it("returns a path inside baseDir for a valid URL", () => {
    const resolved = resolveAttachmentPath(attachmentUrl(SHA, "png"), BASE_DIR);

    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith(path.resolve(BASE_DIR) + path.sep)).toBe(true);
    expect(path.basename(resolved!)).toBe(`${SHA}.png`);
  });

  it("ignores a query string and a fragment", () => {
    const resolved = resolveAttachmentPath(`app-media://attachments/${SHA}.webp?v=2#top`, BASE_DIR);

    expect(resolved).not.toBeNull();
    expect(path.basename(resolved!)).toBe(`${SHA}.webp`);
  });

  it("accepts every allowed extension shape", () => {
    for (const ext of ["png", "jpeg", "pdf", "7z", "docx"]) {
      const resolved = resolveAttachmentPath(attachmentUrl(SHA, ext), BASE_DIR);
      expect(path.basename(resolved!)).toBe(`${SHA}.${ext}`);
    }
  });
});
