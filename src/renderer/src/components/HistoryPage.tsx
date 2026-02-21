import type { Session, Tag } from "../../../shared/types.ts";
import styles from "./HistoryPage.module.scss";
import { TagBadge } from "./TagBadge.tsx";
import { TagPicker } from "./TagPicker.tsx";

interface Props {
  sessions: Session[];
  total: number;
  isLoading: boolean;
  error: string | null;
  allTags: Tag[];
  activeTagFilter: number | undefined;
  onSetTagFilter: (tagId: number | undefined) => void;
  onDeleteSession: (id: string) => void;
  onLoadMore: () => void;
  onAssignTag: (sessionId: string, tagId: number) => Promise<void>;
  onUnassignTag: (sessionId: string, tagId: number) => Promise<void>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

interface SessionCardProps {
  session: Session;
  allTags: Tag[];
  onDelete: (id: string) => void;
  onAssign: (sessionId: string, tagId: number) => Promise<void>;
  onUnassign: (sessionId: string, tagId: number) => Promise<void>;
}

function SessionCard({ session, allTags, onDelete, onAssign, onUnassign }: SessionCardProps) {
  const assignedTagIds = session.tags.map((t) => t.id);

  const typeColor = session.timerType === "work"
    ? "#7aa2f7"
    : session.timerType === "short_break"
    ? "#9ece6a"
    : "#bb9af7";
  const typeLabel = session.timerType === "work"
    ? "Work"
    : session.timerType === "short_break"
    ? "Short Break"
    : "Long Break";

  return (
    <div className={styles.card}>
      <div className={styles.cardTop}>
        <span
          className={styles.typePill}
          style={{ color: typeColor, backgroundColor: typeColor + "18", border: `1px solid ${typeColor}30` }}
        >
          {typeLabel}
        </span>
        <span className={styles.cardDuration}>{formatDuration(session.actualDurationSeconds)}</span>
        <span className={styles.cardMeta}>{formatDate(session.completedAt)} · {formatTime(session.completedAt)}</span>
        <button className={styles.cardDelBtn} onClick={() => onDelete(session.id)} aria-label="Delete session">
          ✕
        </button>
      </div>
      {session.title && <div className={styles.cardTitle}>{session.title}</div>}
      <div className={styles.cardTags}>
        {session.tags.map((t) => <TagBadge key={t.id} tag={t} onRemove={(id) => void onUnassign(session.id, id)} />)}
        <TagPicker
          allTags={allTags}
          selectedTagIds={assignedTagIds}
          onAdd={(tagId) => void onAssign(session.id, tagId)}
          onRemove={(tagId) => void onUnassign(session.id, tagId)}
        />
      </div>
    </div>
  );
}

export function HistoryPage({
  sessions,
  total,
  isLoading,
  error,
  allTags,
  activeTagFilter,
  onSetTagFilter,
  onDeleteSession,
  onLoadMore,
  onAssignTag,
  onUnassignTag,
}: Props) {
  const activeFilterTag = allTags.find((t) => t.id === activeTagFilter);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>History</h1>

      {allTags.length > 0 && (
        <div className={styles.filterRow}>
          <button
            className={activeTagFilter === undefined ? styles.chipActive : styles.chip}
            onClick={() => onSetTagFilter(undefined)}
          >
            All
          </button>
          {allTags.map((t) => (
            <button
              key={t.id}
              className={activeTagFilter === t.id ? styles.chipActive : styles.chip}
              onClick={() => onSetTagFilter(activeTagFilter === t.id ? undefined : t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {activeFilterTag && (
        <div className={styles.filterBy}>
          <span className={styles.filterByLabel}>Filtered by</span>
          <TagBadge tag={activeFilterTag} onRemove={() => onSetTagFilter(undefined)} />
        </div>
      )}

      {isLoading && <div className={styles.stateMsg}>Loading…</div>}
      {error && <div className={styles.errorMsg}>{error}</div>}
      {!isLoading && sessions.length === 0 && <div className={styles.emptyMsg}>No sessions yet.</div>}

      <div className={styles.list}>
        {sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            allTags={allTags}
            onDelete={onDeleteSession}
            onAssign={onAssignTag}
            onUnassign={onUnassignTag}
          />
        ))}
      </div>

      {sessions.length < total && (
        <button className={styles.loadMoreBtn} onClick={onLoadMore}>
          Load more ({total - sessions.length} remaining)
        </button>
      )}
    </div>
  );
}
