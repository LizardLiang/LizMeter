import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tag } from "../../../../shared/types.ts";
import { TagBadge } from "../TagBadge.tsx";

const baseTag: Tag = {
  id: 1,
  name: "Work",
  color: "#7aa2f7",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TagBadge", () => {
  it("renders the tag name", () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    expect(within(container).getByText("Work")).toBeInTheDocument();
  });

  it("does not render remove button when onRemove is not provided", () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    expect(within(container).queryByRole("button")).toBeNull();
  });

  it("renders remove button when onRemove is provided", () => {
    const onRemove = vi.fn();
    const { container } = render(<TagBadge tag={baseTag} onRemove={onRemove} />);
    const btn = within(container).getByRole("button", { name: `Remove tag ${baseTag.name}` });
    expect(btn).toBeInTheDocument();
  });

  it("calls onRemove with the tag id when remove button is clicked", () => {
    const onRemove = vi.fn();
    const { container } = render(<TagBadge tag={baseTag} onRemove={onRemove} />);
    const btn = within(container).getByRole("button", { name: `Remove tag ${baseTag.name}` });
    fireEvent.click(btn);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith(baseTag.id);
  });

  it("sets background color to tag color + '26'", () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    const badge = container.firstChild as HTMLElement;
    expect(badge).toHaveStyle({ backgroundColor: baseTag.color + "26" });
  });

  it("sets text color to tag color", () => {
    const { container } = render(<TagBadge tag={baseTag} />);
    const badge = container.firstChild as HTMLElement;
    expect(badge).toHaveStyle({ color: baseTag.color });
  });

  it("renders correctly for a tag with a different color", () => {
    const tag: Tag = { ...baseTag, id: 2, name: "Bug", color: "#f7768e" };
    const { container } = render(<TagBadge tag={tag} />);
    expect(within(container).getByText("Bug")).toBeInTheDocument();
    const badge = container.firstChild as HTMLElement;
    expect(badge).toHaveStyle({ backgroundColor: "#f7768e26" });
  });

  it("does not call onRemove when clicking elsewhere in the badge", () => {
    const onRemove = vi.fn();
    const { container } = render(<TagBadge tag={baseTag} onRemove={onRemove} />);
    // Click the badge span itself (not the button)
    fireEvent.click(container.firstChild as HTMLElement);
    // onRemove should not have been called (click did not hit button)
    expect(onRemove).not.toHaveBeenCalled();
  });
});
