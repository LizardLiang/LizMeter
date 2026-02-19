import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../../shared/types.ts";
import { SessionHistoryItem } from "../SessionHistoryItem.tsx";

const mockSession: Session = {
  id: "test-id-123",
  title: "Focus session",
  timerType: "work",
  plannedDurationSeconds: 1500,
  actualDurationSeconds: 1498,
  completedAt: "2026-02-19T10:00:00.000Z",
};

describe("TC-323: SessionHistoryItem shows delete button and calls onDelete", () => {
  it("renders delete button and calls onDelete with session id", () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionHistoryItem session={mockSession} onDelete={onDelete} />);

    const deleteBtn = within(container).getByRole("button", { name: /delete/i });
    expect(deleteBtn).toBeInTheDocument();

    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith("test-id-123");
  });

  it("displays session title", () => {
    const onDelete = vi.fn();
    const { container } = render(<SessionHistoryItem session={mockSession} onDelete={onDelete} />);
    expect(within(container).getByText("Focus session")).toBeInTheDocument();
  });
});
