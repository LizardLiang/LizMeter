// Generates native/crates/ui/tests/fixtures/richtext-golden.json from the real TipTap used by RichTextInput.tsx.
// Run from the repo root: bun native/tools/tiptap-golden/gen.ts
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
for (const k of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "DOMParser", "MutationObserver", "getComputedStyle"]) {
  const v = (dom.window as unknown as Record<string, unknown>)[k];
  try {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  } catch { /* ignore */ }
}
(globalThis as unknown as { document: Document }).document = dom.window.document;

const { Editor } = await import("@tiptap/core");
const StarterKit = (await import("@tiptap/starter-kit")).default;

function roundtrip(html: string): string {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const ed = new Editor({
    element: el,
    extensions: [StarterKit.configure({ heading: false, codeBlock: false, blockquote: false, horizontalRule: false })],
    content: html,
  });
  const out = ed.getHTML();
  ed.destroy();
  el.remove();
  return out;
}

const inputs: string[] = [
  "",
  "<p></p>",
  "<p>plain</p>",
  "<p>Linked session test</p>",
  "plain legacy text",
  "<p>a &amp; b &lt;c&gt; &quot;q&quot; 'x'</p>",
  "<p>nbsp&nbsp;here</p>",
  "<p>中文輸入 日本語 emoji 🍅</p>",
  "<p><strong>bold</strong></p>",
  "<p><em>it</em></p>",
  "<p><s>strike</s></p>",
  "<p><u>under</u></p>",
  "<p><code>code</code></p>",
  "<p><strong><em>bi</em></strong></p>",
  "<p><em><strong>ib</strong></em></p>",
  "<p><strong>a<em>b</em>c</strong></p>",
  "<p><strong><em><s>all</s></em></strong></p>",
  "<p><code><strong>codebold</strong></code></p>",
  "<p><strong>bold</strong> and <em>it</em> then <code>c</code></p>",
  "<p>line one<br>line two</p>",
  "<p><strong>x<br>y</strong></p>",
  "<ul><li><p>one</p></li><li><p>two</p></li></ul>",
  "<ol><li><p>one</p></li><li><p>two</p></li></ol>",
  "<ol start=\"3\"><li><p>three</p></li></ol>",
  "<ul><li><p>a</p><ul><li><p>nested</p></li></ul></li></ul>",
  "<ol><li><p>a</p><ul><li><p>mix</p></li></ul></li></ol>",
  "<p>before</p><ul><li><p>item</p></li></ul><p>after</p>",
  "<ul><li><p><strong>b</strong> item</p></li></ul>",
  "<p>one</p><p>two</p>",
  "<p></p><p>x</p><p></p>",
  "<ul><li><p></p></li></ul>",
  "<p>a  b   c</p>",
  "<p> lead and trail </p>",
  "<p><a href=\"https://example.com\">link</a></p>",
  "<p>see https://example.com/x?y=1&amp;z=2 now</p>",
  "<ul><li>bare li text</li></ul>",
  "<h1>heading dropped</h1>",
  "<blockquote><p>quote dropped</p></blockquote>",
  "<pre><code>block</code></pre>",
  "<p><u><s><em><strong>x</strong></em></s></u></p>",
  "<p><s><u>su</u></s> <u><s>us</s></u></p>",
  "<p><a href=\"https://e.com\"><strong>x</strong></a> <strong><a href=\"https://e.com\">y</a></strong></p>",
  "<p><strong>a</strong><strong>b</strong> <em>c</em><strong>d</strong></p>",
  "<p><b>b tag</b> <i>i tag</i> <strike>strike tag</strike> <del>del tag</del></p>",
];

const cases = inputs.map((input) => ({ input, output: roundtrip(input) }));
const path = new URL("../../crates/ui/tests/fixtures/richtext-golden.json", import.meta.url);
await Bun.write(path, JSON.stringify(cases, null, 2) + "\n");
console.log(`wrote ${cases.length} cases`);
