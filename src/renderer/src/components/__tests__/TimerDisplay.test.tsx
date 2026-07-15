import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerDisplay } from "../TimerDisplay.tsx";

function getMinutesInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("input[aria-label='Minutes']")!;
}

function getSecondsInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>("input[aria-label='Seconds']")!;
}

function getDisplayedTime(container: HTMLElement): string {
  return `${getMinutesInput(container).value}:${getSecondsInput(container).value}`;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TimerDisplay: time formatting", () => {
  it("displays 1500s as 25:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={1500} status="idle" />);
    expect(getDisplayedTime(container)).toBe("25:00");
  });

  it("displays 0s as 00:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={0} status="idle" />);
    expect(getDisplayedTime(container)).toBe("00:00");
  });

  it("displays 3661s as 61:01", () => {
    const { container } = render(<TimerDisplay remainingSeconds={3661} status="idle" />);
    expect(getDisplayedTime(container)).toBe("61:01");
  });

  it("clamps negative values to 00:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={-5} status="idle" />);
    expect(getDisplayedTime(container)).toBe("00:00");
  });
});

describe("TimerDisplay: status indicators", () => {
  it("shows 'Session Complete!' when status is completed", () => {
    const { container } = render(<TimerDisplay remainingSeconds={0} status="completed" />);
    expect(within(container).getByText("Session Complete!")).toBeInTheDocument();
  });

  it("does NOT show 'Session Complete!' when status is idle", () => {
    const { container } = render(<TimerDisplay remainingSeconds={1500} status="idle" />);
    expect(within(container).queryByText("Session Complete!")).toBeNull();
  });

  it("shows 'click to edit' hint when idle with onRemainingChange provided", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="idle" onRemainingChange={onRemainingChange} />,
    );
    expect(within(container).getByText("click to edit")).toBeInTheDocument();
  });

  it("does NOT show 'click to edit' hint when status is running", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="running" onRemainingChange={onRemainingChange} />,
    );
    expect(within(container).queryByText("click to edit")).toBeNull();
  });
});

describe("TimerDisplay: editing mode", () => {
  it("enters editing mode on click when idle with onRemainingChange", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="idle" onRemainingChange={onRemainingChange} />,
    );
    fireEvent.click(getMinutesInput(container));
    expect(within(container).getByText("enter to confirm")).toBeInTheDocument();
  });

  it("calls onRemainingChange with parsed value on Enter", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="idle" onRemainingChange={onRemainingChange} />,
    );
    const minsInput = getMinutesInput(container);
    const secsInput = getSecondsInput(container);

    // Enter edit mode
    fireEvent.click(minsInput);

    // Type new values
    fireEvent.change(minsInput, { target: { value: "10" } });
    fireEvent.change(secsInput, { target: { value: "30" } });

    // Commit with Enter
    fireEvent.keyDown(minsInput, { key: "Enter" });

    expect(onRemainingChange).toHaveBeenCalledOnce();
    expect(onRemainingChange).toHaveBeenCalledWith(630); // 10*60+30
  });

  it("exits editing without calling onRemainingChange on Escape", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="idle" onRemainingChange={onRemainingChange} />,
    );
    const minsInput = getMinutesInput(container);

    // Enter edit mode
    fireEvent.click(minsInput);
    expect(within(container).getByText("enter to confirm")).toBeInTheDocument();

    // Press Escape
    fireEvent.keyDown(minsInput, { key: "Escape" });

    expect(onRemainingChange).not.toHaveBeenCalled();
    expect(within(container).getByText("click to edit")).toBeInTheDocument();
  });

  it("strips non-numeric characters from minutes input", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="idle" onRemainingChange={onRemainingChange} />,
    );
    const minsInput = getMinutesInput(container);

    // Enter edit mode
    fireEvent.click(minsInput);

    // Type non-numeric input
    fireEvent.change(minsInput, { target: { value: "1a2b" } });

    // Non-numeric chars stripped by onChange handler (component strips /[^0-9]/)
    expect(minsInput.value).toBe("12");
  });

  it("cannot enter editing mode when status is running", () => {
    const onRemainingChange = vi.fn();
    const { container } = render(
      <TimerDisplay remainingSeconds={1500} status="running" onRemainingChange={onRemainingChange} />,
    );
    const minsInput = getMinutesInput(container);

    fireEvent.click(minsInput);

    // Should NOT have entered editing mode
    expect(within(container).queryByText("enter to confirm")).toBeNull();
    expect(onRemainingChange).not.toHaveBeenCalled();
  });
});
