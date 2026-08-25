import { useEffect, useState } from "react";
import type { CreateTodoInput, Todo, TodoState, UpdateTodoInput } from "../../../shared/types.ts";
import { Combobox } from "./Combobox.tsx";
import { DatePicker } from "./DatePicker.tsx";
import { Select } from "./Select.tsx";
import styles from "./TodoEditDialog.module.scss";

interface Props {
  /** Null opens the dialog in create mode. */
  todo: Todo | null;
  /** Create mode only: the state the new todo lands in. Falls back to the default state. */
  defaultStateId?: number;
  states: TodoState[];
  projects: string[];
  milestones: string[];
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

export function TodoEditDialog(
  { todo, defaultStateId, states, projects, milestones, onSave, onCreate, onDelete, onClose }: Props,
) {
  const creating = todo === null;

  const [title, setTitle] = useState(todo?.title ?? "");
  const [notes, setNotes] = useState(todo?.notes ?? "");
  const [stateId, setStateId] = useState(() => initialStateId(todo, defaultStateId, states));
  const [project, setProject] = useState(todo?.project ?? "");
  const [milestone, setMilestone] = useState(todo?.milestone ?? "");
  const [startDate, setStartDate] = useState(todo?.startDate ?? "");
  const [dueDate, setDueDate] = useState(todo?.dueDate ?? "");
  const [busy, setBusy] = useState(false);

  const datesInvalid = startDate.length > 0 && dueDate.length > 0 && startDate > dueDate;
  const canSubmit = title.trim().length > 0 && !datesInvalid && !busy;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  async function submit() {
    if (!canSubmit) return;

    const fields = {
      title: title.trim(),
      notes: notes.trim().length > 0 ? notes.trim() : null,
      stateId,
      project: project.trim().length > 0 ? project.trim() : null,
      milestone: milestone.trim().length > 0 ? milestone.trim() : null,
      startDate: startDate.length > 0 ? startDate : null,
      dueDate: dueDate.length > 0 ? dueDate : null,
    };

    setBusy(true);
    try {
      if (todo) await onSave({ id: todo.id, ...fields });
      else await onCreate({ ...fields, source: "user" });
      onClose();
    } catch {
      // The hook surfaces the message on the page.
    } finally {
      setBusy(false);
    }
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

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        // Ctrl/Cmd+Enter submits from anywhere in the form, including the notes textarea.
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

          <label className={styles.field}>
            <span className={styles.label}>Notes</span>
            <textarea
              className={styles.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={4000}
            />
          </label>

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
              <span className={styles.label}>Project</span>
              <Combobox
                ariaLabel="Project"
                className={styles.selectTrigger}
                value={project}
                options={projects}
                onChange={setProject}
                maxLength={120}
              />
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
    </div>
  );
}
