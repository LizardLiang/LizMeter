// src/renderer/src/components/__tests__/NewSessionNotification.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeSessionPreview } from "../../../../shared/types.ts";
import { NewSessionNotification } from "../NewSessionNotification.tsx";

afterEach(() => {
  cleanup();
});

const mockSession: ClaudeCodeSessionPreview = {
  ccSessionUuid: "a3f2b1c8-0000-0000-0000-000000000001",
  lastActivityAt: new Date().toISOString(),
  firstUserMessage: "Fix the login bug",
  filePath: "/home/user/.claude/projects/MyProject/a3f2b1c8.jsonl",
};

describe("NewSessionNotification: renders correctly", () => {
  it("shows 'New CC session detected' text", () => {
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("New CC session detected")).toBeInTheDocument();
  });

  it("renders Add button", () => {
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Add/i })).toBeInTheDocument();
  });

  it("renders dismiss button", () => {
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Dismiss/i })).toBeInTheDocument();
  });
});

describe("NewSessionNotification: button interactions", () => {
  it("calls onAdd with the session when Add is clicked", () => {
    const onAdd = vi.fn();
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={onAdd}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add/i }));
    expect(onAdd).toHaveBeenCalledWith(mockSession);
  });

  it("calls onDismiss when dismiss button is clicked", () => {
    const onDismiss = vi.fn();
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("NewSessionNotification: auto-dismiss", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses after 30 seconds", () => {
    const onDismiss = vi.fn();
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not auto-dismiss before 30 seconds", () => {
    const onDismiss = vi.fn();
    render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    vi.advanceTimersByTime(29_999);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("clears timeout on unmount (no call after unmount)", () => {
    const onDismiss = vi.fn();
    const { unmount } = render(
      <NewSessionNotification
        session={mockSession}
        onAdd={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    unmount();
    vi.advanceTimersByTime(30_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
