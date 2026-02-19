import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../../shared/types.ts";
import { SessionHistory } from "../SessionHistory.tsx";

const mockSessions: Session[] = [
  {
    id: "1",
    title: "Write PRD",
    timerType: "work",
    plannedDurationSeconds: 1500,
    actualDurationSeconds: 1498,
    completedAt: "2026-02-19T10:00:00.000Z",
  },
  {
    id: "2",
    title: "Code review",
    timerType: "short_break",
    plannedDurationSeconds: 300,
    actualDurationSeconds: 298,
    completedAt: "2026-02-19T10:30:00.000Z",
  },
  {
    id: "3",
    title: "",
    timerType: "long_break",
    plannedDurationSeconds: 900,
    actualDurationSeconds: 900,
    completedAt: "2026-02-19T11:00:00.000Z",
  },
];

describe("TC-320: SessionHistory renders list of sessions", () => {
  it("renders all three session items", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <SessionHistory sessions={mockSessions} isLoading={false} error={null} onDelete={onDelete} />,
    );
    expect(within(container).getByText("Write PRD")).toBeInTheDocument();
    expect(within(container).getByText("Code review")).toBeInTheDocument();
    // session with empty title shows (no title)
    expect(within(container).getByText("(no title)")).toBeInTheDocument();
  });
});

describe("TC-321: SessionHistory shows title, duration, type, timestamp per item", () => {
  it("shows all fields for a work session", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <SessionHistory
        sessions={[mockSessions[0]!]}
        isLoading={false}
        error={null}
        onDelete={onDelete}
      />,
    );

    expect(within(container).getByText("Write PRD")).toBeInTheDocument();
    expect(within(container).getByText("25:00")).toBeInTheDocument(); // duration
    expect(within(container).getByText("Work")).toBeInTheDocument(); // timer type
    // Timestamp appears somewhere in the document (locale-agnostic check)
    // The timestamp is formatted via toLocaleString, which varies by system locale
    expect(container.textContent).toMatch(/19|Feb|2月/i);
  });
});

describe("TC-322: SessionHistory shows empty state when no sessions", () => {
  it("shows empty state message", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <SessionHistory sessions={[]} isLoading={false} error={null} onDelete={onDelete} />,
    );
    expect(within(container).getByText(/no sessions yet/i)).toBeInTheDocument();
  });

  it("shows no list items", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <SessionHistory sessions={[]} isLoading={false} error={null} onDelete={onDelete} />,
    );
    expect(within(container).queryByRole("listitem")).toBeNull();
  });
});

// Keep using screen for one test to verify it works properly too
describe("SessionHistory shows loading state", () => {
  it("shows loading text while fetching", () => {
    const onDelete = vi.fn();
    const { container } = render(
      <SessionHistory sessions={[]} isLoading={true} error={null} onDelete={onDelete} />,
    );
    expect(container.textContent).toContain("Loading history");
  });
});
