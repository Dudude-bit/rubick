/**
 * The flows table. Renderers are built once per language; a cell says its
 * number and, in its title, whose number it is or why it has none. The two
 * ends are what a row is: floored at a readable name and raised toward the
 * whole of it before any number gets more than its digits, which never go
 * under their own width. The least needed numbers give way first.
 */
import type { ColumnDef } from "@/components/ui/table-features";
import type { Measure } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { Cell, FlowRow } from "@/lib/traffic";
import { refCellPx, wordsFloor } from "../-list/columns";
import { End, Figure } from "./flow-cells";
import {
  cellText,
  endLabel,
  endSub,
  endText,
  type CellKind,
} from "./traffic-words";

/** Lowest first is wrong for a rate, so a missing number sorts below every real one. */
const sortable = (cell: Cell) => cell.value ?? -1;

/** An end is never drawn narrower than this many glyphs of its name, nor raised past the whole of it. */
const END_FLOOR_GLYPHS = 14;
const END_WHOLE_GLYPHS = 48;

type NumberId =
  | "requests"
  | "events"
  | "errorShare"
  | "p50"
  | "p95"
  | "p99"
  | "bytes"
  | "drops";

/** The measure each number column is filled from. */
export const COLUMN_MEASURE: Record<NumberId, Measure> = {
  requests: "requests",
  events: "events",
  errorShare: "errors",
  p50: "p50",
  p95: "p95",
  p99: "p99",
  bytes: "bytes",
  drops: "drops",
};

const number = (
  id: NumberId,
  header: string,
  kind: CellKind,
  yields?: number
): ColumnDef<FlowRow> => ({
  id,
  header,
  size: 70,
  accessorFn: (row) => sortable(row[id]),
  cell: ({ row }) => (
    <Figure cell={row.original[id]} kind={kind} row={row.original} />
  ),
  meta: {
    share: (row: FlowRow, tt: T) => cellText(row[id], kind, tt),
    floor: wordsFloor(
      (row: FlowRow, tt) => cellText(row[id], kind, tt),
      "mono"
    ),
    yields,
  },
});

const end = (id: "from" | "to", header: string, t: T): ColumnDef<FlowRow> => ({
  id,
  header,
  size: 260,
  accessorFn: (row) => `${endLabel(row[id])} ${endSub(row[id], t)}`,
  cell: ({ row }) => <End end={row.original[id]} />,
  meta: {
    share: (row: FlowRow, tt: T) =>
      `${endLabel(row[id])} (${endSub(row[id], tt)})`,
    floor: (tt: T, rows: readonly FlowRow[]) =>
      refCellPx(rows, (row) => endText(row[id], tt), END_FLOOR_GLYPHS),
    ideal: (tt: T, rows: readonly FlowRow[]) =>
      refCellPx(rows, (row) => endText(row[id], tt), END_WHOLE_GLYPHS),
  },
});

export function flowColumns(t: T): ColumnDef<FlowRow>[] {
  return [
    end("from", t("traffic", "columnFrom"), t),
    end("to", t("traffic", "columnTo"), t),
    number("requests", t("traffic", "columnRequests"), "rate"),
    number("events", t("traffic", "columnEvents"), "rate", 7),
    number("errorShare", t("traffic", "columnErrors"), "share"),
    number("p50", "p50", "ms", 1),
    number("p95", "p95", "ms", 5),
    number("p99", "p99", "ms", 2),
    number("bytes", t("traffic", "columnBytes"), "bytes", 6),
    number("drops", t("traffic", "columnDrops"), "rate", 4),
    {
      id: "seenBy",
      header: t("traffic", "columnSeenBy"),
      size: 80,
      accessorFn: (row) => row.seenBy.join(", "),
      cell: ({ row }) => (
        <span className="text-[12px] text-fg-mut">
          {row.original.seenBy.join(", ")}
        </span>
      ),
      meta: {
        share: (row: FlowRow) => row.seenBy.join(", "),
        floor: wordsFloor((row: FlowRow) => row.seenBy.join(", ")),
        yields: 3,
      },
    },
  ];
}

/**
 * The columns a reading can fill: a number no found source measures is not
 * drawn, and its header is in `unfilled`. `null` measures (a source that
 * could not be looked for might measure anything) draws every column.
 */
export function drawnColumns(
  columns: readonly ColumnDef<FlowRow>[],
  measured: ReadonlySet<Measure> | null
): { columns: ColumnDef<FlowRow>[]; unfilled: string[] } {
  const fills = (column: ColumnDef<FlowRow>) => {
    const measure = COLUMN_MEASURE[column.id as NumberId] as
      | Measure
      | undefined;
    return measured === null || measure === undefined || measured.has(measure);
  };
  return {
    columns: columns.filter(fills),
    unfilled: columns
      .filter((column) => !fills(column))
      .map((column) => String(column.header)),
  };
}
