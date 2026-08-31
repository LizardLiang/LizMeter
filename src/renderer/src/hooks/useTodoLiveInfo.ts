// src/renderer/src/hooks/useTodoLiveInfo.ts
// Live-joins a Todo-linked issue badge/group to the Todo's *current* title and state, instead of
// the frozen snapshot every other provider (github/linear/jira) uses. This is a deliberate,
// provider-specific exception -- see the tactical plan's "Title sync" decision.
//
// Returns a discriminated status rather than a bare nullable value: "loading" (in-flight fetch)
// and "missing" (lookup genuinely found nothing -- deleted, or not yet synced to this machine --
// see the "Lookup-failure fallback" decision) are different situations for a caller, even though
// both may render the same stored-snapshot fallback. Collapsing them into a single `null` made it
// impossible for a caller to tell "still loading" from "confirmed gone".
//
// Fetches the full todo list per call site rather than sharing a cache: todo lists are already
// fetched cheaply elsewhere in the app, and each badge/group is independent (see the tactical
// plan's step 8 note).

import { useEffect, useRef, useState } from "react";
import type { Todo } from "../../../shared/types.ts";

export interface TodoLiveInfo {
  title: string;
  isCompleted: boolean;
  stateColor: string;
}

/** Discriminated result: `"found"` carries the live data, `"missing"` means the lookup failed. */
export type TodoLiveInfoResult =
  | { status: "loading"; }
  | { status: "found"; info: TodoLiveInfo; }
  | { status: "missing"; };

/**
 * The union of every real `provider` value passed in by the two call sites --
 * `Session["issueProvider"]` (IssueBadge) and `IssueGroupKey["provider"]` (IssueGroupHeader),
 * which additionally carries `"legacy-github"`.
 */
type TodoIssueProvider = "github" | "linear" | "jira" | "todo" | "legacy-github" | null;

/**
 * `issueId` is the session/group's stored `issueId` string (a stringified todo id).
 * `provider` is the session/group's stored provider -- the lookup only runs when it is `"todo"`.
 */
export function useTodoLiveInfo(issueId: string | null, provider: TodoIssueProvider): TodoLiveInfoResult {
  // Derived at render time rather than written into state inside the effect below: whether the
  // lookup even applies is a pure function of `provider`/`issueId`.
  const numericId = provider === "todo" && issueId !== null ? Number(issueId) : null;
  const applicable = numericId !== null && !Number.isNaN(numericId);
  // A single comparable key for "what this instance is currently supposed to be looking up".
  const lookupKey = applicable ? numericId : null;

  const [result, setResult] = useState<TodoLiveInfoResult>(
    applicable ? { status: "loading" } : { status: "missing" },
  );

  // Reset synchronously during render when the lookup target changes, instead of waiting for the
  // effect below to run after commit. Without this, a mounted instance whose `issueId` changes
  // (e.g. a reused badge) would paint the *previous* todo's title/state for a frame next to the
  // new id, because `useEffect` only runs -- and only then schedules a reset -- after paint.
  const lookupKeyRef = useRef(lookupKey);
  if (lookupKeyRef.current !== lookupKey) {
    lookupKeyRef.current = lookupKey;
    setResult(applicable ? { status: "loading" } : { status: "missing" });
  }

  useEffect(() => {
    if (!applicable || numericId === null) return;

    let cancelled = false;
    window.electronAPI.todo.list({})
      .then((todos: Todo[]) => {
        if (cancelled) return;
        const found = todos.find((t) => t.id === numericId);
        setResult(
          found
            ? {
              status: "found",
              info: { title: found.title, isCompleted: found.state.isCompleted, stateColor: found.state.color },
            }
            : { status: "missing" },
        );
      })
      .catch(() => {
        if (!cancelled) setResult({ status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [applicable, numericId]);

  return result;
}
