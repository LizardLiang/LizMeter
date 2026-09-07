// What is honestly testable about the table widget in jsdom, and nothing more. Whether it
// scrolls, and how the borders actually look, are manual checks in a real window.

import { describe, expect, it } from "vitest";
import type { PreviewTable } from "../livePreviewRanges.ts";
import { TABLE_WIDGET_CLASS, TableWidget } from "../TableWidget.ts";

const SIMPLE: PreviewTable = { header: ["a", "b"], align: [null, "right"], rows: [["1", "2"], ["3", "4"]] };

describe("TableWidget.eq", () => {
  it("compares equal to a widget with the same parsed table", () => {
    expect(new TableWidget(SIMPLE).eq(new TableWidget({ ...SIMPLE }))).toBe(true);
  });

  it("compares unequal when a header cell differs", () => {
    const other: PreviewTable = { ...SIMPLE, header: ["a", "x"] };
    expect(new TableWidget(SIMPLE).eq(new TableWidget(other))).toBe(false);
  });

  it("compares unequal when alignment differs", () => {
    const other: PreviewTable = { ...SIMPLE, align: [null, "left"] };
    expect(new TableWidget(SIMPLE).eq(new TableWidget(other))).toBe(false);
  });

  it("compares unequal when a data row differs", () => {
    const other: PreviewTable = { ...SIMPLE, rows: [["1", "2"], ["9", "4"]] };
    expect(new TableWidget(SIMPLE).eq(new TableWidget(other))).toBe(false);
  });

  it("compares unequal when the row count differs", () => {
    const other: PreviewTable = { ...SIMPLE, rows: [["1", "2"]] };
    expect(new TableWidget(SIMPLE).eq(new TableWidget(other))).toBe(false);
  });
});

describe("TableWidget.toDOM", () => {
  it("renders a real table with a head row and body rows", () => {
    const dom = new TableWidget(SIMPLE).toDOM();
    const table = dom.querySelector("table");

    expect(table).not.toBeNull();
    expect(table?.className).toBe(TABLE_WIDGET_CLASS);
    expect(Array.from(table?.querySelectorAll("thead th") ?? []).map((el) => el.textContent)).toEqual(["a", "b"]);
    expect(
      Array.from(table?.querySelectorAll("tbody tr") ?? []).map((tr) =>
        Array.from(tr.children).map((c) => c.textContent)
      ),
    ).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("applies text-align from the parsed alignment", () => {
    const dom = new TableWidget(SIMPLE).toDOM();
    const headers = dom.querySelectorAll("th");

    expect((headers[0] as HTMLElement).style.textAlign).toBe("");
    expect((headers[1] as HTMLElement).style.textAlign).toBe("right");
  });

  it("never sets innerHTML -- cell text is rendered as text, not markup", () => {
    const withMarkup: PreviewTable = { header: ["<b>x</b>"], align: [null], rows: [] };
    const dom = new TableWidget(withMarkup).toDOM();

    expect(dom.querySelector("th")?.textContent).toBe("<b>x</b>");
    expect(dom.querySelector("b")).toBeNull();
  });
});

describe("TableWidget.ignoreEvent", () => {
  it("lets the editor handle a click, so it lands the cursor in the source", () => {
    expect(new TableWidget(SIMPLE).ignoreEvent()).toBe(false);
  });
});
