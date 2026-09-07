// TableWidget.ts
// A GFM table rendered as a real `<table>` when the cursor is off every one of its lines.
//
// Cell text is rendered as plain text -- never innerHTML, and never re-parsed as markdown, both
// explicitly out of scope for this ticket. `eq` compares the parsed model rather than document
// offsets, for the same reason every other widget in this module does: decorations rebuild on
// every keystroke, and without a correct `eq` CodeMirror destroys and recreates the whole
// `<table>` even when nothing about this particular one changed.

import { WidgetType } from "@codemirror/view";
import { sameTable } from "./livePreviewRanges.ts";
import type { PreviewTable } from "./livePreviewRanges.ts";

export const TABLE_WIDGET_CLASS = "cm-md-table";
export const TABLE_WRAPPER_CLASS = "cm-md-table-wrapper";

export class TableWidget extends WidgetType {
  constructor(readonly table: PreviewTable) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return sameTable(this.table, other.table);
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = TABLE_WRAPPER_CLASS;

    const table = document.createElement("table");
    table.className = TABLE_WIDGET_CLASS;

    const thead = document.createElement("thead");
    thead.appendChild(buildRow("th", this.table.header, this.table.align));
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of this.table.rows) tbody.appendChild(buildRow("td", row, this.table.align));
    table.appendChild(tbody);

    wrapper.appendChild(table);
    return wrapper;
  }

  /**
   * False, so a click lands the cursor in the source -- which then reveals the raw table, the
   * same rule `listMark`'s bullet widget and every other block construct in this feature follow.
   */
  override ignoreEvent(): boolean {
    return false;
  }
}

function buildRow(cellTag: "th" | "td", cells: string[], align: PreviewTable["align"]): HTMLTableRowElement {
  const tr = document.createElement("tr");
  cells.forEach((text, index) => {
    const cell = document.createElement(cellTag);
    cell.textContent = text;
    const cellAlign = align[index];
    if (cellAlign !== undefined && cellAlign !== null) cell.style.textAlign = cellAlign;
    tr.appendChild(cell);
  });
  return tr;
}
