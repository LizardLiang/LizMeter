import type { CreateTagInput, Session, Tag, TimerStatus, UpdateTagInput } from "../../../shared/types.ts";
import { useGroupExpand } from "../hooks/useGroupExpand.ts";
import { formatDuration } from "../utils/format.ts";
import { DateSubGroupHeader } from "./DateSubGroupHeader.tsx";
import { IssueGroupHeader } from "./IssueGroupHeader.tsx";
import styles from "./Sidebar.module.scss";
import { SidebarToggle } from "./SidebarToggle.tsx";
import { TagBadge } from "./TagBadge.tsx";
import { TagManager } from "./TagManager.tsx";
import { TagPicker } from "./TagPicker.tsx";

interface Props {
  isOpen: boolean;
  onToggle: () => void;
  // Timer state
  timerStatus: TimerStatus;
  remainingSeconds: number;
  // Tags
  allTags: Tag[];
  pendingTagIds: number[];
  onPendingTagAdd: (tagId: number) => void;
  onPendingTagRemove: (tagId: number) => void;
  onCreateTag: (input: CreateTagInput) => Promise<Tag>;
  onUpdateTag: (input: UpdateTagInput) => Promise<Tag>;
  onDeleteTag: (id: number) => Promise<void>;
  // Session history
  sessions: Session[];
  total: number;
  isLoading: boolean;
  error: string | null;
  activeTagFilter: number | undefined;
  onSetTagFilter: (tagId: number | undefined) => void;
  onDeleteSession: (id: string) => void;
  onLoadMore: () => void;
  // Per-session tag management
  onAssignTag: (sessionId: string, tagId: number) => Promise<void>;
  onUnassignTag: (sessionId: string, tagId: number) => Promise<void>;
}

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timerStatusColor(status: TimerStatus): string {
  switch (status) {
    case "running":
      return "#9ece6a";
    case "paused":
      return "#e0af68";
    default:
      return "#565f89";
  }
}

function timerStatusLabel(status: TimerStatus): string {
  switch (status) {
    case "running":
      return "In progress";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    default:
      return "No session";
  }
}

export function Sidebar({
  isOpen,
  onToggle,
  timerStatus,
  remainingSeconds,
  allTags,
  pendingTagIds,
  onPendingTagAdd,
  onPendingTagRemove,
  onCreateTag,
  onUpdateTag,
  onDeleteTag,
  sessions,
  total,
  isLoading,
  error,
  activeTagFilter,
  onSetTagFilter,
  onDeleteSession,
  onLoadMore,
  onAssignTag,
  onUnassignTag,
}: Props) {
  const isActive = timerStatus === "running" || timerStatus === "paused";
  const activeFilterTag = allTags.find((t) => t.id === activeTagFilter);
  const { groupedData, expandedIssueGroups, expandedDateGroups, toggleIssueGroup, toggleDateGroup } = useGroupExpand(
    sessions,
    activeTagFilter,
  );

  return (
    <aside
      className={styles.sidebar}
      style={{ width: isOpen ? 260 : 48, minWidth: isOpen ? 260 : 48 }}
      data-testid="sidebar"
    >
      {/* Header */}
      <div
        className={styles.header}
        style={{
          justifyContent: isOpen ? "space-between" : "center",
          padding: isOpen ? "12px 12px 8px" : "12px 0",
        }}
      >
        <span className={styles.headerLabel} style={{ opacity: isOpen ? 1 : 0 }}>SESSION PANEL</span>
        <SidebarToggle isOpen={isOpen} onToggle={onToggle} />
      </div>

      {/* Scrollable content — only shown when open */}
      <div className={styles.scroll} style={{ display: isOpen ? "flex" : "none" }}>
        {/* Current session */}
        <div className={styles.section}>
          <div className={styles.sectionLabel}>CURRENT SESSION</div>
          <div className={styles.statusRow}>
            <span className={styles.statusDot} style={{ backgroundColor: timerStatusColor(timerStatus) }} />
            <span className={styles.statusText} style={{ color: timerStatusColor(timerStatus) }}>
              {timerStatusLabel(timerStatus)}
            </span>
            {isActive && <span className={styles.remainingText}>{formatSeconds(remainingSeconds)}</span>}
          </div>
          {isActive && (
            <div>
              <div className={styles.tagsLabel}>Tags</div>
              <TagPicker
                allTags={allTags}
                selectedTagIds={pendingTagIds}
                onAdd={onPendingTagAdd}
                onRemove={onPendingTagRemove}
              />
            </div>
          )}
        </div>

        {/* History */}
        <div className={styles.section}>
          <div className={styles.sectionLabel}>HISTORY</div>

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
          {!isLoading && sessions.length === 0 && <div className={styles.emptyMsg}>No sessions yet</div>}

          {/* Issue groups */}
          {groupedData.issueGroups.map((group) => {
            const issueKey = group.issueKey.key;
            const isIssueExpanded = expandedIssueGroups.has(issueKey);
            return (
              <IssueGroupHeader
                key={issueKey}
                group={group}
                isExpanded={isIssueExpanded}
                onToggle={() => toggleIssueGroup(issueKey)}
                compact={true}
              >
                {group.dateSubGroups.map((subGroup) => {
                  const dateGroupKey = `${issueKey}::${subGroup.dateKey}`;
                  const isDateExpanded = expandedDateGroups.has(dateGroupKey);
                  return (
                    <DateSubGroupHeader
                      key={subGroup.dateKey}
                      subGroup={subGroup}
                      isExpanded={isDateExpanded}
                      onToggle={() => toggleDateGroup(dateGroupKey)}
                      compact={true}
                    >
                      {subGroup.sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          allTags={allTags}
                          onDelete={onDeleteSession}
                          onAssign={onAssignTag}
                          onUnassign={onUnassignTag}
                        />
                      ))}
                    </DateSubGroupHeader>
                  );
                })}
              </IssueGroupHeader>
            );
          })}

          {/* Ungrouped sessions (no linked issue) */}
          {groupedData.ungroupedSessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              allTags={allTags}
              onDelete={onDeleteSession}
              onAssign={onAssignTag}
              onUnassign={onUnassignTag}
            />
          ))}

          {sessions.length < total && (
            <button className={styles.loadMoreBtn} onClick={onLoadMore}>
              Load more ({total - sessions.length} remaining)
            </button>
          )}
        </div>

        {/* Tags management */}
        <div className={styles.section}>
          <div className={styles.sectionLabel}>TAGS</div>
          <TagManager
            tags={allTags}
            onCreateTag={onCreateTag}
            onUpdateTag={onUpdateTag}
            onDeleteTag={onDeleteTag}
          />
        </div>
      </div>
    </aside>
  );
}

interface SessionRowProps {
  session: Session;
  allTags: Tag[];
  onDelete: (id: string) => void;
  onAssign: (sessionId: string, tagId: number) => Promise<void>;
  onUnassign: (sessionId: string, tagId: number) => Promise<void>;
}

function SessionRow({ session, allTags, onDelete, onAssign, onUnassign }: SessionRowProps) {
  const assignedTagIds = session.tags.map((t) => t.id);

  return (
    <div className={styles.row}>
      <div className={styles.rowTop}>
        <span className={styles.rowDuration}>{formatDuration(session.actualDurationSeconds)}</span>
        <span className={styles.rowDate}>{formatDate(session.completedAt)}</span>
        <button className={styles.rowDelBtn} onClick={() => onDelete(session.id)} aria-label="Delete session">
          ✕
        </button>
      </div>
      {session.title && <div className={styles.rowTitle}>{session.title}</div>}
      <div className={styles.rowTags}>
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
