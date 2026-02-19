import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionTitleInput } from "../SessionTitleInput.tsx";

describe("TC-310: SessionTitleInput binds to value and calls onChange", () => {
  it("calls onChange on every keystroke", () => {
    const onChange = vi.fn();
    const { container } = render(<SessionTitleInput value="" onChange={onChange} />);

    const input = within(container).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Deep work" } });

    expect(onChange).toHaveBeenCalledWith("Deep work");
  });

  it("displays current value", () => {
    const onChange = vi.fn();
    const { container } = render(<SessionTitleInput value="Existing title" onChange={onChange} />);

    const input = within(container).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Existing title");
  });
});

describe("TC-311: SessionTitleInput enforces maxLength", () => {
  it("has maxLength HTML attribute set to 500 by default", () => {
    const onChange = vi.fn();
    const { container } = render(<SessionTitleInput value="" onChange={onChange} />);

    const input = within(container).getByRole("textbox");
    expect(input).toHaveAttribute("maxLength", "500");
  });

  it("respects custom maxLength", () => {
    const onChange = vi.fn();
    const { container } = render(<SessionTitleInput value="" onChange={onChange} maxLength={100} />);

    const input = within(container).getByRole("textbox");
    expect(input).toHaveAttribute("maxLength", "100");
  });
});
