import { describe, expect, it } from "vitest";
import { toPlainSummary } from "../markdownPlain.ts";

describe("toPlainSummary", () => {
  it("turns an image embed into its alt text", () => {
    expect(toPlainSummary("![screenshot](app-media://attachments/deadbeef.png)")).toBe(
      "screenshot",
    );
  });

  it("drops an image embed entirely when alt text is empty", () => {
    expect(toPlainSummary("before ![](app-media://attachments/deadbeef.png) after")).toBe(
      "before after",
    );
  });

  it("turns a link into its text", () => {
    expect(toPlainSummary("see [the docs](https://example.com/docs) for more")).toBe(
      "see the docs for more",
    );
  });

  it("strips nested and adjacent emphasis marks", () => {
    expect(toPlainSummary("**bold *italic* text** and _underline_ and ~~strike~~")).toBe(
      "bold italic text and underline and strike",
    );
  });

  it("strips triple-star bold-italic emphasis", () => {
    expect(toPlainSummary("***bold italic***")).toBe("bold italic");
  });

  it("keeps the code text of a fenced code block and drops the fence markers", () => {
    const md = "before\n```js\nconst x = 1;\n```\nafter";
    expect(toPlainSummary(md)).toBe("before const x = 1; after");
  });

  it("keeps inline code text and drops the backticks", () => {
    expect(toPlainSummary("run `bun run test` first")).toBe("run bun run test first");
  });

  it("strips heading, blockquote, and list-marker prefixes", () => {
    const md = "# Heading\n> a quote\n- item one\n1. item two";
    expect(toPlainSummary(md)).toBe("Heading a quote item one item two");
  });

  it("strips a horizontal rule", () => {
    expect(toPlainSummary("above\n---\nbelow")).toBe("above below");
  });

  it("collapses multi-line input into a single line", () => {
    expect(toPlainSummary("Line one\n\nLine two   \nLine three")).toBe(
      "Line one Line two Line three",
    );
  });

  it("returns the string unchanged when it is exactly maxLen characters", () => {
    const exact = "a".repeat(10);
    expect(toPlainSummary(exact, 10)).toBe(exact);
    expect(toPlainSummary(exact, 10)).toHaveLength(10);
  });

  it("truncates with a trailing ellipsis when one character over maxLen", () => {
    const overByOne = "a".repeat(11);
    const result = toPlainSummary(overByOne, 10);
    expect(result).toHaveLength(10);
    expect(result).toBe(`${"a".repeat(9)}…`);
  });

  it("returns an empty string for empty input", () => {
    expect(toPlainSummary("")).toBe("");
  });

  it("returns an empty string for input that is only markdown syntax", () => {
    const md = "### \n> \n- \n---\n**__~~";
    expect(toPlainSummary(md)).toBe("");
  });

  it("does not throw on an unclosed emphasis marker", () => {
    expect(() => toPlainSummary("**bold and never closed")).not.toThrow();
    expect(toPlainSummary("**bold and never closed")).toBe("bold and never closed");
  });

  it("does not throw on an unclosed fenced code block", () => {
    const md = "```js\nconst x = 1;";
    expect(() => toPlainSummary(md)).not.toThrow();
    expect(toPlainSummary(md)).toBe("js const x = 1;");
  });

  it("does not throw on a link with no closing paren", () => {
    expect(() => toPlainSummary("see [text]( for more")).not.toThrow();
    expect(toPlainSummary("see [text]( for more")).toBe("see [text]( for more");
  });

  it("truncates a long plain-text note to maxLen with an ellipsis", () => {
    const long = "word ".repeat(60).trim();
    const result = toPlainSummary(long, 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith("…")).toBe(true);
  });
});
