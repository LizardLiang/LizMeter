import { useEffect, useState } from "react";
import type { CreateTodoStateInput, TodoState, UpdateTodoStateInput } from "../../../shared/types.ts";
import { TODO_COLORS } from "../../../shared/types.ts";
import { Select } from "./Select.tsx";
import styles from "./TodoStateManager.module.scss";

interface Props {
  states: TodoState[];
  /** How many todos sit in each state, so deletion can say what it will move. */
  countsByState: Record<number, number>;
  onCreate: (input: CreateTodoStateInput) => Promise<TodoState>;
  onUpdate: (input: UpdateTodoStateInput) => Promise<void>;
  onDelete: (id: number, reassignToId: number) => Promise<number>;
  onReorder: (orderedIds: number[]) => Promise<void>;
}

export function ArrowIcon({ direction }: { direction: "up" | "down"; }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === "up" ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
    </svg>
  );
}

/**
 * Keeps the label in local state and commits on blur or Enter.
 *
 * Committing per keystroke would fire an IPC write and a full list refresh for every
 * character, and would reject half-typed labels that momentarily collide with another.
 */
export function CommitOnBlurInput(
  { value, onCommit, ariaLabel }: { value: string; onCommit: (label: string) => void; ariaLabel: string; },
) {
  const [draft, setDraft] = useState(value);

  // Adopt server-side changes (a rejected rename, another window) when not being edited.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const next = draft.trim();
    if (next.length === 0) {
      setDraft(value);
      return;
    }
    if (next !== value) onCommit(next);
  }

  return (
    <input
      className={styles.labelInput}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(value);
      }}
      aria-label={ariaLabel}
      maxLength={32}
    />
  );
}

/**
 * The States tab of the Manage dialog. The overlay, heading and close button live in
 * {@link TodoManageDialog}, which is what lets Projects and Labels share the same chrome.
 */
export function StatesTab(props: Props) {
  const { states, countsByState, onCreate, onUpdate, onDelete, onReorder } = props;

  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState<string>(TODO_COLORS[0]);
  const [pendingDelete, setPendingDelete] = useState<TodoState | null>(null);
  const [reassignTo, setReassignTo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    const label = newLabel.trim();
    if (label.length === 0 || busy) return;
    setBusy(true);
    try {
      await onCreate({ label, color: newColor });
      setNewLabel("");
    } catch {
      // The hook surfaces the message on the page.
    } finally {
      setBusy(false);
    }
  }

  function startDelete(state: TodoState) {
    setPendingDelete(state);
    const fallback = states.find((s) => s.id !== state.id);
    setReassignTo(fallback ? fallback.id : null);
  }

  async function confirmDelete() {
    if (!pendingDelete || reassignTo === null) return;
    setBusy(true);
    try {
      await onDelete(pendingDelete.id, reassignTo);
      setPendingDelete(null);
    } catch {
      // Blocked deletes (default / last completed) surface on the page.
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= states.length) return;
    const ids = states.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    void onReorder(ids);
  }

  return (
    <>
      <p className={styles.hint}>
        Rename, recolor, and reorder freely. One state is where new todos land, and one means finished &mdash; those two
        roles survive renaming.
      </p>

      <ul className={styles.list}>
        {states.map((state, index) => {
          const count = countsByState[state.id] ?? 0;
          return (
            <li key={state.id} className={styles.row}>
              <div className={styles.reorder}>
                <button
                  className={styles.moveBtn}
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${state.label} up`}
                >
                  <ArrowIcon direction="up" />
                </button>
                <button
                  className={styles.moveBtn}
                  onClick={() => move(index, 1)}
                  disabled={index === states.length - 1}
                  aria-label={`Move ${state.label} down`}
                >
                  <ArrowIcon direction="down" />
                </button>
              </div>

              <CommitOnBlurInput
                value={state.label}
                onCommit={(label) => void onUpdate({ id: state.id, label })}
                ariaLabel={`Rename ${state.label}`}
              />

              <div className={styles.swatches}>
                {TODO_COLORS.map((color) => (
                  <button
                    key={color}
                    className={color === state.color ? styles.swatchActive : styles.swatch}
                    style={{ background: color }}
                    onClick={() => void onUpdate({ id: state.id, color })}
                    aria-label={`Set ${state.label} to ${color}`}
                  />
                ))}
              </div>

              <label className={styles.flag} title="New todos land here">
                <input
                  type="radio"
                  name="todo-state-default"
                  checked={state.isDefault}
                  onChange={() => void onUpdate({ id: state.id, isDefault: true })}
                />
                Default
              </label>

              <label className={styles.flag} title="Counts as finished">
                <input
                  type="radio"
                  name="todo-state-completed"
                  checked={state.isCompleted}
                  onChange={() => void onUpdate({ id: state.id, isCompleted: true })}
                />
                Done
              </label>

              <span className={styles.count}>{count}</span>

              <button
                className={styles.deleteBtn}
                onClick={() => startDelete(state)}
                disabled={state.isDefault || state.isCompleted || states.length <= 1}
                title={state.isDefault || state.isCompleted
                  ? "Pick another state for this role first"
                  : "Delete this state"}
                aria-label={`Delete ${state.label}`}
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>

      <form className={styles.addForm} onSubmit={handleCreate}>
        <input
          className={styles.labelInput}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="New state..."
          aria-label="New state label"
          maxLength={32}
        />
        <div className={styles.swatches}>
          {TODO_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={color === newColor ? styles.swatchActive : styles.swatch}
              style={{ background: color }}
              onClick={() => setNewColor(color)}
              aria-label={`Use ${color}`}
            />
          ))}
        </div>
        <button className={styles.addBtn} type="submit" disabled={newLabel.trim().length === 0 || busy}>
          Add
        </button>
      </form>

      {pendingDelete && (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            {countsByState[pendingDelete.id] ?? 0} todo(s) use <strong>{pendingDelete.label}</strong>. Move them to:
          </p>
          <div className={styles.confirmRow}>
            <Select
              ariaLabel="Reassign to state"
              className={styles.select}
              value={reassignTo === null ? "" : String(reassignTo)}
              options={states
                .filter((s) => s.id !== pendingDelete.id)
                .map((s) => ({ value: String(s.id), label: s.label, color: s.color }))}
              onChange={(next) => setReassignTo(Number(next))}
            />
            <button className={styles.confirmBtn} onClick={() => void confirmDelete()} disabled={busy}>
              Move and delete
            </button>
            <button className={styles.cancelBtn} onClick={() => setPendingDelete(null)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
