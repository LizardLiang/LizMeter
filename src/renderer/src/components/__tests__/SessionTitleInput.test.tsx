import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionTitleInput } from "../SessionTitleInput.tsx";

describe("TC-310: SessionTitleInput renders a rich text editor", () => {
  it("renders a contenteditable editor region", () => {
    const onChange = vi.fn();
    const { container } = render(<SessionTitleInput value="" onChange={onChange} />);

    // TipTap renders a div[contenteditable] as its editor surface
    const editor = within(container).getByRole("textbox");
    expect(editor).toBeInTheDocument();
  });

  it("renders the label 'Session Description'", () => {
    const onChange = vi.fn();
    const { getAllByText } = render(<SessionTitleInput value="" onChange={onChange} />);

    const labels = getAllByText("Session Description");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]).toBeInTheDocument();
  });

  it("accepts a disabled prop without throwing", () => {
    const onChange = vi.fn();
    // Should not throw even when disabled
    expect(() => render(<SessionTitleInput value="" onChange={onChange} disabled />)).not.toThrow();
  });
});

describe("TC-311: SessionTitleInput accepts maxLength prop without error", () => {
  it("accepts maxLength prop without throwing", () => {
    const onChange = vi.fn();
    expect(() => render(<SessionTitleInput value="" onChange={onChange} maxLength={500} />)).not.toThrow();
  });

  it("accepts custom maxLength without throwing", () => {
    const onChange = vi.fn();
    expect(() => render(<SessionTitleInput value="" onChange={onChange} maxLength={100} />)).not.toThrow();
  });
});
