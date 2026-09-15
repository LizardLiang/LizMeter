// src/renderer/src/components/TodoDetailPage.tsx
// Full-page todo detail, replacing the edit mode `TodoEditDialog` used to serve. Every field
// auto-saves -- there is no Save button. See
// `.claude/.Arena/tactical-plans/2026-09-15-todo-detail-full-page.md` for the design.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Todo } from "../../../shared/types.ts";
import { TODO_PRIORITY_LABELS } from "../../../shared/types.ts";
import { useTodosContext } from "../contexts/TodosContext.tsx";
import { Combobox } from "./Combobox.tsx";
import { DatePicker } from "./DatePicker.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
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
 * Local draft for a field that auto-saves through `updateTodoQuiet` on a debounce and on blur.
 * The draft is authoritative while the field has focus, so a concurrent write from outside (the
 * MCP server, a sync merge) cannot yank the caret out from under the user (F10). Any pending
 * write is flushed on unmount, which covers prev/next (the page remounts by id, see the `key` in
 * `TomatoClock`) and navigating back to the list -- so a debounce in flight is never silently
 * dropped (F24).
 */
function useQuietDraft(
  serverValue: string,
  onFlush: (value: string) => void,
): { value: string; onChange: (next: string) => void; onFocus: () => void; onBlur: () => void; } {
  const [value, setValue] = useState(serverValue);
  const valueRef = useRef(serverValue);
  const committedRef = useRef(serverValue);
  const focusedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;

  // Follows an external write (the MCP server, a sync merge) while the field is not focused.
  // While it is focused the draft stays authoritative, so a concurrent write cannot yank it.
  useEffect(() => {
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
    committedRef.current = valueRef.current;
    onFlushRef.current(valueRef.current);
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
    visibleIds,
    updateTodo,
    updateTodoQuiet,
    deleteTodo,
    createTodo,
    createProject,
    createLabel,
    toggleTodoLabel,
  } = useTodosContext();

  const todo = useMemo(() => todos.find((t) => t.id === todoId) ?? null, [todos, todoId]);

  // Sync renumber/delete: once the shared list has loaded, a row that is not in it anymore has
  // nothing left to show here -- follow it back to the list rather than rendering an empty page
  // (F19), the same rule `TodosPage.tsx`'s `editing` lookup documents.
  useEffect(() => {
    if (!loading && todo === null) onBack(todoId);
  }, [loading, todo, todoId, onBack]);

  const [picking, setPicking] = useState<"parent" | "child" | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [children, setChildren] = useState<Todo[]>([]);
  const [newChildTitle, setNewChildTitle] = useState("");
  const [childBusy, setChildBusy] = useState(false);
  const overflowWrapRef = useRef<HTMLDivElement>(null);

  const loadChildren = useCallback(async () => {
    try {
      setChildren(await window.electronAPI.todo.list({ parentId: todoId }));
    } catch {
      // A failed read only costs the block its contents -- the shared context surfaces write errors.
    }
  }, [todoId]);

  useEffect(() => {
    void loadChildren();
  }, [loadChildren]);

  const commitTitle = useCallback((value: string) => {
    const trimmed = value.trim();
    // Auto-save has no submit gate to refuse an empty title at, so the write is simply skipped
    // until the user provides one -- the debounce/blur still fires again on the next edit.
    if (trimmed.length === 0) return;
    void updateTodoQuiet({ id: todoId, title: trimmed });
  }, [todoId, updateTodoQuiet]);

  const titleDraft = useQuietDraft(todo?.title ?? "", commitTitle);

  const commitNotes = useCallback((value: string) => {
    void updateTodoQuiet({ id: todoId, notes: value.trim().length > 0 ? value.trim() : null });
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

  async function commitProject() {
    if (todo === null) return;
    const trimmed = projectDraft.trim();
    const current = todo.project?.name ?? "";
    if (trimmed === current) return;
    if (trimmed.length === 0) {
      void updateTodo({ id: todo.id, projectId: null });
      return;
    }
    const existing = projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    const id = existing ? existing.id : (await createProject({ name: trimmed })).id;
    void updateTodo({ id: todo.id, projectId: id });
  }

  const [milestoneDraft, setMilestoneDraft] = useState(todo?.milestone ?? "");
  useEffect(() => {
    setMilestoneDraft(todo?.milestone ?? "");
  }, [todo?.milestone]);

  function commitMilestone() {
    if (todo === null) return;
    const trimmed = milestoneDraft.trim();
    const current = todo.milestone ?? "";
    if (trimmed === current) return;
    void updateTodo({ id: todo.id, milestone: trimmed.length > 0 ? trimmed : null });
  }

  const [labelDraft, setLabelDraft] = useState("");

  async function commitLabel(value: string) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || todo === null) return;
    const existing = labels.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      if (!todo.labels.some((l) => l.id === existing.id)) void toggleTodoLabel(todo, existing.id);
    } else {
      const created = await createLabel({ name: trimmed });
      void toggleTodoLabel(todo, created.id);
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
      // The picker and the expanded notes editor each handle their own Escape -- see
      // `TodoEditDialog`'s identical guard. Without it one press would also navigate away.
      if (picking === null && !notesExpanded) onBack(todoId);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onBack, todoId, picking, notesExpanded, overflowOpen]);

  if (todo === null) {
    return loading
      ? (
        <div className={styles.page}>
          <p className={styles.stateMsg}>Loading...</p>
        </div>
      )
      : null;
  }

  return (
    <div className={styles.page}>
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
                  className={styles.overflowItem}
                  type="button"
                  role="menuitem"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className={styles.layout}>
        <div className={styles.main}>
          <input
            className={styles.titleInput}
            value={titleDraft.value}
            onChange={(e) => titleDraft.onChange(e.target.value)}
            onFocus={titleDraft.onFocus}
            onBlur={titleDraft.onBlur}
            maxLength={500}
            aria-label="Title"
          />

          <div className={styles.metaLine}>
            {todo.parentId === null
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
                    onClick={() => setPicking("parent")}
                    title="Change parent"
                  >
                    <span className={styles.chipId}>#{todo.parentId}</span>
                    Sub-issue of {todo.parentTitle ?? `#${todo.parentId}`}
                  </button>
                  <button
                    className={styles.chipClear}
                    type="button"
                    onClick={() => void updateTodo({ id: todo.id, parentId: null })}
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

          <div className={styles.notesField} onFocus={notesDraft.onFocus} onBlur={notesDraft.onBlur}>
            <span className={styles.sectionLabel} id="todo-detail-notes-label">Notes</span>
            <MarkdownEditor
              value={notesDraft.value}
              onChange={notesDraft.onChange}
              ariaLabelledBy="todo-detail-notes-label"
              placeholder="Markdown supported"
              expandable
              modalTitle="Edit Notes"
              onModalOpenChange={setNotesExpanded}
              todoId={todo.id}
            />
          </div>

          <TodoAttachments todoId={todo.id} onInsertEmbed={insertNotesEmbed} />

          <section className={styles.subSection} aria-label="Sub-issues">
            <div className={styles.subHeader}>
              <span className={styles.sectionLabel}>
                Sub-issues{children.length > 0 ? ` (${children.length})` : ""}
              </span>
              <button className={styles.linkBtn} type="button" onClick={() => setPicking("child")} disabled={childBusy}>
                Link existing
              </button>
            </div>

            {children.length > 0 && (
              <ul className={styles.subList}>
                {children.map((child) => (
                  <li key={child.id} className={styles.subRow}>
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
            {todo.completedAt !== null && <>&middot; Completed {formatDate(todo.completedAt)}</>}
            {" · added by "}
            {todo.source === "user" ? "you" : (todo.sourceLabel ?? "AI")}
          </p>
        </div>

        <div className={styles.rail}>
          <div className={styles.field}>
            <span className={styles.sectionLabel}>State</span>
            <Select
              ariaLabel="State"
              className={styles.selectTrigger}
              value={String(todo.state.id)}
              options={states.map((s) => ({ value: String(s.id), label: s.label, color: s.color }))}
              onChange={(next) => void updateTodo({ id: todo.id, stateId: Number(next) })}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.sectionLabel}>Priority</span>
            <Select
              ariaLabel="Priority"
              className={styles.selectTrigger}
              value={String(todo.priority)}
              options={TODO_PRIORITY_LABELS.map((label, value) => ({ value: String(value), label }))}
              onChange={(next) => void updateTodo({ id: todo.id, priority: Number(next) })}
            />
          </div>

          <div className={styles.field} onBlur={() => void commitProject()}>
            <span className={styles.sectionLabel}>Project</span>
            <Combobox
              ariaLabel="Project"
              className={styles.selectTrigger}
              value={projectDraft}
              options={projects.map((p) => p.name)}
              onChange={setProjectDraft}
              onCommit={() => void commitProject()}
              maxLength={60}
            />
          </div>

          <div className={styles.field}>
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
                    onClick={() => void toggleTodoLabel(todo, label.id)}
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

          <div className={styles.field} onBlur={() => commitMilestone()}>
            <span className={styles.sectionLabel}>Milestone</span>
            <Combobox
              ariaLabel="Milestone"
              className={styles.selectTrigger}
              value={milestoneDraft}
              options={milestones}
              onChange={setMilestoneDraft}
              onCommit={() => commitMilestone()}
              maxLength={120}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.sectionLabel}>Start</span>
            <DatePicker
              ariaLabel="Start date"
              className={styles.selectTrigger}
              value={todo.startDate ?? ""}
              onChange={(v) => void updateTodo({ id: todo.id, startDate: v.length > 0 ? v : null })}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.sectionLabel}>Due</span>
            <DatePicker
              ariaLabel="Due date"
              className={styles.selectTrigger}
              value={todo.dueDate ?? ""}
              onChange={(v) => void updateTodo({ id: todo.id, dueDate: v.length > 0 ? v : null })}
            />
          </div>
        </div>
      </div>

      {picking === "parent" && (
        <TodoPicker
          heading="Nest this todo under"
          mode={{ kind: "parent", todoId: todo.id, currentParentId: todo.parentId }}
          onPick={(picked) => void updateTodo({ id: todo.id, parentId: picked.id })}
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
