import type { CreateTagInput, Tag, UpdateTagInput } from "../../../shared/types.ts";
import { TagManager } from "./TagManager.tsx";
import styles from "./TagsPage.module.scss";

interface Props {
  tags: Tag[];
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onUpdateTag: (input: UpdateTagInput) => Promise<Tag>;
  onDeleteTag: (id: number) => Promise<void>;
}

export function TagsPage({ tags, onCreateTag, onUpdateTag, onDeleteTag }: Props) {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>Tags</h1>
      <TagManager
        tags={tags}
        onCreateTag={onCreateTag}
        onUpdateTag={onUpdateTag}
        onDeleteTag={onDeleteTag}
      />
    </div>
  );
}
