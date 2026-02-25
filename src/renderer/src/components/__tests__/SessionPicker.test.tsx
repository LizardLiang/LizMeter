// src/renderer/src/components/__tests__/SessionPicker.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeSessionPreview } from "../../../../shared/types.ts";
import { SessionPicker } from "../SessionPicker.tsx";

afterEach(() => {
  cleanup();
});

function makeSession(overrides: Partial<ClaudeCodeSessionPreview> = {}): ClaudeCodeSessionPreview {
  return {
    ccSessionUuid: "a3f2b1c8-0000-0000-0000-000000000001",
    lastActivityAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min ago
    firstUserMessage: "Fix the login bug",
    filePath: "/home/user/.claude/projects/MyProject/a3f2b1c8.jsonl",
    ...overrides,
  };
}

const baseProps = {
  sessions: [],
  pickerState: "open" as const,
  trackedUuids: [],
  onConfirm: vi.fn(),
  onSkip: vi.fn(),
  onToggleCollapse: vi.fn(),
};

describe("SessionPicker: loading state", () => {
  it("shows scanning text when pickerState is loading", () => {
    render(<SessionPicker {...baseProps} pickerState="loading" />);
    expect(screen.getByText(/Scanning for Claude Code sessions/i)).toBeInTheDocument();
  });
});

describe("SessionPicker: hidden state", () => {
  it("renders nothing when pickerState is hidden", () => {
    const { container } = render(<SessionPicker {...baseProps} pickerState="hidden" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("SessionPicker: empty state", () => {
  it("shows no active sessions message and Skip button only", () => {
    render(<SessionPicker {...baseProps} sessions={[]} />);
    expect(screen.getByText(/No active sessions found/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Skip/i })).toBeInTheDocument();
  });
});

describe("SessionPicker: session list display", () => {
  it("renders session UUID (first 8 chars) and first user message", () => {
    const session = makeSession({
      ccSessionUuid: "a3f2b1c8-extra-chars",
      firstUserMessage: "Fix the login bug",
    });
    render(<SessionPicker {...baseProps} sessions={[session]} />);
    expect(screen.getByText("a3f2b1c8")).toBeInTheDocument(); // first 8 chars of UUID
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
  });

  it("shows (no preview available) for null firstUserMessage", () => {
    const session = makeSession({ firstUserMessage: null });
    render(<SessionPicker {...baseProps} sessions={[session]} />);
    expect(screen.getByText("(no preview available)")).toBeInTheDocument();
  });

  it("shows relative time for recent session", () => {
    const session = makeSession({
      lastActivityAt: new Date(Date.now() - 30 * 1000).toISOString(), // 30s ago
    });
    render(<SessionPicker {...baseProps} sessions={[session]} />);
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  it("shows X min ago for older sessions", () => {
    const session = makeSession({
      lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
    });
    render(<SessionPicker {...baseProps} sessions={[session]} />);
    expect(screen.getByText("2 min ago")).toBeInTheDocument();
  });

  it("renders multiple sessions", () => {
    const sessions = [
      makeSession({ ccSessionUuid: "aaaa1111-0000", firstUserMessage: "Message A" }),
      makeSession({ ccSessionUuid: "bbbb2222-0000", firstUserMessage: "Message B" }),
    ];
    render(<SessionPicker {...baseProps} sessions={sessions} />);
    expect(screen.getByText("Message A")).toBeInTheDocument();
    expect(screen.getByText("Message B")).toBeInTheDocument();
  });
});

describe("SessionPicker: checkbox interaction", () => {
  it("starts with no sessions selected when trackedUuids is empty", () => {
    const session = makeSession();
    render(<SessionPicker {...baseProps} sessions={[session]} trackedUuids={[]} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
  });

  it("pre-checks sessions that are in trackedUuids", () => {
    const session = makeSession({ ccSessionUuid: "abc123-0000" });
    render(
      <SessionPicker
        {...baseProps}
        sessions={[session]}
        trackedUuids={["abc123-0000"]}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });

  it("toggles checkbox on direct checkbox click", () => {
    const session = makeSession({ ccSessionUuid: "toggle-uuid-00", firstUserMessage: "Test" });
    render(<SessionPicker {...baseProps} sessions={[session]} trackedUuids={[]} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    // Click the checkbox directly
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("untogles checkbox on second row click", () => {
    const session = makeSession({ ccSessionUuid: "toggle-uuid-01", firstUserMessage: "Toggle" });
    render(
      <SessionPicker
        {...baseProps}
        sessions={[session]}
        trackedUuids={["toggle-uuid-01"]}
      />,
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });
});

describe("SessionPicker: Confirm button", () => {
  it("shows disabled Confirm when no sessions selected", () => {
    render(<SessionPicker {...baseProps} sessions={[makeSession()]} trackedUuids={[]} />);
    const confirmBtn = screen.getByRole("button", { name: /Confirm/i });
    expect(confirmBtn).toBeDisabled();
  });

  it("shows Confirm (N) with selected count", () => {
    const session = makeSession({ ccSessionUuid: "confirm-uuid-01" });
    render(
      <SessionPicker
        {...baseProps}
        sessions={[session]}
        trackedUuids={["confirm-uuid-01"]}
      />,
    );
    expect(screen.getByRole("button", { name: /Confirm \(1\)/i })).toBeInTheDocument();
  });

  it("calls onConfirm with selected UUIDs on Confirm click", () => {
    const onConfirm = vi.fn();
    const session = makeSession({ ccSessionUuid: "confirm-uuid-02" });
    render(
      <SessionPicker
        {...baseProps}
        sessions={[session]}
        trackedUuids={["confirm-uuid-02"]}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith(["confirm-uuid-02"]);
  });
});

describe("SessionPicker: Skip button", () => {
  it("calls onSkip when Skip is clicked", () => {
    const onSkip = vi.fn();
    render(<SessionPicker {...baseProps} sessions={[makeSession()]} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: /Skip/i }));
    expect(onSkip).toHaveBeenCalled();
  });
});

describe("SessionPicker: collapsed state", () => {
  it("shows collapsed header with tracked count", () => {
    render(
      <SessionPicker
        {...baseProps}
        pickerState="collapsed"
        trackedUuids={["uuid-1", "uuid-2"]}
      />,
    );
    expect(screen.getByText(/2 tracked/i)).toBeInTheDocument();
  });

  it("shows 'No sessions tracked' when no sessions tracked in collapsed state", () => {
    render(
      <SessionPicker
        {...baseProps}
        pickerState="collapsed"
        trackedUuids={[]}
      />,
    );
    expect(screen.getByText(/No sessions tracked/i)).toBeInTheDocument();
  });

  it("calls onToggleCollapse when collapsed header is clicked", () => {
    const onToggleCollapse = vi.fn();
    render(
      <SessionPicker
        {...baseProps}
        pickerState="collapsed"
        onToggleCollapse={onToggleCollapse}
      />,
    );
    // Click the header
    fireEvent.click(screen.getByText(/Claude Code Sessions/i));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it("calls onToggleCollapse when Collapse toggle in open state is clicked", () => {
    const onToggleCollapse = vi.fn();
    render(
      <SessionPicker
        {...baseProps}
        pickerState="open"
        onToggleCollapse={onToggleCollapse}
      />,
    );
    fireEvent.click(screen.getByText(/Claude Code Sessions/i));
    expect(onToggleCollapse).toHaveBeenCalled();
  });
});
