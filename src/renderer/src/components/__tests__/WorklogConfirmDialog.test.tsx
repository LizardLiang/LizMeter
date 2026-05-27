import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import type { Session } from "../../../../shared/types.ts";
import { WorklogConfirmDialog } from "../WorklogConfirmDialog.tsx";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: `Session ${id}`,
    timerType: "work",
    plannedDurationSeconds: 1500,
    actualDurationSeconds: 1500,
    completedAt: new Date().toISOString(),
    tags: [],
    issueNumber: null,
    issueTitle: null,
    issueUrl: null,
    issueProvider: "jira",
    issueId: "PROJ-1",
    worklogStatus: "not_logged",
    worklogId: null,
    ...overrides,
  };
}

// Return a datetime-local string (YYYY-MM-DDTHH:MM) offset by `offsetSeconds`
// from a given ISO timestamp, for use with fireEvent.change on datetime-local inputs.
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// Default props factory
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<Parameters<typeof WorklogConfirmDialog>[0]> = {}) {
  return {
    issueKey: "PROJ-1",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorklogConfirmDialog — single session mode", () => {
  let session: Session;

  beforeEach(() => {
    // Use a fixed completedAt 25 minutes in the past so actualDurationSeconds
    // (1500 s = 25 min) produces a valid, non-zero duration >= 60 s.
    const completedAt = new Date(Date.now() - 1500 * 1000).toISOString();
    session = makeSession("s1", { completedAt });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 1 — title
  it("renders 'Log Work to PROJ-1' title", () => {
    render(<WorklogConfirmDialog {...makeProps({ session })} />);
    expect(screen.getByText(/Log Work to PROJ-1/)).toBeInTheDocument();
  });

  // Test 2 — description is <input type="text">, not textarea
  it("renders description as <input type='text'> not a textarea", () => {
    const { container } = render(<WorklogConfirmDialog {...makeProps({ session })} />);
    const descInput = container.querySelector("input[type='text']");
    expect(descInput).not.toBeNull();
    const textareas = container.querySelectorAll("textarea");
    expect(textareas.length).toBe(0);
  });

  // Test 3 — confirm button enabled when times are valid
  it("Confirm button is NOT disabled when times are valid", () => {
    render(<WorklogConfirmDialog {...makeProps({ session })} />);
    const confirmBtn = screen.getByRole("button", { name: /Log Work/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  // Test 4 — clicking Confirm calls onConfirm with correct shape
  it("clicking Confirm calls onConfirm with startTime, endTime, description, selectedSessionIds", () => {
    const onConfirm = vi.fn();
    render(<WorklogConfirmDialog {...makeProps({ session, onConfirm })} />);
    const confirmBtn = screen.getByRole("button", { name: /Log Work/i });
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledOnce();
    const arg = onConfirm.mock.calls[0]![0];
    expect(arg).toMatchObject({
      startTime: expect.any(String),
      endTime: expect.any(String),
      description: expect.any(String),
      selectedSessionIds: ["s1"],
    });
  });

  // Test 5 — clicking Cancel calls onCancel
  it("clicking Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(<WorklogConfirmDialog {...makeProps({ session, onCancel })} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  // Test 6 — isRelog=true shows warning banner mentioning "duplicate"
  it("isRelog=true shows warning banner mentioning 'duplicate'", () => {
    render(<WorklogConfirmDialog {...makeProps({ session, isRelog: true })} />);
    const banner = screen.getByText(/duplicate/i);
    expect(banner).toBeInTheDocument();
  });

  // Test 7 — isRelog=true changes confirm button text to "Re-log Work"
  it("isRelog=true changes confirm button text to 'Re-log Work'", () => {
    render(<WorklogConfirmDialog {...makeProps({ session, isRelog: true })} />);
    expect(screen.getByRole("button", { name: /Re-log Work/i })).toBeInTheDocument();
  });

  // Test 8 — pressing Escape calls onCancel
  it("pressing Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(<WorklogConfirmDialog {...makeProps({ session, onCancel })} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("WorklogConfirmDialog — bulk session mode", () => {
  let sessions: Session[];

  beforeEach(() => {
    // Two work sessions completed one after the other, each 1500 s long.
    const now = Date.now();
    sessions = [
      makeSession("s1", {
        title: "Session One",
        completedAt: new Date(now - 3000 * 1000).toISOString(),
        actualDurationSeconds: 1500,
      }),
      makeSession("s2", {
        title: "Session Two",
        completedAt: new Date(now - 1500 * 1000).toISOString(),
        actualDurationSeconds: 1500,
      }),
    ];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 9 — title shows session count
  it("shows session count in title: 'Log Work to PROJ-1 (2/2 sessions)'", () => {
    render(<WorklogConfirmDialog {...makeProps({ session: sessions })} />);
    expect(screen.getByText(/Log Work to PROJ-1 \(2\/2 sessions\)/)).toBeInTheDocument();
  });

  // Test 10 — renders a checkbox for each session
  it("renders a checkbox for each session", () => {
    render(<WorklogConfirmDialog {...makeProps({ session: sessions })} />);
    // The session list rows each have a checkbox; there's also the "Select all" checkbox.
    // We look for the session title labels which contain a checkbox.
    const sessionTitles = [screen.getByText("Session One"), screen.getByText("Session Two")];
    for (const title of sessionTitles) {
      // Each session title is inside a <label> that also contains a checkbox
      const row = title.closest("label");
      expect(row).not.toBeNull();
      const checkbox = within(row!).getByRole("checkbox");
      expect(checkbox).toBeInTheDocument();
    }
  });

  // Test 11 — "Select all" checkbox toggles all sessions
  it("\"Select all\" checkbox deselects all sessions when all are selected", () => {
    render(<WorklogConfirmDialog {...makeProps({ session: sessions })} />);

    // All sessions start selected — title shows 2/2
    expect(screen.getByText(/\(2\/2 sessions\)/)).toBeInTheDocument();

    // Find the Select all checkbox by its label text
    const selectAllLabel = screen.getByText(/Select all/i).closest("label");
    expect(selectAllLabel).not.toBeNull();
    const selectAllCheckbox = within(selectAllLabel!).getByRole("checkbox");

    // Uncheck Select All → deselects all
    fireEvent.click(selectAllCheckbox);
    expect(screen.getByText(/\(0\/2 sessions\)/)).toBeInTheDocument();

    // Check Select All again → re-selects all
    fireEvent.click(selectAllCheckbox);
    expect(screen.getByText(/\(2\/2 sessions\)/)).toBeInTheDocument();
  });

  // Test 12 — deselecting a session reduces count in title
  it("deselecting a session reduces count in title to '1/2 sessions'", () => {
    render(<WorklogConfirmDialog {...makeProps({ session: sessions })} />);

    // Find checkbox for Session One and uncheck it
    const sessionOneLabel = screen.getByText("Session One").closest("label");
    expect(sessionOneLabel).not.toBeNull();
    const sessionOneCheckbox = within(sessionOneLabel!).getByRole("checkbox");
    fireEvent.click(sessionOneCheckbox);

    expect(screen.getByText(/\(1\/2 sessions\)/)).toBeInTheDocument();
  });

  // Test 13 — when no uploadable sessions selected, Confirm is disabled
  it("Confirm is disabled when no uploadable sessions are selected", () => {
    render(<WorklogConfirmDialog {...makeProps({ session: sessions })} />);

    // Deselect all via Select All toggle
    const selectAllLabel = screen.getByText(/Select all/i).closest("label");
    const selectAllCheckbox = within(selectAllLabel!).getByRole("checkbox");
    fireEvent.click(selectAllCheckbox);

    const confirmBtn = screen.getByRole("button", { name: /Log Work/i });
    expect(confirmBtn).toBeDisabled();
  });

  // Test 14 — onConfirm includes only selected session IDs
  it("clicking Confirm includes only selected session IDs in the onConfirm call", () => {
    const onConfirm = vi.fn();
    render(<WorklogConfirmDialog {...makeProps({ session: sessions, onConfirm })} />);

    // Deselect Session Two
    const sessionTwoLabel = screen.getByText("Session Two").closest("label");
    expect(sessionTwoLabel).not.toBeNull();
    const sessionTwoCheckbox = within(sessionTwoLabel!).getByRole("checkbox");
    fireEvent.click(sessionTwoCheckbox);

    // Confirm — only s1 should be included
    const confirmBtn = screen.getByRole("button", { name: /Log Work/i });
    fireEvent.click(confirmBtn);

    expect(onConfirm).toHaveBeenCalledOnce();
    const arg = onConfirm.mock.calls[0]![0];
    expect(arg.selectedSessionIds).toContain("s1");
    expect(arg.selectedSessionIds).not.toContain("s2");
  });

  // Test — bulk mode renders description as textarea, not input
  it("renders description as <textarea> in bulk mode", () => {
    const { container } = render(<WorklogConfirmDialog {...makeProps({ session: sessions })} />);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
  });
});

describe("WorklogConfirmDialog — validation", () => {
  let session: Session;

  beforeEach(() => {
    const completedAt = new Date(Date.now() - 1500 * 1000).toISOString();
    session = makeSession("s1", { completedAt });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Test 15 — validation error when end time equals start time
  it("shows validation error and disables Confirm when end time equals start time", () => {
    const { container } = render(<WorklogConfirmDialog {...makeProps({ session })} />);

    // Grab the two datetime-local inputs; first = Start Time, second = End Time
    const timeInputs = container.querySelectorAll("input[type='datetime-local']");
    expect(timeInputs.length).toBeGreaterThanOrEqual(2);

    const startInput = timeInputs[0]!;
    const endInput = timeInputs[1]!;

    // Set both to the same value (same as start)
    const sameValue = toDatetimeLocal(new Date(Date.now() - 1500 * 1000).toISOString());
    fireEvent.change(startInput, { target: { value: sameValue } });
    fireEvent.change(endInput, { target: { value: sameValue } });

    // Validation error text should appear
    expect(screen.getByText(/end time must be after start time/i)).toBeInTheDocument();

    // Confirm button must be disabled
    const confirmBtn = screen.getByRole("button", { name: /Log Work/i });
    expect(confirmBtn).toBeDisabled();
  });
});

describe("WorklogConfirmDialog — overlay and Escape", () => {
  let session: Session;

  beforeEach(() => {
    const completedAt = new Date(Date.now() - 1500 * 1000).toISOString();
    session = makeSession("s1", { completedAt });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clicking the overlay backdrop calls onCancel", () => {
    const onCancel = vi.fn();
    const { container } = render(<WorklogConfirmDialog {...makeProps({ session, onCancel })} />);
    // The overlay is the outermost div rendered by the component
    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
