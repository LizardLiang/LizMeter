// src/renderer/src/components/RichTextInput.tsx
// Rich text editor for session descriptions — TipTap with luminous glass pane aesthetic

import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./RichTextInput.module.scss";

interface RichTextInputProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

// ── SVG Icon Components ──

function IconBold() {
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
      <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
      <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
    </svg>
  );
}

function IconItalic() {
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
      <line x1="19" y1="4" x2="10" y2="4" />
      <line x1="14" y1="20" x2="5" y2="20" />
      <line x1="15" y1="4" x2="9" y2="20" />
    </svg>
  );
}

function IconStrike() {
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
      <path d="M16 4H9a3 3 0 0 0-3 3c0 2.5 4 3 6 4" />
      <path d="M8 20h7a3 3 0 0 0 3-3c0-2.5-4-3-6-4" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  );
}

function IconBulletList() {
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
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconOrderedList() {
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
      <line x1="10" y1="6" x2="20" y2="6" />
      <line x1="10" y1="12" x2="20" y2="12" />
      <line x1="10" y1="18" x2="20" y2="18" />
      <text x="3" y="8" fontSize="8" fill="currentColor" stroke="none" fontWeight="700" fontFamily="inherit">1</text>
      <text x="3" y="14.5" fontSize="8" fill="currentColor" stroke="none" fontWeight="700" fontFamily="inherit">2</text>
      <text x="3" y="21" fontSize="8" fill="currentColor" stroke="none" fontWeight="700" fontFamily="inherit">3</text>
    </svg>
  );
}

function IconCode() {
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
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

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

// ── Toolbar Button ──

function ToolbarButton(
  { active, onClick, disabled, title, children }: {
    active?: boolean;
    onClick: () => void;
    disabled?: boolean;
    title: string;
    children: React.ReactNode;
  },
) {
  return (
    <button
      type="button"
      className={`${styles.toolbarBtn} ${active ? styles.toolbarBtnActive : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      tabIndex={-1}
    >
      {children}
    </button>
  );
}

// ── Modal Editor Sub-component ──

function ModalEditor({
  initialValue,
  placeholder,
  onSave,
  onClose,
}: {
  initialValue: string;
  placeholder: string;
  onSave: (html: string) => void;
  onClose: () => void;
}) {
  const modalEditor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: initialValue,
    autofocus: "end",
  });

  // Escape key closes modal without saving
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  function handleDone() {
    if (modalEditor) {
      onSave(modalEditor.getHTML());
    }
    onClose();
  }

  if (!modalEditor) return null;

  return (
    <div className={styles.modalBackdrop} onClick={handleBackdropClick}>
      <div className={styles.modalCard} role="dialog" aria-modal="true" aria-label="Edit Description">
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>Edit Description</span>
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

        <div className={styles.modalToolbar}>
          <div className={styles.toolbarGroup}>
            <ToolbarButton
              active={modalEditor.isActive("bold")}
              onClick={() => modalEditor.chain().focus().toggleBold().run()}
              title="Bold (Ctrl+B)"
            >
              <IconBold />
            </ToolbarButton>
            <ToolbarButton
              active={modalEditor.isActive("italic")}
              onClick={() => modalEditor.chain().focus().toggleItalic().run()}
              title="Italic (Ctrl+I)"
            >
              <IconItalic />
            </ToolbarButton>
            <ToolbarButton
              active={modalEditor.isActive("strike")}
              onClick={() => modalEditor.chain().focus().toggleStrike().run()}
              title="Strikethrough"
            >
              <IconStrike />
            </ToolbarButton>
          </div>
          <span className={styles.toolbarSep} />
          <div className={styles.toolbarGroup}>
            <ToolbarButton
              active={modalEditor.isActive("bulletList")}
              onClick={() => modalEditor.chain().focus().toggleBulletList().run()}
              title="Bullet list"
            >
              <IconBulletList />
            </ToolbarButton>
            <ToolbarButton
              active={modalEditor.isActive("orderedList")}
              onClick={() => modalEditor.chain().focus().toggleOrderedList().run()}
              title="Numbered list"
            >
              <IconOrderedList />
            </ToolbarButton>
          </div>
          <span className={styles.toolbarSep} />
          <div className={styles.toolbarGroup}>
            <ToolbarButton
              active={modalEditor.isActive("code")}
              onClick={() => modalEditor.chain().focus().toggleCode().run()}
              title="Inline code"
            >
              <IconCode />
            </ToolbarButton>
          </div>
        </div>

        <div className={styles.modalEditor}>
          <EditorContent editor={modalEditor} className={styles.modalEditorContent} />
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

// ── Editor ──

export function RichTextInput({
  value,
  onChange,
  placeholder = "Describe what you\u2019ll be working on\u2026",
  disabled = false,
}: RichTextInputProps) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const [focused, setFocused] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: value,
    editable: !disabled,
    onUpdate: ({ editor: ed }) => {
      onChangeRef.current(ed.getHTML());
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  });

  // Sync editable state
  useEffect(() => {
    if (editor) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Sync external value changes (e.g. reset)
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (value !== current) {
      editor.commands.setContent(value, false);
    }
  }, [editor, value]);

  if (!editor) return null;

  const wrapperClass = [
    styles.wrapper,
    focused && !disabled ? styles.focused : "",
    disabled ? styles.disabled : "",
  ].filter(Boolean).join(" ");

  function handleModalSave(html: string) {
    onChange(html);
    // Sync the inline editor to the saved value
    editor.commands.setContent(html, false);
  }

  return (
    <>
      <div className={wrapperClass}>
        <div className={styles.accentStripe} />
        <div className={styles.inner}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarGroup}>
              <ToolbarButton
                active={editor.isActive("bold")}
                onClick={() => editor.chain().focus().toggleBold().run()}
                disabled={disabled}
                title="Bold (Ctrl+B)"
              >
                <IconBold />
              </ToolbarButton>
              <ToolbarButton
                active={editor.isActive("italic")}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                disabled={disabled}
                title="Italic (Ctrl+I)"
              >
                <IconItalic />
              </ToolbarButton>
              <ToolbarButton
                active={editor.isActive("strike")}
                onClick={() => editor.chain().focus().toggleStrike().run()}
                disabled={disabled}
                title="Strikethrough"
              >
                <IconStrike />
              </ToolbarButton>
            </div>
            <span className={styles.toolbarSep} />
            <div className={styles.toolbarGroup}>
              <ToolbarButton
                active={editor.isActive("bulletList")}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                disabled={disabled}
                title="Bullet list"
              >
                <IconBulletList />
              </ToolbarButton>
              <ToolbarButton
                active={editor.isActive("orderedList")}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                disabled={disabled}
                title="Numbered list"
              >
                <IconOrderedList />
              </ToolbarButton>
            </div>
            <span className={styles.toolbarSep} />
            <div className={styles.toolbarGroup}>
              <ToolbarButton
                active={editor.isActive("code")}
                onClick={() => editor.chain().focus().toggleCode().run()}
                disabled={disabled}
                title="Inline code"
              >
                <IconCode />
              </ToolbarButton>
            </div>
          </div>
          <EditorContent editor={editor} className={styles.editor} />
          {!disabled && (
            <button
              type="button"
              className={styles.expandBtn}
              onClick={() => setModalOpen(true)}
              tabIndex={-1}
              title="Expand editor"
              aria-label="Open full editor"
            >
              <IconExpand />
            </button>
          )}
        </div>
      </div>

      {modalOpen && createPortal(
        <ModalEditor
          initialValue={editor.getHTML()}
          placeholder={placeholder}
          onSave={handleModalSave}
          onClose={() => setModalOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}
