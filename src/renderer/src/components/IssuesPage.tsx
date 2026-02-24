// src/renderer/src/components/IssuesPage.tsx
// Browse GitHub and/or Linear issues

import { useCallback, useState } from "react";
import type { IssueComment, JiraIssue, LinearIssue } from "../../../shared/types.ts";
import { useIssues } from "../hooks/useIssues.ts";
import { useJiraIssues } from "../hooks/useJiraIssues.ts";
import { useLinearIssues } from "../hooks/useLinearIssues.ts";
import styles from "./IssuesPage.module.scss";
import type { NavPage } from "./NavSidebar.tsx";
import { ProviderTabs } from "./ProviderTabs.tsx";
import type { ProviderTabId } from "./ProviderTabs.tsx";

interface Props {
  onNavigate: (page: NavPage) => void;
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function CommentsSection({ comments, isLoading, error }: {
  comments: IssueComment[];
  isLoading: boolean;
  error: string | null;
}) {
  if (isLoading) {
    return <div className={styles.commentsLoading}>Loading comments…</div>;
  }
  if (error) {
    return <div className={styles.commentsError}>{error}</div>;
  }
  if (comments.length === 0) {
    return <div className={styles.commentsEmpty}>No comments yet</div>;
  }
  return (
    <div className={styles.commentsList}>
      {comments.map((c) => (
        <div key={c.id} className={styles.comment}>
          <div className={styles.commentHeader}>
            <span className={styles.commentAuthor}>{c.author}</span>
            <span className={styles.commentDate}>{formatDate(c.createdAt)}</span>
          </div>
          <div className={styles.commentBody}>{c.body}</div>
        </div>
      ))}
    </div>
  );
}

function useComments() {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggle = useCallback(async (
    id: string,
    fetcher: () => Promise<IssueComment[]>,
  ) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setComments([]);
    setError(null);
    setIsLoading(true);
    try {
      const result = await fetcher();
      setComments(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load comments");
    } finally {
      setIsLoading(false);
    }
  }, [expandedId]);

  return { comments, isLoading, error, expandedId, toggle };
}

function LinearIssueList() {
  const { issues, isLoading, error, refresh } = useLinearIssues();
  const [search, setSearch] = useState("");
  const cm = useComments();

  const filtered = issues.filter((issue) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return issue.title.toLowerCase().includes(q) || issue.identifier.toLowerCase().includes(q);
  });

  if (isLoading) {
    return <div className={styles.stateMsg}>Loading issues…</div>;
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <p className={styles.errorMsg}>{error}</p>
        <button className={styles.retryBtn} onClick={refresh}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className={styles.refreshBtn} onClick={refresh} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {issues.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No open issues in this team</p>
          <p className={styles.emptyDesc}>All caught up, or no issues match the active filters.</p>
        </div>
      )}

      {issues.length > 0 && filtered.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No issues match "{search}"</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className={styles.list}>
          {filtered.map((issue) => (
            <LinearIssueCard
              key={issue.id}
              issue={issue}
              expanded={cm.expandedId === issue.id}
              onToggle={() =>
                void cm.toggle(issue.id, () => window.electronAPI.linear.fetchComments({ issueId: issue.id }))}
              comments={cm.comments}
              commentsLoading={cm.isLoading}
              commentsError={cm.error}
            />
          ))}
        </div>
      )}
    </>
  );
}

function LinearIssueCard({ issue, expanded, onToggle, comments, commentsLoading, commentsError }: {
  issue: LinearIssue;
  expanded: boolean;
  onToggle: () => void;
  comments: IssueComment[];
  commentsLoading: boolean;
  commentsError: string | null;
}) {
  const priorityLabel = PRIORITY_LABELS[issue.priority] ?? "No priority";
  const stateColorClass = issue.state.type === "started"
    ? styles.stateStarted
    : issue.state.type === "backlog"
    ? styles.stateBacklog
    : styles.stateUnstarted;

  return (
    <div
      className={`${styles.card} ${expanded ? styles.cardExpanded : ""}`}
      onClick={onToggle}
      style={{ cursor: "pointer" }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onToggle()}
    >
      <div className={styles.cardTop}>
        <span className={styles.issueNum}>{issue.identifier}</span>
        <span className={`${styles.issueState} ${stateColorClass}`}>{issue.state.name}</span>
      </div>
      <p className={styles.issueTitle}>{issue.title}</p>
      {issue.priority > 0 && (
        <div className={styles.labels}>
          <span className={styles.priorityBadge} data-priority={issue.priority}>
            {priorityLabel}
          </span>
        </div>
      )}
      {expanded && (
        <div className={styles.expandedSection} onClick={(e) => e.stopPropagation()}>
          <div className={styles.expandedActions}>
            <button
              className={styles.openExternalBtn}
              onClick={() => void window.electronAPI.shell.openExternal(issue.url)}
            >
              Open in browser
            </button>
          </div>
          <CommentsSection comments={comments} isLoading={commentsLoading} error={commentsError} />
        </div>
      )}
    </div>
  );
}

function JiraIssueList() {
  const { issues, isLoading, error, refresh } = useJiraIssues();
  const [search, setSearch] = useState("");
  const cm = useComments();

  const filtered = issues.filter((issue) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return issue.title.toLowerCase().includes(q) || issue.key.toLowerCase().includes(q);
  });

  if (isLoading) {
    return <div className={styles.stateMsg}>Loading issues…</div>;
  }

  if (error) {
    return (
      <div className={styles.errorState}>
        <p className={styles.errorMsg}>{error}</p>
        <button className={styles.retryBtn} onClick={refresh}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className={styles.refreshBtn} onClick={refresh} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {issues.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No issues found</p>
          <p className={styles.emptyDesc}>Check your project key or JQL filter in Settings.</p>
        </div>
      )}

      {issues.length > 0 && filtered.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No issues match "{search}"</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className={styles.list}>
          {filtered.map((issue) => (
            <JiraIssueCard
              key={issue.id}
              issue={issue}
              expanded={cm.expandedId === issue.id}
              onToggle={() =>
                void cm.toggle(issue.id, () => window.electronAPI.jira.fetchComments({ issueKey: issue.key }))}
              comments={cm.comments}
              commentsLoading={cm.isLoading}
              commentsError={cm.error}
            />
          ))}
        </div>
      )}
    </>
  );
}

function JiraIssueCard({ issue, expanded, onToggle, comments, commentsLoading, commentsError }: {
  issue: JiraIssue;
  expanded: boolean;
  onToggle: () => void;
  comments: IssueComment[];
  commentsLoading: boolean;
  commentsError: string | null;
}) {
  return (
    <div
      className={`${styles.card} ${expanded ? styles.cardExpanded : ""}`}
      onClick={onToggle}
      style={{ cursor: "pointer" }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onToggle()}
    >
      <div className={styles.cardTop}>
        <span className={styles.issueNum}>{issue.key}</span>
        <span className={`${styles.issueState} ${styles.stateStarted}`}>{issue.status}</span>
      </div>
      <p className={styles.issueTitle}>{issue.title}</p>
      <div className={styles.labels}>
        {issue.priority && <span className={styles.priorityBadge}>{issue.priority}</span>}
        {issue.assignee && (
          <span
            className={styles.labelChip}
            style={{ color: "#7aa2f7", backgroundColor: "#7aa2f718", border: "1px solid #7aa2f740" }}
          >
            {issue.assignee}
          </span>
        )}
      </div>
      {expanded && (
        <div className={styles.expandedSection} onClick={(e) => e.stopPropagation()}>
          <div className={styles.expandedActions}>
            <button
              className={styles.openExternalBtn}
              onClick={() => void window.electronAPI.shell.openExternal(issue.url)}
            >
              Open in browser
            </button>
          </div>
          <CommentsSection comments={comments} isLoading={commentsLoading} error={commentsError} />
        </div>
      )}
    </div>
  );
}

function GitHubIssueList({ refreshGitHub, githubLoading, githubError, githubIssues }: {
  refreshGitHub: () => void;
  githubLoading: boolean;
  githubError: string | null;
  githubIssues: import("../../../shared/types.ts").Issue[];
}) {
  const [search, setSearch] = useState("");
  const cm = useComments();

  const filtered = githubIssues.filter((issue) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return issue.title.toLowerCase().includes(q) || issue.repo.toLowerCase().includes(q)
      || `#${issue.number}`.includes(q);
  });

  if (githubLoading) {
    return <div className={styles.stateMsg}>Loading issues…</div>;
  }

  if (githubError) {
    return (
      <div className={styles.errorState}>
        <p className={styles.errorMsg}>{githubError}</p>
        <button className={styles.retryBtn} onClick={refreshGitHub}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className={styles.refreshBtn} onClick={refreshGitHub} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {githubIssues.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No open issues assigned to you</p>
          <p className={styles.emptyDesc}>Visit GitHub to check your assignments.</p>
        </div>
      )}

      {githubIssues.length > 0 && filtered.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No issues match "{search}"</p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className={styles.list}>
          {filtered.map((issue) => {
            const cardId = `${issue.repo}#${issue.number}`;
            return (
              <div
                key={cardId}
                className={`${styles.card} ${cm.expandedId === cardId ? styles.cardExpanded : ""}`}
                onClick={() =>
                  void cm.toggle(cardId, () =>
                    window.electronAPI.issues.fetchComments({ repo: issue.repo, issueNumber: issue.number }))}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) =>
                  e.key === "Enter"
                  && void cm.toggle(cardId, () =>
                    window.electronAPI.issues.fetchComments({ repo: issue.repo, issueNumber: issue.number }))}
              >
                <div className={styles.cardTop}>
                  <span className={styles.issueNum}>#{issue.number}</span>
                  <span
                    className={`${styles.issueState} ${
                      issue.state === "open" ? styles.stateStarted : styles.stateBacklog
                    }`}
                  >
                    {issue.state}
                  </span>
                </div>
                <p className={styles.issueTitle}>{issue.title}</p>
                <div className={styles.cardMeta}>
                  <span className={styles.issueRepo}>{issue.repo}</span>
                </div>
                {issue.labels.length > 0 && (
                  <div className={styles.labels}>
                    {issue.labels.map((label) => (
                      <span
                        key={label.name}
                        className={styles.labelChip}
                        style={{
                          color: `#${label.color}`,
                          backgroundColor: `#${label.color}18`,
                          border: `1px solid #${label.color}40`,
                        }}
                      >
                        {label.name}
                      </span>
                    ))}
                  </div>
                )}
                {cm.expandedId === cardId && (
                  <div
                    className={styles.expandedSection}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className={styles.expandedActions}>
                      <button
                        className={styles.openExternalBtn}
                        onClick={() =>
                          void window.electronAPI.shell.openExternal(issue.url)}
                      >
                        Open in browser
                      </button>
                    </div>
                    <CommentsSection
                      comments={cm.comments}
                      isLoading={cm.isLoading}
                      error={cm.error}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function IssuesPage({ onNavigate }: Props) {
  const { issues: githubIssues, status, isLoading: githubLoading, error: githubError, refresh: refreshGitHub } =
    useIssues();

  const githubConfigured = status.configured;
  const linearConfigured = status.linearConfigured && status.linearTeamSelected;
  const jiraConfigured = status.jiraConfigured && status.jiraDomainSet;

  // Determine which tabs to show
  const availableProviders: ProviderTabId[] = [];
  if (githubConfigured) availableProviders.push("github");
  if (linearConfigured) availableProviders.push("linear");
  if (jiraConfigured) availableProviders.push("jira");

  const [activeTab, setActiveTab] = useState<ProviderTabId>("github");

  // When none is configured
  if (!githubConfigured && !linearConfigured && !jiraConfigured) {
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>Issues</h1>
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <p className={styles.emptyTitle}>No issue tracker configured</p>
          <p className={styles.emptyDesc}>
            Connect GitHub, Linear, or Jira in Settings to browse and link issues to sessions.
          </p>
          <button className={styles.ctaBtn} onClick={() => onNavigate("settings")}>
            Configure in Settings
          </button>
        </div>
      </div>
    );
  }

  // Determine the effective tab — if only linear is available, always show linear
  const effectiveTab = availableProviders.length === 1
    ? availableProviders[0]!
    : (availableProviders.includes(activeTab) ? activeTab : availableProviders[0]!);

  const showTabs = availableProviders.length > 1;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Issues</h1>
      </div>

      {showTabs && (
        <ProviderTabs
          providers={availableProviders}
          activeProvider={effectiveTab}
          onSwitch={setActiveTab}
        />
      )}

      {effectiveTab === "github" && (
        <GitHubIssueList
          refreshGitHub={refreshGitHub}
          githubLoading={githubLoading}
          githubError={githubError}
          githubIssues={githubIssues}
        />
      )}

      {effectiveTab === "linear" && <LinearIssueList />}

      {effectiveTab === "jira" && <JiraIssueList />}
    </div>
  );
}
