// Chromium reference for the native notes editor (native/crates/ui/src/md_editor.rs).
// Served by the Vite dev server: http://localhost:5174/native/tools/md-harness/index.html?variant=bare
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/renderer/src/styles/global.scss";
import { MarkdownEditor } from "../../../src/renderer/src/components/MarkdownEditor.tsx";
import fixture from "../notes-fixture.md?raw";

const variant = (new URLSearchParams(location.search).get("variant") ?? "framed") as "framed" | "bare";
const note = fixture.replace("](fixture.png)", "](/native/tools/fixture.png)");

function App() {
  const [value, setValue] = useState(note);
  const width = variant === "framed" ? 640 : 720;
  return (
    <div style={{ width, boxSizing: "border-box", padding: "64px 24px 0", margin: "0 auto" }}>
      <MarkdownEditor value={value} onChange={setValue} variant={variant} expandable />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
