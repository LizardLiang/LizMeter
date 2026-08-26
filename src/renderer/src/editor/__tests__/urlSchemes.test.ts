// The allowlist is the only thing standing between `[click](javascript:...)` and a live
// element, and it is pure, so it gets its own cases rather than being covered incidentally
// through `livePreviewRanges`.

import { describe, expect, it } from "vitest";
import { isAllowedUrl } from "../urlSchemes.ts";

describe("isAllowedUrl", () => {
  it.each([
    "http://example.com",
    "https://example.com/a?b=c#d",
    "HTTPS://EXAMPLE.COM",
    "mailto:someone@example.com",
    "app-media://attachments/0123456789abcdef.png",
  ])("allows %s", (url) => {
    expect(isAllowedUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHN2Zz4=",
    "vbscript:msgbox(1)",
    "file:///C:/Windows/System32/drivers/etc/hosts",
    "blob:https://example.com/uuid",
    "C:/Users/someone/secret.txt",
  ])("rejects %s", (url) => {
    expect(isAllowedUrl(url)).toBe(false);
  });

  it("rejects a scheme smuggled past the check with whitespace", () => {
    // A browser strips these before resolving, so the allowlist has to strip them too.
    expect(isAllowedUrl("java\nscript:alert(1)")).toBe(false);
    expect(isAllowedUrl("java\tscript:alert(1)")).toBe(false);
    expect(isAllowedUrl("  javascript:alert(1)  ")).toBe(false);
  });

  it("allows a relative reference, which carries no scheme to abuse", () => {
    expect(isAllowedUrl("./notes.md")).toBe(true);
    expect(isAllowedUrl("#anchor")).toBe(true);
    expect(isAllowedUrl("images/a.png")).toBe(true);
  });

  it("rejects a protocol-relative reference", () => {
    // It inherits the page's scheme, which inside a packaged renderer is `file:`.
    expect(isAllowedUrl("//example.com/a.png")).toBe(false);
  });

  it("rejects an empty destination", () => {
    expect(isAllowedUrl("")).toBe(false);
    expect(isAllowedUrl("   ")).toBe(false);
  });

  it("reads the scheme inside CommonMark angle brackets", () => {
    expect(isAllowedUrl("<https://example.com/a b>")).toBe(true);
    expect(isAllowedUrl("<javascript:alert(1)>")).toBe(false);
  });
});
