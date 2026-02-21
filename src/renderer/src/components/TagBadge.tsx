import type { Tag } from "../../../shared/types.ts";
import styles from "./TagBadge.module.scss";

interface Props {
  tag: Tag;
  onRemove?: (id: number) => void;
}

export function TagBadge({ tag, onRemove }: Props) {
  const bg = tag.color + "26"; // 15% opacity

  return (
    <span className={styles.badge} style={{ backgroundColor: bg, color: tag.color }}>
      <span className={styles.dot} style={{ backgroundColor: tag.color }} />
      {tag.name}
      {onRemove && (
        <button
          className={styles.removeBtn}
          style={{ color: tag.color }}
          onClick={() => onRemove(tag.id)}
          aria-label={`Remove tag ${tag.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
