import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type Row,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableSkeleton } from "@/components/ui/skeleton";
import { QuickActions, type QuickAction } from "@/components/ui/quick-actions";
import { useTableKeyboardNav } from "@/hooks/useTableKeyboardNav";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  SearchX,
  Inbox,
  AlertTriangle,
  AlignJustify,
  List,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

import { cn } from "@/lib/utils";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  isLoading?: boolean;
  searchKey?: string;
  searchPlaceholder?: string;
  /** Enable virtual scrolling for large datasets (default: true for >100 rows) */
  enableVirtualScroll?: boolean;
  /** Max height for virtual scroll container (default: 600px) */
  virtualScrollHeight?: number;
  /** Generate navigation URL for row click */
  getRowHref?: (row: TData) => string;
  /** Custom row click handler (alternative to getRowHref) */
  onRowClick?: (row: TData) => void;
  /** Quick actions shown on row hover */
  quickActions?: QuickAction<TData>[];
  /** Enable keyboard navigation (default: true if getRowHref or onRowClick provided) */
  enableKeyboardNav?: boolean;
  /** Function to get unique row ID (for stable keys during data updates) */
  getRowId?: (row: TData, index: number) => string;
  /** Shown when the cluster genuinely has none of this resource. The
   *  "no search matches" case is handled separately. */
  emptyMessage?: string;
}

// Extended page size options for large datasets
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200, 500];
const LARGE_DATASET_THRESHOLD = 100;
const VIRTUAL_SCROLL_DEFAULT_HEIGHT = 600;

// Create actions column for quick actions
function createActionsColumn<TData, TValue>(
  quickActions: QuickAction<TData>[],
  hoveredRowIndex: number | null,
  focusedRowIndex: number
): ColumnDef<TData, TValue> {
  return {
    id: "_actions",
    header: () => null,
    cell: ({ row }: { row: Row<TData> }) => {
      const isVisible =
        hoveredRowIndex === row.index || focusedRowIndex === row.index;
      return (
        <div data-quick-actions className="flex justify-end">
          <QuickActions
            item={row.original}
            actions={quickActions}
            visible={isVisible}
          />
        </div>
      );
    },
    size: 120,
    enableSorting: false,
    enableHiding: false,
  };
}

export function DataTable<TData, TValue>({
  columns,
  data,
  isLoading = false,
  searchKey,
  searchPlaceholder = "Search...",
  enableVirtualScroll,
  virtualScrollHeight = VIRTUAL_SCROLL_DEFAULT_HEIGHT,
  getRowHref,
  onRowClick,
  quickActions,
  enableKeyboardNav,
  getRowId,
  emptyMessage = "No resources of this type in the current scope.",
}: DataTableProps<TData, TValue>) {
  const navigate = useNavigate();
  const { tableDensity, setTableDensity } = useDisplaySettingsStore();
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [searchValue, setSearchValue] = React.useState("");
  const [pagination, setPagination] = React.useState({
    pageIndex: 0,
    pageSize: 25,
  });
  const [hoveredRowIndex, setHoveredRowIndex] = React.useState<number | null>(
    null
  );
  const deferredSearch = React.useDeferredValue(searchValue);

  // Density styling. Compact rows stay strictly single-line — a pod name
  // like `cron-demo-29765030-v9vcv` otherwise wraps to three lines and the
  // row grows to triple height, which defeats the point of compact. The
  // table container already scrolls horizontally.
  const isCompact = tableDensity === "compact";
  const cellPadding = isCompact ? "py-1.5 px-3 whitespace-nowrap" : "p-4";
  const headerHeight = isCompact ? "h-9" : "h-12";

  // Determine if we should use virtual scroll based on data size
  const shouldVirtualScroll =
    enableVirtualScroll ?? data.length > LARGE_DATASET_THRESHOLD;
  const isShowingAllRows = pagination.pageSize >= data.length;
  const showLargeDatasetWarning =
    isShowingAllRows && data.length > LARGE_DATASET_THRESHOLD;

  // Keyboard navigation setup (need focusedRowIndex before creating columns)
  const keyboardNavEnabled = enableKeyboardNav ?? !!(getRowHref || onRowClick);

  const { containerRef, focusedRowIndex, getRowProps } = useTableKeyboardNav({
    rowCount: data.length,
    getRowHref: undefined, // Will be set properly after table is created
    onRowAction: undefined,
    enabled: keyboardNavEnabled,
  });

  // Add actions column if quickActions provided
  const columnsWithActions = React.useMemo(() => {
    if (!quickActions || quickActions.length === 0) {
      return columns;
    }
    // Filter out any existing "_actions" or "actions" columns to avoid duplicates
    const filteredColumns = columns.filter(
      (col) => col.id !== "_actions" && col.id !== "actions"
    );
    const actionsColumn = createActionsColumn<TData, TValue>(
      quickActions,
      hoveredRowIndex,
      focusedRowIndex
    );
    return [...filteredColumns, actionsColumn];
  }, [columns, quickActions, hoveredRowIndex, focusedRowIndex]);

  // TanStack Table's useReactTable returns functions that React
  // Compiler can't safely memoize. The library-level fix is upstream
  // — until it lands, we silence the lint here. The runtime impact
  // is benign: the table re-renders cheaply on parent state changes.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns: columnsWithActions,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      pagination,
    },
  });

  const rows = table.getRowModel().rows;
  const isClickable = !!(getRowHref || onRowClick);

  React.useEffect(() => {
    const searchColumn = searchKey ? table.getColumn(searchKey) : undefined;

    if (searchColumn) {
      searchColumn.setFilterValue(deferredSearch);
      setGlobalFilter("");
    } else {
      setGlobalFilter(deferredSearch);
    }

    table.setPageIndex(0);
  }, [deferredSearch, searchKey, table]);

  const filteredRows = table.getFilteredRowModel().rows.length;
  const totalRows = data.length;
  const pageRows = rows.length;
  const pageStart =
    totalRows === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = totalRows === 0 ? 0 : pageStart + pageRows - 1;

  // Handle "All" page size
  const handlePageSizeChange = (value: string) => {
    if (value === "all") {
      table.setPageSize(data.length || 1000);
    } else {
      table.setPageSize(Number(value));
    }
    table.setPageIndex(0);
  };

  // Handle row click
  const handleRowClick = (row: TData, event: React.MouseEvent) => {
    // Don't navigate if clicking on interactive elements
    const target = event.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("a") ||
      target.closest('[role="menuitem"]') ||
      target.closest("[data-quick-actions]")
    ) {
      return;
    }

    if (getRowHref) {
      navigate(getRowHref(row));
    } else if (onRowClick) {
      onRowClick(row);
    }
  };

  // Get current page size display value
  const currentPageSizeValue = isShowingAllRows
    ? "all"
    : String(pagination.pageSize);

  if (isLoading) {
    return <TableSkeleton columns={columns.length} rows={5} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          {showLargeDatasetWarning && (
            <div className="flex items-center gap-1.5 text-xs text-yellow-600 dark:text-yellow-500">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Showing all {data.length} rows may affect performance</span>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setTableDensity(isCompact ? "comfortable" : "compact")
                }
                className="h-8 px-2"
              >
                {isCompact ? (
                  <AlignJustify className="h-4 w-4" />
                ) : (
                  <List className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {isCompact ? "Comfortable view" : "Compact view"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div
        ref={containerRef}
        className="rounded-md border"
        role={keyboardNavEnabled ? "grid" : undefined}
        aria-label={keyboardNavEnabled ? "Data table" : undefined}
      >
        {/* Use scrollable container for large datasets when showing all rows */}
        <div
          className={cn(
            shouldVirtualScroll &&
              isShowingAllRows &&
              "overflow-auto scrollbar-thin"
          )}
          style={
            shouldVirtualScroll && isShowingAllRows
              ? { maxHeight: virtualScrollHeight }
              : undefined
          }
        >
          <Table>
            <TableHeader
              className={cn(
                shouldVirtualScroll &&
                  isShowingAllRows &&
                  "sticky top-0 bg-background z-10"
              )}
            >
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead
                        key={header.id}
                        className={cn(headerHeight, cellPadding)}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((row, index) => {
                  const rowProps = keyboardNavEnabled ? getRowProps(index) : {};
                  const isFocused = focusedRowIndex === index;

                  return (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() && "selected"}
                      {...rowProps}
                      className={cn(
                        isClickable && "cursor-pointer",
                        isFocused && "ring-2 ring-ring ring-inset",
                        "relative group"
                      )}
                      onClick={
                        isClickable
                          ? (e) => handleRowClick(row.original, e)
                          : undefined
                      }
                      onMouseEnter={() => setHoveredRowIndex(index)}
                      onMouseLeave={() => setHoveredRowIndex(null)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className={cellPadding}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columnsWithActions.length}
                    className="h-32 text-center"
                  >
                    {/* "Nothing matches your filter" and "this cluster has
                     * none of these" are different problems with different
                     * fixes — saying "No results." for both leaves the user
                     * guessing which one they're looking at. */}
                    {searchValue ? (
                      <div className="flex flex-col items-center gap-2">
                        <SearchX
                          className="h-5 w-5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <p className="text-sm text-muted-foreground">
                          Nothing matches{" "}
                          <span className="font-mono text-foreground">
                            {searchValue}
                          </span>
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSearchValue("")}
                        >
                          Clear search
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Inbox
                          className="h-5 w-5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <p className="text-sm text-muted-foreground">
                          {emptyMessage}
                        </p>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {filteredRows === totalRows
            ? `${totalRows} row(s)`
            : `${filteredRows} of ${totalRows} row(s)`}
          {totalRows > 0 && !isShowingAllRows && (
            <span className="ml-2">
              Showing {pageStart}-{pageEnd}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={currentPageSizeValue}
            onValueChange={handlePageSizeChange}
          >
            <SelectTrigger className="h-8 w-[120px]">
              <SelectValue placeholder="Rows" />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} / page
                </SelectItem>
              ))}
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
