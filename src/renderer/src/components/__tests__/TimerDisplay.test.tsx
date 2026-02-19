import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimerDisplay } from "../TimerDisplay.tsx";

function getDisplayedTime(container: HTMLElement): string {
  const mins = container.querySelector<HTMLInputElement>("input[aria-label='Minutes']")!;
  const secs = container.querySelector<HTMLInputElement>("input[aria-label='Seconds']")!;
  return `${mins.value}:${secs.value}`;
}

describe("TC-210: TimerDisplay renders MM:SS format", () => {
  it("renders 1500 as 25:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={1500} status="idle" />);
    expect(getDisplayedTime(container)).toBe("25:00");
  });

  it("renders 0 as 00:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={0} status="completed" />);
    expect(getDisplayedTime(container)).toBe("00:00");
  });

  it("renders 61 as 01:01", () => {
    const { container } = render(<TimerDisplay remainingSeconds={61} status="running" />);
    expect(getDisplayedTime(container)).toBe("01:01");
  });
});

describe("TC-211: TimerDisplay shows completion visual state at 00:00", () => {
  it("applies data-status='completed' and shows completion text", () => {
    const { container } = render(<TimerDisplay remainingSeconds={0} status="completed" />);
    const wrapper = container.querySelector("[data-status='completed']");
    expect(wrapper).not.toBeNull();
    expect(getDisplayedTime(container)).toBe("00:00");
    expect(within(container).getByText("Session Complete!")).toBeInTheDocument();
  });
});
