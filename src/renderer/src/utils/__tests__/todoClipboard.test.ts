import { describe, expect, it } from "vitest";
import { formatTodoAgentPrompt, formatTodoId } from "../todoClipboard.ts";

describe("formatTodoId", () => {
  it("TC-01: prefixes the id with a hash", () => {
    expect(formatTodoId(1004)).toBe("#1004");
  });

  it("TC-02: works for a single-digit id", () => {
    expect(formatTodoId(7)).toBe("#7");
  });
});

describe("formatTodoAgentPrompt", () => {
  it("TC-03: title + notes, no parent, no children", () => {
    const result = formatTodoAgentPrompt(
      { id: 1004, title: "Ship the thing", notes: "Some context about the task." },
      null,
      [],
    );

    expect(result).toBe(
      [
        "# Ship the thing",
        "",
        "Some context about the task.",
        "",
        "---",
        "This task is LizMeter todo #1004. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 1004`. List its sub-issues with `todo_list` and `parentId: 1004`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-04: null notes are omitted -- no stray blank heading, no leading blank line", () => {
    const result = formatTodoAgentPrompt({ id: 5, title: "No notes here", notes: null }, null, []);

    expect(result.startsWith("# No notes here\n\n---")).toBe(true);
    expect(result).not.toContain("##");
    expect(result.startsWith("\n")).toBe(false);
  });

  it("TC-05: whitespace-only notes are treated as empty and omitted", () => {
    const result = formatTodoAgentPrompt({ id: 5, title: "Whitespace notes", notes: "   \n  " }, null, []);

    expect(result.startsWith("# Whitespace notes\n\n---")).toBe(true);
    expect(result).not.toContain("##");
  });

  it("TC-06: includes the parent section when the todo has a parent", () => {
    const result = formatTodoAgentPrompt(
      { id: 42, title: "Sub task", notes: null },
      { id: 10, title: "Umbrella task" },
      [],
    );

    expect(result).toContain("## Parent\n#10 Umbrella task");
    expect(result).not.toContain("## Sub-issues");
  });

  it("TC-07: includes direct sub-issues with correct checkbox state", () => {
    const result = formatTodoAgentPrompt(
      { id: 1, title: "Parent task", notes: null },
      null,
      [
        { id: 2, title: "Done child", stateLabel: "Done", isCompleted: true },
        { id: 3, title: "Open child", stateLabel: "Todo", isCompleted: false },
      ],
    );

    expect(result).toContain(
      "## Sub-issues\n- [x] #2 Done child (Done)\n- [ ] #3 Open child (Todo)",
    );
  });

  it("TC-08: omits the Sub-issues section entirely when there are no children", () => {
    const result = formatTodoAgentPrompt({ id: 1, title: "Lonely task", notes: null }, null, []);

    expect(result).not.toContain("## Sub-issues");
  });

  it("TC-09: the trailing hint separates re-read (id) from listing sub-issues (parentId), each a correct MCP call", () => {
    const result = formatTodoAgentPrompt({ id: 1004, title: "Any task", notes: null }, null, []);

    const hint = result.slice(result.indexOf("---"));
    expect(hint).toBe(
      [
        "---",
        "This task is LizMeter todo #1004. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 1004`. List its sub-issues with `todo_list` and `parentId: 1004`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-10: assembles parent + children + notes together, each section separated by a blank line", () => {
    const result = formatTodoAgentPrompt(
      { id: 8, title: "Full task", notes: "Body text." },
      { id: 1, title: "Root" },
      [{ id: 9, title: "Kid", stateLabel: "In progress", isCompleted: false }],
    );

    expect(result).toBe(
      [
        "# Full task",
        "",
        "Body text.",
        "",
        "## Parent",
        "#1 Root",
        "",
        "## Sub-issues",
        "- [ ] #9 Kid (In progress)",
        "",
        "---",
        "This task is LizMeter todo #8. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 8`. List its sub-issues with `todo_list` and `parentId: 8`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-11: notes markdown survives verbatim -- a fenced code block and a table", () => {
    const notes = [
      "Here is the fix:",
      "",
      "```ts",
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "```",
      "",
      "| Case | Input | Output |",
      "| --- | --- | --- |",
      "| a | 1 | 2 |",
      "| b | 2 | 4 |",
    ].join("\n");

    const result = formatTodoAgentPrompt({ id: 3, title: "With markdown", notes }, null, []);

    expect(result).toContain(notes);
  });
});
