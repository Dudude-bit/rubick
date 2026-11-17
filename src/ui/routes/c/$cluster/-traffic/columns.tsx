/**
 * The flows table. Renderers are built once per language; a cell says its
 * number and, in its title, whose number it is or why it has none.
 */
import type { ColumnDef } from "@/components/ui/table-features";
import type { T } from "@/i18n/useT";
import type { Cell, FlowRow } from "@/lib/traffic";
import { End, Figure } from "./flow-cells";
import { cellText, endLabel, endSub, type CellKind } from "./traffic-words";

/** Lowest first is wrong for a rate, so a missing number sorts below every real one. */
const sortable = (cell: Cell) => cell.value ?? -1;

const number = (
  id: keyof Pick<
    FlowRow,
    "requests" | "errorShare" | "p50" | "p95" | "p99" | "bytes" | "drops"
  >,
  header: string,
  kind: CellKind
): ColumnDef<FlowRow> => ({
  id,
  header,
  accessorFn: (row) => sortable(row[id]),
  cell: ({ row }) => (
    <Figure cell={row.original[id]} kind={kind} row={row.original} />
  ),
  meta: {
    share: (row: FlowRow, tt: T) => cellText(row[id], kind, tt),
  },
});

export function flowColumns(t: T): ColumnDef<FlowRow>[] {
  return [
    {
      id: "from",
      header: t("traffic", "columnFrom"),
      accessorFn: (row) => `${endLabel(row.from)} ${endSub(row.from, t)}`,
      cell: ({ row }) => <End end={row.original.from} />,
      meta: {
        share: (row: FlowRow, tt: T) =>
          `${endLabel(row.from)} (${endSub(row.from, tt)})`,
      },
    },
    {
      id: "to",
      header: t("traffic", "columnTo"),
      accessorFn: (row) => `${endLabel(row.to)} ${endSub(row.to, t)}`,
      cell: ({ row }) => <End end={row.original.to} />,
      meta: {
        share: (row: FlowRow, tt: T) =>
          `${endLabel(row.to)} (${endSub(row.to, tt)})`,
      },
    },
    number("requests", t("traffic", "columnRequests"), "rate"),
    number("errorShare", t("traffic", "columnErrors"), "share"),
    number("p50", "p50", "ms"),
    number("p95", "p95", "ms"),
    number("p99", "p99", "ms"),
    number("bytes", t("traffic", "columnBytes"), "bytes"),
    number("drops", t("traffic", "columnDrops"), "rate"),
    {
      id: "seenBy",
      header: t("traffic", "columnSeenBy"),
      accessorFn: (row) => row.seenBy.join(", "),
      cell: ({ row }) => (
        <span className="text-[12px] text-fg-mut">
          {row.original.seenBy.join(", ")}
        </span>
      ),
      meta: { share: (row: FlowRow) => row.seenBy.join(", ") },
    },
  ];
}
