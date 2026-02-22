// src/renderer/src/components/IssuesPage.tsx
// Browse GitHub issues assigned to the authenticated user

import { useIssues } from "../hooks/useIssues.ts";
import styles from "./IssuesPage.module.scss";
import type { NavPage } from "./NavSidebar.tsx";

interface Props {
  onNavigate: (page: NavPage) => void;
}

export function IssuesPage({ onNavigate }: Props) {
  const { issues, status, isLoading, error, refresh } = useIssues();

  if (!status.configured) {
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
          <p className={styles.emptyTitle}>No GitHub token configured</p>
          <p className={styles.emptyDesc}>Connect your GitHub account to browse and link issues to sessions.</p>
          <button className={styles.ctaBtn} onClick={() => onNavigate("settings")}>
            Configure in Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Issues</h1>
        <button className={styles.refreshBtn} onClick={refresh} disabled={isLoading} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {isLoading && <div className={styles.stateMsg}>Loading issues…</div>}
      {error && (
        <div className={styles.errorState}>
          <p className={styles.errorMsg}>{error}</p>
          <button className={styles.retryBtn} onClick={refresh}>Retry</button>
        </div>
      )}

      {!isLoading && !error && issues.length === 0 && (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No open issues assigned to you</p>
          <p className={styles.emptyDesc}>Visit GitHub to check your assignments.</p>
        </div>
      )}

      {!isLoading && !error && issues.length > 0 && (
        <div className={styles.list}>
          {issues.map((issue) => (
            <div key={`${issue.repo}#${issue.number}`} className={styles.card}>
              <div className={styles.cardTop}>
                <span className={styles.issueNum}>#{issue.number}</span>
                <span className={styles.issueRepo}>{issue.repo}</span>
              </div>
              <p className={styles.issueTitle}>{issue.title}</p>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
