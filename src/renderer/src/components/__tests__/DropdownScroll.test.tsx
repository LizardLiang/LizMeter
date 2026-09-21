import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Combobox } from "../Combobox.tsx";
import { Select } from "../Select.tsx";

describe("dropdown scrolling", () => {
  it("keeps Select open when its option list scrolls", () => {
    render(
      <Select
        value="one"
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ]}
        onChange={vi.fn()}
        ariaLabel="State"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "State" }));
    const list = screen.getByRole("listbox", { name: "State" });
    fireEvent.scroll(list);

    expect(screen.getByRole("listbox", { name: "State" })).toBeInTheDocument();
  });

  it("keeps Select open when Chromium routes its wheel to the page scroller", () => {
    render(
      <Select
        value="one"
        options={[{ value: "one", label: "One" }]}
        onChange={vi.fn()}
        ariaLabel="Project"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
    fireEvent.scroll(document);

    expect(screen.getByRole("listbox", { name: "Project" })).toBeInTheDocument();
  });

  it("keeps Combobox suggestions open when their list scrolls", () => {
    render(
      <Combobox
        value=""
        options={["One", "Two"]}
        onChange={vi.fn()}
        ariaLabel="Labels"
      />,
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Labels" }));
    const list = screen.getByRole("listbox", { name: "Labels" });
    fireEvent.scroll(list);

    expect(screen.getByRole("listbox", { name: "Labels" })).toBeInTheDocument();
  });
});
