/**
 * The columns of the three breakdowns, built once per language: each one
 * floored at the width of what it says, the least needed hidden first when
 * the port cannot hold every floor, as the app's lists are laid out.
 */
import { ResourceRef } from "@/components/object/ResourceRef";
import type { ColumnDef } from "@/components/ui/table-features";
import type { T } from "@/i18n/useT";
import {
  monthOf,
  type NamespaceCost,
  type NodeCost,
  type WorkloadCost,
} from "@/lib/cost";
import {
  EFFICIENCY_WINDOW,
  type Efficiency,
  type WorkloadEfficiency,
} from "@/lib/efficiency";
import { drawnCrd, kindWords } from "@/lib/links";
import { formatQuantity } from "@/lib/metric-format";
import {
  NAMESPACE_CELL_PX,
  nodeCellPx,
  refCellPx,
  wordsFloor,
} from "../-list/columns";
import {
  efficiencyWords,
  money,
  partOf,
  share,
  sortable,
  totalOf,
  usedWords,
  type Said,
} from "./cost-words";
import { EfficiencyCell, Money } from "./cost-cells";

interface Priced {
  perHour: number | null;
  share: number | null;
  currency: string;
}

export type NamespaceRow = NamespaceCost & Priced;
export type WorkloadRow = WorkloadCost &
  Priced & {
    id: string;
    /** The CRD its group serves the kind as; none for a built-in's own group. */
    crd: string | null | undefined;
    efficiency: WorkloadEfficiency;
  };
export type NodeRow = NodeCost & { currency: string };

export function namespaceColumns(t: T): ColumnDef<NamespaceRow>[] {
  const moneyColumn = (
    id: string,
    header: string,
    read: (row: NamespaceRow) => Said,
    yields?: number
  ): ColumnDef<NamespaceRow> => ({
    id,
    header,
    size: 110,
    accessorFn: (row) => sortable(read(row)),
    cell: ({ row }) => (
      <Money value={read(row.original)} currency={row.original.currency} />
    ),
    meta: {
      share: (row: NamespaceRow, tt: T) => money(read(row), row.currency, tt),
      floor: wordsFloor((row: NamespaceRow, tt) =>
        money(read(row), row.currency, tt)
      ),
      yields,
    },
  });
  return [
    {
      id: "namespace",
      accessorKey: "namespace",
      header: t("columns", "namespace"),
      size: 200,
      cell: ({ row }) => (
        <ResourceRef
          kind="Namespace"
          crd={BUILT_IN}
          name={row.original.namespace}
          showKind={false}
        />
      ),
      meta: {
        names: true,
        floor: (_t: T, rows: readonly NamespaceRow[]) =>
          refCellPx(rows, (row) => row.namespace, 31),
      },
    },
    moneyColumn("perHour", t("cost", "perHour"), (row) => totalOf(row)),
    moneyColumn(
      "perMonth",
      t("cost", "perMonth"),
      (row) => totalOf(row, monthOf(1)),
      7
    ),
    {
      id: "share",
      header: t("cost", "share"),
      size: 70,
      accessorFn: (row) => row.share ?? -1,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {share(row.original.share, t)}
        </span>
      ),
      meta: {
        share: (row: NamespaceRow, tt: T) => share(row.share, tt),
        floor: wordsFloor((row: NamespaceRow, tt) => share(row.share, tt)),
        yields: 6,
      },
    },
    moneyColumn("cpu", t("cost", "cpu"), (row) => partOf(row, "cpu"), 5),
    moneyColumn(
      "memory",
      t("cost", "memory"),
      (row) => partOf(row, "memory"),
      4
    ),
    moneyColumn("gpu", t("cost", "gpu"), (row) => partOf(row, "gpu"), 2),
    moneyColumn(
      "storage",
      t("cost", "storage"),
      (row) => partOf(row, "storage"),
      3
    ),
    moneyColumn(
      "loadBalancer",
      t("cost", "loadBalancers"),
      (row) => partOf(row, "loadBalancer"),
      1
    ),
  ];
}

const avgOf = (e: Efficiency) =>
  e.state === "measured" || e.state === "unrequested" ? (e.avg ?? -1) : -1;

/** A column as wide as the widest of what it says, in the face it is drawn in. */
const saying = <Row,>(
  words: (row: Row, t: T) => string,
  face: "sans" | "mono" = "sans"
) => wordsFloor(words, face);

/**
 * The breakdown by workload, laid out as the app's lists are: each column
 * floored at the width of what it says, the least needed hidden first
 * (`yields`) when the port cannot hold every floor, and the rest scrolled.
 * The name and its cost are never hidden.
 */
export function workloadColumns(t: T): ColumnDef<WorkloadRow>[] {
  return [
    {
      id: "workload",
      header: t("cost", "workload"),
      size: 300,
      accessorFn: (row) => `${row.key.kind}/${row.key.name}`,
      cell: ({ row }) => (
        <ResourceRef
          kind={row.original.key.kind}
          crd={row.original.crd}
          name={row.original.key.name}
          namespace={row.original.key.namespace}
        />
      ),
      meta: {
        share: (row: WorkloadRow) => `${row.key.kind} ${row.key.name}`,
        // Kinds mix here, so every row says its kind before its name, as
        // Audit does; a cell too narrow for both drops the kind, and only
        // the rows with longer names lost theirs.
        floor: (_t: T, rows: readonly WorkloadRow[]) =>
          refCellPx(rows, (row) => row.key.name, 31) +
          Math.ceil(
            Math.max(
              0,
              ...rows.map(
                (row) =>
                  kindWords({ kind: row.key.kind, crd: row.crd }).length + 1
              )
            ) * 7.2
          ),
      },
    },
    {
      id: "namespace",
      header: t("columns", "namespace"),
      size: 160,
      accessorFn: (row) => row.key.namespace,
      cell: ({ row }) => (
        <span className="font-mono text-fg-mut">
          {row.original.key.namespace}
        </span>
      ),
      // Never given up for width: two `web`s in two namespaces read alike
      // without it. One namespace chosen drops it, the scope bar saying it.
      meta: { floor: NAMESPACE_CELL_PX },
    },
    {
      id: "pods",
      header: t("columns", "pods"),
      size: 60,
      accessorKey: "pods",
      meta: {
        floor: saying((row: WorkloadRow) => String(row.pods), "mono"),
        yields: 3,
      },
    },
    {
      id: "perHour",
      size: 110,
      header: t("cost", "perHour"),
      accessorFn: (row) => sortable(totalOf(row)),
      cell: ({ row }) => (
        <Money value={totalOf(row.original)} currency={row.original.currency} />
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          money(totalOf(row), row.currency, tt),
        floor: saying(
          (row: WorkloadRow, tt) => money(totalOf(row), row.currency, tt),
          "mono"
        ),
      },
    },
    {
      id: "share",
      header: t("cost", "share"),
      size: 70,
      accessorFn: (row) => row.share ?? -1,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {share(row.original.share, t)}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) => share(row.share, tt),
        floor: saying((row: WorkloadRow, tt) => share(row.share, tt), "mono"),
        yields: 4,
      },
    },
    {
      id: "cpuRequested",
      size: 100,
      header: t("cost", "cpuRequested"),
      accessorFn: (row) => row.requests.cpu,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {formatQuantity(row.original.requests.cpu, "cpu")}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow) => formatQuantity(row.requests.cpu, "cpu"),
        floor: saying(
          (row: WorkloadRow) => formatQuantity(row.requests.cpu, "cpu"),
          "mono"
        ),
        yields: 2,
      },
    },
    {
      id: "cpuUsed",
      size: 180,
      header: t("cost", "cpuUsed", { window: EFFICIENCY_WINDOW }),
      accessorFn: (row) => avgOf(row.efficiency.cpu),
      cell: ({ row }) => (
        <span className="text-[11px]">
          {usedWords(row.original.efficiency.cpu, "cpu", t)}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          usedWords(row.efficiency.cpu, "cpu", tt),
        floor: saying((row: WorkloadRow, tt) =>
          usedWords(row.efficiency.cpu, "cpu", tt)
        ),
        yields: 6,
      },
    },
    {
      id: "memoryRequested",
      size: 110,
      header: t("cost", "memoryRequested"),
      accessorFn: (row) => row.requests.memory,
      cell: ({ row }) => (
        <span className="font-mono tabular-nums">
          {formatQuantity(row.original.requests.memory, "memory")}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow) =>
          formatQuantity(row.requests.memory, "memory"),
        floor: saying(
          (row: WorkloadRow) => formatQuantity(row.requests.memory, "memory"),
          "mono"
        ),
        yields: 1,
      },
    },
    {
      id: "memoryUsed",
      size: 180,
      header: t("cost", "memoryUsed", { window: EFFICIENCY_WINDOW }),
      accessorFn: (row) => avgOf(row.efficiency.memory),
      cell: ({ row }) => (
        <span className="text-[11px]">
          {usedWords(row.original.efficiency.memory, "memory", t)}
        </span>
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          usedWords(row.efficiency.memory, "memory", tt),
        floor: saying((row: WorkloadRow, tt) =>
          usedWords(row.efficiency.memory, "memory", tt)
        ),
        yields: 5,
      },
    },
    {
      id: "efficiency",
      size: 240,
      header: t("cost", "efficiency"),
      accessorFn: (row) =>
        row.efficiency.cpu.state === "measured"
          ? (row.efficiency.cpu.ratio ?? -1)
          : -1,
      cell: ({ row }) => (
        <EfficiencyCell efficiency={row.original.efficiency} />
      ),
      meta: {
        share: (row: WorkloadRow, tt: T) =>
          `${tt("cost", "cpu")} ${efficiencyWords(row.efficiency.cpu, tt)}; ${tt(
            "cost",
            "memory"
          )} ${efficiencyWords(row.efficiency.memory, tt)}`,
        // Two lines, each its resource's word and its own; the wider one.
        floor: (tt: T, rows: readonly WorkloadRow[]) =>
          Math.max(
            cpuEfficiencyFloor(tt, rows),
            memoryEfficiencyFloor(tt, rows)
          ),
      },
    },
  ];
}

const cpuEfficiencyFloor = saying(
  (row: WorkloadRow, t: T) =>
    `${t("cost", "cpu")} ${efficiencyWords(row.efficiency.cpu, t)}`
);
const memoryEfficiencyFloor = saying(
  (row: WorkloadRow, t: T) =>
    `${t("cost", "memory")} ${efficiencyWords(row.efficiency.memory, t)}`
);

export function nodeColumns(t: T, estimate: boolean): ColumnDef<NodeRow>[] {
  const moneyColumn = (
    id: string,
    header: string,
    read: (row: NodeRow) => number | null,
    yields?: number
  ): ColumnDef<NodeRow> => ({
    id,
    header,
    size: 110,
    accessorFn: (row) => read(row) ?? -1,
    cell: ({ row }) => (
      <Money value={read(row.original)} currency={row.original.currency} />
    ),
    meta: {
      share: (row: NodeRow, tt: T) => money(read(row), row.currency, tt),
      floor: saying(
        (row: NodeRow, tt) => money(read(row), row.currency, tt),
        "mono"
      ),
      yields,
    },
  });
  const spotWords = (row: NodeRow, tt: T) =>
    row.spot === null
      ? ""
      : row.spot
        ? tt("cost", "spotYes")
        : tt("cost", "spotNo");
  return [
    {
      id: "node",
      accessorKey: "name",
      header: t("columns", "node"),
      size: 240,
      cell: ({ row }) => (
        <ResourceRef
          kind="Node"
          crd={BUILT_IN}
          name={row.original.name}
          showKind={false}
        />
      ),
      meta: {
        floor: (_t: T, rows: readonly NodeRow[]) =>
          nodeCellPx(rows, (row) => row.name),
      },
    },
    {
      id: "instanceType",
      header: t("cost", "instanceType"),
      size: 130,
      accessorFn: (row) => row.instanceType ?? "",
      meta: {
        floor: saying((row: NodeRow) => row.instanceType ?? "", "mono"),
        yields: 3,
      },
    },
    {
      id: "spot",
      header: t("cost", "spot"),
      size: 90,
      accessorFn: (row) => spotWords(row, t),
      meta: { floor: saying(spotWords), yields: 1 },
    },
    moneyColumn("perHour", t("cost", "perHour"), (row) => row.perHour),
    moneyColumn("allocated", t("cost", "allocated"), (row) => row.allocated, 4),
    moneyColumn("idle", t("cost", "idle"), (row) => row.idle, 5),
    // Only an estimate knows it: OpenCost's idle already holds it.
    ...(estimate
      ? [
          moneyColumn(
            "reserved",
            t("cost", "reserved"),
            (row) => row.reserved,
            2
          ),
        ]
      : []),
  ];
}

/** Namespaces and nodes are the core group's own kinds. */
const BUILT_IN = drawnCrd({ kind: "Node", group: "" });
