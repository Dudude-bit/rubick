import { describe, expect, it, vi } from "vite-plus/test";

import { searchableColumn } from "./table-features";

function column(values: unknown[], accessor = true) {
  const getValue = vi.fn((index: number) => values[index]);
  const flatRows = values.map((_, index) => ({
    getValue: () => getValue(index),
  }));
  const getCoreRowModel = vi.fn(() => ({ flatRows }));
  const subject = {
    id: "c",
    accessorFn: accessor ? () => null : undefined,
    columnDef: {},
    table: { getCoreRowModel },
  } as never;
  return { subject, getValue, getCoreRowModel };
}

describe("which columns the search box reads", () => {
  /**
   * The vendor asked every row for a value a column without an accessor
   * never has, on each keystroke: 10 000 pods, once per such column.
   * Fails if that column is answered by reading the rows.
   */
  it("answers a column without an accessor without reading a row", () => {
    const { subject, getCoreRowModel } = column([null, null, null], false);
    expect(searchableColumn(subject)).toBe(false);
    expect(getCoreRowModel).not.toHaveBeenCalled();
  });

  /** Fails if the answer is worked out again on every keystroke over the same rows. */
  it("reads a column's rows once for the same data", () => {
    const { subject, getValue } = column([null, null, "Pending"]);
    expect(searchableColumn(subject)).toBe(true);
    const reads = getValue.mock.calls.length;
    expect(searchableColumn(subject)).toBe(true);
    expect(getValue).toHaveBeenCalledTimes(reads);
  });

  /** The vendor's own rule, kept: text and numbers are searched, anything else is not. */
  it("searches text and numbers and not other values", () => {
    expect(searchableColumn(column([7]).subject)).toBe(true);
    expect(searchableColumn(column([{ app: "web" }]).subject)).toBe(false);
    expect(searchableColumn(column([null, null]).subject)).toBe(false);
  });
});
