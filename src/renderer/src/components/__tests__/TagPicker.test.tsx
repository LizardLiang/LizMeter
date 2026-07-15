import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tag } from "../../../../shared/types.ts";
import { TagPicker } from "../TagPicker.tsx";

const makeTag = (id: number, name: string, color = "#7aa2f7"): Tag => ({
  id,
  name,
  color,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const allTags: Tag[] = [
  makeTag(1, "bug"),
  makeTag(2, "feature"),
  makeTag(3, "docs"),
];

describe("TagPicker — placeholder", () => {
  it("shows 'Add tags…' placeholder when no tags are selected", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(within(container).getByText("Add tags…")).toBeInTheDocument();
  });
});

describe("TagPicker — selected chip row", () => {
  it("shows selected tag names in the chip row", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[1, 3]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(within(container).getByText("bug")).toBeInTheDocument();
    expect(within(container).getByText("docs")).toBeInTheDocument();
    expect(within(container).queryByText("feature")).not.toBeInTheDocument();
  });
});

describe("TagPicker — open/close dropdown", () => {
  it("clicking the chip row opens the dropdown and shows available tags", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[1]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    // Dropdown not visible yet — "feature" and "docs" are available but the div is absent
    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);

    // After open, available tags appear as buttons
    expect(within(container).getByRole("button", { name: "feature" })).toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "docs" })).toBeInTheDocument();
  });
});

describe("TagPicker — selecting an available tag", () => {
  it("clicking an available tag calls onAdd(tagId) and closes the dropdown", () => {
    const onAdd = vi.fn();
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[1]}
        onAdd={onAdd}
        onRemove={vi.fn()}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);

    const featureBtn = within(container).getByRole("button", { name: "feature" });
    fireEvent.click(featureBtn);

    expect(onAdd).toHaveBeenCalledWith(2);
    // Dropdown closes — feature button is gone
    expect(within(container).queryByRole("button", { name: "feature" })).not.toBeInTheDocument();
  });
});

describe("TagPicker — empty allTags, no onCreateTag", () => {
  it("shows 'No tags yet' when allTags is empty and onCreateTag is not provided", () => {
    const { container } = render(
      <TagPicker
        allTags={[]}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);

    expect(within(container).getByText("No tags yet")).toBeInTheDocument();
  });
});

describe("TagPicker — all tags selected, no onCreateTag", () => {
  it("shows 'All tags selected' when every tag is already selected", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[1, 2, 3]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);

    expect(within(container).getByText("All tags selected")).toBeInTheDocument();
  });
});

describe("TagPicker — remove button", () => {
  it("clicking the × button on a chip calls onRemove(tagId)", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[2]}
        onAdd={vi.fn()}
        onRemove={onRemove}
      />,
    );

    const removeBtn = within(container).getByRole("button", { name: "Remove tag feature" });
    fireEvent.click(removeBtn);

    expect(onRemove).toHaveBeenCalledWith(2);
  });
});

describe("TagPicker — + New tag button visibility", () => {
  it("shows '+ New tag' button in dropdown when onCreateTag is provided", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onCreateTag={vi.fn()}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);

    expect(within(container).getByRole("button", { name: "+ New tag" })).toBeInTheDocument();
  });
});

describe("TagPicker — create form visibility", () => {
  it("clicking '+ New tag' shows the create form", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onCreateTag={vi.fn()}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);

    fireEvent.click(within(container).getByRole("button", { name: "+ New tag" }));

    expect(within(container).getByPlaceholderText("Tag name")).toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "Create" })).toBeInTheDocument();
  });
});

describe("TagPicker — create form validation", () => {
  it("submitting with empty name shows 'Name is required.' error", async () => {
    const onCreateTag = vi.fn();
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onCreateTag={onCreateTag}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);
    fireEvent.click(within(container).getByRole("button", { name: "+ New tag" }));

    // Name input is empty — submit
    fireEvent.click(within(container).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(within(container).getByText("Name is required.")).toBeInTheDocument();
    });
    expect(onCreateTag).not.toHaveBeenCalled();
  });
});

describe("TagPicker — successful create", () => {
  it("submitting with a valid name calls onCreateTag, then onAdd, then resets form", async () => {
    const newTag = makeTag(99, "urgent");
    const onCreateTag = vi.fn().mockResolvedValue(newTag);
    const onAdd = vi.fn();

    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onCreateTag={onCreateTag}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);
    fireEvent.click(within(container).getByRole("button", { name: "+ New tag" }));

    const nameInput = within(container).getByPlaceholderText("Tag name");
    fireEvent.change(nameInput, { target: { value: "urgent" } });
    fireEvent.click(within(container).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreateTag).toHaveBeenCalledWith({ name: "urgent", color: "#7aa2f7" });
      expect(onAdd).toHaveBeenCalledWith(99);
    });

    // Form resets — input and Create button gone, back to "+" New tag
    await waitFor(() => {
      expect(within(container).queryByPlaceholderText("Tag name")).not.toBeInTheDocument();
    });
  });
});

describe("TagPicker — create failure", () => {
  it("onCreateTag rejection shows 'Failed to create tag.' error", async () => {
    const onCreateTag = vi.fn().mockRejectedValue(new Error("server error"));

    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onCreateTag={onCreateTag}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);
    fireEvent.click(within(container).getByRole("button", { name: "+ New tag" }));

    const nameInput = within(container).getByPlaceholderText("Tag name");
    fireEvent.change(nameInput, { target: { value: "urgent" } });
    fireEvent.click(within(container).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(within(container).getByText("Failed to create tag.")).toBeInTheDocument();
    });
  });
});

describe("TagPicker — Escape key resets create form", () => {
  it("pressing Escape in the name input resets the form back to '+ New tag'", () => {
    const { container } = render(
      <TagPicker
        allTags={allTags}
        selectedTagIds={[]}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onCreateTag={vi.fn()}
      />,
    );

    const trigger = container.firstChild as HTMLElement;
    const chipRow = trigger.firstElementChild as HTMLElement;
    fireEvent.click(chipRow);
    fireEvent.click(within(container).getByRole("button", { name: "+ New tag" }));

    const nameInput = within(container).getByPlaceholderText("Tag name");
    fireEvent.change(nameInput, { target: { value: "something" } });
    fireEvent.keyDown(nameInput, { key: "Escape" });

    // Form is dismissed — input gone, "+ New tag" button is back
    expect(within(container).queryByPlaceholderText("Tag name")).not.toBeInTheDocument();
    expect(within(container).getByRole("button", { name: "+ New tag" })).toBeInTheDocument();
  });
});
