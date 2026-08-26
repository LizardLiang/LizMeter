import { useState } from "react";
import type {
  CreateTodoLabelInput,
  CreateTodoProjectInput,
  CreateTodoStateInput,
  TodoLabel,
  TodoProject,
  TodoState,
  UpdateTodoLabelInput,
  UpdateTodoProjectInput,
  UpdateTodoStateInput,
} from "../../../shared/types.ts";
import { TODO_COLORS } from "../../../shared/types.ts";
import styles from "./TodoStateManager.module.scss";
import { ArrowIcon, CommitOnBlurInput, StatesTab } from "./TodoStateManager.tsx";

type Tab = "states" | "projects" | "labels";

const TABS: Array<{ id: Tab; label: string; }> = [
  { id: "states", label: "States" },
  { id: "projects", label: "Projects" },
  { id: "labels", label: "Labels" },
];

interface Props {
  states: TodoState[];
  projects: TodoProject[];
  labels: TodoLabel[];
  /** How many todos sit in each state, so deletion can say what it will move. */
  countsByState: Record<number, number>;
  countsByProject: Record<number, number>;
  countsByLabel: Record<number, number>;
  onCreateState: (input: CreateTodoStateInput) => Promise<TodoState>;
  onUpdateState: (input: UpdateTodoStateInput) => Promise<void>;
  onDeleteState: (id: number, reassignToId: number) => Promise<number>;
  onReorderStates: (orderedIds: number[]) => Promise<void>;
  onCreateProject: (input: CreateTodoProjectInput) => Promise<TodoProject>;
  onUpdateProject: (input: UpdateTodoProjectInput) => Promise<void>;
  onDeleteProject: (id: number) => Promise<number>;
  onReorderProjects: (orderedIds: number[]) => Promise<void>;
  onCreateLabel: (input: CreateTodoLabelInput) => Promise<TodoLabel>;
  onUpdateLabel: (input: UpdateTodoLabelInput) => Promise<void>;
  onDeleteLabel: (id: number) => Promise<number>;
  onClose: () => void;
}

/** Shared by both new-row forms: a name box, the palette, and an Add button. */
function AddRowForm(
  { placeholder, ariaLabel, maxLength, onAdd }: {
    placeholder: string;
    ariaLabel: string;
    maxLength: number;
    onAdd: (name: string, color: string) => Promise<unknown>;
  },
) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(TODO_COLORS[0]);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    try {
      await onAdd(trimmed, color);
      setName("");
    } catch {
      // The hook surfaces the message on the page.
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.addForm} onSubmit={(e) => void submit(e)}>
      <input
        className={styles.labelInput}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={maxLength}
      />
      <div className={styles.swatches}>
        {TODO_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className={swatch === color ? styles.swatchActive : styles.swatch}
            style={{ background: swatch }}
            onClick={() => setColor(swatch)}
            aria-label={`Use ${swatch}`}
          />
        ))}
      </div>
      <button className={styles.addBtn} type="submit" disabled={name.trim().length === 0 || busy}>
        Add
      </button>
    </form>
  );
}

/**
 * Deleting a project or a label never moves work items anywhere, so this is a plain
 * confirm rather than the reassignment picker the States tab needs.
 */
function DeleteConfirm(
  { name, count, noun, onConfirm, onCancel }: {
    name: string;
    count: number;
    noun: string;
    onConfirm: () => void;
    onCancel: () => void;
  },
) {
  return (
    <div className={styles.confirm}>
      <p className={styles.confirmText}>
        {count === 0
          ? (
            <>
              No todos use <strong>{name}</strong>.
            </>
          )
          : (
            <>
              {count} todo(s) will lose the {noun} <strong>{name}</strong>. The todos themselves are kept.
            </>
          )}
      </p>
      <div className={styles.confirmRow}>
        <button className={styles.confirmBtn} onClick={onConfirm}>Delete {noun}</button>
        <button className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ProjectsTab(
  { projects, countsByProject, onCreate, onUpdate, onDelete, onReorder }: {
    projects: TodoProject[];
    countsByProject: Record<number, number>;
    onCreate: (input: CreateTodoProjectInput) => Promise<TodoProject>;
    onUpdate: (input: UpdateTodoProjectInput) => Promise<void>;
    onDelete: (id: number) => Promise<number>;
    onReorder: (orderedIds: number[]) => Promise<void>;
  },
) {
  const [pendingDelete, setPendingDelete] = useState<TodoProject | null>(null);

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= projects.length) return;
    const ids = projects.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    void onReorder(ids);
  }

  return (
    <>
      <p className={styles.hint}>
        Projects group todos. A todo can belong to one, or to none &mdash; deleting a project only removes the grouping,
        never the work.
      </p>

      <ul className={styles.list}>
        {projects.map((project, index) => (
          <li key={project.id} className={styles.row}>
            <div className={styles.reorder}>
              <button
                className={styles.moveBtn}
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${project.name} up`}
              >
                <ArrowIcon direction="up" />
              </button>
              <button
                className={styles.moveBtn}
                onClick={() => move(index, 1)}
                disabled={index === projects.length - 1}
                aria-label={`Move ${project.name} down`}
              >
                <ArrowIcon direction="down" />
              </button>
            </div>

            <CommitOnBlurInput
              value={project.name}
              onCommit={(name) => void onUpdate({ id: project.id, name })}
              ariaLabel={`Rename ${project.name}`}
            />

            <div className={styles.swatches}>
              {TODO_COLORS.map((color) => (
                <button
                  key={color}
                  className={color === project.color ? styles.swatchActive : styles.swatch}
                  style={{ background: color }}
                  onClick={() => void onUpdate({ id: project.id, color })}
                  aria-label={`Set ${project.name} to ${color}`}
                />
              ))}
            </div>

            <span className={styles.count}>{countsByProject[project.id] ?? 0}</span>

            <button
              className={styles.deleteBtn}
              onClick={() => setPendingDelete(project)}
              aria-label={`Delete ${project.name}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {projects.length === 0 && <p className={styles.hint}>No projects yet. Add one below.</p>}

      <AddRowForm
        placeholder="New project..."
        ariaLabel="New project name"
        maxLength={60}
        onAdd={(name, color) => onCreate({ name, color })}
      />

      {pendingDelete && (
        <DeleteConfirm
          name={pendingDelete.name}
          count={countsByProject[pendingDelete.id] ?? 0}
          noun="project"
          onConfirm={() => {
            void onDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

function LabelsTab(
  { labels, countsByLabel, onCreate, onUpdate, onDelete }: {
    labels: TodoLabel[];
    countsByLabel: Record<number, number>;
    onCreate: (input: CreateTodoLabelInput) => Promise<TodoLabel>;
    onUpdate: (input: UpdateTodoLabelInput) => Promise<void>;
    onDelete: (id: number) => Promise<number>;
  },
) {
  const [pendingDelete, setPendingDelete] = useState<TodoLabel | null>(null);

  return (
    <>
      <p className={styles.hint}>
        A todo can carry any number of labels. You can also make one on the spot by typing a new name into the label
        picker &mdash; this tab is for renaming, recoloring, and tidying up.
      </p>

      <ul className={styles.list}>
        {labels.map((label) => (
          <li key={label.id} className={styles.row}>
            <CommitOnBlurInput
              value={label.name}
              onCommit={(name) => void onUpdate({ id: label.id, name })}
              ariaLabel={`Rename ${label.name}`}
            />

            <div className={styles.swatches}>
              {TODO_COLORS.map((color) => (
                <button
                  key={color}
                  className={color === label.color ? styles.swatchActive : styles.swatch}
                  style={{ background: color }}
                  onClick={() => void onUpdate({ id: label.id, color })}
                  aria-label={`Set ${label.name} to ${color}`}
                />
              ))}
            </div>

            <span className={styles.count}>{countsByLabel[label.id] ?? 0}</span>

            <button
              className={styles.deleteBtn}
              onClick={() => setPendingDelete(label)}
              aria-label={`Delete ${label.name}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {labels.length === 0 && <p className={styles.hint}>No labels yet. Add one below.</p>}

      <AddRowForm
        placeholder="New label..."
        ariaLabel="New label name"
        maxLength={40}
        onAdd={(name, color) => onCreate({ name, color })}
      />

      {pendingDelete && (
        <DeleteConfirm
          name={pendingDelete.name}
          count={countsByLabel[pendingDelete.id] ?? 0}
          noun="label"
          onConfirm={() => {
            void onDelete(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

/**
 * One dialog for the three things a todo can be filed under.
 *
 * They share chrome rather than getting a toolbar button each: the three lists are the same
 * shape (name, colour, count, delete) and the toolbar already carries five controls.
 */
export function TodoManageDialog(props: Props) {
  const [tab, setTab] = useState<Tab>("states");

  return (
    <div className={styles.overlay} onClick={props.onClose} role="presentation">
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Manage todo states, projects and labels"
      >
        <div className={styles.header}>
          <div className={styles.tabs} role="tablist">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? styles.tabActive : styles.tab}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className={styles.closeBtn} onClick={props.onClose} aria-label="Close">x</button>
        </div>

        {tab === "states" && (
          <StatesTab
            states={props.states}
            countsByState={props.countsByState}
            onCreate={props.onCreateState}
            onUpdate={props.onUpdateState}
            onDelete={props.onDeleteState}
            onReorder={props.onReorderStates}
          />
        )}

        {tab === "projects" && (
          <ProjectsTab
            projects={props.projects}
            countsByProject={props.countsByProject}
            onCreate={props.onCreateProject}
            onUpdate={props.onUpdateProject}
            onDelete={props.onDeleteProject}
            onReorder={props.onReorderProjects}
          />
        )}

        {tab === "labels" && (
          <LabelsTab
            labels={props.labels}
            countsByLabel={props.countsByLabel}
            onCreate={props.onCreateLabel}
            onUpdate={props.onUpdateLabel}
            onDelete={props.onDeleteLabel}
          />
        )}
      </div>
    </div>
  );
}
