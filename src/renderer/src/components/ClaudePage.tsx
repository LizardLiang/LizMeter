// src/renderer/src/components/ClaudePage.tsx
// Full detail page for Claude Code tracking data

import { useEffect, useState } from "react";
import type { ClaudeCodeProject } from "../../../shared/types.ts";

export function ClaudePage() {
  const [projects, setProjects] = useState<ClaudeCodeProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.claudeTracker
      .getProjects()
      .then(({ projects: p }) => {
        setProjects(p);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load projects");
        setLoading(false);
      });
  }, []);

  const pageStyle: React.CSSProperties = {
    padding: "24px 28px",
    color: "#c0caf5",
    fontFamily: "inherit",
    maxWidth: 640,
  };

  const headingStyle: React.CSSProperties = {
    fontSize: 22,
    fontWeight: 700,
    color: "#7aa2f7",
    marginBottom: 8,
    marginTop: 0,
  };

  const subheadingStyle: React.CSSProperties = {
    fontSize: 13,
    color: "#565f89",
    marginBottom: 24,
    marginTop: 0,
  };

  const cardStyle: React.CSSProperties = {
    background: "rgba(122, 162, 247, 0.06)",
    border: "1px solid rgba(122, 162, 247, 0.18)",
    borderRadius: 10,
    padding: "14px 18px",
    marginBottom: 10,
  };

  const projectNameStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    color: "#c0caf5",
    marginBottom: 4,
    fontFamily: "monospace",
    wordBreak: "break-all",
  };

  const projectDirStyle: React.CSSProperties = {
    fontSize: 11,
    color: "#565f89",
    fontFamily: "monospace",
    wordBreak: "break-all",
  };

  const emptyStyle: React.CSSProperties = {
    color: "#565f89",
    fontSize: 13,
    padding: "20px 0",
  };

  return (
    <div style={pageStyle}>
      <h1 style={headingStyle}>Claude Code</h1>
      <p style={subheadingStyle}>
        Tracks Claude Code AI coding sessions during your LizMeter timer sessions. Select a project in Settings to
        enable tracking.
      </p>

      <h2 style={{ ...headingStyle, fontSize: 15, color: "#c0caf5", marginBottom: 12 }}>
        Available Projects
      </h2>

      {loading && <div style={emptyStyle}>Loading projects…</div>}
      {error && <div style={{ ...emptyStyle, color: "#f7768e" }}>{error}</div>}

      {!loading && !error && projects.length === 0 && (
        <div style={emptyStyle}>
          No Claude Code projects found. Make sure Claude Code has been used at least once so that project directories
          exist in <code>~/.claude/projects/</code>.
        </div>
      )}

      {!loading && projects.map((project) => (
        <div key={project.dirName} style={cardStyle}>
          <div style={projectNameStyle}>{project.displayPath}</div>
          <div style={projectDirStyle} title={project.dirName}>{project.dirName}</div>
        </div>
      ))}
    </div>
  );
}
