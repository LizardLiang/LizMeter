// src/renderer/src/components/IssuePickerDropdown.tsx
// Issue picker for the Timer page — select an issue to link before starting

import { useEffect, useRef, useState } from "react";
import type { Issue } from "../../../shared/types.ts";
import { useIssues } from "../hooks/useIssues.ts";
import styles from "./IssuePickerDropdown.module.scss";

interface Props {
  selectedIssue: Issue | null;
  onSelect: (issue: Issue | null) => void;
}

export function IssuePickerDropdown({ selectedIssue, onSelect }: Props) {
  const { issues, status, isLoading } = useIssues();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  // Focus search input when dropdown opens (no setState in effect)
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [open]);

  if (!status.configured) return null;

  const filtered = issues.filter((issue) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return issue.title.toLowerCase().includes(s) || String(issue.number).includes(s);
  });

  function handleSelect(issue: Issue) {
    onSelect(issue);
    setOpen(false);
    setSearch("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && focusedIndex >= 0) {
      const issue = filtered[focusedIndex];
      if (issue) handleSelect(issue);
    }
  }

  if (selectedIssue) {
    return (
      <div className={styles.selected}>
        <span className={styles.selectedLabel}>
          <span className={styles.selectedNum}>#{selectedIssue.number}</span>
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
          <div className={styles.list}>
            {isLoading && <div className={styles.hint}>Loading…</div>}
            {!isLoading && filtered.length === 0 && (
              <div className={styles.hint}>{search ? "No matching issues" : "No open issues"}</div>
            )}
            {filtered.map((issue, i) => (
              <button
                key={issue.number}
                className={i === focusedIndex ? styles.itemFocused : styles.item}
                onClick={() => handleSelect(issue)}
                onMouseEnter={() => setFocusedIndex(i)}
              >
                <span className={styles.itemNum}>#{issue.number}</span>
                <span className={styles.itemTitle}>{issue.title}</span>
                <span className={styles.itemRepo}>{issue.repo}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
