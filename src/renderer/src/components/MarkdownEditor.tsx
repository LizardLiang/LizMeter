import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState, Facet, Prec, StateEffect, StateField } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { NOTES_MAX_LENGTH, type TodoAttachment } from "../../../shared/types.ts";
import { livePreviewPlugin } from "../editor/livePreviewPlugin.ts";
import styles from "./MarkdownEditor.module.scss";

interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** px. Ignored when `fillHeight` is set. */
  minHeight?: number;
  /** px. Ignored when `fillHeight` is set. */
  maxHeight?: number;
  disabled?: boolean;
  /**
   * Renders markdown in place and reveals the raw source of the line the cursor is on.
   * Defaults to on: it is the point of this editor, and turning it off is the documented
   * fallback if the decoration plugin ever misbehaves in a real window.
   */
  livePreview?: boolean;
  /**
   * Deliberately not called from inside the editor. Mod-Enter is handled by the dialog's own
   * React `onKeyDown`; invoking this as well would submit the form twice. It stays on the
   * interface for the Phase 2 modal, whose Done button is a real button and not a keybinding.
   */
  onSubmit?: () => void;
  /** Id of the element labelling this editor. Lands on `.cm-content`, which is the textbox. */
  ariaLabelledBy?: string;
  /**
   * Renders the expand button and its modal surface. The modal seeds its own editor with this
   * one instead of nesting a second expandable editor, so it passes this as false.
   */
  expandable?: boolean;
  /** Heading and accessible name of the expanded surface. */
  modalTitle?: string;
  /**
   * Fires whenever the expanded surface opens or closes. `TodoEditDialog` uses it as the
   * second Escape layer: the modal's capture-phase listener already stops the event before
   * the dialog's native `document` listener sees it, and this makes that outcome independent
   * of which listener happens to win the phase race.
   */
  onModalOpenChange?: (open: boolean) => void;
  /** Focus the editor on mount. The modal uses it so typing carries on without a click. */
  autoFocus?: boolean;
  /** Stretch to the container's height instead of using minHeight/maxHeight. Modal surface. */
  fillHeight?: boolean;
  /**
   * Turns on paste and native file drop, storing each file against this todo.
   *
   * `null` is create mode: there is no row to attach to yet, so a dropped file is refused with
   * a hint rather than staged in memory and reconciled on save (decision A-2). It defaults to
   * `null` so no existing caller starts writing attachments by accident.
   */
  todoId?: number | null;
}

/**
 * A notes field is not an IDE. Line numbers, folding, autocompletion and bracket matching are
 * all noise here, and `highlightActiveLine` would fight the live-preview active line in Phase 3.
 * The gutter highlight goes too — left on it renders an empty gutter strip beside the prose.
 * `syntaxHighlighting` is off because the default style is tuned for a light background; the
 * replacement below emits stable `.tok-*` classes that the SCSS module can colour.
 */
const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  autocompletion: false,
  searchKeymap: false,
  bracketMatching: false,
  closeBrackets: false,
  syntaxHighlighting: false,
} as const;

/**
 * Rejects any transaction that would push the document past the shared notes cap. This is the
 * convenience guard only -- `validateTodoNotes` in the main process is the one that actually
 * holds, because the MCP writer never passes through this editor.
 */
const lengthCap = EditorState.changeFilter.of((tr) => tr.newDoc.length <= NOTES_MAX_LENGTH);

/**
 * CodeMirror's `defaultKeymap` binds Mod-Enter to `insertBlankLine`, and `TodoEditDialog`
 * submits the form on Mod-Enter from a React handler on the dialog div. Without this both fire
 * and the note gains a blank line on every save. Returning `true` marks the command handled so
 * `insertBlankLine` never runs, while the DOM event still bubbles to the dialog, so the form
 * submits exactly once.
 */
const modEnterGuard = Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => true }]));

// --- Paste and native file drop ---

/** Shown when a file arrives before the todo exists. Same wording as the attachment strip. */
const CREATE_FIRST_HINT = "Create this todo first, then attach files.";

/** Marks an upload placeholder that has not been replaced by its real embed yet. */
const PLACEHOLDER_PREFIX = "![uploading ";

/** One in-flight upload's placeholder range, kept mapped through every later edit. */
interface UploadMark {
  id: number;
  from: number;
  to: number;
}

const addUploadMark = StateEffect.define<UploadMark>();
const dropUploadMark = StateEffect.define<number>();

/**
 * Tracks where each upload placeholder currently sits.
 *
 * A `StateField` is what lets the user keep typing while a 20 MB file is still being written:
 * every transaction remaps the range through its own changes, so the finished embed replaces
 * the placeholder rather than whatever happens to occupy the original offset by then.
 *
 * `from` maps with assoc 1 and `to` with assoc -1, so text typed against either boundary lands
 * outside the tracked range instead of being swallowed by the replacement.
 */
const uploadMarks = StateField.define<readonly UploadMark[]>({
  create: () => [],
  update(marks, tr) {
    let next = marks;
    if (tr.docChanged) {
      next = next.map((mark) => ({
        id: mark.id,
        from: tr.changes.mapPos(mark.from, 1),
        to: tr.changes.mapPos(mark.to, -1),
      }));
    }
    for (const effect of tr.effects) {
      if (effect.is(addUploadMark)) next = [...next, effect.value];
      else if (effect.is(dropUploadMark)) next = next.filter((mark) => mark.id !== effect.value);
    }
    return next;
  },
});

let nextUploadId = 1;

/** Markdown link text is bracket-delimited, so a file called `a[1].png` has to be escaped. */
function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, "\\$&");
}

function uploadPlaceholder(fileName: string): string {
  return `${PLACEHOLDER_PREFIX}${escapeLinkText(fileName)}...]()`;
}

/** `kind` comes from the main process, so the image/document rule lives in exactly one place. */
function embedMarkdown(attachment: TodoAttachment): string {
  const text = escapeLinkText(attachment.fileName);
  return attachment.kind === "image" ? `![${text}](${attachment.url})` : `[${text}](${attachment.url})`;
}

/**
 * Files carried by a paste or a drop.
 *
 * `files` is the authoritative list on both events. `items` is only consulted as a fallback,
 * because a `DataTransfer` assembled by hand -- in a test, or by some Chromium paste paths --
 * can populate `items` alone. Entries of kind `"string"` are ignored, which is what keeps a
 * plain-text paste out of this list entirely.
 */
function filesFrom(data: DataTransfer | null): File[] {
  if (data === null) return [];
  if (data.files !== undefined && data.files.length > 0) return Array.from(data.files);

  const items = data.items;
  if (items === undefined || items === null) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined || item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  return out;
}

/**
 * True when a drag carries files rather than editor text. During `dragover` the files
 * themselves are withheld by the browser for privacy, so `types` is the only signal available
 * at that point -- and `dragover` is the event that decides whether a drop happens at all.
 */
function carriesFiles(data: DataTransfer | null): boolean {
  if (data === null) return false;
  if (data.types !== undefined && Array.from(data.types).includes("Files")) return true;
  return filesFrom(data).length > 0;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the DOM handlers need from the component, read fresh on every event. */
interface AttachmentConfig {
  /** `null` means create mode: there is no row to attach to yet. */
  todoId: number | null;
  disabled: boolean;
  notify: (message: string) => void;
}

const NO_ATTACHMENTS: AttachmentConfig = { todoId: null, disabled: false, notify: () => {} };

/**
 * Carries the component's props into the DOM handlers through editor state rather than a React
 * ref. A ref would have to be handed to the handler factory during render, which the React
 * Compiler lint rules reject outright, and a facet is the mechanism CodeMirror already provides
 * for exactly this. Changing it reconfigures the editor, and a reconfigure preserves the value
 * of every field still present -- so `uploadMarks` keeps its placeholder positions across one.
 */
const attachmentConfig = Facet.define<AttachmentConfig, AttachmentConfig>({
  combine: (values) => values[0] ?? NO_ATTACHMENTS,
});

/**
 * Replaces a finished upload's placeholder with `insert`, or removes it when `insert` is empty.
 *
 * The IPC call can outlive the editor -- closing the dialog mid-upload destroys the view -- so
 * a detached view is dropped silently rather than dispatched into.
 */
function settleUpload(view: EditorView, id: number, insert: string) {
  if (!view.dom.isConnected) return;

  const mark = view.state.field(uploadMarks, false)?.find((entry) => entry.id === id);
  if (mark === undefined) return;
  const effects = [dropUploadMark.of(id)];

  if (view.state.doc.sliceString(mark.from, mark.to).startsWith(PLACEHOLDER_PREFIX)) {
    view.dispatch({ changes: { from: mark.from, to: mark.to, insert }, effects });
    return;
  }

  // The placeholder was edited or undone out from under the upload. The bytes are on disk by
  // now, so silently dropping the link would strand a file the user cannot reach again;
  // appending is the one placement that is never wrong about position.
  if (insert.length === 0) {
    view.dispatch({ effects });
    return;
  }
  const end = view.state.doc.length;
  const prefix = end === 0 || view.state.doc.sliceString(end - 1, end) === "\n" ? "" : "\n";
  view.dispatch({ changes: { from: end, insert: prefix + insert }, effects });
}

async function storeOne(view: EditorView, file: File, mark: UploadMark, todoId: number, notify: (m: string) => void) {
  try {
    const data = await file.arrayBuffer();
    const attachment = await window.electronAPI.attachment.addBuffer({
      todoId,
      fileName: file.name,
      // Empty for an extension the OS has no mapping for. The main process falls back to the
      // extension, so no guess is made here.
      mimeType: file.type,
      data,
    });
    settleUpload(view, mark.id, embedMarkdown(attachment));
  } catch (error) {
    notify(`Could not attach ${file.name}: ${failureText(error)}`);
    settleUpload(view, mark.id, "");
  }
}

/**
 * Writes one placeholder per file straight away, then swaps each for its embed as the IPC call
 * resolves. The placeholders go in as a single transaction so one undo removes the lot.
 */
function runUpload(view: EditorView, files: File[], at: number, todoId: number, notify: (m: string) => void) {
  const marks: UploadMark[] = [];
  let insert = "";
  for (const file of files) {
    if (insert.length > 0) insert += "\n";
    const from = at + insert.length;
    insert += uploadPlaceholder(file.name);
    marks.push({ id: nextUploadId++, from, to: at + insert.length });
  }

  view.dispatch({
    changes: { from: at, insert },
    effects: marks.map((mark) => addUploadMark.of(mark)),
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
  });
  view.focus();

  for (const [index, file] of files.entries()) {
    const mark = marks[index];
    if (mark === undefined) continue;
    void storeOne(view, file, mark, todoId, notify);
  }
}

/**
 * Where a dropped file belongs. `posAtCoords` needs real layout, so an environment without it
 * (jsdom, or a view that has not been measured yet) falls back to the cursor.
 */
function dropPosition(view: EditorView, event: DragEvent): number {
  try {
    return view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
  } catch {
    return view.state.selection.main.head;
  }
}

/**
 * Paste and native file drop, registered through CodeMirror rather than React props.
 *
 * Two reasons for that. `view.posAtCoords` puts a dropped file where the pointer is instead of
 * where the cursor happens to be. And a handler returning `false` leaves CodeMirror's own
 * clipboard and drag paths completely untouched, which is what keeps ordinary text paste and
 * the editor's internal text drag working -- both far more valuable than this feature.
 */
const attachmentHandlers = EditorView.domEventHandlers({
  dragover(event, view) {
    const config = view.state.facet(attachmentConfig);
    if (config.disabled || !carriesFiles(event.dataTransfer)) return false;
    // Without this the drag is refused and `drop` never fires at all.
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    return true;
  },

  drop(event, view) {
    const config = view.state.facet(attachmentConfig);
    if (!carriesFiles(event.dataTransfer)) return false;
    // Claimed before anything else can run: CodeMirror's own file drop reads the bytes as
    // text and pastes them into the note, which for a PNG is several screens of mojibake.
    // That path ignores `editable`, so a disabled editor has to swallow the event too rather
    // than decline it -- verified by a test that caught exactly that.
    event.preventDefault();
    if (config.disabled) return true;

    const files = filesFrom(event.dataTransfer);
    if (files.length === 0) return true;
    if (config.todoId === null) {
      config.notify(CREATE_FIRST_HINT);
      return true;
    }
    runUpload(view, files, dropPosition(view, event), config.todoId, config.notify);
    return true;
  },

  paste(event, view) {
    const config = view.state.facet(attachmentConfig);
    const files = filesFrom(event.clipboardData);
    // Text, HTML, anything without a file: hand it straight back to CodeMirror untouched.
    // Breaking ordinary copy-paste would be far worse than lacking image paste. This is
    // checked before `disabled` on purpose, so a read-only editor still pastes nothing new
    // but a text paste is declined the same way in both states.
    if (files.length === 0) return false;

    event.preventDefault();
    if (config.disabled) return true;
    if (config.todoId === null) {
      config.notify(CREATE_FIRST_HINT);
      return true;
    }
    runUpload(view, files, view.state.selection.main.head, config.todoId, config.notify);
    return true;
  },
});

function IconExpand() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/**
 * The expanded editing surface. It edits a local draft and hands it back only on Done, so
 * Cancel, Escape and a backdrop click all leave the inline value untouched.
 */
function ModalEditor(
  { initialValue, placeholder, title, livePreview, todoId, onApply, onClose }: {
    initialValue: string;
    placeholder: string | undefined;
    title: string;
    livePreview: boolean;
    todoId: number | null;
    onApply: (next: string) => void;
    onClose: () => void;
  },
) {
  const [draft, setDraft] = useState(initialValue);
  const titleId = useId();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase on `document`, and both halves of that are load-bearing. Verified by
      // flipping the flag to `false` and watching two tests fail:
      //
      // 1. `TodoEditDialog` closes the whole dialog from a NATIVE bubble-phase listener on
      //    this same `document`, registered before this one. A React synthetic
      //    `stopPropagation` cannot reach a native listener at all, and a native bubble
      //    listener added here would run after the dialog's. Capture runs while the event is
      //    still descending, so stopping it there means the bubble pass never reaches
      //    `document` and the dialog's listener never fires.
      // 2. This modal is portalled into `document.body`, which React also uses as the
      //    delegation root for the portal's synthetic events -- and the card's own
      //    `onKeyDown` calls `stopPropagation`, which React forwards to the native event. A
      //    bubble listener here would therefore be killed at `body` by this component's own
      //    Ctrl+Enter guard, one level below `document`.
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function handleDone() {
    onApply(draft);
    onClose();
  }

  return (
    <div className={styles.modalBackdrop} onClick={handleBackdropClick} role="presentation">
      <div
        className={styles.modalCard}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        // React portals bubble synthetic events through the React tree, not the DOM tree, so
        // a key pressed in here still reaches `TodoEditDialog`'s `onKeyDown` and its
        // Ctrl+Enter submit -- which would save the pre-modal notes and bin this draft.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle} id={titleId}>{title}</span>
          <button
            type="button"
            className={styles.modalCloseBtn}
            onClick={onClose}
            title="Close without saving"
            aria-label="Close without saving"
          >
            <IconClose />
          </button>
        </div>

        <div className={styles.modalBody}>
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            placeholder={placeholder}
            ariaLabelledBy={titleId}
            livePreview={livePreview}
            todoId={todoId}
            autoFocus
            fillHeight
          />
        </div>

        <div className={styles.modalFooter}>
          <button type="button" className={styles.modalBtnCancel} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.modalBtnDone} onClick={handleDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Plain markdown editing surface. CodeMirror owns the document while mounted and reports every
 * edit through `onChange`; there is no `value !== doc` reconciliation effect here because
 * `TodosPage` remounts the dialog with a `key` per todo, so the value cannot change underneath
 * an open editor. The one exception is the modal's Done, and the `@uiw` wrapper already
 * reconciles a changed `value` prop by itself -- which is why applying a draft needs no
 * imperative sync of the kind `RichTextInput.handleModalSave` performs for TipTap.
 */
export function MarkdownEditor(
  {
    value,
    onChange,
    placeholder,
    minHeight = 160,
    maxHeight = 320,
    disabled = false,
    // Defaulted here rather than at the TodoEditDialog call site: the dialog is owned by
    // another change in flight, and every caller of this editor wants live preview anyway.
    livePreview = true,
    ariaLabelledBy,
    expandable = false,
    modalTitle = "Edit Notes",
    onModalOpenChange,
    autoFocus = false,
    fillHeight = false,
    todoId = null,
  }: MarkdownEditorProps,
) {
  const [modalOpen, setModalOpen] = useState(false);
  // `seq` makes the object identity change even when the same message is shown twice, which is
  // what re-arms the dismissal timer below. Holding the timer handle in a ref instead would be
  // the obvious shape, but a ref read during render is rejected outright by the React Compiler
  // lint rules -- and this version gets unmount cleanup for free.
  const [hint, setHint] = useState<{ message: string; seq: number; } | null>(null);

  const showHint = useCallback((message: string) => {
    setHint((prev) => ({ message, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (hint === null) return;
    const timer = window.setTimeout(() => setHint(null), 5000);
    return () => clearTimeout(timer);
  }, [hint]);

  const extensions = useMemo(() => [
    // `base: markdownLanguage` is GFM. The commonmark default has no Strikethrough node at
    // all, so `~~gone~~` would never reach the live-preview walker.
    markdown({ base: markdownLanguage, codeLanguages: [] }),
    syntaxHighlighting(classHighlighter),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of(ariaLabelledBy === undefined ? {} : { "aria-labelledby": ariaLabelledBy }),
    lengthCap,
    modEnterGuard,
    uploadMarks,
    attachmentConfig.of({ todoId, disabled, notify: showHint }),
    attachmentHandlers,
    // Highlighting stays underneath: it still colours the revealed line, and the constructs
    // live preview leaves alone (tables, setext headings) keep their token colours.
    ...(livePreview ? [livePreviewPlugin] : []),
  ], [ariaLabelledBy, livePreview, todoId, disabled, showHint]);

  // The modal cannot silence the dialog's own native Escape listener from inside itself, so
  // the dialog is told when to stand down instead. See the comment in ModalEditor.
  useEffect(() => {
    onModalOpenChange?.(modalOpen);
  }, [modalOpen, onModalOpenChange]);

  // `@uiw` writes these as inline styles on `.cm-editor`, so the two shapes are exclusive:
  // in the modal the flex body owns the height and any min/max here would fight it.
  const sizing = fillHeight
    ? { height: "100%" }
    : { minHeight: `${minHeight}px`, maxHeight: `${maxHeight}px` };

  return (
    <>
      <div className={fillHeight ? `${styles.wrapper} ${styles.wrapperFill}` : styles.wrapper}>
        <CodeMirror
          value={value}
          onChange={onChange}
          extensions={extensions}
          basicSetup={BASIC_SETUP}
          theme="none"
          editable={!disabled}
          // The wrapper defaults this to true. Tab has to keep moving focus through the dialog
          // form rather than indenting, so it is turned off explicitly.
          indentWithTab={false}
          placeholder={placeholder}
          autoFocus={autoFocus}
          {...sizing}
        />
        {expandable && !disabled && (
          <button
            type="button"
            className={styles.expandBtn}
            onClick={() => setModalOpen(true)}
            // Out of the tab order on purpose: Tab moves through the dialog's form fields.
            tabIndex={-1}
            title="Expand editor"
            aria-label="Open full editor"
          >
            <IconExpand />
          </button>
        )}

        {
          /* `role="status"` rather than an alert: a refused drop is informational, and an
            assertive live region would cut across whatever the screen reader is mid-sentence. */
        }
        {hint !== null && <p className={styles.dropHint} role="status">{hint.message}</p>}
      </div>

      {modalOpen && createPortal(
        <ModalEditor
          initialValue={value}
          placeholder={placeholder}
          title={modalTitle}
          livePreview={livePreview}
          todoId={todoId}
          onApply={onChange}
          onClose={() => setModalOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}
