import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tag } from "../../../../shared/types.ts";
import { TagManager } from "../TagManager.tsx";

const makeTag = (id: number, name: string, color = "#7aa2f7"): Tag => ({
  id,
  name,
  color,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const sampleTags: Tag[] = [
  makeTag(1, "bug", "#f7768e"),
  makeTag(2, "feature", "#9ece6a"),
];

describe("TagManager — empty state", () => {
  it("shows 'No tags yet' when tags array is empty", () => {
    const { container } = render(
      <TagManager
        tags={[]}
        onCreateTag={vi.fn()}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );
    expect(within(container).getByText("No tags yet")).toBeInTheDocument();
  });
});

describe("TagManager — renders tag list", () => {
  it("renders each tag name from the tags array", () => {
    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );
    expect(within(container).getByText("bug")).toBeInTheDocument();
    expect(within(container).getByText("feature")).toBeInTheDocument();
  });
});

describe("TagManager — create tag", () => {
  it("clicking '+' with text in input calls onCreateTag and clears input", async () => {
    const createdTag = makeTag(3, "docs");
    const onCreateTag = vi.fn().mockResolvedValue(createdTag);

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={onCreateTag}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );

    const nameInput = within(container).getByPlaceholderText("New tag name…");
    fireEvent.change(nameInput, { target: { value: "docs" } });
    fireEvent.click(within(container).getByRole("button", { name: "+" }));

    await waitFor(() => {
      expect(onCreateTag).toHaveBeenCalledWith({ name: "docs", color: "#7aa2f7" });
    });

    await waitFor(() => {
      expect((nameInput as HTMLInputElement).value).toBe("");
    });
  });

  it("clicking '+' with empty input does NOT call onCreateTag", async () => {
    const onCreateTag = vi.fn();

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={onCreateTag}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );

    // Input is empty by default
    fireEvent.click(within(container).getByRole("button", { name: "+" }));

    // Allow any async flushes
    await waitFor(() => {
      expect(onCreateTag).not.toHaveBeenCalled();
    });
  });

  it("pressing Enter in the name input also creates the tag", async () => {
    const createdTag = makeTag(4, "wontfix");
    const onCreateTag = vi.fn().mockResolvedValue(createdTag);

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={onCreateTag}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );

    const nameInput = within(container).getByPlaceholderText("New tag name…");
    fireEvent.change(nameInput, { target: { value: "wontfix" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    await waitFor(() => {
      expect(onCreateTag).toHaveBeenCalledWith({ name: "wontfix", color: "#7aa2f7" });
    });
  });

  it("onCreateTag rejection shows error message", async () => {
    const onCreateTag = vi.fn().mockRejectedValue(new Error("Database error"));

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={onCreateTag}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );

    const nameInput = within(container).getByPlaceholderText("New tag name…");
    fireEvent.change(nameInput, { target: { value: "badtag" } });
    fireEvent.click(within(container).getByRole("button", { name: "+" }));

    await waitFor(() => {
      expect(within(container).getByText("Database error")).toBeInTheDocument();
    });
  });
});

describe("TagManager — edit tag", () => {
  it("clicking the edit button shows the edit form for that tag", () => {
    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={vi.fn()}
        onDeleteTag={vi.fn()}
      />,
    );

    fireEvent.click(within(container).getByRole("button", { name: "Edit tag bug" }));

    // Edit form replaces the row — input with tag name value appears
    const editInput = within(container).getByDisplayValue("bug");
    expect(editInput).toBeInTheDocument();
    // Confirm and cancel buttons appear
    expect(within(container).getByRole("button", { name: "✓" })).toBeInTheDocument();
  });

  it("clicking ✓ calls onUpdateTag with id, name, color and hides the edit form", async () => {
    const updatedTag = makeTag(1, "BUG", "#f7768e");
    const onUpdateTag = vi.fn().mockResolvedValue(updatedTag);

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={onUpdateTag}
        onDeleteTag={vi.fn()}
      />,
    );

    fireEvent.click(within(container).getByRole("button", { name: "Edit tag bug" }));

    const editInput = within(container).getByDisplayValue("bug");
    fireEvent.change(editInput, { target: { value: "BUG" } });
    fireEvent.click(within(container).getByRole("button", { name: "✓" }));

    await waitFor(() => {
      expect(onUpdateTag).toHaveBeenCalledWith({ id: 1, name: "BUG", color: "#f7768e" });
    });

    // Edit form hidden — confirm button gone
    await waitFor(() => {
      expect(within(container).queryByRole("button", { name: "✓" })).not.toBeInTheDocument();
    });
  });

  it("clicking ✕ in the edit form cancels without calling onUpdateTag", async () => {
    const onUpdateTag = vi.fn();

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={onUpdateTag}
        onDeleteTag={vi.fn()}
      />,
    );

    fireEvent.click(within(container).getByRole("button", { name: "Edit tag bug" }));

    // There are two ✕ buttons (one per tag) — use the cancel within the edit form context.
    // After clicking edit for "bug", the edit row has a ✕ cancel button and a ✓ confirm button.
    // The other tag ("feature") still has its delete ✕. Query the ✓ row's sibling cancel.
    const confirmBtn = within(container).getByRole("button", { name: "✓" });
    const editRow = confirmBtn.closest("div") as HTMLElement;
    const cancelBtn = within(editRow).getByRole("button", { name: "✕" });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(onUpdateTag).not.toHaveBeenCalled();
    });

    // Edit form hidden
    expect(within(container).queryByRole("button", { name: "✓" })).not.toBeInTheDocument();
  });
});

describe("TagManager — delete tag", () => {
  it("clicking the delete button calls onDeleteTag(id)", async () => {
    const onDeleteTag = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={vi.fn()}
        onDeleteTag={onDeleteTag}
      />,
    );

    fireEvent.click(within(container).getByRole("button", { name: "Delete tag feature" }));

    await waitFor(() => {
      expect(onDeleteTag).toHaveBeenCalledWith(2);
    });
  });

  it("onDeleteTag rejection shows error message", async () => {
    const onDeleteTag = vi.fn().mockRejectedValue(new Error("Cannot delete"));

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={vi.fn()}
        onDeleteTag={onDeleteTag}
      />,
    );

    fireEvent.click(within(container).getByRole("button", { name: "Delete tag bug" }));

    await waitFor(() => {
      expect(within(container).getByText("Cannot delete")).toBeInTheDocument();
    });
  });

  it("deleting a different tag while editing another does not dismiss the edit form", async () => {
    const onDeleteTag = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <TagManager
        tags={sampleTags}
        onCreateTag={vi.fn()}
        onUpdateTag={vi.fn()}
        onDeleteTag={onDeleteTag}
      />,
    );

    // Open edit form for "bug" (id 1)
    fireEvent.click(within(container).getByRole("button", { name: "Edit tag bug" }));
    expect(within(container).getByRole("button", { name: "✓" })).toBeInTheDocument();

    // Delete the OTHER tag "feature" (id 2) — its delete button is still visible
    fireEvent.click(within(container).getByRole("button", { name: "Delete tag feature" }));

    await waitFor(() => {
      expect(onDeleteTag).toHaveBeenCalledWith(2);
    });

    // Edit form for "bug" must still be open
    expect(within(container).getByRole("button", { name: "✓" })).toBeInTheDocument();
  });
});
