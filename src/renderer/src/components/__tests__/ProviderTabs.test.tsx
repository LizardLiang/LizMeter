// ProviderTabs component tests
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderTabs } from "../ProviderTabs.tsx";

describe("TC-351: ProviderTabs renders correct tab labels", () => {
  it("renders GitHub and Linear tabs with GitHub as active", () => {
    const { container } = render(
      <ProviderTabs providers={["github", "linear"]} activeProvider="github" onSwitch={vi.fn()} />,
    );
    const tabs = within(container).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(within(container).getByText("GitHub")).toBeInTheDocument();
    expect(within(container).getByText("Linear")).toBeInTheDocument();
    const githubTab = within(container).getByText("GitHub");
    expect(githubTab).toHaveAttribute("aria-selected", "true");
    const linearTab = within(container).getByText("Linear");
    expect(linearTab).toHaveAttribute("aria-selected", "false");
  });
});

describe("TC-352: ProviderTabs calls onSwitch with the clicked provider", () => {
  it("clicking Linear tab calls onSwitch with 'linear'", () => {
    const onSwitch = vi.fn();
    const { container } = render(
      <ProviderTabs providers={["github", "linear"]} activeProvider="github" onSwitch={onSwitch} />,
    );
    const linearTab = within(container).getByText("Linear");
    fireEvent.click(linearTab);
    expect(onSwitch).toHaveBeenCalledWith("linear");
  });

  it("clicking GitHub tab calls onSwitch with 'github'", () => {
    const onSwitch = vi.fn();
    const { container } = render(
      <ProviderTabs providers={["github", "linear"]} activeProvider="linear" onSwitch={onSwitch} />,
    );
    const githubTab = within(container).getByText("GitHub");
    fireEvent.click(githubTab);
    expect(onSwitch).toHaveBeenCalledWith("github");
  });
});
