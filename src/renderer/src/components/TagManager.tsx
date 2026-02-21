import { useState } from "react";
import type { CreateTagInput, Tag, UpdateTagInput } from "../../../shared/types.ts";
import { TagBadge } from "./TagBadge.tsx";
import { TagColorPicker } from "./TagColorPicker.tsx";
import { TAG_COLORS } from "./tagColors.ts";
import styles from "./TagManager.module.scss";

interface Props {
  tags: Tag[];
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onUpdateTag: (input: UpdateTagInput) => Promise<Tag>;
  onDeleteTag: (id: number) => Promise<void>;
}

export function TagManager({ tags, onCreateTag, onUpdateTag, onDeleteTag }: Props) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_COLORS[0]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      await onCreateTag({ name, color: newColor });
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tag");
    }
  }

  function startEdit(tag: Tag) {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color);
  }

  async function handleUpdate() {
    if (editingId === null) return;
    const name = editName.trim();
    if (!name) return;
    setError(null);
    try {
      await onUpdateTag({ id: editingId, name, color: editColor });
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update tag");
    }
  }

  async function handleDelete(id: number) {
    setError(null);
    try {
      await onDeleteTag(id);
      if (editingId === id) setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete tag");
    }
  }

  return (
    <div className={styles.section}>
      {/* Create form */}
      <div className={styles.createForm}>
        <div className={styles.createRow}>
          <input
            className={styles.input}
            placeholder="New tag name…"
            value={newName}
            maxLength={32}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
          />
          <button className={styles.createBtn} onClick={() => void handleCreate()}>
            +
          </button>
        </div>
        <TagColorPicker value={newColor} onChange={setNewColor} />
      </div>

      {error && <div className={styles.errorMsg}>{error}</div>}

      {/* Tag list */}
      {tags.length === 0 && <div className={styles.emptyMsg}>No tags yet</div>}

      {tags.map((tag) =>
        editingId === tag.id
          ? (
            <div key={tag.id} className={styles.editForm}>
              <div className={styles.editRow}>
                <input
                  className={styles.input}
                  value={editName}
                  maxLength={32}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleUpdate();
                  }}
                  autoFocus
                />
                <button className={styles.createBtn} onClick={() => void handleUpdate()}>✓</button>
                <button className={styles.cancelBtn} onClick={() => setEditingId(null)}>✕</button>
              </div>
              <TagColorPicker value={editColor} onChange={setEditColor} />
            </div>
          )
          : (
            <div key={tag.id} className={styles.tagRow}>
              <div className={styles.tagBadgeWrap}>
                <TagBadge tag={tag} />
              </div>
              <button className={styles.iconBtn} onClick={() => startEdit(tag)} aria-label={`Edit tag ${tag.name}`}>
                ✎
              </button>
              <button
                className={styles.deleteIconBtn}
                onClick={() => void handleDelete(tag.id)}
                aria-label={`Delete tag ${tag.name}`}
              >
                ✕
              </button>
            </div>
          )
      )}
    </div>
  );
}
