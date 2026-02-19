import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TimerControls } from "../TimerControls.tsx";

function renderControls(status: "idle" | "running" | "paused" | "completed") {
  const onStart = vi.fn();
  const onPause = vi.fn();
  const onResume = vi.fn();
  const onReset = vi.fn();
  const onDismiss = vi.fn();

  const { container } = render(
    <TimerControls
      status={status}
      onStart={onStart}
      onPause={onPause}
      onResume={onResume}
      onReset={onReset}
      onDismiss={onDismiss}
    />,
  );

  return { onStart, onPause, onResume, onReset, onDismiss, container };
}

describe("TC-212: Start button is enabled when idle", () => {
  it("Start button is rendered and clickable in idle state", () => {
    const { onStart, container } = renderControls("idle");
    const startBtn = within(container).getByRole("button", { name: /^start$/i });
    expect(startBtn).not.toBeDisabled();
    fireEvent.click(startBtn);
    expect(onStart).toHaveBeenCalledOnce();
  });
});

describe("TC-213: Pause button is enabled when running, Resume when paused", () => {
  it("Pause button is enabled when running", () => {
    const { onPause, container } = renderControls("running");
    const pauseBtn = within(container).getByRole("button", { name: /pause/i });
    expect(pauseBtn).not.toBeDisabled();
    fireEvent.click(pauseBtn);
    expect(onPause).toHaveBeenCalledOnce();
  });

  it("Resume button is shown when paused", () => {
    const { onResume, container } = renderControls("paused");
    const resumeBtn = within(container).getByRole("button", { name: /resume/i });
    expect(resumeBtn).not.toBeDisabled();
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledOnce();
  });
});

describe("TC-214: Reset button enabled when running or paused", () => {
  it("Reset is enabled when running", () => {
    const { onReset, container } = renderControls("running");
    const resetBtn = within(container).getByRole("button", { name: /reset/i });
    expect(resetBtn).not.toBeDisabled();
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("Reset is enabled when paused", () => {
    const { onReset, container } = renderControls("paused");
    const resetBtn = within(container).getByRole("button", { name: /reset/i });
    expect(resetBtn).not.toBeDisabled();
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("Reset is disabled when idle", () => {
    const { container } = renderControls("idle");
    const resetBtn = within(container).getByRole("button", { name: /reset/i });
    expect(resetBtn).toBeDisabled();
  });
});

describe("TC-215: Completed state shows dismiss button, not Start", () => {
  it("shows Start New Session button when completed", () => {
    const { onDismiss, container } = renderControls("completed");
    const dismissBtn = within(container).getByRole("button", { name: /start new session/i });
    expect(dismissBtn).toBeInTheDocument();
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalledOnce();

    // Start button should not be present
    expect(within(container).queryByRole("button", { name: /^start$/i })).toBeNull();
  });
});
