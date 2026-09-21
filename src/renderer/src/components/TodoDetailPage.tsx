// src/renderer/src/components/TodoDetailPage.tsx
// Full-page todo detail, replacing the edit mode `TodoEditDialog` used to serve. Every field
// auto-saves -- there is no Save button. See
// `.claude/.Arena/tactical-plans/2026-09-15-todo-detail-full-page.md` for the design.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Todo, TodoProject } from "../../../shared/types.ts";
import { TODO_PRIORITY_LABELS } from "../../../shared/types.ts";
import { useTodosContext } from "../contexts/TodosContext.tsx";
import { copyFeedbackIsFailed, copyFeedbackLabel, useCopyFeedback } from "../hooks/useCopyFeedback.ts";
import { collapseLineBreaks, formatTodoAgentPrompt, formatTodoId } from "../utils/todoClipboard.ts";
import { Combobox } from "./Combobox.tsx";
import { DatePicker } from "./DatePicker.tsx";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor.tsx";
import { Select } from "./Select.tsx";
import { TodoAttachments } from "./TodoAttachments.tsx";
import styles from "./TodoDetailPage.module.scss";
import { TodoPicker } from "./TodoPicker.tsx";
import { SubProgressRing } from "./TodosPage.tsx";

/** Title and notes save this long after the user stops typing (F10). */
const DEBOUNCE_MS = 600;

interface Props {
  todoId: number;
  /** Breadcrumb, Escape, delete, and "the todo is gone" all leave through here. */
  onBack: (todoId: number) => void;
  /** Prev/next arrows switch to a different todo's detail without leaving the page. */
  onNavigate: (todoId: number) => void;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Fires a write and swallows its rejection. The write itself (`updateTodo`, `updateTodoQuiet`,
 * `createProject`/`createLabel` through `useTodos`'s `run()`) already sets the shared `error`
 * state before rethrowing -- that state is what the page renders. Leaving the rejection
 * unhandled here would only add a console warning on top of the message already shown.
 */
function fireWrite(promise: Promise<unknown>): void {
  promise.catch(() => {
    // Surfaced via the shared `error` state, rendered below.
  });
}

/**
 * True once focus has genuinely left this field and its own listbox. A mouse pick on a
 * `Combobox` option moves focus to the portalled option and then straight back to the input
 * (`Combobox.pick`); that transition must not also fire a redundant, stale-value commit here
 * (BLOCKER 3) -- `onCommit` already carries the correct picked value.
 */
function blurLeavesField(e: React.FocusEvent<HTMLDivElement>, listboxLabel: string): boolean {
  const related = e.relatedTarget;
  if (!(related instanceof Node)) return true;
  if (e.currentTarget.contains(related)) return false;
  const listbox = document.querySelector(`[role="listbox"][aria-label="${listboxLabel}"]`);
  return !(listbox !== null && listbox.contains(related));
}

/**
 * Local draft for a field that auto-saves through `updateTodoQuiet` on a debounce and on blur.
 * The draft is authoritative while the field has focus, so a concurrent write from outside (the
 * MCP server, a sync merge) cannot yank the caret out from under the user (F10). Any pending
 * write is flushed on unmount, which covers prev/next (the page remounts by id, see the `key` in
 * `TomatoClock`) and navigating back to the list -- so a debounce in flight is never silently
 * dropped (F24).
 *
 * `onFlush` may return a promise. A rejection rolls `committedRef` back to what it held before
 * this attempt, so the next debounce or blur retries the same value instead of treating the
 * failed write as done (a failed write still surfaces through the shared `error` state).
 */
function useQuietDraft(
  serverValue: string,
  onFlush: (value: string) => Promise<void> | void,
): { value: string; onChange: (next: string) => void; onFocus: () => void; onBlur: () => void; } {
  const [value, setValue] = useState(serverValue);
  const valueRef = useRef(serverValue);
  const committedRef = useRef(serverValue);
  /** The latest known server value, tracked even while focused (WARNING 4). */
  const serverRef = useRef(serverValue);
  const focusedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  // Follows an external write (the MCP server, a sync merge) while the field is not focused.
  // While it is focused the draft stays authoritative, so a concurrent write cannot yank it --
  // `serverRef` still tracks the latest value so a blur with no unsaved edit can adopt it.
  useEffect(() => {
    serverRef.current = serverValue;
    if (focusedRef.current) return;
    setValue(serverValue);
    valueRef.current = serverValue;
    committedRef.current = serverValue;
  }, [serverValue]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const commit = useCallback(() => {
    clearTimer();
    if (valueRef.current === committedRef.current) return;
    const attempted = valueRef.current;
    const previousCommitted = committedRef.current;
    committedRef.current = attempted;
    const result = onFlushRef.current(attempted);
    if (result) {
      result.catch(() => {
        // The write failed -- the page renders the shared `error`. Roll back so the next
        // debounce or blur retries, unless the value has already moved on to something else.
        if (committedRef.current === attempted) committedRef.current = previousCommitted;
      });
    }
  }, [clearTimer]);

  useEffect(() => {
    return () => {
      // Flush on unmount: prev/next remounts this page by id, and navigating back unmounts it
      // entirely. Either way, a debounce in flight must not be silently dropped (F24).
      clearTimer();
      if (valueRef.current !== committedRef.current) {
        onFlushRef.current(valueRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = useCallback((next: string) => {
    setValue(next);
    valueRef.current = next;
    clearTimer();
    timerRef.current = window.setTimeout(commit, DEBOUNCE_MS);
  }, [clearTimer, commit]);

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    // No unsaved local edit, but the server moved on while this field was focused -- adopt it
    // rather than let the next commit silently overwrite an external change (WARNING 4).
    if (valueRef.current === committedRef.current && serverRef.current !== valueRef.current) {
      setValue(serverRef.current);
      valueRef.current = serverRef.current;
      committedRef.current = serverRef.current;
      return;
    }
    commit();
  }, [commit]);

  return { value, onChange, onFocus, onBlur };
}

export function TodoDetailPage({ todoId, onBack, onNavigate }: Props) {
  const {
    todos,
    states,
    projects,
    labels,
    milestones,
    loading,
    error,
    visibleIds,
    updateTodo,
    updateTodoQuiet,
    deleteTodo,
    createTodo,
    createProject,
    createLabel,
    toggleTodoLabel,
  } = useTodosContext();

  const contextTodo = useMemo(() => todos.find((t) => t.id === todoId) ?? null, [todos, todoId]);

  /**
   * `contextTodo` only ever holds rows that pass the list's active filters (`useTodos`'s fetch
   * forwards `filter`/`stateId`/`projectId`/`labelId`). Writing a field that no longer matches
   * the filter (e.g. setting State to a completed state under the "Active" tab) drops the row
   * out of `todos` on the next refetch even though the todo still exists -- that is not the same
   * as the row being gone, and must not send the user back to the list (BLOCKER 1).
   */
  const [fallbackTodo, setFallbackTodo] = useState<Todo | null>(null);

  useEffect(() => {
    if (contextTodo !== null) setFallbackTodo(null);
  }, [contextTodo]);

  useEffect(() => {
    if (loading || contextTodo !== null) return;
    let cancelled = false;
    // Unfiltered, so a row that only dropped out of the active filter is still found here.
    window.electronAPI.todo.list().then((all) => {
      if (cancelled) return;
      const found = all.find((t) => t.id === todoId) ?? null;
      if (found === null) {
        // Genuinely gone -- deleted, or renumbered out from under this id by a sync merge
        // (`reconcileTodoIds` in merge-engine.ts). Nothing left to show here (F19).
        onBack(todoId);
      } else {
        setFallbackTodo(found);
      }
    }).catch(() => {
      // Inconclusive: leave the page open on the last data it had rather than navigating away
      // on a failed check.
    });
    return () => {
      cancelled = true;
    };
  }, [loading, contextTodo, todoId, onBack]);

  const todo = contextTodo ?? fallbackTodo;

  const [picking, setPicking] = useState<"parent" | "child" | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [children, setChildren] = useState<Todo[]>([]);
  const [newChildTitle, setNewChildTitle] = useState("");
  const [childBusy, setChildBusy] = useState(false);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  /** De-dupes a repeat commit (Enter, then blur) for a name still being created (BLOCKER 3). */
  const projectCreateRef = useRef<Map<string, Promise<TodoProject>>>(new Map());
  /** Enter in the title moves focus here, caret at the very start -- see `handleTitleKeyDown`. */
  const notesEditorRef = useRef<MarkdownEditorHandle>(null);
  /** Which overflow copy item (if either) currently reads "Copied ✓"/"Copy failed" instead of its
   * normal label. Unlike the row menu's copy items, the feedback window's expiry here only
   * reverts the label -- the overflow menu stays open (no `onExpire` passed). */
  const { feedback: copyFeedback, trigger: triggerCopyFeedback } = useCopyFeedback<"id" | "prompt">();
  /** True while a `handleCopyPrompt` fetch-then-copy chain is in flight. The overflow menu stays
   * open after a copy (unlike the row menu), so nothing else stops a second click from firing a
   * second `todo.list({ parentId })` call before the first resolves -- whichever response landed
   * last would silently win the clipboard instead of whichever click was last. Same shape as
   * `deleting` below: a flag checked at handler entry and reflected on the button's `disabled`. */
  const [copyPromptPending, setCopyPromptPending] = useState(false);

  const loadChildren = useCallback(async () => {
    try {
      setChildren(await window.electronAPI.todo.list({ parentId: todoId }));
    } catch {
      // A failed read only costs the block its contents -- the shared context surfaces write errors.
    }
  }, [todoId]);

  useEffect(() => {
    void loadChildren();
    // `todo?.childCount`/`completedChildCount` are included so an external add/remove/complete
    // (the MCP server, a sync merge) refreshes this block too -- `todoId` alone missed that,
    // leaving the list stale after the count on the meta line had already moved on (WARNING 6).
  }, [loadChildren, todo?.childCount, todo?.completedChildCount]);

  const commitTitle = useCallback((value: string): Promise<void> | void => {
    const trimmed = value.trim();
    // Auto-save has no submit gate to refuse an empty title at, so the write is simply skipped
    // until the user provides one -- the debounce/blur still fires again on the next edit.
    if (trimmed.length === 0) return undefined;
    return updateTodoQuiet({ id: todoId, title: trimmed });
  }, [todoId, updateTodoQuiet]);

  const titleDraft = useQuietDraft(todo?.title ?? "", commitTitle);

  /**
   * Enter is "done with the title," not "add a line" -- the field is single-line text that only
   * wraps visually. `preventDefault` stops the textarea from ever seeing the newline, `onBlur`
   * flushes the debounce exactly the way a real blur would (same function, same behaviour), and
   * focus moves into notes with the caret at the very start rather than wherever it last was.
   */
  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    titleDraft.onBlur();
    notesEditorRef.current?.focusStart();
  }

  const commitNotes = useCallback((value: string): Promise<void> => {
    return updateTodoQuiet({ id: todoId, notes: value.trim().length > 0 ? value.trim() : null });
  }, [todoId, updateTodoQuiet]);

  const notesDraft = useQuietDraft(todo?.notes ?? "", commitNotes);

  function insertNotesEmbed(markdown: string) {
    const body = notesDraft.value.replace(/\s+$/, "");
    notesDraft.onChange(body.length === 0 ? markdown : body + "\n\n" + markdown);
  }

  // Project and milestone are plain typed fields (a name, not a per-keystroke id), so they
  // resolve on commit/blur only -- never per keystroke, or a half-typed name becomes a real
  // project row (F12). Unlike title/notes they are not debounced: `updateTodo` here is the
  // existing instant write, just deferred to commit/blur instead of firing on every keystroke.
  const [projectDraft, setProjectDraft] = useState(todo?.project?.name ?? "");
  useEffect(() => {
    setProjectDraft(todo?.project?.name ?? "");
  }, [todo?.project?.name]);

  /** `value` is always the value being committed -- never read from `projectDraft` state here,
   * which a same-tick `onChange` may not have applied yet (BLOCKER 3). */
  async function commitProject(value: string) {
    if (todo === null) return;
    const trimmed = value.trim();
    const current = todo.project?.name ?? "";
    if (trimmed === current) return;
    if (trimmed.length === 0) {
      fireWrite(updateTodo({ id: todo.id, projectId: null }));
      return;
    }
    const existing = projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      fireWrite(updateTodo({ id: todo.id, projectId: existing.id }));
      return;
    }

    const key = trimmed.toLowerCase();
    let inFlight = projectCreateRef.current.get(key);
    if (inFlight === undefined) {
      inFlight = createProject({ name: trimmed });
      projectCreateRef.current.set(key, inFlight);
      // Handled again below via `await inFlight` for this call; attached here too so a
      // *different* concurrent caller sharing this same promise is not left with its own
      // unhandled rejection.
      inFlight
        .catch(() => {})
        .finally(() => {
          if (projectCreateRef.current.get(key) === inFlight) projectCreateRef.current.delete(key);
        });
    }
    try {
      const created = await inFlight;
      fireWrite(updateTodo({ id: todo.id, projectId: created.id }));
    } catch {
      // Surfaced via the shared `error` state, rendered below.
    }
  }

  const [milestoneDraft, setMilestoneDraft] = useState(todo?.milestone ?? "");
  useEffect(() => {
    setMilestoneDraft(todo?.milestone ?? "");
  }, [todo?.milestone]);

  function commitMilestone(value: string) {
    if (todo === null) return;
    const trimmed = value.trim();
    const current = todo.milestone ?? "";
    if (trimmed === current) return;
    fireWrite(updateTodo({ id: todo.id, milestone: trimmed.length > 0 ? trimmed : null }));
  }

  const [labelDraft, setLabelDraft] = useState("");

  async function commitLabel(value: string) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || todo === null) return;
    const existing = labels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      if (!todo.labels.some((l) => l.id === existing.id)) fireWrite(toggleTodoLabel(todo, existing.id));
    } else {
      try {
        const created = await createLabel({ name: trimmed });
        fireWrite(toggleTodoLabel(todo, created.id));
      } catch {
        // Surfaced via the shared `error` state, rendered below.
        return;
      }
    }
    setLabelDraft("");
  }

  async function runChildAction(action: () => Promise<void>) {
    if (childBusy) return;
    setChildBusy(true);
    try {
      await action();
      await loadChildren();
    } catch {
      // Surfaced by the shared context's `error` already.
    } finally {
      setChildBusy(false);
    }
  }

  async function addChild() {
    const childTitle = newChildTitle.trim();
    if (childTitle.length === 0) return;
    await runChildAction(async () => {
      await createTodo({ title: childTitle, parentId: todoId, source: "user" });
      setNewChildTitle("");
    });
  }

  const currentIndex = visibleIds.indexOf(todoId);
  const canPrev = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex + 1 < visibleIds.length;

  const handlePrev = useCallback(() => {
    const at = visibleIds.indexOf(todoId);
    if (at <= 0) return;
    const prevId = visibleIds[at - 1];
    if (prevId !== undefined) onNavigate(prevId);
  }, [visibleIds, todoId, onNavigate]);

  const handleNext = useCallback(() => {
    const at = visibleIds.indexOf(todoId);
    if (at === -1 || at + 1 >= visibleIds.length) return;
    const nextId = visibleIds[at + 1];
    if (nextId !== undefined) onNavigate(nextId);
  }, [visibleIds, todoId, onNavigate]);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteTodo(todoId);
      onBack(todoId);
    } catch {
      // Surfaced via the shared `error` state, rendered below.
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    if (!overflowOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (overflowWrapRef.current?.contains(e.target as Node)) return;
      setOverflowOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [overflowOpen]);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (overflowOpen) {
        setOverflowOpen(false);
        return;
      }
      // The picker and the overflow menu each handle their own Escape -- see `TodoEditDialog`'s
      // identical guard. Without it one press would also navigate away. The notes editor here has
      // no expanded surface (`expandable={false}`), so there is no third guard to add.
      if (picking === null) onBack(todoId);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onBack, todoId, picking, overflowOpen]);

  if (todo === null) {
    return loading
      ? (
        <div className={styles.page}>
          <p className={styles.stateMsg}>Loading...</p>
        </div>
      )
      : null;
  }

  // Bound once so the `number` narrowing (todo.parentId !== null) survives into the onClick
  // closures below -- narrowing a property access does not persist across a closure boundary,
  // narrowing a plain const does.
  const parentId = todo.parentId;

  // Arrow functions bound to `const`, not `function` declarations: a hoisted declaration loses
  // the `todo !== null` narrowing from the check above (same closure-boundary pitfall as
  // `parentId`'s own comment), an arrow expression created after the check keeps it.
  const handleCopyId = () => {
    navigator.clipboard
      .writeText(formatTodoId(todo.id))
      .then(() => triggerCopyFeedback("id"))
      .catch((err: unknown) => {
        console.error("Failed to copy todo id", err);
        triggerCopyFeedback("id", "failed");
      });
  };

  const handleCopyPrompt = () => {
    // This handler is async (the `todo.list` fetch below) and the overflow menu deliberately
    // stays open after a copy -- so without this guard a second click before the first fetch
    // resolves fires a second `todo.list` call, and whichever response lands last wins the
    // clipboard instead of whichever click was last (silent wrong result, no crash).
    if (copyPromptPending) return;
    setCopyPromptPending(true);
    const parentInfo = parentId !== null ? { id: parentId, title: todo.parentTitle ?? formatTodoId(parentId) } : null;
    // The local `children` state only reflects the last successful `loadChildren` call (its catch
    // block is empty by design -- a failed load simply leaves it stale), so it cannot be trusted
    // as "the current sub-issues" at copy time. Fetched fresh here instead, mirroring
    // `TodoRowMenu`'s `handleCopyPrompt`, which never had a local `children` state to begin with.
    window.electronAPI.todo
      .list({ parentId: todo.id })
      .then((rows) => {
        const prompt = formatTodoAgentPrompt(
          todo,
          parentInfo,
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            stateLabel: row.state.label,
            isCompleted: row.state.isCompleted,
          })),
        );
        return navigator.clipboard.writeText(prompt);
      })
      .then(() => triggerCopyFeedback("prompt"))
      .catch((err: unknown) => {
        console.error("Failed to copy agent prompt", err);
        triggerCopyFeedback("prompt", "failed");
      })
      .finally(() => setCopyPromptPending(false));
  };

  return (
    <div className={styles.page}>
      {
        /* `.page` only establishes the container query used below (TodoDetailPage.module.scss)
          -- a container query cannot restyle the element it is measuring, so the padding that
          actually shrinks at the narrow breakpoint lives on this wrapper instead. */
      }
      <div className={styles.pageBody}>
        <header className={styles.breadcrumb}>
          <button className={styles.crumbBtn} type="button" onClick={() => onBack(todo.id)}>
            Todos
          </button>
          <span className={styles.crumbSep}>/</span>
          <span className={styles.crumbCurrent}>#{todo.id} {todo.title}</span>

          <div className={styles.headerRight}>
            <span className={styles.stepCounter}>
              {currentIndex === -1 ? visibleIds.length : `${currentIndex + 1} / ${visibleIds.length}`}
            </span>
            <button
              className={styles.stepBtn}
              type="button"
              onClick={handlePrev}
              disabled={!canPrev}
              aria-label="Previous todo"
            >
              &lsaquo;
            </button>
            <button
              className={styles.stepBtn}
              type="button"
              onClick={handleNext}
              disabled={!canNext}
              aria-label="Next todo"
            >
              &rsaquo;
            </button>

            <div className={styles.overflowWrap} ref={overflowWrapRef}>
              <button
                className={styles.overflowBtn}
                type="button"
                onClick={() => setOverflowOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                aria-label="More actions"
              >
                &hellip;
              </button>
              {overflowOpen && (
                <div className={styles.overflowMenu} role="menu" aria-label={`Actions for ${todo.title}`}>
                  <button
                    className={copyFeedbackIsFailed(copyFeedback, "id")
                      ? styles.overflowItemFailed
                      : styles.overflowItemNeutral}
                    type="button"
                    role="menuitem"
                    onClick={handleCopyId}
                  >
                    {copyFeedbackLabel(copyFeedback, "id", "Copy id")}
                  </button>
                  <button
                    className={copyFeedbackIsFailed(copyFeedback, "prompt")
                      ? styles.overflowItemFailed
                      : styles.overflowItemNeutral}
                    type="button"
                    role="menuitem"
                    disabled={copyPromptPending}
                    onClick={handleCopyPrompt}
                  >
                    {copyFeedbackLabel(copyFeedback, "prompt", "Copy agent prompt")}
                  </button>
                  <div className={styles.overflowDivider} />
                  <button
                    className={styles.overflowItem}
                    type="button"
                    role="menuitem"
                    disabled={deleting}
                    onClick={() =>
                      void handleDelete()}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {error && <p className={styles.errorMsg}>{error}</p>}

        {
          /* Three siblings in reading order -- header (title + meta), the properties rail, then
          the body (notes onward) -- rather than the rail nested after a single "main" block.
          Below the 48rem container breakpoint (TodoDetailPage.module.scss) these simply stack in
          that order; at and above it, CSS Grid areas pull the rail beside header+body without
          touching this order. Either way DOM order is visual reading order, so Tab never departs
          from what is on screen -- see the comment above `.layout` in the stylesheet. */
        }
        <div className={styles.layout}>
          <div className={styles.mainHeader}>
            <textarea
              className={styles.titleInput}
              value={titleDraft.value}
              onChange={(e) => titleDraft.onChange(collapseLineBreaks(e.target.value))}
              onFocus={titleDraft.onFocus}
              onBlur={titleDraft.onBlur}
              onKeyDown={handleTitleKeyDown}
              maxLength={500}
              aria-label="Title"
              rows={1}
            />

            <div className={styles.metaLine}>
              {parentId === null
                ? (
                  <button className={styles.linkBtn} type="button" onClick={() => setPicking("parent")}>
                    + Set parent
                  </button>
                )
                : (
                  <span className={styles.parentChip}>
                    <button
                      className={styles.parentChipBody}
                      type="button"
                      onClick={() => onNavigate(parentId)}
                      title="Go to parent"
                    >
                      <span className={styles.chipId}>#{parentId}</span>
                      Sub-issue of {todo.parentTitle ?? formatTodoId(parentId)}
                    </button>
                    <button
                      className={styles.chipChangeParent}
                      type="button"
                      onClick={() => setPicking("parent")}
                      aria-label="Change parent"
                      title="Change parent"
                    >
                      &#8646;
                    </button>
                    <button
                      className={styles.chipClear}
                      type="button"
                      onClick={() => fireWrite(updateTodo({ id: todo.id, parentId: null }))}
                      aria-label="Remove parent"
                    >
                      x
                    </button>
                  </span>
                )}

              {todo.childCount > 0 && (
                <span
                  className={styles.subProgress}
                  title={`${todo.completedChildCount} of ${todo.childCount} sub-issue${
                    todo.childCount === 1 ? "" : "s"
                  } done`}
                >
                  <SubProgressRing done={todo.completedChildCount} total={todo.childCount} />
                  {todo.completedChildCount}/{todo.childCount}
                </span>
              )}
            </div>
          </div>

          <div className={styles.rail}>
            <div className={styles.field}>
              <span className={styles.sectionLabel}>State</span>
              <Select
                ariaLabel="State"
                className={styles.selectTrigger}
                value={String(todo.state.id)}
                options={states.map((s) => ({ value: String(s.id), label: s.label, color: s.color }))}
                onChange={(next) => fireWrite(updateTodo({ id: todo.id, stateId: Number(next) }))}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.sectionLabel}>Priority</span>
              <Select
                ariaLabel="Priority"
                className={styles.selectTrigger}
                value={String(todo.priority)}
                options={TODO_PRIORITY_LABELS.map((label, value) => ({ value: String(value), label }))}
                onChange={(next) => fireWrite(updateTodo({ id: todo.id, priority: Number(next) }))}
              />
            </div>

            <div
              className={styles.field}
              onBlur={(e) => {
                if (blurLeavesField(e, "Project")) void commitProject(projectDraft);
              }}
            >
              <span className={styles.sectionLabel}>Project</span>
              <Combobox
                ariaLabel="Project"
                className={styles.selectTrigger}
                value={projectDraft}
                options={projects.map((p) => p.name)}
                onChange={setProjectDraft}
                onCommit={(v) => void commitProject(v)}
                maxLength={60}
              />
            </div>

            <div
              className={`${styles.field} ${styles.fieldWide}`}
              onBlur={(e) => {
                if (blurLeavesField(e, "Add label")) void commitLabel(labelDraft);
              }}
            >
              <span className={styles.sectionLabel}>Labels</span>
              <div className={styles.labelRow}>
                {todo.labels.map((label) => (
                  <span
                    key={label.id}
                    className={styles.labelChip}
                    style={{ borderColor: `${label.color}66`, color: label.color }}
                  >
                    {label.name}
                    <button
                      type="button"
                      className={styles.labelRemove}
                      onClick={() => fireWrite(toggleTodoLabel(todo, label.id))}
                      aria-label={`Remove label ${label.name}`}
                    >
                      &times;
                    </button>
                  </span>
                ))}
                <Combobox
                  ariaLabel="Add label"
                  className={styles.labelBox}
                  value={labelDraft}
                  options={labels
                    .map((l) => l.name)
                    .filter((n) => !todo.labels.some((picked) => picked.name.toLowerCase() === n.toLowerCase()))}
                  onChange={setLabelDraft}
                  onCommit={(value) => void commitLabel(value)}
                  maxLength={40}
                />
              </div>
            </div>

            <div
              className={styles.field}
              onBlur={(e) => {
                if (blurLeavesField(e, "Milestone")) commitMilestone(milestoneDraft);
              }}
            >
              <span className={styles.sectionLabel}>Milestone</span>
              <Combobox
                ariaLabel="Milestone"
                className={styles.selectTrigger}
                value={milestoneDraft}
                options={milestones}
                onChange={setMilestoneDraft}
                onCommit={(v) => commitMilestone(v)}
                maxLength={120}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.sectionLabel}>Start</span>
              <DatePicker
                ariaLabel="Start date"
                className={styles.selectTrigger}
                value={todo.startDate ?? ""}
                onChange={(v) => fireWrite(updateTodo({ id: todo.id, startDate: v.length > 0 ? v : null }))}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.sectionLabel}>Due</span>
              <DatePicker
                ariaLabel="Due date"
                className={styles.selectTrigger}
                value={todo.dueDate ?? ""}
                onChange={(v) => fireWrite(updateTodo({ id: todo.id, dueDate: v.length > 0 ? v : null }))}
              />
            </div>
          </div>

          <div className={styles.mainBody}>
            <div className={styles.notesField} onFocus={notesDraft.onFocus} onBlur={notesDraft.onBlur}>
              <span className={styles.visuallyHidden} id="todo-detail-notes-label">Notes</span>
              <MarkdownEditor
                ref={notesEditorRef}
                value={notesDraft.value}
                onChange={notesDraft.onChange}
                ariaLabelledBy="todo-detail-notes-label"
                placeholder="Add notes…"
                variant="bare"
                expandable={false}
                todoId={todo.id}
              />
            </div>

            <TodoAttachments todoId={todo.id} onInsertEmbed={insertNotesEmbed} />

            <section className={styles.subSection} aria-label="Sub-issues">
              <div className={styles.subHeader}>
                <span className={styles.sectionLabel}>
                  Sub-issues{children.length > 0 ? ` (${children.length})` : ""}
                </span>
                <button
                  className={styles.linkBtn}
                  type="button"
                  onClick={() => setPicking("child")}
                  disabled={childBusy}
                >
                  Link existing
                </button>
              </div>

              {children.length > 0 && (
                <ul className={styles.subList}>
                  {children.map((child) => (
                    <li key={child.id} className={styles.subRow}>
                      <button
                        className={styles.subRowBody}
                        type="button"
                        onClick={() => onNavigate(child.id)}
                        title={`Go to #${child.id}`}
                      >
                        <span className={styles.chipId}>#{child.id}</span>
                        <span
                          className={styles.subDot}
                          style={{
                            borderColor: child.state.color,
                            background: child.state.isCompleted ? child.state.color : "transparent",
                          }}
                          aria-hidden="true"
                        />
                        <span className={child.state.isCompleted ? styles.subTitleDone : styles.subTitle}>
                          {child.title}
                        </span>
                        <span className={styles.subState}>{child.state.label}</span>
                      </button>
                      <button
                        className={styles.chipClear}
                        type="button"
                        disabled={childBusy}
                        onClick={() => void runChildAction(() => updateTodo({ id: child.id, parentId: null }))}
                        aria-label={`Remove ${child.title} from this todo`}
                      >
                        x
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className={styles.subAdd}>
                <input
                  className={styles.input}
                  value={newChildTitle}
                  onChange={(e) => setNewChildTitle(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter adds a sub-issue here. Left alone it would do nothing on a page with
                    // no form to submit.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addChild();
                    }
                  }}
                  placeholder="Add a sub-issue and press Enter"
                  aria-label="New sub-issue title"
                  maxLength={500}
                />
                <button
                  className={styles.subAddBtn}
                  type="button"
                  onClick={() => void addChild()}
                  disabled={childBusy || newChildTitle.trim().length === 0}
                >
                  Add
                </button>
              </div>
            </section>

            <p className={styles.metaFooter}>
              Created {formatDate(todo.createdAt)}
              {todo.completedAt !== null && <>{" · Completed "}{formatDate(todo.completedAt)}</>}
              {" · added by "}
              {todo.source === "user" ? "you" : (todo.sourceLabel ?? "AI")}
            </p>
          </div>
        </div>
      </div>

      {picking === "parent" && (
        <TodoPicker
          heading="Nest this todo under"
          mode={{ kind: "parent", todoId: todo.id, currentParentId: todo.parentId }}
          onPick={(picked) => fireWrite(updateTodo({ id: todo.id, parentId: picked.id }))}
          onClose={() => setPicking(null)}
        />
      )}

      {picking === "child" && (
        <TodoPicker
          heading={`Add an existing todo as a sub-issue of #${todo.id} ${todo.title}`}
          mode={{ kind: "child", todoId: todo.id }}
          onPick={(picked) => void runChildAction(() => updateTodo({ id: picked.id, parentId: todo.id }))}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
