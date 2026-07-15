import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagColorPicker } from "../TagColorPicker.tsx";
import { TAG_COLORS } from "../tagColors.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TagColorPicker", () => {
  it("renders 8 color swatches", () => {
    const onChange = vi.fn();
    const { container } = render(<TagColorPicker value={TAG_COLORS[0]} onChange={onChange} />);
    const buttons = within(container).getAllByRole("button");
    expect(buttons).toHaveLength(8);
  });

  it("sets aria-pressed=true only on the selected color swatch", () => {
    const onChange = vi.fn();
    const selectedColor = TAG_COLORS[2]; // "#7dcfff"
    const { container } = render(<TagColorPicker value={selectedColor} onChange={onChange} />);

    const selectedBtn = within(container).getByRole("button", { name: selectedColor });
    expect(selectedBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("sets aria-pressed=false on all non-selected swatches", () => {
    const onChange = vi.fn();
    const selectedColor = TAG_COLORS[0]; // "#7aa2f7"
    const { container } = render(<TagColorPicker value={selectedColor} onChange={onChange} />);

    const unselectedColors = TAG_COLORS.filter((c) => c !== selectedColor);
    for (const color of unselectedColors) {
      const btn = within(container).getByRole("button", { name: color });
      expect(btn).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("calls onChange with the clicked color", () => {
    const onChange = vi.fn();
    const { container } = render(<TagColorPicker value={TAG_COLORS[0]} onChange={onChange} />);

    const targetColor = TAG_COLORS[4]; // "#f7768e"
    const btn = within(container).getByRole("button", { name: targetColor });
    fireEvent.click(btn);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(targetColor);
  });

  it("calls onChange with correct color for each swatch when clicked", () => {
    const onChange = vi.fn();
    const { container } = render(<TagColorPicker value={TAG_COLORS[0]} onChange={onChange} />);

    for (const color of TAG_COLORS) {
      const btn = within(container).getByRole("button", { name: color });
      fireEvent.click(btn);
    }

    expect(onChange).toHaveBeenCalledTimes(TAG_COLORS.length);
    TAG_COLORS.forEach((color, i) => {
      expect(onChange).toHaveBeenNthCalledWith(i + 1, color);
    });
  });

  it("each swatch has an aria-label matching its color hex value", () => {
    const onChange = vi.fn();
    const { container } = render(<TagColorPicker value={TAG_COLORS[0]} onChange={onChange} />);

    for (const color of TAG_COLORS) {
      expect(within(container).getByRole("button", { name: color })).toBeInTheDocument();
    }
  });

  it("updates selected swatch when value prop changes", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<TagColorPicker value={TAG_COLORS[0]} onChange={onChange} />);

    expect(within(container).getByRole("button", { name: TAG_COLORS[0] })).toHaveAttribute("aria-pressed", "true");
    expect(within(container).getByRole("button", { name: TAG_COLORS[1] })).toHaveAttribute("aria-pressed", "false");

    rerender(<TagColorPicker value={TAG_COLORS[1]} onChange={onChange} />);

    expect(within(container).getByRole("button", { name: TAG_COLORS[0] })).toHaveAttribute("aria-pressed", "false");
    expect(within(container).getByRole("button", { name: TAG_COLORS[1] })).toHaveAttribute("aria-pressed", "true");
  });
});
