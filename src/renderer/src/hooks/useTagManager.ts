import { useCallback, useEffect, useState } from "react";
import type { CreateTagInput, Tag, UpdateTagInput } from "../../../shared/types.ts";

export interface UseTagManagerReturn {
  tags: Tag[];
  isLoading: boolean;
  error: string | null;
  createTag: (input: CreateTagInput) => Promise<Tag>;
  updateTag: (input: UpdateTagInput) => Promise<Tag>;
  deleteTag: (id: number) => Promise<void>;
  assignTag: (sessionId: string, tagId: number) => Promise<void>;
  unassignTag: (sessionId: string, tagId: number) => Promise<void>;
}

export function useTagManager(): UseTagManagerReturn {
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTags = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.tag.list();
      setTags(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tags");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  const createTag = useCallback(
    async (input: CreateTagInput): Promise<Tag> => {
      const tag = await window.electronAPI.tag.create(input);
      await loadTags();
      return tag;
    },
    [loadTags],
  );

  const updateTag = useCallback(
    async (input: UpdateTagInput): Promise<Tag> => {
      const tag = await window.electronAPI.tag.update(input);
      await loadTags();
      return tag;
    },
    [loadTags],
  );

  const deleteTag = useCallback(
    async (id: number): Promise<void> => {
      await window.electronAPI.tag.delete(id);
      await loadTags();
    },
    [loadTags],
  );

  const assignTag = useCallback(async (sessionId: string, tagId: number): Promise<void> => {
    await window.electronAPI.tag.assign({ sessionId, tagId });
  }, []);

  const unassignTag = useCallback(async (sessionId: string, tagId: number): Promise<void> => {
    await window.electronAPI.tag.unassign({ sessionId, tagId });
  }, []);

  return { tags, isLoading, error, createTag, updateTag, deleteTag, assignTag, unassignTag };
}
