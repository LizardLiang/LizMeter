import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TimerDisplay } from "../TimerDisplay.tsx";

describe("TC-210: TimerDisplay renders MM:SS format", () => {
  it("renders 1500 as 25:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={1500} status="idle" />);
    expect(within(container).getByText("25:00")).toBeInTheDocument();
  });

  it("renders 0 as 00:00", () => {
    const { container } = render(<TimerDisplay remainingSeconds={0} status="completed" />);
    expect(within(container).getByText("00:00")).toBeInTheDocument();
  });

  it("renders 61 as 01:01", () => {
    const { container } = render(<TimerDisplay remainingSeconds={61} status="running" />);
    expect(within(container).getByText("01:01")).toBeInTheDocument();
  });
});

describe("TC-211: TimerDisplay shows completion visual state at 00:00", () => {
  it("applies data-status='completed' and shows completion text", () => {
    const { container } = render(<TimerDisplay remainingSeconds={0} status="completed" />);
    const wrapper = container.querySelector("[data-status='completed']");
    expect(wrapper).not.toBeNull();
    expect(within(container).getByText("00:00")).toBeInTheDocument();
    expect(within(container).getByText("Session Complete!")).toBeInTheDocument();
  });
});
