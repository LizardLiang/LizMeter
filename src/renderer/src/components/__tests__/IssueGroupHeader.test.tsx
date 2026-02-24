import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IssueGroup } from "../../utils/groupSessions.ts";
import { IssueGroupHeader } from "../IssueGroupHeader.tsx";

function makeIssueGroup(overrides: Partial<IssueGroup> = {}): IssueGroup {
  return {
    issueKey: {
      key: "github:42",
      provider: "github",
      displayId: "#42",
      title: "Fix the bug",
      url: "https://github.com/owner/repo/issues/42",
    },
    totalSeconds: 3600,
    sessionCount: 3,
    dateSubGroups: [],
    latestCompletedAt: "2026-02-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("IssueGroupHeader", () => {
  it("renders display ID and title", () => {
    const group = makeIssueGroup();
    const { container } = render(
      <IssueGroupHeader group={group} isExpanded={false} onToggle={vi.fn()} />,
    );
    expect(within(container).getByText("#42")).toBeInTheDocument();
    expect(within(container).getByText("Fix the bug")).toBeInTheDocument();
  });

  it("renders total time and session count", () => {
    const group = makeIssueGroup({ totalSeconds: 3660, sessionCount: 3 });
    const { container } = render(
      <IssueGroupHeader group={group} isExpanded={false} onToggle={vi.fn()} />,
    );
    // 3660 seconds = 1h 1m
    expect(container.textContent).toContain("1h 1m");
    expect(container.textContent).toContain("3 sessions");
  });

  it("uses singular 'session' for sessionCount of 1", () => {
    const group = makeIssueGroup({ sessionCount: 1 });
    const { container } = render(
      <IssueGroupHeader group={group} isExpanded={false} onToggle={vi.fn()} />,
    );
    expect(container.textContent).toContain("1 session");
    expect(container.textContent).not.toContain("1 sessions");
  });

  it("calls onToggle when header is clicked", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <IssueGroupHeader group={makeIssueGroup()} isExpanded={false} onToggle={onToggle} />,
    );
    const header = container.querySelector("[data-testid='issue-group-header']")!;
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle on Enter key press", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <IssueGroupHeader group={makeIssueGroup()} isExpanded={false} onToggle={onToggle} />,
    );
    const header = container.querySelector("[data-testid='issue-group-header']")!;
    fireEvent.keyDown(header, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle on Space key press", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <IssueGroupHeader group={makeIssueGroup()} isExpanded={false} onToggle={onToggle} />,
    );
    const header = container.querySelector("[data-testid='issue-group-header']")!;
    fireEvent.keyDown(header, { key: " " });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("has aria-expanded=false when collapsed", () => {
    const { container } = render(
      <IssueGroupHeader group={makeIssueGroup()} isExpanded={false} onToggle={vi.fn()} />,
    );
    const header = container.querySelector("[data-testid='issue-group-header']")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("has aria-expanded=true when expanded", () => {
    const { container } = render(
      <IssueGroupHeader group={makeIssueGroup()} isExpanded={true} onToggle={vi.fn()} />,
    );
    const header = container.querySelector("[data-testid='issue-group-header']")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders children when expanded", () => {
    const { container } = render(
      <IssueGroupHeader group={makeIssueGroup()} isExpanded={true} onToggle={vi.fn()}>
        <div data-testid="child-content">Child content</div>
      </IssueGroupHeader>,
    );
    expect(within(container).getByTestId("child-content")).toBeInTheDocument();
  });

  it("does not show title when issueKey.title is null", () => {
    const group = makeIssueGroup({
      issueKey: {
        key: "github:42",
        provider: "github",
        displayId: "#42",
        title: null,
        url: null,
      },
    });
    const { container } = render(
      <IssueGroupHeader group={group} isExpanded={false} onToggle={vi.fn()} />,
    );
    expect(within(container).getByText("#42")).toBeInTheDocument();
    // No title text
    expect(container.textContent).not.toContain("Fix");
  });
});
