// src/renderer/src/components/IssuePromptDialog.tsx
// Modal dialog for selecting an issue when starting a stopwatch session

import { useEffect, useState } from "react";
import type { IssueRef, JiraIssue, LinearIssue } from "../../../shared/types.ts";
import styles from "./IssuePromptDialog.module.scss";

interface IssuePromptDialogProps {
  onSelect: (issue: IssueRef) => void;
  onSkip: () => void;
}

export function IssuePromptDialog({ onSelect, onSkip }: IssuePromptDialogProps) {
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([]);
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasLinear, setHasLinear] = useState(false);
  const [hasJira, setHasJira] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [linearStatus, jiraStatus] = await Promise.all([
          window.electronAPI.linear.providerStatus(),
          window.electronAPI.jira.providerStatus(),
        ]);

        if (cancelled) return;
        setHasLinear(linearStatus.configured && linearStatus.teamSelected);
        setHasJira(jiraStatus.configured);

        const fetches: Promise<void>[] = [];
        if (linearStatus.configured && linearStatus.teamSelected) {
          fetches.push(
            window.electronAPI.linear.fetchIssues({}).then((issues) => {
              if (!cancelled) setLinearIssues(issues);
            }),
          );
        }
        if (jiraStatus.configured) {
          fetches.push(
            window.electronAPI.jira.fetchIssues({}).then((issues) => {
              if (!cancelled) setJiraIssues(issues);
            }),
          );
        }
        await Promise.all(fetches);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load issues");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLinearSelect = (issue: LinearIssue) => {
    onSelect({
      provider: "linear",
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    });
  };

  const handleJiraSelect = (issue: JiraIssue) => {
    onSelect({
      provider: "jira",
      key: issue.key,
      title: issue.title,
      url: issue.url,
    });
  };

  const noProviders = !hasLinear && !hasJira;

  return (
    <div className={styles.overlay} onClick={onSkip}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>Link an issue (optional)</h3>
          <button className={styles.skipBtn} onClick={onSkip}>Skip</button>
        </div>

        {loading && <div className={styles.status}>Loading issues...</div>}
        {error && <div className={styles.error}>{error}</div>}

        {!loading && noProviders && (
          <div className={styles.status}>
            No issue providers configured. Set up Linear or Jira in Settings.
          </div>
        )}

        {!loading && !noProviders && (
          <div className={styles.issueList}>
            {linearIssues.map((issue) => (
              <button
                key={issue.id}
                className={styles.issueRow}
                onClick={() => handleLinearSelect(issue)}
              >
                <span className={styles.issueKey}>{issue.identifier}</span>
                <span className={styles.issueRowTitle}>{issue.title}</span>
              </button>
            ))}
            {jiraIssues.map((issue) => (
              <button
                key={issue.id}
                className={styles.issueRow}
                onClick={() => handleJiraSelect(issue)}
              >
                <span className={styles.issueKey}>{issue.key}</span>
                <span className={styles.issueRowTitle}>{issue.title}</span>
              </button>
            ))}
            {linearIssues.length === 0 && jiraIssues.length === 0 && (
              <div className={styles.status}>No issues found.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
