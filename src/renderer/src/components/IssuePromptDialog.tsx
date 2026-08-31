// src/renderer/src/components/IssuePromptDialog.tsx
// Modal dialog for selecting an issue when starting a stopwatch session

import { useEffect, useState } from "react";
import type { IssueRef, JiraIssue, LinearIssue, Todo } from "../../../shared/types.ts";
import styles from "./IssuePromptDialog.module.scss";
import { TodoIssuePicker } from "./TodoIssuePicker.tsx";

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

  const handleTodoSelect = (todo: Todo) => {
    onSelect({ provider: "todo", id: todo.id, title: todo.title });
  };

  // The Todo section is always available (no config needed), so this only gates the
  // external-tracker section below it -- GitHub stays excluded here, pre-existing and unrelated.
  const noProviders = !hasLinear && !hasJira;

  return (
    <div className={styles.overlay} onClick={onSkip}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>Link an issue (optional)</h3>
          <button className={styles.skipBtn} onClick={onSkip}>Skip</button>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        {/* Todos are always available (no config needed) -- never gated on the Linear/Jira fetches below, which have no timeout. */}
        <div className={styles.issueList}>
          <div className={styles.sectionLabel}>Todos</div>
          <TodoIssuePicker onSelect={handleTodoSelect} />

          {loading && <div className={styles.status}>Loading issues...</div>}
          {!loading && (
            <>
              <div className={styles.sectionLabel}>Issue trackers</div>
              {noProviders && (
                <div className={styles.status}>
                  No issue providers configured. Set up Linear or Jira in Settings.
                </div>
              )}
              {!noProviders && (
                <>
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
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
