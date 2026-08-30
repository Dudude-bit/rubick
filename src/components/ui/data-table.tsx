import * as React from "react";
import { toSingularNoun } from "@/lib/resource-registry";
import { useNavigate } from "react-router-dom";
import {
  flexRender,
  useTable,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import {
  tableStack,
  type ColumnDef,
  type Row,
} from "@/components/ui/table-features";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/ui/skeleton";
import { QuickActions, type QuickAction } from "@/components/ui/quick-actions";
import { useTableKeyboardNav } from "@/hooks/useTableKeyboardNav";
import { readLinkIntent, useLinkGesture } from "@/hooks/useLinkGesture";
import {
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
import type { RowGrouping } from "@/components/ui/row-grouping";

import { cn } from "@/lib/utils";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  isLoading?: boolean;
  searchKey?: string;
  searchPlaceholder?: string;
  /** Force the windowed layout on or off; unset, the table reads its own length. */
  enableVirtualScroll?: boolean;
  /**
   * The table may use the whole height of the pane it is in: rows scroll
   * inside it while the search row and the count stay put.
   *
   * A ceiling rather than a target — the table takes what it needs and no
   * more, so a twelve-row list still ends where its rows end instead of
   * pushing its count line to the bottom of the window. Only a list too long
   * to fit reaches the ceiling, and that is the one that used to be cut to
   * 600px with the rest of the pane blank beneath it.
   *
   * For a table that *is* the page: the parent has to be a flex column with a
   * height of its own — `h-full min-h-0` the whole way up to the scroll pane —
   * or there is no ceiling to find and the table grows the page scroll as
   * before. Off for a table embedded in a flow, where that is the right
   * answer anyway.
   */
  fill?: boolean;
  /**
   * How tall the windowed scroll port is when there is no height to fill.
   *
   * Only reached by an unfilled table, and only once it is long enough to
   * window: the virtualiser measures its scroll element, and an element with
   * no bound measures as tall as its own content — which draws every row and
   * is the one thing windowing exists to avoid.
   */
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
  /** Opt in to caption rows above runs of related rows. */
  grouping?: RowGrouping<TData> | null;
  /** Plural noun for the group caption count, e.g. "pods". */
  rowLabel?: string;
}

/**
 * Where the table stops mounting every row and draws a window instead — and
 * where it goes back.
 *
 * Two marks rather than one, because a single one is a number that moves under
 * the reader: a namespace sitting at a hundred pods crosses it on a watch tick
 * and crosses back on the next. Crossing swaps every row's measured height for
 * an estimate and back, and on an unfilled table it swaps the whole list for a
 * fixed box with its own scrollbar — scroll position lost both ways. The gap is
 * wide enough that only a list genuinely changing size moves anything.
 */
const VIRTUALISE_ABOVE_ROWS = 100;
const STAY_FLAT_BELOW_ROWS = 75;
const VIRTUAL_SCROLL_DEFAULT_HEIGHT = 600;

/**
 * How long a keyboard jump waits for its row to be drawn before giving up.
 *
 * The scroll and the mount take a frame or two; a row that has not arrived by
 * now is not coming. Without a deadline the pending index outlives the key
 * press for the life of the table — a watch tick that drops the list shorter
 * than the index strands it there, and the moment the list grows back the
 * table pulls the focus off whatever the reader had moved to since.
 */
const PENDING_FOCUS_MS = 1000;

/** The generated column, named once so the cells can recognise it. */
const ACTIONS_COLUMN_ID = "_actions";

/**
 * A row's height before it has been measured, per density.
 *
 * Compact is the 23px pitch the cell padding is built around; comfortable is
 * the same line box with `py-2` around it. Only a first guess — every drawn
 * row is measured, because a comfortable row whose labels wrap is taller.
 */
const ESTIMATED_ROW_PX = { compact: 23, comfortable: 33 } as const;

/** How many rows either side of the viewport stay mounted. */
const OVERSCAN = 12;

/**
 * The width the actions cell needs, from what it actually holds: a 20px icon
 * and a 2px gap each, inside the cell's own 10px padding on both sides.
 *
 * TanStack's default is 150 — a name column's worth of the table reserved for
 * two buttons, on every list in the app.
 */
const actionsColumnSize = (count: number) => 20 + count * 22;

/**
 * What the row's buttons do, handed to the cell through a context rather than
 * captured in its closure.
 *
 * `flexRender` calls a cell renderer *as a component*, so the renderer's
 * identity is a React element type: build it fresh on each render and React
 * unmounts and remounts the cell every time. On a list that re-reads itself
 * every two seconds that replaced the button under the pointer between
 * `mousedown` and `mouseup` — no `click` was ever raised, the buttons appeared
 * dead, and the row's own handler (bound to a `tr` that does survive) opened
 * the object instead.
 *
 * A caller cannot get this wrong by passing a fresh array, which is what every
 * caller does: the renderer below is defined once and reads the array here.
 */
const RowActions = React.createContext<QuickAction<never>[]>([]);

const NO_ACTIONS: QuickAction<never>[] = [];

function RowActionsProvider<TData extends RowData>({
  actions,
  children,
}: {
  actions: QuickAction<TData>[] | undefined;
  children: React.ReactNode;
}) {
  return (
    <RowActions.Provider
      value={(actions as unknown as QuickAction<never>[]) ?? NO_ACTIONS}
    >
      {children}
    </RowActions.Provider>
  );
}

function ActionsCell<TData extends RowData>({ row }: { row: Row<TData> }) {
  const actions = React.useContext(
    RowActions
  ) as unknown as QuickAction<TData>[];
  return (
    // The icon buttons are 20px so their hit area can stay 24px, which is 4px
    // more than a compact row's line box. The negative margin lets that
    // overhang bleed into the cell padding instead of setting the height of
    // every row in the table.
    <div
      data-quick-actions
      className="-my-0.5 flex items-center justify-end gap-0.5"
    >
      <QuickActions item={row.original} actions={actions} />
    </div>
  );
}

function createActionsColumn<TData extends RowData>(
  count: number
): ColumnDef<TData> {
  return {
    id: ACTIONS_COLUMN_ID,
    header: () => null,
    // The one reference that matters. The column object around it may be
    // rebuilt as often as it likes.
    cell: ActionsCell,
    size: actionsColumnSize(count),
    enableSorting: false,
    enableHiding: false,
  };
}

/**
 * One entry per line the table draws, captions included.
 *
 * Descriptors rather than rendered nodes: the virtualiser needs to count and
 * measure the lines before anything decides which of them to draw.
 */
type BodyItem<TData extends RowData> =
  | { key: string; caption: React.ReactNode; row?: undefined }
  | { key: string; caption?: undefined; row: Row<TData>; rowIndex: number };

/** Where a nav key wants to go, or null if it is not a nav key. */
function navTarget(key: string, from: number, rowCount: number): number | null {
  switch (key) {
    case "ArrowDown":
      return from < rowCount - 1 ? from + 1 : null;
    case "ArrowUp":
      return from > 0 ? from - 1 : null;
    case "Home":
      return 0;
    case "End":
      return rowCount - 1;
    default:
      return null;
  }
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  isLoading = false,
  searchKey,
  searchPlaceholder,
  enableVirtualScroll,
  fill = false,
  virtualScrollHeight = VIRTUAL_SCROLL_DEFAULT_HEIGHT,
  getRowHref,
  onRowClick,
  quickActions,
  enableKeyboardNav,
  getRowId,
  emptyMessage,
  grouping = null,
  rowLabel,
}: DataTableProps<TData>) {
  const navigate = useNavigate();
  const linkGesture = useLinkGesture();
  const { tableDensity, setTableDensity } = useDisplaySettingsStore();
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [globalFilter, setGlobalFilter] = React.useState("");
  const t = useT();
  const [searchValue, setSearchValue] = React.useState("");
  const deferredSearch = React.useDeferredValue(searchValue);

  // Density styling. Compact rows stay strictly single-line — a pod name
  // like `cron-demo-29765030-v9vcv` otherwise wraps to three lines and the
  // row grows to triple height, which defeats the point of compact.
  //
  // 3px against a 16px line box and a 1px rule is a 23px pitch: nothing in
  // a cell may be taller than that line box or it, not the padding, becomes
  // the row height.
  const isCompact = tableDensity === "compact";
  const cellPadding = isCompact ? "py-[3px] px-2.5" : "py-2 px-2.5";

  // Clipped, because the table is fixed-layout: a name longer than its
  // column has nowhere to go and would otherwise paint straight over the
  // namespace beside it.
  //
  // Text cells only. The actions cell holds 20px buttons whose pointer target
  // is pushed back out to 24px by a pseudo-element, and hangs over the cell's
  // padding by design; clipping that cell clips the hit area back to 20px in
  // the density most of the app is looking at.
  const clipText =
    isCompact && "overflow-hidden text-ellipsis whitespace-nowrap";

  // Grouping only switches on once the data has enough groups to be worth
  // captioning at all — which is also what keeps an unmanaged cluster's Nodes
  // page exactly the flat list it was.
  const groupingActive = React.useMemo(() => {
    if (!grouping) return false;
    const seen = new Set<string>();
    for (const item of data) {
      const key = grouping.keyOf(item);
      if (key) seen.add(key);
    }
    return seen.size >= (grouping.minGroups ?? 1);
  }, [data, grouping]);

  const columnVisibility = React.useMemo<ColumnVisibilityState>(() => {
    const state: ColumnVisibilityState = {};
    if (groupingActive) {
      for (const id of grouping?.hides ?? []) state[id] = false;
    }
    return state;
  }, [groupingActive, grouping]);

  // Latched rather than derived: between the two marks the answer is
  // "whatever it already was", which is a fact about the last render and not
  // about this data.
  const [wasLong, setWasLong] = React.useState(
    () => data.length > VIRTUALISE_ABOVE_ROWS
  );
  const isLong =
    data.length > VIRTUALISE_ABOVE_ROWS
      ? true
      : data.length < STAY_FLAT_BELOW_ROWS
        ? false
        : wasLong;
  if (isLong !== wasLong) setWasLong(isLong);

  const shouldVirtualScroll = enableVirtualScroll ?? isLong;

  // Add actions column if quickActions provided
  // Keyed on the count, not the array: the cell renderer no longer reads the
  // array at all, and the column has nothing else to learn from it.
  const actionCount = quickActions?.length ?? 0;
  const columnsWithActions = React.useMemo(() => {
    if (actionCount === 0) return columns;
    // Filter out any existing "_actions" or "actions" columns to avoid duplicates
    const filteredColumns = columns.filter(
      (col) => col.id !== ACTIONS_COLUMN_ID && col.id !== "actions"
    );
    return [...filteredColumns, createActionsColumn<TData>(actionCount)];
  }, [columns, actionCount]);

  const table = useTable({
    // Which features exist is now part of the table's type, and the app names
    // them in one place rather than at every list. Row models come with them:
    // in v9 the sorted and filtered ones are slots on the feature set, not
    // functions handed in here.
    features: tableStack,
    data,
    columns: columnsWithActions,
    getRowId,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
    },
  });

  const rows = table.getRowModel().rows;
  const isClickable = !!(getRowHref || onRowClick);
  const visibleColumnCount = table.getVisibleFlatColumns().length;

  const keyboardNavEnabled = enableKeyboardNav ?? !!(getRowHref || onRowClick);

  // Counted over the rows the table draws, not over `data`. A search narrows
  // the list without narrowing `data`, and a hook counting to five hundred in
  // front of three rows leaves its focus — and the table's only tab stop — on
  // a row that is not there. Home and End mean the ends of what is on screen
  // for the same reason.
  //
  // Enter is left to the row itself: the hook is indexed by visual position
  // and would have to be handed a row order that grouping only settles at
  // render time, and it cannot see the modifiers on the key press anyway.
  const { containerRef, focusedRowIndex, getRowProps } = useTableKeyboardNav({
    rowCount: rows.length,
    enabled: keyboardNavEnabled,
  });

  React.useEffect(() => {
    const searchColumn = searchKey ? table.getColumn(searchKey) : undefined;

    if (searchColumn) {
      searchColumn.setFilterValue(deferredSearch);
      setGlobalFilter("");
    } else {
      setGlobalFilter(deferredSearch);
    }
  }, [deferredSearch, searchKey, table]);

  const filteredRows = table.getFilteredRowModel().rows.length;
  const totalRows = data.length;

  // One caption per group, rows beneath it in first-seen order. Flat, so the
  // keyboard-nav index stays the visual position and does not skip captions.
  const items: BodyItem<TData>[] = [];
  // Where each data row sits among those lines. The two numberings come apart
  // wherever a caption is inserted, and the virtualiser counts lines while the
  // keyboard counts rows.
  const rowLine: number[] = [];
  const pushRow = (row: Row<TData>, rowIndex: number) => {
    rowLine[rowIndex] = items.length;
    items.push({ key: row.id, row, rowIndex });
  };

  if (groupingActive && grouping) {
    const groups = new Map<string, Row<TData>[]>();
    const ungrouped: Row<TData>[] = [];
    for (const row of rows) {
      const key = grouping.keyOf(row.original);
      if (key === null) {
        ungrouped.push(row);
        continue;
      }
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    let index = 0;
    // No caption over these: the data did not say which group they are in,
    // and a heading reading "ungrouped" would turn that silence into a claim.
    for (const row of ungrouped) pushRow(row, index++);
    for (const [key, groupRows] of groups) {
      items.push({
        key: `group-${key}`,
        caption: grouping.caption(
          key,
          groupRows.map((row) => row.original)
        ),
      });
      for (const row of groupRows) pushRow(row, index++);
    }
  } else {
    rows.forEach((row, index) => pushRow(row, index));
  }

  const scrollRef = React.useRef<HTMLDivElement>(null);

  // Above the threshold every row used to mount, and a list that re-reads
  // itself every two seconds then re-rendered all of them on every tick.
  //
  // The window is spliced into the table with spacer rows rather than
  // absolutely positioned ones: an out-of-flow `tr` leaves the fixed-layout
  // column grid, and every cell would have to carry its own width again.
  //
  // TanStack Virtual returns functions React Compiler cannot safely memoize,
  // so it declines to compile this component. That used to be true of the
  // table hook as well, and the disable sat there; v9's `useTable` is
  // compatible, which is what let this one surface. The runtime cost is the
  // same either way — the table re-renders cheaply — and it goes away when
  // the fix lands upstream.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    enabled: shouldVirtualScroll,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX[isCompact ? "compact" : "comfortable"],
    // Keyed by row rather than by position, so sorting or filtering never
    // hands a row someone else's measured height.
    getItemKey: (index) => items[index].key,
    overscan: OVERSCAN,
    // Measuring inside the ResizeObserver callback that reported the resize
    // re-enters the observer, which WebKit reports as an uncaught error and
    // this app turns into a toast.
    useAnimationFrameWithResizeObserver: true,
  });

  // Density changes the row height, and nothing in virtual-core notices:
  // measured heights are cached per item and `estimateSize` is not part of
  // what invalidates that cache. Without this, toggling density on a list
  // whose rows have all been measured leaves the total height stale by the
  // difference — a scrollbar that lies, and rows that jump as each one
  // re-measures on its way back into the window.
  React.useEffect(() => {
    virtualizer.measure();
  }, [isCompact, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();
  const padTop = virtualItems.length ? virtualItems[0].start : 0;
  const padBottom = virtualItems.length
    ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0;

  // A row the reader jumped to is not in the DOM yet at the moment the key is
  // pressed, so the focus is left pending until the virtualiser has drawn it
  // — and dropped once the list can no longer produce it.
  const pendingFocus = React.useRef<{ row: number; until: number } | null>(
    null
  );
  React.useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (pending.row >= rows.length || Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    const row = containerRef.current?.querySelector(
      `[data-row-index="${pending.row}"]`
    );
    if (row instanceof HTMLElement) {
      pendingFocus.current = null;
      row.focus();
    }
  });

  const isDrawn = (rowIndex: number) => {
    if (!shouldVirtualScroll || virtualItems.length === 0) return true;
    const line = rowLine[rowIndex];
    return (
      line >= virtualItems[0].index &&
      line <= virtualItems[virtualItems.length - 1].index
    );
  };

  // A roving tab stop has to sit on a row that exists. The hook puts it on the
  // focused row, and in a windowed table that row can be scrolled clean out of
  // the DOM — taking the whole table out of the tab order with it. When it is
  // gone, the first drawn row holds the stop instead.
  let firstDrawnRow = 0;
  if (shouldVirtualScroll) {
    for (const virtual of virtualItems) {
      const item = items[virtual.index];
      if (item.row) {
        firstDrawnRow = item.rowIndex;
        break;
      }
    }
  }
  const tabStopRow =
    focusedRowIndex >= 0 && isDrawn(focusedRowIndex)
      ? focusedRowIndex
      : firstDrawnRow;

  // A row is not an anchor — the name cell inside it is — but the whitespace
  // beside the name still opens the row, and it reads the gesture through the
  // same code, so a modifier means the same thing wherever it lands.
  const handleRowGesture = (
    row: TData,
    event: React.MouseEvent | React.KeyboardEvent
  ) => {
    // Quick actions, menus and the row's own links are their own targets.
    const target = event.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("a") ||
      target.closest('[role="menuitem"]') ||
      target.closest("[data-quick-actions]")
    ) {
      return;
    }

    const href = getRowHref?.(row);
    if (href) {
      // A list is where you are already browsing, so plain click goes there
      // rather than peeking: the peek exists to check a name mentioned
      // elsewhere without losing the page, and here the page is the list.
      linkGesture(event, href, () => navigate(href));
    } else if (onRowClick && readLinkIntent(event) === "activate") {
      // No destination, so nothing to open a tab on; only a plain click acts.
      onRowClick(row);
    }
  };

  const renderRow = (row: Row<TData>, index: number, line: number) => {
    const rowProps = keyboardNavEnabled ? getRowProps(index) : undefined;
    const isFocused = focusedRowIndex === index;
    const act = isClickable
      ? (event: React.MouseEvent | React.KeyboardEvent) =>
          handleRowGesture(row.original, event)
      : undefined;

    return (
      <TableRow
        key={row.id}
        data-index={line}
        ref={shouldVirtualScroll ? virtualizer.measureElement : undefined}
        // No `data-state="selected"`: nothing in this app ever selects a row
        // — no checkbox column, no selection state, no handler — so the answer
        // was always "no". `TableRow` keeps the style for whoever wires
        // selection up later.
        // `rowProps` carries `data-focused`, which is what reveals the row's
        // actions — read by CSS rather than by React, because hovering a row
        // used to set state, and that rebuilt every column definition and
        // re-rendered every cell in the table under the pointer.
        {...rowProps}
        // After the spread on purpose: the hook's tab stop follows the focused
        // row, and the one that ships has to follow a drawn one.
        tabIndex={rowProps && (index === tabStopRow ? 0 : -1)}
        className={cn(
          isClickable && "cursor-pointer",
          isFocused && "ring-1 ring-inset ring-info",
          "relative group"
        )}
        onClick={act}
        onAuxClick={act}
        onKeyDown={
          rowProps &&
          ((event: React.KeyboardEvent) => {
            // Home and End reach past the drawn window, and so does an arrow
            // at its edge. The hook focuses by querying the DOM, so the row
            // has to be scrolled into existence before it can be handed over.
            const target = navTarget(event.key, index, rows.length);
            if (target !== null && !isDrawn(target)) {
              event.preventDefault();
              pendingFocus.current = {
                row: target,
                until: Date.now() + PENDING_FOCUS_MS,
              };
              virtualizer.scrollToIndex(rowLine[target], { align: "center" });
              return;
            }
            rowProps.onKeyDown(event);
            // The hook owns the arrows, Home/End and Escape. Enter is an
            // activation, so it belongs to the click's gesture instead.
            if (event.key === "Enter") act?.(event);
          })
        }
      >
        {row.getVisibleCells().map((cell) => (
          <TableCell
            key={cell.id}
            className={cn(
              cellPadding,
              cell.column.id !== ACTIONS_COLUMN_ID && clipText
            )}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        ))}
      </TableRow>
    );
  };

  const renderItem = (item: BodyItem<TData>, line: number) =>
    item.row ? (
      renderRow(item.row, item.rowIndex, line)
    ) : (
      <TableRow
        key={item.key}
        data-index={line}
        ref={shouldVirtualScroll ? virtualizer.measureElement : undefined}
        data-quiet
        className="border-0"
      >
        <TableCell
          colSpan={visibleColumnCount}
          className="px-2.5 pb-1 pt-3 text-[11px] text-fg-fnt"
        >
          {item.caption}
        </TableCell>
      </TableRow>
    );

  // A spacer, not a row: `data-quiet` keeps the hover off it and it carries
  // no rule of its own.
  const spacer = (where: string, height: number) => (
    <tr key={where} data-quiet aria-hidden="true">
      <td colSpan={visibleColumnCount} style={{ height }} />
    </tr>
  );

  const body = shouldVirtualScroll
    ? [
        ...(padTop > 0 ? [spacer("pad-top", padTop)] : []),
        ...virtualItems.map((virtual) =>
          renderItem(items[virtual.index], virtual.index)
        ),
        ...(padBottom > 0 ? [spacer("pad-bottom", padBottom)] : []),
      ]
    : items.map((item, line) => renderItem(item, line));

  if (isLoading) {
    return (
      <TableSkeleton
        widths={columns.map((column) => column.size ?? 100)}
        compact={isCompact}
        grouped={grouping !== null}
      />
    );
  }

  // `min-h-0` and nothing else, at every level down to the port: a flex item
  // is `flex: 0 1 auto` by default — as tall as its content, shrinking only
  // when the column runs out of room — and `min-h-0` is what lets that shrink
  // go past the content instead of stopping at it. `flex-1` here would make
  // the height a target rather than a ceiling and strand the count line at
  // the bottom of a mostly empty window.
  return (
    <RowActionsProvider actions={quickActions}>
      <div className={cn("flex flex-col gap-2", fill && "min-h-0")}>
        <div className="flex flex-none flex-wrap items-center justify-between gap-2">
          {/* A search field is a text entry, not a panel: the box only
            appears once it has focus or a value. */}
          <div className="flex h-7 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover focus-within:bg-hover">
            <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <input
              type="text"
              aria-label={searchPlaceholder ?? t("action", "searchEllipsis")}
              placeholder={searchPlaceholder ?? t("action", "searchEllipsis")}
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              className="w-40 bg-transparent text-xs text-fg outline-hidden placeholder:text-fg-fnt"
            />
          </div>
          <div className="flex items-center gap-2">
            {/* Not a warning any more, a fact: the list is whole and only a
              screenful of it is drawn. It stays because "why is this list
              slow" and "why is my pod not here" have the same answer often
              enough — narrow the scope or the search. */}
            {isLong && (
              <div className="flex items-center gap-1.5 text-[11px] text-fg-fnt">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{t("readings", "longListTrim", { n: data.length })}</span>
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setTableDensity(isCompact ? "comfortable" : "compact")
                  }
                  className="h-7 w-7 p-0 text-fg-mut"
                >
                  {isCompact ? (
                    <AlignJustify className="h-3.5 w-3.5" />
                  ) : (
                    <List className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isCompact
                  ? t("action", "comfortableView")
                  : t("action", "compactView")}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div
          ref={containerRef}
          className={cn(fill && "flex min-h-0 flex-col")}
          role={keyboardNavEnabled ? "grid" : undefined}
          aria-label={keyboardNavEnabled ? t("nav", "dataTable") : undefined}
        >
          <Table
            // The scroll port has to be the element the header sticks to and
            // the element the virtualiser measures. Wrapping another div around
            // the table's own container gave it neither.
            containerRef={scrollRef}
            // Every column here declares a width, which is what makes fixed
            // layout safe: it stops the browser re-measuring columns from
            // content that changes on every watch tick.
            className="table-fixed"
            containerClassName={cn(
              shouldVirtualScroll && "scrollbar-thin",
              fill && "min-h-0"
            )}
            // A filled table takes its bound from the flex row above; only an
            // unfilled one falls back to the fixed port.
            containerStyle={
              shouldVirtualScroll && !fill
                ? { maxHeight: virtualScrollHeight }
                : undefined
            }
          >
            <TableHeader
              className={cn(
                // Wherever the port can scroll. A filled table's does whenever
                // its rows outgrow the pane, which is not only past the
                // windowing mark — a 40-row list in a short window used to
                // scroll its own column labels away.
                (fill || shouldVirtualScroll) && "sticky top-0 z-10 bg-canvas"
              )}
            >
              {table.getHeaderGroups().map((headerGroup) => {
                // The denominator for the shares below. Only the columns
                // actually on screen count, so hiding one hands its room to the
                // rest instead of leaving a gap.
                const totalSize = headerGroup.headers.reduce(
                  (sum, header) => sum + header.getSize(),
                  0
                );
                return (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      return (
                        <TableHead
                          key={header.id}
                          // A share of the table, not a pixel count. Fixed layout
                          // reads its widths from the first row and resolves
                          // `width: 100%` as `max(100%, Σ widths)` — so declared
                          // pixels never shrink, and the ten columns a Pods list
                          // wants added up to 378px more than the default window
                          // has: a permanent horizontal scrollbar with the row's
                          // actions off the right edge. As percentages the same
                          // numbers keep their proportions and always sum to the
                          // table, at any width.
                          style={{
                            width: `${(header.getSize() / totalSize) * 100}%`,
                          }}
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
                );
              })}
            </TableHeader>
            <TableBody>
              {rows.length ? (
                body
              ) : (
                <TableRow data-quiet>
                  <TableCell
                    colSpan={visibleColumnCount}
                    className="h-32 text-center"
                  >
                    {/* "Nothing matches your filter" and "this cluster has
                     * none of these" are different problems with different
                     * fixes — saying "No results." for both leaves the user
                     * guessing which one they're looking at. */}
                    {searchValue ? (
                      <div className="flex flex-col items-center gap-2">
                        <SearchX
                          className="h-5 w-5 text-fg-mut"
                          aria-hidden="true"
                        />
                        <p className="text-xs text-fg-mut">
                          <T section="empty" k="nothingMatches" />{" "}
                          <span className="font-mono text-fg">
                            {searchValue}
                          </span>
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => setSearchValue("")}
                        >
                          {t("action", "clearSearch")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Inbox
                          className="h-5 w-5 text-fg-mut"
                          aria-hidden="true"
                        />
                        <p className="text-xs text-fg-mut">
                          {emptyMessage ?? (
                            <T section="empty" k="noResourcesInScope" />
                          )}
                        </p>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {/* What the table holds, and nothing about pages. A live list has no
          stable page 2 — objects appear and vanish under the reader, so a row
          they saw a moment ago moves to another page they have to go and find
          — and Ctrl-F only ever searched the twenty-five rows on screen. The
          list is whole, the search narrows it, and long ones scroll. */}
        <div className="flex flex-none items-center justify-between text-[11px] text-fg-fnt">
          <div>
            {/* The noun is the kind's own plural and stays as the cluster
              spells it; only the frame around it is translated. Without one
              — a table of something with no kind — the frame counts rows. */}
            {rowLabel === undefined
              ? t("readings", "rowCount", { n: filteredRows })
              : filteredRows === totalRows
                ? `${totalRows} ${
                    totalRows === 1 ? toSingularNoun(rowLabel) : rowLabel
                  }`
                : t("readings", "rowsOfTotal", {
                    shown: filteredRows,
                    total: totalRows,
                    label: rowLabel,
                  })}
          </div>
        </div>
      </div>
    </RowActionsProvider>
  );
}
