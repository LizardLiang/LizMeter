import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DateSubGroup } from "../../utils/groupSessions.ts";
import { DateSubGroupHeader } from "../DateSubGroupHeader.tsx";

function makeDateSubGroup(overrides: Partial<DateSubGroup> = {}): DateSubGroup {
  return {
    dateKey: "2026-02-24",
    dateLabel: "Today",
    sessionCount: 2,
    totalSeconds: 1800,
    sessions: [],
    ...overrides,
  };
}

describe("DateSubGroupHeader", () => {
  it("renders date label and total time", () => {
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={false} onToggle={vi.fn()} />,
    );
    expect(within(container).getByText("Today")).toBeInTheDocument();
    expect(container.textContent).toContain("30m");
  });

  it("renders session count", () => {
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup({ sessionCount: 2 })} isExpanded={false} onToggle={vi.fn()} />,
    );
    expect(container.textContent).toContain("2 sessions");
  });

  it("uses singular 'session' for count of 1", () => {
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup({ sessionCount: 1 })} isExpanded={false} onToggle={vi.fn()} />,
    );
    expect(container.textContent).toContain("1 session");
    expect(container.textContent).not.toContain("1 sessions");
  });

  it("calls onToggle when header is clicked", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={false} onToggle={onToggle} />,
    );
    const header = container.querySelector("[data-testid='date-subgroup-header']")!;
    fireEvent.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle on Enter key press", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={false} onToggle={onToggle} />,
    );
    const header = container.querySelector("[data-testid='date-subgroup-header']")!;
    fireEvent.keyDown(header, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("calls onToggle on Space key press", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={false} onToggle={onToggle} />,
    );
    const header = container.querySelector("[data-testid='date-subgroup-header']")!;
    fireEvent.keyDown(header, { key: " " });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("has aria-expanded=false when collapsed", () => {
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={false} onToggle={vi.fn()} />,
    );
    const header = container.querySelector("[data-testid='date-subgroup-header']")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("has aria-expanded=true when expanded", () => {
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={true} onToggle={vi.fn()} />,
    );
    const header = container.querySelector("[data-testid='date-subgroup-header']")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders children when expanded", () => {
    const { container } = render(
      <DateSubGroupHeader subGroup={makeDateSubGroup()} isExpanded={true} onToggle={vi.fn()}>
        <div data-testid="session-content">Session row</div>
      </DateSubGroupHeader>,
    );
    expect(within(container).getByTestId("session-content")).toBeInTheDocument();
  });
});
