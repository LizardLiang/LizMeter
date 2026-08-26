import { useCallback, useEffect, useState } from "react";
import type {
  CreateTodoInput,
  CreateTodoLabelInput,
  CreateTodoProjectInput,
  Todo,
  TodoLabel,
  TodoProject,
  TodoState,
  UpdateTodoInput,
} from "../../../shared/types.ts";
import { TODO_PRIORITY_LABELS } from "../../../shared/types.ts";
import { Combobox } from "./Combobox.tsx";
import { DatePicker } from "./DatePicker.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { Select } from "./Select.tsx";
import { TodoAttachments } from "./TodoAttachments.tsx";
import styles from "./TodoEditDialog.module.scss";
import { TodoPicker } from "./TodoPicker.tsx";

interface Props {
  /** Null opens the dialog in create mode. */
  todo: Todo | null;
  /** Create mode only: the state the new todo lands in. Falls back to the default state. */
  defaultStateId?: number;
  /** Create mode only: pre-fills the parent chip, so "add sub-issue" opens ready to type a title. */
  defaultParent?: { id: number; title: string; };
  states: TodoState[];
  projects: TodoProject[];
  labels: TodoLabel[];
  milestones: string[];
  /** Creates a project named in the Project box that does not exist yet. */
  onCreateProject: (input: CreateTodoProjectInput) => Promise<TodoProject>;
  /** Get-or-create, so naming an existing label in the Labels box reuses it. */
  onCreateLabel: (input: CreateTodoLabelInput) => Promise<TodoLabel>;
  onSave: (input: UpdateTodoInput) => Promise<void>;
  onCreate: (input: CreateTodoInput) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onClose: () => void;
}

/** The state a new todo starts in: the group it was added from, else the workflow default. */
function initialStateId(todo: Todo | null, defaultStateId: number | undefined, states: TodoState[]): number {
  if (todo) return todo.state.id;
  if (defaultStateId !== undefined) return defaultStateId;
  return states.find((s) => s.isDefault)?.id ?? states[0]?.id ?? 0;
}

/** The parent chip's label, falling back to the bare id if the join did not carry a title. */
function initialParent(
  todo: Todo | null,
  defaultParent: { id: number; title: string; } | undefined,
): { id: number; title: string; } | null {
  if (todo === null) return defaultParent ?? null;
  if (todo.parentId === null) return null;
  return { id: todo.parentId, title: todo.parentTitle ?? "#" + todo.parentId };
}

export function TodoEditDialog(
  {
    todo,
    defaultStateId,
    defaultParent,
    states,
    projects,
    labels,
    milestones,
    onCreateProject,
    onCreateLabel,
    onSave,
    onCreate,
    onDelete,
    onClose,
  }: Props,
) {
  const creating = todo === null;

  const [title, setTitle] = useState(todo?.title ?? "");
  const [notes, setNotes] = useState(todo?.notes ?? "");
  const [stateId, setStateId] = useState(() => initialStateId(todo, defaultStateId, states));
  // Held as the project's name rather than its id, so the box keeps accepting a new name.
  // `submit` turns whatever is in it into a real row.
  const [project, setProject] = useState(todo?.project?.name ?? "");
  /** Staged label names. Resolved to ids on save, the same way `project` is. */
  const [labelNames, setLabelNames] = useState<string[]>(() => todo?.labels.map((l) => l.name) ?? []);
  const [labelDraft, setLabelDraft] = useState("");
  const [milestone, setMilestone] = useState(todo?.milestone ?? "");
  const [priority, setPriority] = useState(todo?.priority ?? 0);
  const [startDate, setStartDate] = useState(todo?.startDate ?? "");
  const [dueDate, setDueDate] = useState(todo?.dueDate ?? "");
  const [busy, setBusy] = useState(false);

  // The parent is a property of this todo, so it is staged locally and written on Save.
  // Sub-issues are rows of their own, so those are written the moment you change them.
  const [parent, setParent] = useState(() => initialParent(todo, defaultParent));
  const [children, setChildren] = useState<Todo[]>([]);
  const [newChildTitle, setNewChildTitle] = useState("");
  const [childBusy, setChildBusy] = useState(false);
  const [picking, setPicking] = useState<"parent" | "child" | null>(null);
  // Mirrors the notes editor's expanded surface. Only the Escape guard below reads it.
  const [notesExpanded, setNotesExpanded] = useState(false);

  const datesInvalid = startDate.length > 0 && dueDate.length > 0 && startDate > dueDate;
  const canSubmit = title.trim().length > 0 && !datesInvalid && !busy;

  /** Read straight from the main process, so the page filter cannot hide a sub-issue. */
  const loadChildren = useCallback(async () => {
    if (todo === null) return;
    try {
      setChildren(await window.electronAPI.todo.list({ parentId: todo.id }));
    } catch {
      // A failed read only costs the block its contents. The page surfaces write errors.
    }
  }, [todo]);

  useEffect(() => {
    void loadChildren();
  }, [loadChildren]);

  /**
   * Appends an image embed to the notes. Appending, rather than inserting at the caret, is
   * deliberate for now: the caret lives inside CodeMirror and reaching into it belongs to the
   * paste-and-drop work, which owns editor-side insertion.
   */
  const insertNotesEmbed = useCallback((markdown: string) => {
    setNotes((prev) => {
      const body = prev.replace(/\s+$/, "");
      return body.length === 0 ? markdown : body + "\n\n" + markdown;
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        // The picker and the expanded notes editor each handle their own Escape. Without
        // these guards one press closes both them and the dialog, binning the user's edits.
        // The expanded editor stops the event in the capture phase, so in practice this
        // listener never sees that press at all; `notesExpanded` is the second layer, so the
        // dialog survives even if the editor's listener ever loses the race.
        if (picking === null && !notesExpanded) onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, picking, notesExpanded]);

  /** Resolves the typed project name to an id, creating the project when it is a new name. */
  async function resolveProject(): Promise<number | null> {
    const name = project.trim();
    if (name.length === 0) return null;
    const existing = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    return (await onCreateProject({ name })).id;
  }

  /** Same idea for labels, except creation there is get-or-create so a race cannot duplicate. */
  async function resolveLabels(): Promise<number[]> {
    const ids: number[] = [];
    for (const name of labelNames) {
      const existing = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
      ids.push(existing ? existing.id : (await onCreateLabel({ name })).id);
    }
    return ids;
  }

  async function submit() {
    if (!canSubmit) return;

    setBusy(true);
    try {
      // Resolved inside the try: a rejected name (too long, a clash) has to surface as a
      // failed save rather than being quietly written as "no project".
      const fields = {
        title: title.trim(),
        notes: notes.trim().length > 0 ? notes.trim() : null,
        stateId,
        projectId: await resolveProject(),
        labelIds: await resolveLabels(),
        milestone: milestone.trim().length > 0 ? milestone.trim() : null,
        priority,
        startDate: startDate.length > 0 ? startDate : null,
        dueDate: dueDate.length > 0 ? dueDate : null,
        parentId: parent === null ? null : parent.id,
      };

      if (todo) await onSave({ id: todo.id, ...fields });
      else await onCreate({ ...fields, source: "user" });
      onClose();
    } catch {
      // The hook surfaces the message on the page.
    } finally {
      setBusy(false);
    }
  }

  function addLabel(name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (labelNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) return;
    setLabelNames((current) => [...current, trimmed]);
    setLabelDraft("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await submit();
  }

  async function handleDelete() {
    if (!todo) return;
    setBusy(true);
    try {
      await onDelete(todo.id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  /** Every sub-issue write goes through here: run it, reload the block, keep the dialog open. */
  async function runChildAction(action: () => Promise<void>) {
    if (childBusy) return;
    setChildBusy(true);
    try {
      await action();
      await loadChildren();
    } catch {
      // The hook surfaces the message on the page.
    } finally {
      setChildBusy(false);
    }
  }

  async function addChild() {
    const childTitle = newChildTitle.trim();
    if (todo === null || childTitle.length === 0) return;
    await runChildAction(async () => {
      await onCreate({ title: childTitle, parentId: todo.id, source: "user" });
      setNewChildTitle("");
    });
  }

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        // Ctrl/Cmd+Enter submits from anywhere in the form, including the notes editor, which
        // swallows the CodeMirror binding but lets the DOM event bubble up to here.
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={creating ? "New todo" : "Edit todo"}
      >
        <form onSubmit={handleSubmit}>
          <div className={styles.header}>
            <h2 className={styles.heading}>{creating ? "New Todo" : "Edit Todo"}</h2>
            <button className={styles.closeBtn} type="button" onClick={onClose} aria-label="Close">x</button>
          </div>

          <div className={styles.parentRow}>
            <span className={styles.label}>Parent</span>
            {parent === null
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
                    <span className={styles.chipId}>#{parent.id}</span>
                    {parent.title}
                  </button>
                  <button
                    className={styles.chipClear}
                    type="button"
                    onClick={() => setParent(null)}
                    aria-label="Remove parent"
                  >
                    x
                  </button>
                </span>
              )}
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={500}
              autoFocus
            />
          </label>

          {
            /*
            A <label> wrapping a contenteditable does not focus it on click and screen readers
            mis-announce it, so the notes field uses a plain <div> and an explicit
            aria-labelledby instead.
          */
          }
          <div className={styles.notesField}>
            <span className={styles.label} id="todo-notes-label">Notes</span>
            <MarkdownEditor
              value={notes}
              onChange={setNotes}
              ariaLabelledBy="todo-notes-label"
              placeholder="Markdown supported"
              expandable
              modalTitle="Edit Notes"
              onModalOpenChange={setNotesExpanded}
              todoId={todo === null ? null : todo.id}
            />
          </div>

          <TodoAttachments todoId={todo === null ? null : todo.id} onInsertEmbed={insertNotesEmbed} />

          <div className={styles.grid}>
            <div className={styles.field}>
              <span className={styles.label}>State</span>
              <Select
                ariaLabel="State"
                className={styles.selectTrigger}
                value={String(stateId)}
                options={states.map((s) => ({ value: String(s.id), label: s.label, color: s.color }))}
                onChange={(next) => setStateId(Number(next))}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Priority</span>
              <Select
                ariaLabel="Priority"
                className={styles.selectTrigger}
                value={String(priority)}
                options={TODO_PRIORITY_LABELS.map((label, value) => ({ value: String(value), label }))}
                onChange={(next) => setPriority(Number(next))}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Project</span>
              <Combobox
                ariaLabel="Project"
                className={styles.selectTrigger}
                value={project}
                options={projects.map((p) => p.name)}
                onChange={setProject}
                maxLength={60}
              />
            </div>

            <div className={styles.fieldWide}>
              <span className={styles.label}>Labels</span>
              <div className={styles.labelRow}>
                {labelNames.map((name) => {
                  const known = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
                  return (
                    <span
                      key={name}
                      className={styles.labelChip}
                      style={known ? { borderColor: known.color + "66", color: known.color } : undefined}
                    >
                      {name}
                      <button
                        type="button"
                        className={styles.labelRemove}
                        onClick={() => setLabelNames((current) => current.filter((n) => n !== name))}
                        aria-label={`Remove label ${name}`}
                      >
                        &times;
                      </button>
                    </span>
                  );
                })}
                <Combobox
                  ariaLabel="Add label"
                  className={styles.labelBox}
                  value={labelDraft}
                  options={labels
                    .map((l) => l.name)
                    .filter((n) => !labelNames.some((picked) => picked.toLowerCase() === n.toLowerCase()))}
                  onChange={setLabelDraft}
                  onCommit={() => addLabel(labelDraft)}
                  maxLength={40}
                />
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Milestone</span>
              <Combobox
                ariaLabel="Milestone"
                className={styles.selectTrigger}
                value={milestone}
                options={milestones}
                onChange={setMilestone}
                maxLength={120}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Start</span>
              <DatePicker
                ariaLabel="Start date"
                className={styles.selectTrigger}
                value={startDate}
                onChange={setStartDate}
              />
            </div>

            <div className={styles.field}>
              <span className={styles.label}>Due</span>
              <DatePicker
                ariaLabel="Due date"
                className={styles.selectTrigger}
                value={dueDate}
                onChange={setDueDate}
              />
            </div>
          </div>

          {datesInvalid && <p className={styles.errorMsg}>Start date must not be after the due date.</p>}

          <section className={styles.subSection} aria-label="Sub-issues">
            <div className={styles.subHeader}>
              <span className={styles.label}>
                Sub-issues{children.length > 0 ? " (" + children.length + ")" : ""}
              </span>
              {todo !== null && (
                <button
                  className={styles.linkBtn}
                  type="button"
                  onClick={() => setPicking("child")}
                  disabled={childBusy}
                >
                  Link existing
                </button>
              )}
            </div>

            {creating
              ? <p className={styles.subHint}>Create this todo first, then add sub-issues to it.</p>
              : (
                <>
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
                            onClick={() => void runChildAction(() => onSave({ id: child.id, parentId: null }))}
                            aria-label={"Remove " + child.title + " from this todo"}
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
                        // Enter adds a sub-issue here. Left alone it would submit the whole form.
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

                  {children.length > 0 && (
                    <p className={styles.subHint}>
                      Sub-issues keep their own state. Completing or deleting this todo leaves them alone.
                    </p>
                  )}
                </>
              )}
          </section>

          <div className={styles.actions}>
            {todo
              ? (
                <button className={styles.deleteBtn} type="button" onClick={() => void handleDelete()} disabled={busy}>
                  Delete
                </button>
              )
              : <span />}
            <div className={styles.actionsRight}>
              <button className={styles.cancelBtn} type="button" onClick={onClose}>Cancel</button>
              <button className={styles.saveBtn} type="submit" disabled={!canSubmit}>
                {creating ? "Create" : "Save"}
              </button>
            </div>
          </div>
        </form>
      </div>

      {picking === "parent" && (
        <TodoPicker
          heading="Nest this todo under"
          mode={{
            kind: "parent",
            todoId: todo === null ? null : todo.id,
            currentParentId: parent === null ? null : parent.id,
          }}
          onPick={(picked) => setParent({ id: picked.id, title: picked.title })}
          onClose={() => setPicking(null)}
        />
      )}

      {picking === "child" && todo !== null && (
        <TodoPicker
          heading="Add an existing todo as a sub-issue"
          mode={{ kind: "child", todoId: todo.id }}
          onPick={(picked) => void runChildAction(() => onSave({ id: picked.id, parentId: todo.id }))}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
