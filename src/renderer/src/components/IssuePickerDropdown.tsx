// src/renderer/src/components/IssuePickerDropdown.tsx
// Issue picker for the Timer page — select an issue to link before starting
// Supports both GitHub Issues and Linear Issues via provider tabs

import { useEffect, useRef, useState } from "react";
import type { Issue, IssueRef, JiraIssue, LinearIssue, Todo } from "../../../shared/types.ts";
import { useIssues } from "../hooks/useIssues.ts";
import { useJiraIssues } from "../hooks/useJiraIssues.ts";
import { useLinearIssues } from "../hooks/useLinearIssues.ts";
import styles from "./IssuePickerDropdown.module.scss";
import { ProviderTabs } from "./ProviderTabs.tsx";
import type { ProviderTabId } from "./ProviderTabs.tsx";
import { TodoIssuePicker } from "./TodoIssuePicker.tsx";

interface Props {
  selectedIssue: IssueRef | null;
  onSelect: (issue: IssueRef | null) => void;
}

export function IssuePickerDropdown({ selectedIssue, onSelect }: Props) {
  const { issues: githubIssues, status, isLoading: githubLoading } = useIssues();
  const { issues: linearIssues, isLoading: linearLoading } = useLinearIssues();
  const { issues: jiraIssues, isLoading: jiraLoading } = useJiraIssues();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [activeTab, setActiveTab] = useState<ProviderTabId>("github");
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const githubConfigured = status.configured;
  const linearConfigured = status.linearConfigured && status.linearTeamSelected;
  const jiraConfigured = status.jiraConfigured && status.jiraDomainSet;

  // The Todo tab is never gated by configuration -- it is always available, unlike
  // github/linear/jira which each require setup in Settings first.
  const externalProviders: ProviderTabId[] = [];
  if (githubConfigured) externalProviders.push("github");
  if (linearConfigured) externalProviders.push("linear");
  if (jiraConfigured) externalProviders.push("jira");
  const availableProviders: ProviderTabId[] = [...externalProviders, "todo"];

  const showTabs = availableProviders.length > 1;

  // When nothing external is configured, Todo is the only tab and becomes the default.
  const effectiveTab = availableProviders.length === 1
    ? availableProviders[0]!
    : (availableProviders.includes(activeTab) ? activeTab : externalProviders[0]!);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  // The Todo tab always renders (it needs no configuration), so this list is never empty.
  const isLoading = effectiveTab === "github"
    ? githubLoading
    : effectiveTab === "linear"
    ? linearLoading
    : effectiveTab === "jira"
    ? jiraLoading
    : false;

  // Filter GitHub issues
  const filteredGitHub = githubIssues.filter((issue) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return issue.title.toLowerCase().includes(s) || String(issue.number).includes(s);
  });

  // Filter Linear issues
  const filteredLinear = linearIssues.filter((issue) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return issue.title.toLowerCase().includes(s) || issue.identifier.toLowerCase().includes(s);
  });

  // Filter Jira issues
  const filteredJira = jiraIssues.filter((issue) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return issue.title.toLowerCase().includes(s) || issue.key.toLowerCase().includes(s);
  });

  function handleSelectGitHub(issue: Issue) {
    onSelect({ provider: "github", number: issue.number, title: issue.title, url: issue.url });
    setOpen(false);
    setSearch("");
  }

  function handleSelectLinear(issue: LinearIssue) {
    onSelect({ provider: "linear", identifier: issue.identifier, title: issue.title, url: issue.url });
    setOpen(false);
    setSearch("");
  }

  function handleSelectJira(issue: JiraIssue) {
    onSelect({ provider: "jira", key: issue.key, title: issue.title, url: issue.url });
    setOpen(false);
    setSearch("");
  }

  function handleSelectTodo(todo: Todo) {
    onSelect({ provider: "todo", id: todo.id, title: todo.title });
    setOpen(false);
    setSearch("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
      return;
    }
    // TodoIssuePicker manages its own arrow-key/Enter navigation and stops propagation for the
    // keys it handles, so this dropdown-level list navigation only applies to the other tabs.
    if (effectiveTab === "todo") return;

    const activeList = effectiveTab === "github"
      ? filteredGitHub
      : effectiveTab === "linear"
      ? filteredLinear
      : filteredJira;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, activeList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && focusedIndex >= 0) {
      if (effectiveTab === "github") {
        const issue = filteredGitHub[focusedIndex];
        if (issue) handleSelectGitHub(issue);
      } else if (effectiveTab === "linear") {
        const issue = filteredLinear[focusedIndex];
        if (issue) handleSelectLinear(issue);
      } else {
        const issue = filteredJira[focusedIndex];
        if (issue) handleSelectJira(issue);
      }
    }
  }

  // Show selected issue trigger
  if (selectedIssue) {
    const displayId = selectedIssue.provider === "linear"
      ? selectedIssue.identifier
      : selectedIssue.provider === "jira"
      ? selectedIssue.key
      : selectedIssue.provider === "todo"
      ? `#${selectedIssue.id}`
      : `#${selectedIssue.number}`;
    return (
      <div className={styles.selected}>
        <span className={styles.selectedLabel}>
          <span className={styles.selectedNum}>{displayId}</span>
          {selectedIssue.title}
        </span>
        <button
          className={styles.clearBtn}
          onClick={() => onSelect(null)}
          aria-label="Unlink issue"
          title="Unlink issue"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={styles.linkBtn}
        onClick={() => {
          setFocusedIndex(-1);
          setOpen((v) => !v);
        }}
        disabled={isLoading}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        Link issue
      </button>

      {open && (
        <div className={styles.dropdown} onKeyDown={handleKeyDown}>
          {effectiveTab !== "todo" && (
            <input
              ref={searchRef}
              className={styles.search}
              type="text"
              placeholder="Search issues…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setFocusedIndex(-1);
              }}
            />
          )}

          {showTabs && (
            <div className={styles.tabsInDropdown}>
              <ProviderTabs
                providers={availableProviders}
                activeProvider={effectiveTab}
                onSwitch={(tab) => {
                  setActiveTab(tab);
                  setFocusedIndex(-1);
                }}
              />
            </div>
          )}

          {effectiveTab === "todo" && <TodoIssuePicker onSelect={handleSelectTodo} />}

          {effectiveTab !== "todo" && (
            <div className={styles.list}>
              {isLoading && <div className={styles.hint}>Loading…</div>}

              {effectiveTab === "github" && !githubLoading && (
                <>
                  {filteredGitHub.length === 0 && (
                    <div className={styles.hint}>{search ? "No matching issues" : "No open issues"}</div>
                  )}
                  {filteredGitHub.map((issue, i) => (
                    <button
                      key={issue.number}
                      className={i === focusedIndex ? styles.itemFocused : styles.item}
                      onClick={() => handleSelectGitHub(issue)}
                      onMouseEnter={() => setFocusedIndex(i)}
                    >
                      <span className={styles.itemNum}>#{issue.number}</span>
                      <span className={styles.itemTitle}>{issue.title}</span>
                      <span className={styles.itemRepo}>{issue.repo}</span>
                    </button>
                  ))}
                </>
              )}

              {effectiveTab === "linear" && !linearLoading && (
                <>
                  {filteredLinear.length === 0 && (
                    <div className={styles.hint}>{search ? "No matching issues" : "No open issues"}</div>
                  )}
                  {filteredLinear.map((issue, i) => (
                    <button
                      key={issue.id}
                      className={i === focusedIndex ? styles.itemFocused : styles.item}
                      onClick={() => handleSelectLinear(issue)}
                      onMouseEnter={() => setFocusedIndex(i)}
                    >
                      <span className={styles.itemNum}>{issue.identifier}</span>
                      <span className={styles.itemTitle}>{issue.title}</span>
                      <span className={styles.itemRepo}>{issue.state.name}</span>
                    </button>
                  ))}
                </>
              )}

              {effectiveTab === "jira" && !jiraLoading && (
                <>
                  {filteredJira.length === 0 && (
                    <div className={styles.hint}>{search ? "No matching issues" : "No issues found"}</div>
                  )}
                  {filteredJira.map((issue, i) => (
                    <button
                      key={issue.id}
                      className={i === focusedIndex ? styles.itemFocused : styles.item}
                      onClick={() => handleSelectJira(issue)}
                      onMouseEnter={() => setFocusedIndex(i)}
                    >
                      <span className={styles.itemNum}>{issue.key}</span>
                      <span className={styles.itemTitle}>{issue.title}</span>
                      <span className={styles.itemRepo}>{issue.status}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
