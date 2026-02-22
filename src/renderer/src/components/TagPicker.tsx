// src/renderer/src/components/TagPicker.tsx
import { useEffect, useRef, useState } from "react";
import type { CreateTagInput, Tag } from "../../../shared/types.ts";
import { TagBadge } from "./TagBadge.tsx";
import { TAG_COLORS } from "./tagColors.ts";
import styles from "./TagPicker.module.scss";

interface Props {
  allTags: Tag[];
  selectedTagIds: number[];
  onAdd: (tagId: number) => void;
  onRemove: (tagId: number) => void;
  /** When provided, a "+ New tag" row appears at the bottom of the dropdown. */
  onCreateTag?: (input: CreateTagInput) => Promise<Tag>;
}

export function TagPicker({ allTags, selectedTagIds, onAdd, onRemove, onCreateTag }: Props) {
  const [open, setOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_COLORS[0] as string);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  function resetCreate() {
    setIsCreating(false);
    setNewName("");
    setNewColor(TAG_COLORS[0] as string);
    setCreateError(null);
    setCreateLoading(false);
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        resetCreate();
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Focus name input when create form opens
  useEffect(() => {
    if (isCreating) nameRef.current?.focus();
  }, [isCreating]);

  async function handleCreate(e?: React.FormEvent) {
    e?.preventDefault();
    const name = newName.trim();
    if (!name) {
      setCreateError("Name is required.");
      return;
    }
    if (!onCreateTag) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const tag = await onCreateTag({ name, color: newColor });
      onAdd(tag.id);
      resetCreate();
    } catch {
      setCreateError("Failed to create tag.");
      setCreateLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleCreate();
    }
    if (e.key === "Escape") resetCreate();
  }

  const selected = allTags.filter((t) => selectedTagIds.includes(t.id));
  const available = allTags.filter((t) => !selectedTagIds.includes(t.id));

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <div
        className={styles.chipRow}
        onClick={() => {
          if (!open) resetCreate();
          setOpen((v) => !v);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setOpen((v) => !v)}
      >
        {selected.length === 0 && <span className={styles.placeholder}>Add tags…</span>}
        {selected.map((t) => <TagBadge key={t.id} tag={t} onRemove={(id) => onRemove(id)} />)}
      </div>

      {open && (
        <div className={styles.dropdown}>
          {available.length === 0 && !onCreateTag && (
            <div className={styles.empty}>
              {allTags.length === 0 ? "No tags yet" : "All tags selected"}
            </div>
          )}
          {available.map((t) => (
            <button
              key={t.id}
              className={styles.item}
              onClick={() => {
                onAdd(t.id);
                setOpen(false);
              }}
            >
              <span className={styles.itemDot} style={{ backgroundColor: t.color }} />
              {t.name}
            </button>
          ))}

          {onCreateTag && (
            <>
              {(available.length > 0 || allTags.length > 0) && <div className={styles.divider} />}
              {!isCreating
                ? (
                  <button className={styles.newTagBtn} onClick={() => setIsCreating(true)}>
                    + New tag
                  </button>
                )
                : (
                  <form className={styles.createForm} onSubmit={(e) => void handleCreate(e)}>
                    <div className={styles.createHeader}>
                      <span className={styles.createTitle}>New tag</span>
                      <button
                        type="button"
                        className={styles.cancelBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          resetCreate();
                        }}
                      >
                        ×
                      </button>
                    </div>

                    <input
                      ref={nameRef}
                      className={styles.nameInput}
                      type="text"
                      placeholder="Tag name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={handleKeyDown}
                      disabled={createLoading}
                      maxLength={64}
                    />

                    <div className={styles.swatchRow}>
                      {TAG_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`${styles.swatch} ${newColor === c ? styles.swatchActive : ""}`}
                          style={{ backgroundColor: c }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setNewColor(c);
                          }}
                          aria-label={c}
                        />
                      ))}
                    </div>

                    {createError && <div className={styles.createError}>{createError}</div>}

                    <button type="submit" className={styles.createBtn} disabled={createLoading}>
                      {createLoading ? "Creating…" : "Create"}
                    </button>
                  </form>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
