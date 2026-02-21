import { useState } from "react";
import type { Tag } from "../../../shared/types.ts";
import { TagBadge } from "./TagBadge.tsx";
import styles from "./TagPicker.module.scss";

interface Props {
  allTags: Tag[];
  selectedTagIds: number[];
  onAdd: (tagId: number) => void;
  onRemove: (tagId: number) => void;
}

export function TagPicker({ allTags, selectedTagIds, onAdd, onRemove }: Props) {
  const [open, setOpen] = useState(false);

  const selected = allTags.filter((t) => selectedTagIds.includes(t.id));
  const available = allTags.filter((t) => !selectedTagIds.includes(t.id));

  return (
    <div className={styles.wrap}>
      <div
        className={styles.chipRow}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setOpen((v) => !v)}
      >
        {selected.length === 0 && <span className={styles.placeholder}>Add tags…</span>}
        {selected.map((t) => (
          <TagBadge
            key={t.id}
            tag={t}
            onRemove={(id) => {
              onRemove(id);
            }}
          />
        ))}
      </div>

      {open && (
        <div className={styles.dropdown}>
          {available.length === 0 && (
            <div className={styles.empty}>
              {allTags.length === 0 ? "No tags yet — create in sidebar" : "All tags selected"}
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
              <span
                className={styles.itemDot}
                style={{ backgroundColor: t.color }}
              />
              {t.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
