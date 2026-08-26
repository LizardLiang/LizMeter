import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.scss";
import { App } from "./App.tsx";

/**
 * Swallows every file drag that does not land on a component which handles it.
 *
 * Chromium's default action for a file dropped on a page that is not a drop target is to
 * navigate to that file -- inside a packaged renderer that replaces the whole app with a PNG
 * and there is no back button. The main process carries a `will-navigate` guard for the same
 * reason; this is the renderer half, and it also stops the OS showing a "copy" cursor over
 * parts of the window that can do nothing with a file.
 *
 * `dragover` must be prevented as well as `drop`: without it the region is not a valid drop
 * target, `drop` never fires, and the browser default runs instead.
 *
 * Two things keep this away from working drags. Only drags carrying files are touched, so
 * CodeMirror's internal text drag (`text/plain`) is untouched. And an event already handled by
 * the notes editor arrives here with `defaultPrevented` set, so the editor's own drop is left
 * alone rather than processed twice. dnd-kit is unaffected either way: its `PointerSensor`
 * activates on `onPointerDown`, and an OS file drag emits no pointer events at all.
 */
function blockStrayFileDrop(e: DragEvent) {
  if (e.defaultPrevented) return;
  const types = e.dataTransfer?.types;
  if (types === undefined || !Array.from(types).includes("Files")) return;
  e.preventDefault();
}

window.addEventListener("dragover", blockStrayFileDrop);
window.addEventListener("drop", blockStrayFileDrop);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
