import { describe, expect, it } from "vitest";
import { collapseLineBreaks, formatTodoAgentPrompt, formatTodoId } from "../todoClipboard.ts";

describe("collapseLineBreaks", () => {
  it("collapses a single newline to a single space", () => {
    expect(collapseLineBreaks("Line one\nLine two")).toBe("Line one Line two");
  });

  it("collapses a run of line breaks to one space, not one per line break", () => {
    expect(collapseLineBreaks("Line one \r\n\n  Line two")).toBe("Line one Line two");
  });

  it(
    "also eats whitespace surrounding the line break, not just the break itself -- the behavior "
      + "TodoDetailPage's title field now shares with this module (item 3, Hermes re-review)",
    () => {
      expect(collapseLineBreaks("foo  \n  bar")).toBe("foo bar");
    },
  );
});

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

    expect(result).toBe(
      [
        "# No notes here",
        "",
        "---",
        "This task is LizMeter todo #5. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 5`. List its sub-issues with `todo_list` and `parentId: 5`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-05: whitespace-only notes are treated as empty and omitted", () => {
    const result = formatTodoAgentPrompt({ id: 5, title: "Whitespace notes", notes: "   \n  " }, null, []);

    expect(result).toBe(
      [
        "# Whitespace notes",
        "",
        "---",
        "This task is LizMeter todo #5. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 5`. List its sub-issues with `todo_list` and `parentId: 5`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-06: includes the parent section when the todo has a parent", () => {
    const result = formatTodoAgentPrompt(
      { id: 42, title: "Sub task", notes: null },
      { id: 10, title: "Umbrella task" },
      [],
    );

    expect(result).toBe(
      [
        "# Sub task",
        "",
        "## Parent",
        "#10 Umbrella task",
        "",
        "---",
        "This task is LizMeter todo #42. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 42`. List its sub-issues with `todo_list` and `parentId: 42`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
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

    expect(result).toBe(
      [
        "# Parent task",
        "",
        "## Sub-issues",
        "- [x] #2 Done child (Done)",
        "- [ ] #3 Open child (Todo)",
        "",
        "---",
        "This task is LizMeter todo #1. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 1`. List its sub-issues with `todo_list` and `parentId: 1`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
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

  it("TC-11: notes markdown survives verbatim -- a fenced code block and a table, joined exactly like every other section", () => {
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

    expect(result).toBe(
      [
        "# With markdown",
        "",
        notes,
        "",
        "---",
        "This task is LizMeter todo #3. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 3`. List its sub-issues with `todo_list` and `parentId: 3`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-12: a newline in the title (an AI-agent write through the MCP tools, or a smuggled paste) collapses to a single space in the heading", () => {
    const result = formatTodoAgentPrompt({ id: 6, title: "Line one\nLine two", notes: null }, null, []);

    expect(result.startsWith("# Line one Line two\n\n---")).toBe(true);
  });

  it("TC-13: a run of newlines and surrounding whitespace in the title collapses to one space, not one per line break", () => {
    const result = formatTodoAgentPrompt({ id: 6, title: "Line one \r\n\n  Line two", notes: null }, null, []);

    expect(result.startsWith("# Line one Line two\n\n---")).toBe(true);
  });

  it("TC-14: an unbalanced fence in notes is closed before the next section, instead of swallowing it", () => {
    const notes = ["Before the fence.", "", "```ts", "const x = 1;"].join("\n");

    const result = formatTodoAgentPrompt(
      { id: 4, title: "Broken fence", notes },
      { id: 1, title: "Root" },
      [],
    );

    expect(result).toBe(
      [
        "# Broken fence",
        "",
        `${notes}\n\`\`\``,
        "",
        "## Parent",
        "#1 Root",
        "",
        "---",
        "This task is LizMeter todo #4. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 4`. List its sub-issues with `todo_list` and `parentId: 4`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-15: a fence marker appearing mid-sentence (not at the start of a line) does not count toward the balance check", () => {
    const notes = ["Run `echo ```` ` in a shell to see it print the backticks literally."].join("\n");

    const result = formatTodoAgentPrompt({ id: 4, title: "Inline backticks", notes }, null, []);

    // Not closed with an extra fence -- the notes block passes through unchanged, since no line
    // in it starts with ``` .
    expect(result).toBe(
      [
        "# Inline backticks",
        "",
        notes,
        "",
        "---",
        "This task is LizMeter todo #4. Re-read it with the lizmeter-todo MCP server:",
        "`todo_list` with `id: 4`. List its sub-issues with `todo_list` and `parentId: 4`.",
        "Mark it done with `todo_complete`, or update it with `todo_update`.",
      ].join("\n"),
    );
  });

  it("TC-16: a child's stateLabel with nested parens (e.g. \"Blocked (external)\") renders unescaped -- markdown does not treat parens specially outside link syntax", () => {
    const result = formatTodoAgentPrompt(
      { id: 1, title: "Parent task", notes: null },
      null,
      [{ id: 2, title: "Stuck child", stateLabel: "Blocked (external)", isCompleted: false }],
    );

    expect(result).toContain("- [ ] #2 Stuck child (Blocked (external))");
  });
});
