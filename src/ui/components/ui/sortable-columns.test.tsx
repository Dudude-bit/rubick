import { describe, expect, it } from "vite-plus/test";

import { columnHeader } from "@/i18n/column-header";
import type { AppColumnMeta, ColumnDef } from "@/components/ui/table-features";
import { sortableColumn } from "./sortable-columns";

interface Row {
  n: number;
}

describe("sortableColumn", () => {
  /** A header that offered to sort a column with nothing to compare would do nothing when pressed. */
  it("leaves a column with neither a value nor a sort hint as it came", () => {
    const column: ColumnDef<Row> = {
      id: "cpu",
      header: columnHeader("columns", "cpu"),
    };
    expect(sortableColumn(column)).toBe(column);
  });

  /** Fails if a derived cell stays unsortable, or its accessor leaks into the search and a shared file. */
  it("gives a derived column an accessor that only orders the rows", () => {
    const column: ColumnDef<Row> = {
      id: "cpu",
      header: columnHeader("columns", "cpu"),
      meta: { sort: (row: Row) => row.n },
    };
    const sorted = sortableColumn(column);
    expect(sorted).not.toBe(column);
    expect(sorted.enableGlobalFilter).toBe(false);
    const meta = sorted.meta as AppColumnMeta;
    expect(meta.sortOnly).toBe(true);
    expect(meta.label).toEqual({ section: "columns", key: "cpu" });
    expect(sortableColumn(column)).toBe(sorted);
  });

  /** Fails if a column that opted out of sorting is made sortable anyway. */
  it("respects a column that says it does not sort", () => {
    const column: ColumnDef<Row> = {
      id: "cpu",
      header: columnHeader("columns", "cpu"),
      enableSorting: false,
      meta: { sort: (row: Row) => row.n },
    };
    expect(sortableColumn(column)).toBe(column);
  });
});
