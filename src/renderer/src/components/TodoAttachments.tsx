import { useState } from "react";
import type { TodoAttachment } from "../../../shared/types.ts";
import { useTodoAttachments } from "../hooks/useTodoAttachments.ts";
import styles from "./TodoAttachments.module.scss";

interface Props {
  /** Null puts the strip in create mode: there is no row to attach to yet, so it is disabled. */
  todoId: number | null;
  /**
   * Appends a markdown embed to the notes. Optional: without it the "Insert into notes" control
   * is not rendered at all, so the strip still works wherever no editor is in reach.
   */
  onInsertEmbed?: (markdown: string) => void;
}

/** One decimal for MB, none for KB -- an exact byte count tells the user nothing here. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** The user-facing extension, for the document glyph. Empty when the name carries none. */
function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1);
}

/** Images embed, everything else links. Both point at the same app-media URL. */
function embedMarkdown(attachment: TodoAttachment): string {
  const prefix = attachment.kind === "image" ? "!" : "";
  return prefix + "[" + attachment.fileName + "](" + attachment.url + ")";
}

/**
 * The attachment strip under the notes field: a tile per file, with add, open, remove, and --
 * for images -- insert-into-notes.
 */
export function TodoAttachments({ todoId, onInsertEmbed }: Props) {
  const { attachments, error, busy, addAttachment, removeAttachment, openAttachment } = useTodoAttachments(todoId);
  // Blobs can disappear if the user prunes userData by hand, and a failed <img> renders as an
  // empty box that looks like a stuck load. Ids that failed once show a placeholder instead.
  const [brokenIds, setBrokenIds] = useState<number[]>([]);
  const creating = todoId === null;

  function markBroken(id: number) {
    setBrokenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }

  return (
    <section className={styles.section} aria-label="Attachments">
      <div className={styles.header}>
        <span className={styles.label}>
          Attachments{attachments.length > 0 ? " (" + attachments.length + ")" : ""}
        </span>
        <button
          className={styles.addBtn}
          type="button"
          onClick={() => void addAttachment()}
          disabled={creating || busy}
        >
          Attach file
        </button>
      </div>

      {creating
        ? <p className={styles.hint}>Create this todo first, then attach files.</p>
        : (
          <>
            {attachments.length > 0 && (
              <ul className={styles.list}>
                {attachments.map((attachment) => {
                  const broken = brokenIds.includes(attachment.id);
                  const extension = fileExtension(attachment.fileName);
                  return (
                    <li key={attachment.id} className={styles.tile}>
                      <button
                        className={styles.preview}
                        type="button"
                        onClick={() => void openAttachment(attachment.id)}
                        disabled={busy}
                        title={attachment.fileName}
                        aria-label={"Open " + attachment.fileName}
                      >
                        {attachment.kind === "image" && !broken
                          ? (
                            <img
                              className={styles.thumb}
                              src={attachment.url}
                              alt={attachment.fileName}
                              onError={() => markBroken(attachment.id)}
                            />
                          )
                          : broken
                          ? (
                            <span className={styles.brokenGlyph}>
                              <span className={styles.brokenMark} aria-hidden="true">!</span>
                              Missing file
                            </span>
                          )
                          : <span className={styles.glyph}>{extension.length > 0 ? extension : "file"}</span>}
                      </button>

                      <div className={styles.meta}>
                        <span className={styles.name} title={attachment.fileName}>{attachment.fileName}</span>
                        <span className={styles.size}>{formatBytes(attachment.sizeBytes)}</span>
                      </div>

                      <div className={styles.tileActions}>
                        {attachment.kind === "image" && onInsertEmbed !== undefined && (
                          <button
                            className={styles.insertBtn}
                            type="button"
                            onClick={() => onInsertEmbed(embedMarkdown(attachment))}
                            aria-label={"Insert " + attachment.fileName + " into notes"}
                          >
                            Insert
                          </button>
                        )}
                        <button
                          className={styles.removeBtn}
                          type="button"
                          onClick={() => void removeAttachment(attachment.id)}
                          disabled={busy}
                          aria-label={"Remove " + attachment.fileName}
                        >
                          x
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {attachments.length === 0 && error === null && (
              <p className={styles.hint}>
                No attachments yet. Images embed into the notes; other files open in the OS.
              </p>
            )}
          </>
        )}

      {error !== null && <p className={styles.errorMsg}>{error}</p>}
    </section>
  );
}
