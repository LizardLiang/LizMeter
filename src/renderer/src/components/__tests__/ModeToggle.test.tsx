import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMode } from "../../../../shared/types.ts";
import { ModeToggle } from "../ModeToggle.tsx";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModeToggle", () => {
  it("renders both Pomodoro and Time Tracking tabs", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} />);
    expect(within(container).getByRole("tab", { name: "Pomodoro" })).toBeInTheDocument();
    expect(within(container).getByRole("tab", { name: "Time Tracking" })).toBeInTheDocument();
  });

  it("marks pomodoro tab as aria-selected when mode is 'pomodoro'", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} />);
    const pomodoroTab = within(container).getByRole("tab", { name: "Pomodoro" });
    const timeTrackingTab = within(container).getByRole("tab", { name: "Time Tracking" });
    expect(pomodoroTab).toHaveAttribute("aria-selected", "true");
    expect(timeTrackingTab).toHaveAttribute("aria-selected", "false");
  });

  it("marks time-tracking tab as aria-selected when mode is 'time-tracking'", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="time-tracking" onModeChange={onModeChange} />);
    const pomodoroTab = within(container).getByRole("tab", { name: "Pomodoro" });
    const timeTrackingTab = within(container).getByRole("tab", { name: "Time Tracking" });
    expect(timeTrackingTab).toHaveAttribute("aria-selected", "true");
    expect(pomodoroTab).toHaveAttribute("aria-selected", "false");
  });

  it("calls onModeChange with 'pomodoro' when Pomodoro tab is clicked", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="time-tracking" onModeChange={onModeChange} />);
    fireEvent.click(within(container).getByRole("tab", { name: "Pomodoro" }));
    expect(onModeChange).toHaveBeenCalledOnce();
    expect(onModeChange).toHaveBeenCalledWith("pomodoro" satisfies AppMode);
  });

  it("calls onModeChange with 'time-tracking' when Time Tracking tab is clicked", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} />);
    fireEvent.click(within(container).getByRole("tab", { name: "Time Tracking" }));
    expect(onModeChange).toHaveBeenCalledOnce();
    expect(onModeChange).toHaveBeenCalledWith("time-tracking" satisfies AppMode);
  });

  it("disables both tabs when disabled prop is true", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} disabled={true} />);
    const pomodoroTab = within(container).getByRole("tab", { name: "Pomodoro" });
    const timeTrackingTab = within(container).getByRole("tab", { name: "Time Tracking" });
    expect(pomodoroTab).toBeDisabled();
    expect(timeTrackingTab).toBeDisabled();
  });

  it("does not disable tabs when disabled prop is false", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} disabled={false} />);
    const pomodoroTab = within(container).getByRole("tab", { name: "Pomodoro" });
    const timeTrackingTab = within(container).getByRole("tab", { name: "Time Tracking" });
    expect(pomodoroTab).not.toBeDisabled();
    expect(timeTrackingTab).not.toBeDisabled();
  });

  it("does not call onModeChange when a disabled tab is clicked", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} disabled={true} />);
    fireEvent.click(within(container).getByRole("tab", { name: "Time Tracking" }));
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("renders a tablist with accessible label", () => {
    const onModeChange = vi.fn();
    const { container } = render(<ModeToggle mode="pomodoro" onModeChange={onModeChange} />);
    expect(within(container).getByRole("tablist", { name: "App mode" })).toBeInTheDocument();
  });
});
