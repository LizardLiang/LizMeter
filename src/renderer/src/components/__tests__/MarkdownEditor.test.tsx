// Coarse tests only. jsdom performs no layout, so CodeMirror's viewport measures as zero
// height and decoration/DOM assertions are either flaky or vacuously true. What is worth
// asserting here is the wiring: the component mounts, it seeds the document, it reports
// changes upward, the length filter refuses an over-cap transaction, and the expand modal
// applies or discards its draft without disturbing the dialog behind it.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES_MAX_LENGTH, type TodoAttachment } from "../../../../shared/types.ts";
import { livePreviewPlugin } from "../../editor/livePreviewPlugin.ts";
import { MarkdownEditor } from "../MarkdownEditor.tsx";

/** The single `.cm-content` element CodeMirror mounts inside the given root. */
function editorView(root: ParentNode): EditorView {
  const content = root.querySelector(".cm-content");
  if (content === null) throw new Error("CodeMirror did not mount a .cm-content element");
  const view = EditorView.findFromDOM(content as HTMLElement);
  if (view === null) throw new Error("no EditorView is attached to .cm-content");
  return view;
}

/**
 * Types into the modal's editor. The `act` wrapper is load-bearing: a bare `dispatch` reaches
 * CodeMirror's update listener, which calls the React setter from outside React's event
 * system, so the modal's draft state stays unflushed until something else forces a render.
 */
function typeIntoModal(next: string) {
  act(() => {
    const view = editorView(modalCard());
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  });
}

function expandButton(): HTMLElement {
  return screen.getByRole("button", { name: "Open full editor" });
}

/** The modal card. Portalled to `document.body`, so `screen` is what finds it, not `container`. */
function modalCard(): HTMLElement {
  return screen.getByRole("dialog");
}

// --- Paste and drop scaffolding ---
//
// jsdom implements neither `DataTransfer` nor `ClipboardEvent.clipboardData`, so both are
// assembled by hand and defined onto a plain `Event`. This exercises the component's handler
// logic and nothing below it: a genuine OS drag payload cannot be produced by jsdom or by
// Playwright, so the native drop path itself stays a manual check.

interface FakeTransfer {
  files: File[];
  text?: string;
}

function fakeTransfer({ files, text }: FakeTransfer): DataTransfer {
  const types: string[] = [];
  if (files.length > 0) types.push("Files");
  if (text !== undefined) types.push("text/plain");

  return {
    files: Object.assign([...files], { item: (i: number) => files[i] ?? null }),
    items: files.map((file) => ({ kind: "file" as const, type: file.type, getAsFile: () => file })),
    types,
    dropEffect: "none",
    getData: (type: string) => (type === "text/plain" ? text ?? "" : ""),
    setData: () => {},
  } as unknown as DataTransfer;
}

/** Dispatches on `.cm-content`, which is where CodeMirror attaches every DOM handler. */
function dispatchOnContent(view: EditorView, type: string, property: string, data: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, property, { value: data });
  Object.defineProperty(event, "clientX", { value: 0 });
  Object.defineProperty(event, "clientY", { value: 0 });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function paste(view: EditorView, transfer: FakeTransfer): Event {
  return dispatchOnContent(view, "paste", "clipboardData", fakeTransfer(transfer));
}

function drop(view: EditorView, transfer: FakeTransfer): Event {
  return dispatchOnContent(view, "drop", "dataTransfer", fakeTransfer(transfer));
}

function dragOver(view: EditorView, transfer: FakeTransfer): Event {
  return dispatchOnContent(view, "dragover", "dataTransfer", fakeTransfer(transfer));
}

function makeFile(name: string, type: string): File {
  return new File(["file-bytes"], name, { type });
}

function makeAttachment(extra: Partial<TodoAttachment> = {}): TodoAttachment {
  return {
    id: 1,
    todoId: 7,
    sha256: "a".repeat(64),
    fileName: "shot.png",
    mimeType: "image/png",
    sizeBytes: 10,
    kind: "image",
    url: `app-media://attachments/${"a".repeat(64)}.png`,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

/** Lets React flush the promise chain inside the upload without asserting on timing. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MarkdownEditor", () => {
  beforeAll(() => {
    // jsdom implements no layout, so Range#getClientRects is missing and CodeMirror's cursor
    // measuring logs a TypeError on every mount. Stubbing it silences noise that would
    // otherwise read as a real failure; nothing here asserts on geometry.
    if (typeof Range.prototype.getClientRects !== "function") {
      Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
      Range.prototype.getBoundingClientRect = () => new DOMRect();
    }
  });

  // This suite runs without vitest `globals`, so Testing Library never registers its own
  // auto-cleanup. Unmounting by hand is what keeps a portalled modal from one test out of
  // the `screen` queries of the next.
  afterEach(() => {
    cleanup();
  });

  it("mounts a CodeMirror surface", () => {
    const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} />);

    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(container.querySelector(".cm-content")).not.toBeNull();
  });

  it("seeds the document with the initial value", () => {
    // Braces, not a bare JSX attribute: `\n` in an attribute string is a literal backslash.
    const { container } = render(<MarkdownEditor value={"# Heading\n\nbody text"} onChange={vi.fn()} />);

    expect(editorView(container).state.doc.toString()).toBe("# Heading\n\nbody text");
    expect(editorView(container).state.doc.lines).toBe(3);
  });

  it("forwards aria-labelledby to the editable element", () => {
    const { container } = render(
      <MarkdownEditor value="" onChange={vi.fn()} ariaLabelledBy="todo-notes-label" />,
    );

    expect(container.querySelector(".cm-content")?.getAttribute("aria-labelledby")).toBe("todo-notes-label");
  });

  it("reports edits through onChange", () => {
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor value="a" onChange={onChange} />);
    const view = editorView(container);

    view.dispatch({ changes: { from: 1, insert: "bc" } });

    // The @uiw wrapper calls onChange(value, viewUpdate); only the first argument is ours.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe("abc");
  });

  it("rejects an insert that would push the document past NOTES_MAX_LENGTH", () => {
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor value="seed" onChange={onChange} />);
    const view = editorView(container);

    view.dispatch({ changes: { from: 4, insert: "x".repeat(NOTES_MAX_LENGTH) } });

    expect(view.state.doc.length).toBe(4);
    expect(view.state.doc.toString()).toBe("seed");
  });

  it("accepts an insert that lands exactly on NOTES_MAX_LENGTH", () => {
    const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} />);
    const view = editorView(container);

    view.dispatch({ changes: { from: 0, insert: "x".repeat(NOTES_MAX_LENGTH) } });

    expect(view.state.doc.length).toBe(NOTES_MAX_LENGTH);
  });

  // Wiring only. Whether the `**` markers actually disappear on screen is not assertable
  // here: jsdom performs no layout, so the viewport measures as zero height and
  // `view.visibleRanges` is degenerate. The decisions those decorations encode are covered in
  // `src/renderer/src/editor/__tests__/livePreviewRanges.test.ts`; the rendering itself is on
  // the manual checklist.
  describe("live preview wiring", () => {
    it("installs the plugin by default", () => {
      const { container } = render(<MarkdownEditor value={"**bold**\n\ntail"} onChange={vi.fn()} />);
      const view = editorView(container);

      expect(view.plugin(livePreviewPlugin)).not.toBeNull();
      // Decorations are derived from state and are never document changes, which is what
      // makes undo free. If that ever stops holding, this is where it shows up.
      expect(view.state.doc.toString()).toBe("**bold**\n\ntail");
    });

    it("omits the plugin when live preview is turned off", () => {
      const { container } = render(<MarkdownEditor value="**bold**" onChange={vi.fn()} livePreview={false} />);

      expect(editorView(container).plugin(livePreviewPlugin)).toBeNull();
    });

    it("registers one more atomicRanges provider while live preview is on", () => {
      // Without a provider, a single arrow-key press lands inside characters that are no
      // longer on screen and the cursor appears to stall.
      const off = render(<MarkdownEditor value="**bold**" onChange={vi.fn()} livePreview={false} />);
      const withoutPlugin = editorView(off.container).state.facet(EditorView.atomicRanges).length;
      cleanup();

      const on = render(<MarkdownEditor value="**bold**" onChange={vi.fn()} />);
      const withPlugin = editorView(on.container).state.facet(EditorView.atomicRanges).length;

      expect(withPlugin).toBe(withoutPlugin + 1);
    });

    it("parses GFM rather than bare commonmark", () => {
      // Commonmark has no Strikethrough node at all, so `~~gone~~` would never be decorated.
      const { container } = render(<MarkdownEditor value="~~gone~~" onChange={vi.fn()} />);
      const { state } = editorView(container);
      ensureSyntaxTree(state, state.doc.length, 5000);

      let found = false;
      syntaxTree(state).iterate({
        enter: (node) => {
          if (node.name === "Strikethrough") found = true;
        },
      });

      expect(found).toBe(true);
    });

    it("keeps the plugin inside the expanded surface", () => {
      render(<MarkdownEditor value="**bold**" onChange={vi.fn()} expandable />);
      fireEvent.click(expandButton());

      expect(editorView(modalCard()).plugin(livePreviewPlugin)).not.toBeNull();
    });
  });

  describe("expand-to-modal surface", () => {
    it("renders no expand button unless the editor is expandable", () => {
      render(<MarkdownEditor value="" onChange={vi.fn()} />);

      expect(screen.queryByRole("button", { name: "Open full editor" })).toBeNull();
    });

    it("renders no expand button while disabled", () => {
      render(<MarkdownEditor value="" onChange={vi.fn()} expandable disabled />);

      expect(screen.queryByRole("button", { name: "Open full editor" })).toBeNull();
    });

    it("opens a modal seeded with the inline value", () => {
      render(<MarkdownEditor value={"# note\nbody"} onChange={vi.fn()} expandable modalTitle="Edit Notes" />);
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(expandButton());

      const card = modalCard();
      expect(card.getAttribute("aria-label")).toBe("Edit Notes");
      expect(editorView(card).state.doc.toString()).toBe("# note\nbody");
    });

    it("applies the edited draft on Done", () => {
      const onChange = vi.fn();
      render(<MarkdownEditor value="before" onChange={onChange} expandable />);
      fireEvent.click(expandButton());

      typeIntoModal("after");
      // The draft is modal-local until Done, so nothing has reached the parent yet.
      expect(onChange).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Done" }));

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0]?.[0]).toBe("after");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("discards the edited draft on Cancel", () => {
      const onChange = vi.fn();
      const { container } = render(<MarkdownEditor value="before" onChange={onChange} expandable />);
      fireEvent.click(expandButton());

      typeIntoModal("after");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(editorView(container).state.doc.toString()).toBe("before");
    });

    it("discards the edited draft on a backdrop click", () => {
      const onChange = vi.fn();
      render(<MarkdownEditor value="before" onChange={onChange} expandable />);
      fireEvent.click(expandButton());
      const backdrop = modalCard().parentElement;
      if (backdrop === null) throw new Error("the modal card has no backdrop parent");

      typeIntoModal("after");
      fireEvent.click(backdrop);

      expect(onChange).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("closes only the modal on Escape, never a dialog listening on document", () => {
      // TodoEditDialog closes itself from a NATIVE bubble-phase keydown listener on
      // `document`, registered before this modal ever mounts. This spy stands in for it. If
      // the modal handled Escape from a React synthetic handler, or from a bubble-phase
      // native listener, the spy would fire and the real dialog would close underneath the
      // user. The modal's capture-phase listener on `document` is what prevents that.
      const dialogListener = vi.fn();
      document.addEventListener("keydown", dialogListener);
      try {
        render(<MarkdownEditor value="x" onChange={vi.fn()} expandable />);
        fireEvent.click(expandButton());

        fireEvent.keyDown(modalCard(), { key: "Escape" });

        expect(screen.queryByRole("dialog")).toBeNull();
        expect(dialogListener).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("keydown", dialogListener);
      }
    });

    it("keeps Ctrl+Enter inside the modal away from the form behind it", () => {
      // React portals bubble synthetic events through the React tree, not the DOM tree, so
      // a key pressed in the modal still reaches TodoEditDialog's onKeyDown, which submits
      // the form. Submitting from here would save the pre-modal notes and bin the draft.
      const parentKeyDown = vi.fn();
      render(
        <div onKeyDown={parentKeyDown}>
          <MarkdownEditor value="x" onChange={vi.fn()} expandable />
        </div>,
      );
      fireEvent.click(expandButton());

      fireEvent.keyDown(modalCard(), { key: "Enter", ctrlKey: true });

      expect(parentKeyDown).not.toHaveBeenCalled();
    });

    it("reports the modal open state to the parent", () => {
      // TodoEditDialog's Escape guard reads this. It is the second of the two layers: the
      // capture listener above already stops the press, and this keeps the dialog alive
      // regardless of which listener wins the phase race.
      const onModalOpenChange = vi.fn();
      render(<MarkdownEditor value="" onChange={vi.fn()} expandable onModalOpenChange={onModalOpenChange} />);
      expect(onModalOpenChange).toHaveBeenLastCalledWith(false);

      fireEvent.click(expandButton());
      expect(onModalOpenChange).toHaveBeenLastCalledWith(true);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onModalOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  // What is real coverage here: the component's own branching -- whether it claims an event or
  // hands it back, what it writes into the document, and where the replacement lands. What is
  // NOT covered: that a file dragged from Explorer produces such an event in the first place.
  // No test runner can synthesise an OS drag payload, so that half is on the manual checklist.
  describe("paste and file drop", () => {
    const attachmentAPI = {
      add: vi.fn(),
      addBuffer: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      open: vi.fn(),
      reveal: vi.fn(),
    };

    beforeEach(() => {
      vi.stubGlobal("electronAPI", { attachment: attachmentAPI });
      attachmentAPI.addBuffer.mockReset();
      attachmentAPI.addBuffer.mockResolvedValue(makeAttachment());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("leaves a plain-text paste to CodeMirror", async () => {
      // The single most important assertion in this file. Intercepting a text paste would
      // break the editor's most-used interaction in exchange for a feature nobody asked to
      // apply to text, so the handler has to decline the event outright.
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      const event = paste(view, { files: [], text: "hello world" });
      await settle();

      expect(event.defaultPrevented).toBe(true); // CodeMirror's own handler, not ours.
      expect(view.state.doc.toString()).toBe("hello world");
      expect(attachmentAPI.addBuffer).not.toHaveBeenCalled();
    });

    it("leaves an editor-internal text drag alone", () => {
      // Dragging a selection inside the editor is CodeMirror's own feature and carries no
      // files. Claiming that dragover would break it.
      const { container } = render(<MarkdownEditor value="abc" onChange={vi.fn()} todoId={7} />);

      const event = dragOver(editorView(container), { files: [], text: "abc" });

      expect(event.defaultPrevented).toBe(false);
    });

    it("accepts a file dragover so the drop can fire at all", () => {
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} />);

      const event = dragOver(editorView(container), { files: [makeFile("shot.png", "image/png")] });

      expect(event.defaultPrevented).toBe(true);
    });

    it("refuses a dropped file while the todo does not exist yet", async () => {
      // Create mode. Decision A-2: there is no row to attach to, and staging bytes in memory
      // to reconcile on save is real complexity for a rare case.
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} />);
      const view = editorView(container);

      const event = drop(view, { files: [makeFile("shot.png", "image/png")] });
      await settle();

      expect(attachmentAPI.addBuffer).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("");
      // Still claimed, so the window-level guard is not the thing stopping navigation here.
      expect(event.defaultPrevented).toBe(true);
      expect(screen.getByRole("status").textContent).toBe("Create this todo first, then attach files.");
    });

    it("refuses a pasted file while the todo does not exist yet", async () => {
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={null} />);
      const view = editorView(container);

      paste(view, { files: [makeFile("shot.png", "image/png")] });
      await settle();

      expect(attachmentAPI.addBuffer).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toBe("Create this todo first, then attach files.");
    });

    it("shows a placeholder immediately and replaces it once the upload resolves", async () => {
      let release: (value: TodoAttachment) => void = () => {};
      attachmentAPI.addBuffer.mockImplementation(() =>
        new Promise<TodoAttachment>((resolve) => {
          release = resolve;
        })
      );
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      drop(view, { files: [makeFile("shot.png", "image/png")] });
      // Synchronous on purpose: a 20 MB file must not leave the editor looking dead while the
      // main process hashes and writes it.
      expect(view.state.doc.toString()).toBe("![uploading shot.png...]()");

      await settle();
      const input = attachmentAPI.addBuffer.mock.calls[0]?.[0];
      expect(input.todoId).toBe(7);
      expect(input.fileName).toBe("shot.png");
      expect(input.mimeType).toBe("image/png");
      expect(input.data).toBeInstanceOf(ArrayBuffer);

      await act(async () => {
        release(makeAttachment());
      });

      expect(view.state.doc.toString()).toBe(`![shot.png](app-media://attachments/${"a".repeat(64)}.png)`);
    });

    it("replaces the right span after the user keeps typing during the upload", async () => {
      // The reason the placeholder is tracked in a StateField rather than as a pair of
      // numbers: every edit in between shifts it, and a stale offset would overwrite the
      // user's own text.
      let release: (value: TodoAttachment) => void = () => {};
      attachmentAPI.addBuffer.mockImplementation(() =>
        new Promise<TodoAttachment>((resolve) => {
          release = resolve;
        })
      );
      const { container } = render(<MarkdownEditor value="tail" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      // Pasted rather than dropped: paste anchors on the cursor, so this asserts the mapping
      // and nothing about `posAtCoords`, which needs layout jsdom does not have.
      view.dispatch({ selection: { anchor: 4 } });
      paste(view, { files: [makeFile("shot.png", "image/png")] });
      await settle();

      view.dispatch({ changes: { from: 0, insert: "AB" } });
      await act(async () => {
        release(makeAttachment());
      });

      expect(view.state.doc.toString()).toBe(`ABtail![shot.png](app-media://attachments/${"a".repeat(64)}.png)`);
    });

    it("writes a plain link rather than an embed for a document", async () => {
      attachmentAPI.addBuffer.mockResolvedValue(
        makeAttachment({
          fileName: "spec.pdf",
          mimeType: "application/pdf",
          kind: "file",
          url: `app-media://attachments/${"b".repeat(64)}.pdf`,
        }),
      );
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      drop(view, { files: [makeFile("spec.pdf", "application/pdf")] });
      await settle();

      expect(view.state.doc.toString()).toBe(`[spec.pdf](app-media://attachments/${"b".repeat(64)}.pdf)`);
    });

    it("inserts one placeholder per file when several are dropped together", async () => {
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      drop(view, { files: [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")] });

      expect(view.state.doc.toString()).toBe("![uploading a.png...]()\n![uploading b.png...]()");
      await settle();
      expect(attachmentAPI.addBuffer).toHaveBeenCalledTimes(2);
    });

    it("removes the placeholder and reports the reason when the upload fails", async () => {
      attachmentAPI.addBuffer.mockRejectedValue(new Error("file is larger than 25 MB"));
      const { container } = render(<MarkdownEditor value="notes" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      drop(view, { files: [makeFile("huge.png", "image/png")] });
      await settle();

      expect(view.state.doc.toString()).toBe("notes");
      expect(screen.getByRole("status").textContent).toBe("Could not attach huge.png: file is larger than 25 MB");
    });

    it("escapes brackets in a file name so the link syntax survives", async () => {
      attachmentAPI.addBuffer.mockResolvedValue(makeAttachment({ fileName: "shot [1].png" }));
      const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} />);
      const view = editorView(container);

      drop(view, { files: [makeFile("shot [1].png", "image/png")] });
      await settle();

      expect(view.state.doc.toString()).toBe(
        `![shot \\[1\\].png](app-media://attachments/${"a".repeat(64)}.png)`,
      );
    });

    it("swallows a file drop while the editor is disabled", async () => {
      // CodeMirror's built-in file drop reads the bytes with a FileReader and inserts them as
      // text, and that path does not consult `editable`. Declining the event would therefore
      // dump binary into a field the user is not allowed to edit, so it is claimed and
      // discarded instead.
      const { container } = render(<MarkdownEditor value="ro" onChange={vi.fn()} todoId={7} disabled />);
      const view = editorView(container);

      const event = drop(view, { files: [makeFile("shot.png", "image/png")] });
      await settle();

      expect(attachmentAPI.addBuffer).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe("ro");
      expect(event.defaultPrevented).toBe(true);
    });

    it("carries the todo through to the expanded surface", async () => {
      render(<MarkdownEditor value="" onChange={vi.fn()} todoId={7} expandable />);
      fireEvent.click(expandButton());
      const view = editorView(modalCard());

      drop(view, { files: [makeFile("shot.png", "image/png")] });
      await settle();

      expect(attachmentAPI.addBuffer).toHaveBeenCalledTimes(1);
      expect(view.state.doc.toString()).toBe(`![shot.png](app-media://attachments/${"a".repeat(64)}.png)`);
    });
  });
});
