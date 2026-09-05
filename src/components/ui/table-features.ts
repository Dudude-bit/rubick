/**
 * The one place that says which table features this app uses.
 *
 * In TanStack Table v9 the feature set is part of the type — `ColumnDef` reads
 * `<TFeatures, TData, TValue>`, and a table only has the options, state and row
 * APIs its features contribute — so it would otherwise appear in the type of
 * every column in the app. Named once here, lists import `ColumnDef` from this
 * module and go on writing `ColumnDef<Pod>`, and turning a feature on later is
 * one edit rather than thirty.
 */

import {
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  type CellData,
  type CellContext as VendorCellContext,
  type ColumnDef as VendorColumnDef,
  type Row as VendorRow,
  type RowData,
} from "@tanstack/react-table";

/**
 * Sorting, per-column filtering, one search box over every column, hiding
 * columns, and column widths — what `DataTable` actually offers. Row selection,
 * pinning, pagination and resizing are deliberately absent: the app does none
 * of them, and in v9 leaving them out is what keeps them out of the bundle.
 *
 * Grouping is absent for a different reason. The lists *do* group — the
 * namespace captions on a Pods list — but by `RowGrouping`, which draws caption
 * rows between the table's own rows and hides the column it took over: a
 * rendering concern, not a row model.
 *
 * No `sortFns`/`filterFns` registries: those name the *extra* functions a
 * column may ask for by string, and no column here asks for one. Every column
 * resolves through `auto`, which reaches the built-ins regardless — registering
 * the full sets only puts every one of them in the bundle. Pinned by
 * "reverses the rows when its header is toggled twice" in data-table.test.tsx.
 */
export const tableStack = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  columnSizingFeature,
  globalFilteringFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
});

/**
 * What the vendor will accept as a row and as a cell value. Re-exported so a
 * list that needs to constrain its own generic has one door to knock on.
 */
export type { CellData, RowData };

/** The feature set as a type, for the rare place that needs to name it. */
export type TableStack = typeof tableStack;

/** A column of one of this app's tables. */
export type ColumnDef<
  TData extends RowData,
  TValue extends CellData = CellData,
> = VendorColumnDef<TableStack, TData, TValue>;

/** A row of one of this app's tables. */
export type Row<TData extends RowData> = VendorRow<TableStack, TData>;

/** What a column's `cell` renderer is handed. */
export type CellContext<
  TData extends RowData,
  TValue extends CellData = CellData,
> = VendorCellContext<TableStack, TData, TValue>;
