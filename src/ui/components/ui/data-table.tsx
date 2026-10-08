import * as React from "react";
import { PerfProfiler } from "@/lib/perf-profiler";
import { rowNouns, type KindNoun } from "@/lib/resource-registry";
import { useNavigate } from "@tanstack/react-router";
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
import {
  useColumnWidthsStore,
  type ColumnWidths,
} from "@/stores/columnWidthsStore";
import { readLinkIntent, useLinkGesture } from "@/hooks/useLinkGesture";
import { stallWatch } from "@/lib/stall-watch";
import { claimListKeys } from "@/lib/list-keys";
import { revealInScroller } from "@/lib/reveal";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { peekOfRow, usePeek, type PeekTarget } from "@/hooks/usePeek";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import type { AppSearch } from "@/lib/app-search";
import { useClusterStore } from "@/stores/clusterStore";
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
import { buildTableRows, type BodyItem } from "./data-table-rows";
import {
  ACTIONS_CELL_GUTTER,
  SIDEWAYS_SCROLLBAR_GUTTER,
  actionsColumnSize,
  tableLayout,
} from "./column-shares";
import { controlAt } from "@/lib/row-control";
import { holdTitles } from "@/lib/hold-titles";
import { columnFloor } from "@/lib/column-label";
import type { RowGrouping } from "@/components/ui/row-grouping";

import { cn } from "@/lib/utils";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { useShareSection } from "@/components/share/screen-share";
import { tableSection, type TableShare } from "@/components/share/table-share";
import { formatCount } from "@/lib/count";

interface DataTableProps<TData extends RowData> {
  columns: ColumnDef<TData>[];
  data: TData[];
  isLoading?: boolean;
  /**
   * The query-string key the search lives under. A tab records its route
   * with the query string, so a search kept here survives leaving the tab
   * and coming back; one kept in state did not.
   */
  searchParam?: keyof AppSearch;
  searchPlaceholder?: string;
  /** Force the windowed layout on or off; unset, the table reads its own length. */
  enableVirtualScroll?: boolean;
  /**
   * The table may use the whole height of the pane it is in: rows scroll
   * inside it while the search row and the count stay put.
   *
   * A ceiling rather than a target — a twelve-row list still ends where its
   * rows end instead of pushing its count line to the bottom of the window,
   * and only a list too long to fit reaches the ceiling.
   *
   * For a table that *is* the page: the parent has to be a flex column with a
   * height of its own — `h-full min-h-0` the whole way up to the scroll pane —
   * or there is no ceiling to find and the table grows the page scroll
   * instead. Off for a table embedded in a flow.
   */
  fill?: boolean;
  /**
   * How tall the windowed scroll port is when there is no height to fill.
   *
   * The virtualiser measures its scroll element, and an element with no bound
   * measures as tall as its own content — which draws every row, the one thing
   * windowing exists to avoid.
   */
  virtualScrollHeight?: number;
  /** Generate navigation URL for row click */
  getRowHref?: (row: TData) => string;
  /** The peek a row opens, for a kind its address cannot name: one outside the registry. */
  getRowPeek?: (row: TData) => PeekTarget | null;
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
  /** The kind the footer counts, where the label is not a kind the registry knows. */
  rowNoun?: KindNoun;
  /** What dragged column widths are filed under; the row label otherwise. */
  widthsKey?: string;
  /** The rows are not the whole of what was asked for, so no total. */
  partial?: boolean;
  /** Offers the rows on screen to this screen's Share. */
  share?: TableShare;
  /** The page's own list: it answers the list keys wherever the focus is. */
  pageKeys?: boolean;
  /** A right click, the Menu key or Shift+F10 on a row, and where to draw the menu. */
  onRowMenu?: (row: TData, at: { x: number; y: number }) => void;
  /** Drawn in place of the search box, for a page that narrows its rows before they reach the table. */
  toolbar?: React.ReactNode;
}

/**
 * Where the table stops mounting every row and draws a window instead — and
 * where it goes back.
 *
 * Two marks rather than one: a single one is a number that moves under the
 * reader, with a namespace sitting at a hundred pods crossing it on one watch
 * tick and back on the next. Crossing swaps every row's measured height for an
 * estimate and back, and on an unfilled table it swaps the whole list for a
 * fixed box with its own scrollbar — scroll position lost both ways.
 */
/**
 * The narrowest a column may be dragged, in the same units the column sizes
 * are written in. Eighty is about the width of the longest header word once
 * it is a share of a real table; below that a column is a sliver whose own
 * label is cut, which is not a width anybody is asking for.
 */
const MIN_COLUMN_SIZE = 80;

const VIRTUALISE_ABOVE_ROWS = 100;
const STAY_FLAT_BELOW_ROWS = 75;
const VIRTUAL_SCROLL_DEFAULT_HEIGHT = 600;

/**
 * How long a keyboard jump waits for its row to be drawn before giving up.
 *
 * The scroll and the mount take a frame or two; a row that has not arrived by
 * now is not coming. Without a deadline the pending index outlives the key
 * press for the life of the table: a watch tick that drops the list shorter
 * than the index strands it there, and when the list grows back the table
 * pulls focus off whatever the reader had moved to since.
 */
const PENDING_FOCUS_MS = 1000;

/** The generated column, named once so the cells can recognise it. */
const ACTIONS_COLUMN_ID = "_actions";
/** Cells holding controls, not text: an ellipsis there is a stray "..." beside a button. */
const CONTROL_COLUMNS = new Set([ACTIONS_COLUMN_ID, "actions"]);

/**
 * A row's height before it has been measured, per density. Compact is the 23px
 * pitch the cell padding is built around; comfortable is the same line box with
 * `py-2` around it. Only a first guess — every drawn row is measured, because a
 * comfortable row whose labels wrap is taller.
 */
const ESTIMATED_ROW_PX = { compact: 23, comfortable: 33 } as const;

/** How many rows either side of the viewport stay mounted. */
const OVERSCAN = 12;

/** Read off the table's attribute, so a density switch restyles rows instead of drawing them. */
const CELL_PADDING = "px-2.5 py-2 group-data-[density=compact]/table:py-[3px]";

/**
 * Text cells clip, because the table is fixed-layout; the actions cell does
 * not, or its buttons lose the hit area that hangs over the padding.
 */
const CLIP_TEXT =
  "overflow-hidden text-ellipsis whitespace-nowrap [&>a]:max-w-full";

/** What a row does when it is used, read at that moment from the table. */
interface RowEvents<TData extends RowData> {
  gesture: (row: TData, event: React.MouseEvent) => void;
  openPage: (row: TData, event: React.MouseEvent) => void;
  menu: (row: TData, index: number, event: React.MouseEvent) => void;
  key: (event: React.KeyboardEvent, index: number, row: TData) => void;
  focus: (id: string, index: number) => void;
}

interface BodyRowProps<TData extends RowData> {
  row: Row<TData>;
  index: number;
  line: number;
  selected: boolean;
  tabStop: boolean;
  keyboard: boolean;
  clickable: boolean;
  menu: boolean;
  measure: ((node: Element | null) => void) | undefined;
  /** Held only to compare: a new set of columns draws every row again. */
  columns: ColumnDef<TData>[];
  visibility: ColumnVisibilityState;
  events: React.RefObject<RowEvents<TData> | null>;
}

interface RowCellsProps<TData extends RowData> {
  row: Row<TData>;
  columns: ColumnDef<TData>[];
  visibility: ColumnVisibilityState;
}

function RowCellsView<TData extends RowData>({ row }: RowCellsProps<TData>) {
  return (
    <>
      {row.getVisibleCells().map((cell) => (
        <TableCell
          key={cell.id}
          className={cn(
            CELL_PADDING,
            !CONTROL_COLUMNS.has(cell.column.id) && CLIP_TEXT
          )}
          style={
            cell.column.id === ACTIONS_COLUMN_ID
              ? ACTIONS_CELL_GUTTER
              : undefined
          }
        >
          {flexRender(cell.column.columnDef.cell, cell.getContext())}
        </TableCell>
      ))}
    </>
  );
}

/** A row that only moved keeps its cells: a newest-first feed moves every row on each insert. */
const RowCells = React.memo(
  RowCellsView,
  (before, after) =>
    before.columns === after.columns &&
    before.visibility === after.visibility &&
    before.row.id === after.row.id &&
    before.row.original === after.row.original
) as typeof RowCellsView;

function BodyRowView<TData extends RowData>({
  row,
  index,
  line,
  selected,
  tabStop,
  keyboard,
  clickable,
  menu,
  measure,
  columns,
  visibility,
  events,
}: BodyRowProps<TData>) {
  const act = clickable
    ? (event: React.MouseEvent) => events.current?.gesture(row.original, event)
    : undefined;
  return (
    <TableRow
      data-index={line}
      data-row-index={index}
      ref={measure}
      // `aria-selected` is also what reveals the row's actions, read by CSS
      // rather than by React: hover state rebuilt every column definition
      // and re-rendered every cell in the table under the pointer.
      aria-selected={keyboard ? selected : undefined}
      tabIndex={keyboard ? (tabStop ? 0 : -1) : undefined}
      className={cn(
        clickable && "cursor-pointer",
        selected && "bg-hover ring-1 ring-inset ring-info",
        "relative group"
      )}
      onFocus={
        keyboard ? () => events.current?.focus(row.id, index) : undefined
      }
      onClick={act}
      onDoubleClick={(event) => events.current?.openPage(row.original, event)}
      onAuxClick={act}
      // Capture, so the row's own name opens this rather than the bare link
      // menu; a link to somewhere else keeps its own.
      onContextMenuCapture={
        menu
          ? (event) => events.current?.menu(row.original, index, event)
          : undefined
      }
      onKeyDown={
        keyboard
          ? (event) => events.current?.key(event, index, row.original)
          : undefined
      }
    >
      <RowCells row={row} columns={columns} visibility={visibility} />
    </TableRow>
  );
}

/**
 * A row draws again when its object, its place or its columns changed, and
 * not because the table did. A list re-reads itself every few seconds and a
 * watch replaces one row at a time; drawing all of them for each was the
 * stall on every list of a few dozen rows, and with every read failing the
 * whole table again every two seconds.
 */
function sameRow<TData extends RowData>(
  before: BodyRowProps<TData>,
  after: BodyRowProps<TData>
): boolean {
  for (const key of Object.keys(after) as Array<keyof BodyRowProps<TData>>) {
    if (key !== "row" && before[key] !== after[key]) return false;
  }
  return (
    before.row.id === after.row.id && before.row.original === after.row.original
  );
}

const BodyRow = React.memo(BodyRowView, sameRow) as typeof BodyRowView;

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
 * the object instead. The renderer below is defined once and reads the array
 * here, so a caller passing a fresh array — which every caller does — cannot
 * get it wrong.
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
    meta: { floor: actionsColumnSize(count) },
    enableSorting: false,
    enableHiding: false,
  };
}

/**
 * The scroll port's width, which the column floors are pixels of, and the ref
 * that attaches the port. A ref callback, because the port mounts after the
 * loading skeleton, where an effect reading `ref.current` never saw it.
 */
function usePortWidth(
  ref: React.RefObject<HTMLDivElement | null>
): [number, (node: HTMLDivElement | null) => () => void] {
  const [width, setWidth] = React.useState(0);
  const attach = React.useCallback(
    (node: HTMLDivElement | null) => {
      ref.current = node;
      let frame = 0;
      let observer: ResizeObserver | undefined;
      if (node) {
        setWidth(node.clientWidth);
        // A frame later, for the reason the virtualiser below measures in one.
        observer =
          typeof ResizeObserver === "undefined"
            ? undefined
            : new ResizeObserver(() => {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(() => setWidth(node.clientWidth));
              });
        observer?.observe(node);
      }
      return () => {
        ref.current = null;
        cancelAnimationFrame(frame);
        observer?.disconnect();
      };
    },
    [ref]
  );
  return [width, attach];
}

/** Where a nav key wants to go, or null if it is not a nav key. */
function navTarget(key: string, from: number, rowCount: number): number | null {
  if (rowCount === 0) return null;
  switch (key) {
    case "ArrowDown":
      if (from < 0) return 0;
      return from < rowCount - 1 ? from + 1 : null;
    case "ArrowUp":
      if (from < 0) return 0;
      return from > 0 ? from - 1 : null;
    case "Home":
      return 0;
    case "End":
      return rowCount - 1;
    default:
      return null;
  }
}

const VIM_KEYS: Record<string, string> = { j: "ArrowDown", k: "ArrowUp" };

const isMenuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

/**
 * Widgets that walk with Up and Down themselves; the list leaves those keys
 * to them. A tab strip walks with Left and Right, and nothing here uses j/k.
 */
const OWN_ARROWS =
  '[role="tablist"][aria-orientation="vertical"],[role="radiogroup"],[role="slider"],[role="tree"],[role="grid"],[role="menubar"]';

export function DataTable<TData extends RowData>(props: DataTableProps<TData>) {
  return (
    <PerfProfiler id="data-table">
      <DataTableInner {...props} />
    </PerfProfiler>
  );
}

function DataTableInner<TData extends RowData>({
  columns,
  data,
  isLoading = false,
  searchParam,
  searchPlaceholder,
  enableVirtualScroll,
  fill = false,
  virtualScrollHeight = VIRTUAL_SCROLL_DEFAULT_HEIGHT,
  getRowHref,
  getRowPeek,
  onRowClick,
  quickActions,
  enableKeyboardNav,
  getRowId,
  emptyMessage,
  grouping = null,
  rowLabel,
  rowNoun,
  widthsKey,
  partial = false,
  share,
  pageKeys = false,
  onRowMenu,
  toolbar,
}: DataTableProps<TData>) {
  const navigate = useNavigate();
  const linkGesture = useLinkGesture();
  const { open: openPeek } = usePeek();
  const { tableDensity, setTableDensity } = useDisplaySettingsStore();
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    []
  );
  const [globalFilter, setGlobalFilter] = React.useState("");
  const t = useT();
  const search = useAppSearch();
  const setSearch = useSetSearch();
  const inTheUrl = searchParam ? (search[searchParam] ?? "") : "";
  const [searchValue, setSearchValue] = React.useState(inTheUrl);
  // The query string is the authority, and the state beside it is only so
  // that typing does not wait for a navigation. Seeded once, the two came
  // apart whenever the address changed under a mounted table — the sidebar
  // row for the list you are already on, a deep link, a jump from the
  // palette: the box and the rows kept the old search while the tab
  // recorded the new address, and the filter vanished on the way back.
  React.useEffect(() => setSearchValue(inTheUrl), [inTheUrl]);
  const changeSearch = (value: string) => {
    setSearchValue(value);
    if (!searchParam) return;
    setSearch({ [searchParam]: value || undefined }, { replace: true });
  };
  const deferredSearch = React.useDeferredValue(searchValue);

  // Compact rows stay strictly single-line — a pod name like
  // `cron-demo-29765030-v9vcv` otherwise wraps to three lines and the row
  // grows to triple height. 3px against a 16px line box and a 1px rule is a
  // 23px pitch: nothing in a cell may be taller than that line box or it, not
  // the padding, becomes the row height.
  const isCompact = tableDensity === "compact";

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

  // One namespace chosen is the same word on every row, and the scope bar
  // above already says it; several are grouped, and the caption says it.
  const oneNamespace = useClusterStore(
    (state) => state.namespaceScope.length === 1
  );
  const columnVisibility = React.useMemo<ColumnVisibilityState>(() => {
    const state: ColumnVisibilityState = {};
    if (groupingActive) {
      for (const id of grouping?.hides ?? []) state[id] = false;
    }
    if (oneNamespace) state.namespace = false;
    return state;
  }, [groupingActive, grouping, oneNamespace]);

  // Latched rather than derived: between the two marks the answer is
  // "whatever it already was", which is a fact about the last render and not
  // about this data.
  const [wasLong, setWasLong] = React.useState(
    () => data.length > VIRTUALISE_ABOVE_ROWS
  );
  // The stall watch names the big lists on screen; a table says its size
  // and takes it back when it leaves.
  const tableId = React.useId();
  React.useEffect(() => {
    stallWatch.noteList(tableId, rowLabel ?? null, data.length);
  }, [tableId, rowLabel, data.length]);
  React.useEffect(() => () => stallWatch.forgetList(tableId), [tableId]);
  const isLong =
    data.length > VIRTUALISE_ABOVE_ROWS
      ? true
      : data.length < STAY_FLAT_BELOW_ROWS
        ? false
        : wasLong;
  if (isLong !== wasLong) setWasLong(isLong);

  const shouldVirtualScroll = enableVirtualScroll ?? isLong;

  // Keyed on the count, not the array: the cell renderer reads the array from
  // the context, and the column has nothing else to learn from it.
  const actionCount = quickActions?.length ?? 0;
  const columnsWithActions = React.useMemo(() => {
    if (actionCount === 0) return columns;
    // Drop any column already claiming the id, so it cannot appear twice.
    const filteredColumns = columns.filter(
      (col) => !CONTROL_COLUMNS.has(col.id ?? "")
    );
    return [...filteredColumns, createActionsColumn<TData>(actionCount)];
  }, [columns, actionCount]);

  // Keyed by what the table lists rather than by `tableId`, which is a
  // `useId` and new on every mount — a width that forgot itself on the way to
  // the next page is a control that does not hold. A table with no label
  // still resizes; it just has nowhere to remember it.
  const widthsFiledAs = widthsKey ?? rowLabel ?? null;
  const storedWidths = useColumnWidthsStore((state) =>
    widthsFiledAs ? state.widths[widthsFiledAs] : undefined
  );
  const saveWidths = useColumnWidthsStore((state) => state.set);
  const forgetWidths = useColumnWidthsStore((state) => state.reset);
  const [localWidths, setLocalWidths] = React.useState<ColumnWidths>({});
  // What the drag is doing before anybody lets go. The store is persisted,
  // so writing there per frame means a `localStorage.setItem` per frame.
  const [dragging, setDragging] = React.useState<ColumnWidths | null>(null);
  const columnSizing = dragging ?? storedWidths ?? localWidths;
  const keepWidths = React.useCallback(
    (next: ColumnWidths) => {
      if (!widthsFiledAs) return setLocalWidths(next);
      // An empty map is not a width anybody chose; forgetting the table is
      // what lets the column definitions answer again.
      if (Object.keys(next).length === 0) return forgetWidths(widthsFiledAs);
      saveWidths(widthsFiledAs, next);
    },
    [widthsFiledAs, saveWidths, forgetWidths]
  );
  const setColumnSizing = React.useCallback(
    (updater: ColumnWidths | ((old: ColumnWidths) => ColumnWidths)) => {
      const next =
        typeof updater === "function" ? updater(columnSizing) : updater;
      keepWidths(next);
    },
    [columnSizing, keepWidths]
  );

  /**
   * The drag, written here rather than taken from the vendor, whose handler
   * commits pixel deltas. These tables are laid out in shares of their own
   * width and the dragged column sits in its own denominator, so pixels move
   * the rendered edge by a fraction of the travel — less and less as the
   * drag goes on. Moving width from one column to the next holds the total
   * still, which is what puts the edge under the finger.
   */
  const startResize = React.useCallback(
    (
      event: React.PointerEvent<HTMLSpanElement>,
      columnId: string,
      nextColumnId: string,
      sizes: { own: number; next: number },
      pairWidth: number,
      started: ColumnWidths
    ) => {
      // Only the primary button. A right-click on the grip started a drag
      // whose pointerup the context menu swallowed, leaving the table
      // resizing itself until the next click anywhere.
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      // A screen pixel is the pair's size over the pixels it is drawn
      // across. Zero width means nobody has measured the table yet, and
      // dividing by it would send the first move straight to the clamp.
      const perPixel = pairWidth > 0 ? (sizes.own + sizes.next) / pairWidth : 1;
      // A floor never wider than the column already is. The actions strip is
      // 64 units by design, so a flat 80 made the first pixel of any drag
      // inflate it and narrow its neighbour, undoing sizing nobody touched.
      const ownFloor = Math.min(MIN_COLUMN_SIZE, sizes.own);
      const nextFloor = Math.min(MIN_COLUMN_SIZE, sizes.next);
      const limit = sizes.own + sizes.next - nextFloor;
      // Outside the state updater, which React is free to defer: a drag
      // released in the same tick as its last move let go of a width nobody
      // had computed yet.
      let latest: ColumnWidths | null = null;
      const move = (moved: PointerEvent) => {
        const delta = (moved.clientX - startX) * perPixel;
        const own = Math.max(ownFloor, Math.min(limit, sizes.own + delta));
        latest = {
          ...started,
          [columnId]: own,
          [nextColumnId]: sizes.own + sizes.next - own,
        };
        setDragging(latest);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        if (latest) keepWidths(latest);
        setDragging(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    },
    [keepWidths]
  );

  const table = useTable({
    // Which features exist is part of the table's type, named in one place.
    // Row models come with them: in v9 the sorted and filtered ones are slots
    // on the feature set, not functions handed in here.
    features: tableStack,
    data,
    columns: columnsWithActions,
    getRowId,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnSizingChange: setColumnSizing,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      columnSizing,
    },
  });

  const rows = table.getRowModel().rows;
  useShareSection(share ? `table:${tableId}` : null, () =>
    share
      ? tableSection(table as never, { ...share, search: globalFilter }, t)
      : null
  );
  const isClickable = !!(getRowHref || onRowClick);
  const visibleColumnCount = table.getVisibleFlatColumns().length;

  const keyboardNavEnabled = enableKeyboardNav ?? !!(getRowHref || onRowClick);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const filterRef = React.useRef<HTMLInputElement>(null);

  // One road. The box used to be able to aim at a single column instead,
  // chosen by whether a caller passed a `searchKey`, and nothing said which
  // pages should — so ten of them narrowed the search to the name for no
  // stated reason, and the road they took was the one that quietly stopped
  // filtering (#185). A column opts out with `enableGlobalFilter: false`.
  React.useEffect(() => {
    setGlobalFilter(deferredSearch);
  }, [deferredSearch]);

  const filteredRows = table.getFilteredRowModel().rows.length;
  const totalRows = data.length;
  const nounsOf = (n: number) =>
    rowNoun ? { n, ...rowNoun } : rowNouns(rowLabel ?? "", n);

  const { items, rowLine } = React.useMemo(
    () => buildTableRows(rows, groupingActive ? grouping : null),
    [rows, groupingActive, grouping]
  );
  // In the order drawn, which grouping settles: the keys walk what is on
  // screen, not the order the rows were sorted in.
  const ordered = React.useMemo(
    () => items.flatMap((item) => (item.row ? [item.row] : [])),
    [items]
  );

  // By id, so a watch tick that replaces every row, or puts a new one above,
  // leaves the mark on the same object. The index is the fallback once the
  // object itself is gone: the mark stays where it was.
  const [selection, setSelection] = React.useState<{
    id: string;
    index: number;
  } | null>(null);
  const selectedIndex = React.useMemo(() => {
    if (!selection) return -1;
    const at = ordered.findIndex((row) => row.id === selection.id);
    if (at >= 0) return at;
    return ordered.length ? Math.min(selection.index, ordered.length - 1) : -1;
  }, [ordered, selection]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [portWidth, attachPort] = usePortWidth(scrollRef);
  // Floors are measured text: drawn again once the fonts they are measured in arrive.
  const [, fontsArrived] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (document.fonts?.status !== "loading") return;
    let live = true;
    void document.fonts.ready.then(() => live && fontsArrived());
    return () => {
      live = false;
    };
  }, []);

  // The window is spliced into the table with spacer rows rather than
  // absolutely positioned ones: an out-of-flow `tr` leaves the fixed-layout
  // column grid, and every cell would have to carry its own width again.
  //
  // TanStack Virtual returns functions React Compiler cannot safely memoize,
  // so it declines to compile this component. The runtime cost is the same
  // either way — the table re-renders cheaply — and the disable goes away when
  // the fix lands upstream.
  // oxlint-disable-next-line react-hooks/incompatible-library
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
  // measured heights are cached per item and `estimateSize` does not
  // invalidate that cache. Without this, toggling density on a list whose rows
  // have all been measured leaves the total height stale by the difference —
  // a scrollbar that lies, and rows that jump as each one re-measures.
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
  const headerRef = React.useRef<HTMLTableSectionElement>(null);
  const stickyHeader = fill || shouldVirtualScroll;

  const rowElement = (index: number) =>
    containerRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${index}"]`
    ) ?? null;

  // Never a bare `focus()`: it scrolls every ancestor that can, the window too.
  const focusRow = (element: HTMLElement) => {
    element.focus({ preventScroll: true });
    revealInScroller(
      element,
      stickyHeader ? (headerRef.current?.offsetHeight ?? 0) : 0
    );
  };

  React.useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (pending.row >= rows.length || Date.now() > pending.until) {
      pendingFocus.current = null;
      return;
    }
    const row = rowElement(pending.row);
    if (row) {
      pendingFocus.current = null;
      focusRow(row);
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

  // A roving tab stop has to sit on a row that exists. It follows the
  // selection, and in a windowed table that row can be scrolled clean out of
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
    selectedIndex >= 0 && isDrawn(selectedIndex)
      ? selectedIndex
      : firstDrawnRow;

  const select = (index: number) => {
    const row = ordered[index];
    if (!row) return;
    setSelection({ id: row.id, index });
    const element = isDrawn(index) ? rowElement(index) : null;
    if (element) return focusRow(element);
    pendingFocus.current = { row: index, until: Date.now() + PENDING_FOCUS_MS };
    virtualizer.scrollToIndex(rowLine[index], { align: "center" });
  };

  // Under the row when there is no pointer to open it at.
  const openMenu = (index: number, at?: { x: number; y: number }) => {
    const row = ordered[index];
    if (!row || !onRowMenu) return false;
    setSelection({ id: row.id, index });
    const box = rowElement(index)?.getBoundingClientRect();
    onRowMenu(row.original, at ?? { x: box?.left ?? 0, y: box?.bottom ?? 0 });
    return true;
  };

  const clearSelection = () => {
    setSelection(null);
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      containerRef.current?.contains(focused)
    )
      focused.blur();
  };

  // A row is not an anchor — the name cell inside it is — but the whitespace
  // beside the name still opens the row, and it reads the gesture through the
  // same code, so a modifier means the same thing wherever it lands.
  const handleRowGesture = (
    row: TData,
    event: React.MouseEvent | React.KeyboardEvent | KeyboardEvent
  ) => {
    // Quick actions, menus and the row's own links are their own targets.
    if (controlAt(event.target as HTMLElement)) return;

    const href = getRowHref?.(row);
    if (href) {
      // A plain click or Enter on a row whose object has a peek opens the
      // peek, the same as the click on the name inside it: one gesture, one
      // answer, wherever on the row it lands. The page is a double click
      // away, or Enter again in the peek. Modified ones open tabs.
      const peek = peekOfRow(row, getRowHref, getRowPeek);
      if (peek && readLinkIntent(event) === "activate") {
        event.preventDefault();
        if ("clientX" in event)
          holdTitles(event.target as HTMLElement, event.currentTarget, event);
        openPeek(peek);
        return;
      }
      linkGesture(event, href, () => navigate({ href }));
    } else if (onRowClick && readLinkIntent(event) === "activate") {
      // No destination, so nothing to open a tab on; only a plain activation acts.
      onRowClick(row);
    }
  };

  // Home and End reach past the drawn window, and so does an arrow at its
  // edge; `select` scrolls the row into existence before handing it focus.
  const onRowKey = (event: React.KeyboardEvent, index: number, row: TData) => {
    if (isMenuKey(event) && openMenu(index)) {
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End": {
        event.preventDefault();
        const to = navTarget(event.key, index, ordered.length);
        if (to !== null) select(to);
        return;
      }
      case "Escape":
        event.preventDefault();
        clearSelection();
        return;
      case "Enter":
        if (isClickable) handleRowGesture(row, event);
    }
  };

  // The same keys from anywhere else on the page: the body after a click on
  // nothing, the sidebar, a button. Not from a field, a terminal or an open
  // layer; `useShortcuts` has already turned those away.
  const pageKey = (event: KeyboardEvent): boolean => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inside = !!target && !!containerRef.current?.contains(target);
    if (event.key === "/" && filterRef.current) {
      event.preventDefault();
      filterRef.current.focus();
      return true;
    }
    const key = VIM_KEYS[event.key] ?? event.key;
    if (!inside && key === event.key && target?.closest(OWN_ARROWS))
      return false;
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (ordered.length === 0) return false;
      event.preventDefault();
      const to = navTarget(key, selectedIndex, ordered.length);
      if (to !== null) select(to);
      return true;
    }
    const row = ordered[selectedIndex];
    if (!row) return false;
    if (isMenuKey(event)) {
      if (!openMenu(selectedIndex)) return false;
      event.preventDefault();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      clearSelection();
      return true;
    }
    // A focused button or link owns its own Enter.
    if (event.key === "Enter" && isClickable) {
      if (target && target !== document.body && !inside) return false;
      handleRowGesture(row.original, event);
      return true;
    }
    return false;
  };

  const surfaceVisible = useSurfaceVisible();
  const pageKeyRef = React.useRef(pageKey);
  React.useEffect(() => {
    pageKeyRef.current = pageKey;
  });
  React.useEffect(
    () =>
      pageKeys && keyboardNavEnabled && surfaceVisible
        ? claimListKeys((event) => pageKeyRef.current(event))
        : undefined,
    [pageKeys, keyboardNavEnabled, surfaceVisible]
  );

  const rowEvents = React.useRef<RowEvents<TData> | null>(null);
  React.useLayoutEffect(() => {
    rowEvents.current = {
      gesture: handleRowGesture,
      openPage: (row, event) => {
        const href = getRowHref?.(row);
        if (!href || !peekOfRow(row, getRowHref, getRowPeek)) return;
        // The same places a single click keeps its hands off, so the two
        // gestures agree about what belongs to the row and what belongs to
        // the controls sitting in it. A link to somewhere else (a row's node,
        // its owner) keeps the double click; the row's own name is where the
        // eye goes when told "double click the row", so it must not be the
        // one spot where nothing happens.
        const control = controlAt(event.target as HTMLElement);
        if (
          control &&
          !(control.tagName === "A" && control.getAttribute("href") === href)
        ) {
          return;
        }
        navigate({ href });
      },
      menu: (row, index, event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (link && link.getAttribute("href") !== getRowHref?.(row)) return;
        event.preventDefault();
        event.stopPropagation();
        const keyboard = event.clientX === 0 && event.clientY === 0;
        if (!keyboard)
          holdTitles(event.target as HTMLElement, event.currentTarget, event);
        openMenu(
          index,
          keyboard ? undefined : { x: event.clientX, y: event.clientY }
        );
      },
      key: onRowKey,
      focus: (id, index) =>
        setSelection((current) =>
          current?.id === id && current.index === index
            ? current
            : { id, index }
        ),
    };
  });

  const renderRow = (row: Row<TData>, index: number, line: number) => (
    <BodyRow<TData>
      key={row.id}
      row={row}
      index={index}
      line={line}
      selected={selectedIndex === index}
      tabStop={index === tabStopRow}
      keyboard={keyboardNavEnabled}
      clickable={isClickable}
      menu={!!onRowMenu}
      measure={shouldVirtualScroll ? virtualizer.measureElement : undefined}
      columns={columnsWithActions}
      visibility={columnVisibility}
      events={rowEvents}
    />
  );

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

  // Only the columns actually on screen count, so hiding one hands its room
  // to the rest instead of leaving a gap.
  const specs = table.getVisibleFlatColumns().map((column) => ({
    size: column.getSize(),
    floor: columnFloor(column.columnDef, t),
  }));
  const layout = tableLayout(specs, portWidth);

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
          {toolbar !== undefined ? (
            <div className="flex h-7 min-w-0 items-center">{toolbar}</div>
          ) : (
            <div className="flex h-7 items-center gap-1.5 rounded px-1.5 text-fg-fnt transition-colors hover:bg-hover focus-within:bg-hover">
              <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <input
                ref={filterRef}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                type="text"
                aria-label={searchPlaceholder ?? t("action", "searchEllipsis")}
                placeholder={searchPlaceholder ?? t("action", "searchEllipsis")}
                value={searchValue}
                onChange={(event) => changeSearch(event.target.value)}
                // Back out to the rows without reaching for the mouse.
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    if (searchValue) changeSearch("");
                    else event.currentTarget.blur();
                  } else if (event.key === "ArrowDown" && keyboardNavEnabled) {
                    event.preventDefault();
                    select(0);
                  }
                }}
                className="w-40 bg-transparent text-xs text-fg outline-hidden placeholder:text-fg-fnt"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            {/* The list is whole and only a screenful of it is drawn. It
              stays because "why is this list slow" and "why is my pod not
              here" have the same answer often enough — narrow the scope or
              the search. */}
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
                  aria-label={
                    isCompact
                      ? t("action", "comfortableView")
                      : t("action", "compactView")
                  }
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
            containerRef={attachPort}
            // Every column here declares a width, which is what makes fixed
            // layout safe: it stops the browser re-measuring columns from
            // content that changes on every watch tick.
            className="group/table table-fixed"
            data-density={tableDensity}
            style={layout.scrolls ? { minWidth: layout.span } : undefined}
            containerClassName={cn(
              shouldVirtualScroll && "scrollbar-thin",
              fill && "min-h-0"
            )}
            // A filled table takes its bound from the flex row above; only an
            // unfilled one falls back to the fixed port.
            containerStyle={{
              ...(shouldVirtualScroll && !fill
                ? { maxHeight: virtualScrollHeight }
                : undefined),
              ...(layout.scrolls ? SIDEWAYS_SCROLLBAR_GUTTER : undefined),
            }}
          >
            <TableHeader
              ref={headerRef}
              className={cn(
                // Wherever the port can scroll. A filled table's does whenever
                // its rows outgrow the pane, which is not only past the
                // windowing mark — a 40-row list in a short window used to
                // scroll its own column labels away.
                stickyHeader && "sticky top-0 z-10 bg-canvas"
              )}
            >
              {table.getHeaderGroups().map((headerGroup) => {
                return (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header, index) => {
                      // Who gives up the width this one takes.
                      const next = headerGroup.headers[index + 1];
                      return (
                        <TableHead
                          key={header.id}
                          // A share of the table, not a pixel count. Fixed
                          // layout reads its widths from the first row
                          // and resolves `width: 100%` as
                          // `max(100%, Σ widths)`, so declared pixels never
                          // shrink: the ten columns a Pods list wants add up to
                          // 378px more than the default window has — a
                          // permanent horizontal scrollbar with the row's
                          // actions off the right edge. As percentages the same
                          // numbers keep their proportions and sum to the table
                          // at any width.
                          style={{ width: `${layout.shares[index]}%` }}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext()
                              )}
                          {/* Inside the column's own right edge, not
                              straddling it: straddling put 4.5px of the last
                              header past the table and gave every list a
                              little horizontal scroll it never had. The last
                              column has no grip — nothing to its right to
                              take width from. Double-click puts both columns
                              back to their declared widths. */}
                          {next && (
                            <span
                              // `presentation`, and deliberately: anything in
                              // the accessibility tree inside a `th` joins
                              // that header's name, so a labelled separator
                              // here made every column announce as "Name Drag
                              // to resize". The keyboard path belongs on an
                              // affordance of its own, not on this grip.
                              role="presentation"
                              onPointerDown={(event) => {
                                const drawn = tableLayout(
                                  specs,
                                  scrollRef.current?.clientWidth ?? 0
                                );
                                startResize(
                                  event,
                                  header.column.id,
                                  next.column.id,
                                  {
                                    own: header.getSize(),
                                    next: next.getSize(),
                                  },
                                  ((drawn.shares[index] +
                                    drawn.shares[index + 1]) /
                                    100) *
                                    drawn.span,
                                  columnSizing
                                );
                              }}
                              onDoubleClick={() =>
                                setColumnSizing((old) => {
                                  const back = { ...old };
                                  delete back[header.column.id];
                                  delete back[next.column.id];
                                  return back;
                                })
                              }
                              title={t("action", "dragToResize")}
                              className={cn(
                                "absolute inset-y-0 right-0 z-10 w-[9px] cursor-col-resize touch-none select-none",
                                "after:absolute after:inset-y-1 after:right-0 after:w-px after:bg-hair after:opacity-0 after:transition-opacity",
                                "hover:after:opacity-100"
                              )}
                            />
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
                          onClick={() => changeSearch("")}
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
        {/* What the table holds, and nothing about pages: a live list has no
          stable page 2 — objects appear and vanish under the reader, so a row
          moves to another page they have to go and find — and Ctrl-F would
          only search the rows on screen. */}
        <div className="flex flex-none items-center justify-between text-[11px] text-fg-fnt">
          <div>
            {/* The noun is the kind's own plural and stays as the cluster
              spells it; only the frame around it is translated. Without one
              — a table of something with no kind — the frame counts rows. */}
            {rowLabel === undefined && rowNoun === undefined
              ? partial
                ? t("readings", "rowCountWhereAnswered", { n: filteredRows })
                : t("readings", "rowCount", { n: filteredRows })
              : partial
                ? t("readings", "rowsWhereAnswered", nounsOf(filteredRows))
                : filteredRows === totalRows
                  ? t("readings", "objectCount", nounsOf(totalRows))
                  : t("readings", "rowsOfTotal", {
                      ...nounsOf(totalRows),
                      shown: formatCount(filteredRows),
                    })}
          </div>
        </div>
      </div>
    </RowActionsProvider>
  );
}
