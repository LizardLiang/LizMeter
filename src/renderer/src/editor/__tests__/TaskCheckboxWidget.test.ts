// What is honestly testable about the checkbox widget in jsdom, and nothing more.
//
// The click-to-toggle path needs a real `EditorView` to dispatch into, so that half is covered
// in `MarkdownEditor.test.tsx` instead, where a whole editor is already standing up.

import { describe, expect, it } from "vitest";
import { TASK_CHECKBOX_CLASS, TaskCheckboxWidget } from "../TaskCheckboxWidget.ts";

describe("TaskCheckboxWidget.eq", () => {
  it("compares equal to a widget with the same checked state", () => {
    expect(new TaskCheckboxWidget(true).eq(new TaskCheckboxWidget(true))).toBe(true);
    expect(new TaskCheckboxWidget(false).eq(new TaskCheckboxWidget(false))).toBe(true);
  });

  it("compares unequal when the checked state differs", () => {
    expect(new TaskCheckboxWidget(true).eq(new TaskCheckboxWidget(false))).toBe(false);
  });
});

describe("TaskCheckboxWidget.toDOM", () => {
  it("renders a checkbox reflecting the checked state", () => {
    const checked = new TaskCheckboxWidget(true).toDOM() as HTMLInputElement;
    const unchecked = new TaskCheckboxWidget(false).toDOM() as HTMLInputElement;

    expect(checked.type).toBe("checkbox");
    expect(checked.checked).toBe(true);
    expect(unchecked.checked).toBe(false);
  });

  it("carries the widget class", () => {
    expect(new TaskCheckboxWidget(false).toDOM().className).toBe(TASK_CHECKBOX_CLASS);
  });

  it("builds without a view, for use outside a live editor", () => {
    // No `view` argument, unlike `ImageWidget` -- the click handler is skipped, not required.
    expect(() => new TaskCheckboxWidget(false).toDOM()).not.toThrow();
  });
});

describe("TaskCheckboxWidget.ignoreEvent", () => {
  it("claims every event, letting its own listener drive the toggle", () => {
    // False would leave the click racing CodeMirror's own cursor-placement handling, which
    // would land the cursor on the item's line and reveal its raw source mid-click.
    expect(new TaskCheckboxWidget(true).ignoreEvent()).toBe(true);
  });
});
