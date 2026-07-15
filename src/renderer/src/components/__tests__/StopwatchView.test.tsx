import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import type { IssueRef } from "../../../../../shared/types.ts";
import type { UseStopwatchReturn } from "../../hooks/useStopwatch.ts";
import type { StopwatchState } from "../../hooks/useStopwatch.ts";
import { StopwatchView } from "../StopwatchView.tsx";

// vi.mock calls are hoisted to top of file by Vitest

vi.mock("../ClaudeSessionSelect.tsx", () => ({
  ClaudeSessionSelect: () => null,
}));

vi.mock("../IssuePickerDropdown.tsx", () => ({
  IssuePickerDropdown: () => null,
}));

vi.mock("../RichTextInput.tsx", () => ({
  RichTextInput: (
    { onChange, disabled, placeholder }: {
      value: string;
      onChange: (v: string) => void;
      disabled?: boolean;
      placeholder?: string;
    },
  ) => (
    <input
      data-testid="rich-text-input"
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("../IssuePromptDialog.tsx", () => ({
  IssuePromptDialog: ({ onSkip }: { onSelect: (issue: unknown) => void; onSkip: () => void; }) => (
    <div data-testid="issue-prompt-dialog">
      <button onClick={onSkip}>Skip</button>
    </div>
  ),
}));

// --- Helpers ---

function makeIdleState(overrides?: Partial<StopwatchState>): StopwatchState {
  return {
    status: "idle",
    elapsedSeconds: 0,
    title: "",
    linkedIssue: null,
    startedAtWallClock: null,
    accumulatedActiveMs: 0,
    restoredBaseMs: 0,
    restoredSessionId: null,
    ...overrides,
  };
}

function makeStopwatch(overrides?: Partial<UseStopwatchReturn>): UseStopwatchReturn {
  return {
    state: makeIdleState(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    setTitle: vi.fn(),
    setLinkedIssue: vi.fn(),
    restore: vi.fn(),
    saveError: null,
    ...overrides,
  };
}

function renderStopwatchView(stopwatch: UseStopwatchReturn, promptForIssue = false) {
  const onClaudeSessionSelect = vi.fn();
  const { container } = render(
    <StopwatchView
      stopwatch={stopwatch}
      promptForIssue={promptForIssue}
      selectedClaudeSession={null}
      onClaudeSessionSelect={onClaudeSessionSelect}
    />,
  );
  return { container, onClaudeSessionSelect };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// --- TC-SWV-01: Idle state renders Start button ---

describe("TC-SWV-01: Idle state renders Start button", () => {
  it("shows Start button when status is idle", () => {
    const stopwatch = makeStopwatch();
    renderStopwatchView(stopwatch);

    expect(screen.getByRole("button", { name: /^start$/i })).toBeInTheDocument();
  });
});

// --- TC-SWV-02: Start button disabled when title is empty ---

describe("TC-SWV-02: Start button disabled when title is empty", () => {
  it("Start button is disabled when title is empty string (stripHtml returns empty)", () => {
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "" }),
    });
    renderStopwatchView(stopwatch);

    expect(screen.getByRole("button", { name: /^start$/i })).toBeDisabled();
  });
});

// --- TC-SWV-03: Start button enabled when title is not empty ---

describe("TC-SWV-03: Start button enabled when title is not empty", () => {
  it("Start button is enabled when title has content", () => {
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "My task" }),
    });
    renderStopwatchView(stopwatch);

    expect(screen.getByRole("button", { name: /^start$/i })).not.toBeDisabled();
  });
});

// --- TC-SWV-04: Clicking Start (without promptForIssue) calls stopwatch.start() ---

describe("TC-SWV-04: Clicking Start without promptForIssue calls start()", () => {
  it("calls stopwatch.start() directly when promptForIssue is false", () => {
    const start = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "My task" }),
      start,
    });
    renderStopwatchView(stopwatch, false);

    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(start).toHaveBeenCalledOnce();
  });
});

// --- TC-SWV-05: promptForIssue=true with no linkedIssue shows IssuePromptDialog ---

describe("TC-SWV-05: promptForIssue=true and no linkedIssue shows IssuePromptDialog", () => {
  it("shows IssuePromptDialog and does not call start() immediately", () => {
    const start = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "My task", linkedIssue: null }),
      start,
    });
    renderStopwatchView(stopwatch, true);

    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(screen.getByTestId("issue-prompt-dialog")).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });
});

// --- TC-SWV-06: promptForIssue=true with linkedIssue calls start() directly ---

describe("TC-SWV-06: promptForIssue=true with linkedIssue calls start() directly", () => {
  it("calls start() without showing dialog when issue already linked", () => {
    const start = vi.fn();
    const linkedIssue: IssueRef = {
      provider: "jira",
      key: "PROJ-1",
      title: "Some issue",
      url: "https://jira.example.com/PROJ-1",
    };
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "My task", linkedIssue }),
      start,
    });
    renderStopwatchView(stopwatch, true);

    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(start).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("issue-prompt-dialog")).toBeNull();
  });
});

// --- TC-SWV-07: Running state renders Pause and Stop, no Start ---

describe("TC-SWV-07: Running state shows Pause and Stop buttons", () => {
  it("Pause and Stop are visible, Start is absent when running", () => {
    const stopwatch = makeStopwatch({
      state: makeIdleState({ status: "running", title: "Running task", startedAtWallClock: Date.now() }),
    });
    renderStopwatchView(stopwatch);

    expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
  });
});

// --- TC-SWV-08: Clicking Pause calls stopwatch.pause() ---

describe("TC-SWV-08: Clicking Pause calls stopwatch.pause()", () => {
  it("calls pause() when Pause button is clicked", () => {
    const pause = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ status: "running", title: "Running task", startedAtWallClock: Date.now() }),
      pause,
    });
    renderStopwatchView(stopwatch);

    fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));

    expect(pause).toHaveBeenCalledOnce();
  });
});

// --- TC-SWV-09: Clicking Stop calls stopwatch.stop() ---

describe("TC-SWV-09: Clicking Stop calls stopwatch.stop()", () => {
  it("calls stop() when Stop button is clicked in running state", () => {
    const stop = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ status: "running", title: "Running task", startedAtWallClock: Date.now() }),
      stop,
    });
    renderStopwatchView(stopwatch);

    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    expect(stop).toHaveBeenCalledOnce();
  });
});

// --- TC-SWV-10: Paused state renders Resume and Stop buttons ---

describe("TC-SWV-10: Paused state shows Resume and Stop buttons", () => {
  it("Resume and Stop are visible when paused", () => {
    const stopwatch = makeStopwatch({
      state: makeIdleState({ status: "paused", title: "Paused task", accumulatedActiveMs: 5000 }),
    });
    renderStopwatchView(stopwatch);

    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
  });
});

// --- TC-SWV-11: Clicking Resume calls stopwatch.resume() ---

describe("TC-SWV-11: Clicking Resume calls stopwatch.resume()", () => {
  it("calls resume() when Resume button is clicked in paused state", () => {
    const resume = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ status: "paused", title: "Paused task", accumulatedActiveMs: 5000 }),
      resume,
    });
    renderStopwatchView(stopwatch);

    fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));

    expect(resume).toHaveBeenCalledOnce();
  });
});

// --- TC-SWV-12: Displays elapsed time using formatElapsed ---

describe("TC-SWV-12: Displays elapsed time as HH:MM:SS", () => {
  it("shows '01:01:01' for elapsedSeconds=3661", () => {
    const stopwatch = makeStopwatch({
      state: makeIdleState({ elapsedSeconds: 3661 }),
    });
    renderStopwatchView(stopwatch);

    expect(screen.getByText("01:01:01")).toBeInTheDocument();
  });

  it("shows '00:00:00' when elapsedSeconds=0", () => {
    const stopwatch = makeStopwatch();
    renderStopwatchView(stopwatch);

    expect(screen.getByText("00:00:00")).toBeInTheDocument();
  });
});

// --- TC-SWV-13: Shows saveError message when saveError is set ---

describe("TC-SWV-13: Shows saveError message when present", () => {
  it("renders the error message when saveError is non-null", () => {
    const stopwatch = makeStopwatch({
      saveError: "Session could not be saved",
    });
    renderStopwatchView(stopwatch);

    expect(screen.getByText("Session could not be saved")).toBeInTheDocument();
  });

  it("does not render error element when saveError is null", () => {
    const stopwatch = makeStopwatch({ saveError: null });
    renderStopwatchView(stopwatch);

    expect(screen.queryByText(/could not be saved/i)).toBeNull();
  });
});

// --- TC-SWV-14: Idle with restoredSessionId shows Cancel button ---

describe("TC-SWV-14: Idle with restoredSessionId shows Cancel button that calls reset()", () => {
  it("shows Cancel button when restoredSessionId is set", () => {
    const reset = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "Restored task", restoredSessionId: "session-xyz" }),
      reset,
    });
    renderStopwatchView(stopwatch);

    const cancelBtn = screen.getByRole("button", { name: /^cancel$/i });
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.click(cancelBtn);
    expect(reset).toHaveBeenCalledOnce();
  });

  it("does not show Cancel button when restoredSessionId is null", () => {
    const stopwatch = makeStopwatch({
      state: makeIdleState({ restoredSessionId: null }),
    });
    renderStopwatchView(stopwatch);

    expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
  });
});

// --- TC-SWV-15: Skip in IssuePromptDialog calls start() ---

describe("TC-SWV-15: Skipping IssuePromptDialog calls start()", () => {
  it("calls start() when user skips issue selection", () => {
    const start = vi.fn();
    const stopwatch = makeStopwatch({
      state: makeIdleState({ title: "My task", linkedIssue: null }),
      start,
    });
    renderStopwatchView(stopwatch, true);

    // Open dialog
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));
    expect(screen.getByTestId("issue-prompt-dialog")).toBeInTheDocument();

    // Skip
    fireEvent.click(within(screen.getByTestId("issue-prompt-dialog")).getByRole("button", { name: /skip/i }));

    expect(start).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("issue-prompt-dialog")).toBeNull();
  });
});
