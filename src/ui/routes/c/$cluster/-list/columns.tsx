/**
 * Column factory for resource tables
 *
 * Provides reusable column definitions to reduce duplication across resource lists.
 */

import type { ColumnDef } from "@/components/ui/table-features";
import { AgeHeader } from "@/components/ui/sortable-header";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import type { T as Translate } from "@/i18n/useT";
import { widestText } from "@/lib/text-width";
import { RealtimeAge } from "@/components/ui/realtime";
import { MetricValue, UnitValue } from "@/components/ui/metric-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { formatUsage, notMeasured } from "@/lib/metric-format";
import { cn } from "@/lib/utils";
import type { ResourceKind } from "@/lib/resource-registry";
import { ResourceRef } from "@/components/object/ResourceRef";
import { CopyName } from "../-object/CopyName";
import { None } from "@/components/ui/none";
import { declaredQuantity } from "@/lib/metric-format";

interface WithCreatedAt {
  createdAt?: string | null;
}

interface WithCpuUsage {
  cpuMillicores?: number | null;
}

interface WithMemoryUsage {
  memoryBytes?: number | null;
}

interface WithCpuLimits {
  cpuLimits?: string | null;
  cpuRequests?: string | null;
}

interface WithMemoryLimits {
  memoryLimits?: string | null;
  memoryRequests?: string | null;
}

/** The kind's icon and the copy mark with a 4px gap each, and a cell's 20px of padding. */
const NAME_CHROME_PX = 2 * (14 + 4) + 20;

/**
 * `named-port-demo-dcbc89bf5-4lh84` (31 glyphs at 7.2px) and the name cell's
 * chrome. The narrowest a Name column is drawn while its names are unknown:
 * it is the cell a reader aims at, so every other column gives up its room
 * before this one does.
 */
export const NAME_CELL_PX = Math.ceil(31 * 7.2 + NAME_CHROME_PX);

/** The node's 10px icon, its 4px gap and the link's 4px of padding, and a cell's padding. */
const NODE_CHROME_PX = 18 + 20;

/** `controlplane` (12 glyphs at 7.2px) and the node cell's chrome; a longer name ends in an ellipsis, whole on hover. */
export const NODE_CELL_PX = Math.ceil(12 * 7.2 + NODE_CHROME_PX);

/** The most of a node's name a column holds whole: `gke-prod-pool-1-a3f9-x2kd` and `k3d-rubick-live-agent-0`, not an EKS hostname. */
const NODE_GLYPHS = 28;

/** The most glyphs any of `rows` says in `text`, up to `cap`. */
function longestText<Row>(
  rows: readonly Row[],
  text: (row: Row) => string | null | undefined,
  cap: number
): number {
  let longest = 0;
  for (const row of rows) {
    const said = text(row)?.length ?? 0;
    if (said > longest) longest = Math.min(said, cap);
    if (longest === cap) break;
  }
  return longest;
}

/**
 * A Name column as narrow as the longest name it holds, up to 31 glyphs:
 * room a short list's names never use goes to the columns beside it.
 */
export const nameCellPx = (_t: unknown, rows: readonly { name: string }[]) =>
  rows.length === 0
    ? NAME_CELL_PX
    : Math.ceil(
        longestText(rows, (row) => row.name, 31) * 7.2 + NAME_CHROME_PX
      );

/** A Node column as wide as the longest node name in it, up to {@link NODE_GLYPHS}. */
export const nodeCellPx = <Row,>(
  rows: readonly Row[],
  node: (row: Row) => string | null | undefined
) =>
  rows.length === 0
    ? NODE_CELL_PX
    : Math.ceil(longestText(rows, node, NODE_GLYPHS) * 7.2 + NODE_CHROME_PX);

/** `ingress-nginx` and `cert-manager` whole: 14 glyphs at 7.2px and a cell's padding. */
export const NAMESPACE_CELL_PX = Math.ceil(14 * 7.2 + 20);

/** A status badge: its word in 11px mono at 6.6px a glyph, the 10px mark with its 4px gap, and a cell's padding. */
export const statusCellPx = (glyphs: number) =>
  Math.ceil(glyphs * 6.6 + 14 + 20);

/** The same badge around the widest of `words`, as they are drawn. */
export const badgeCellPx = (words: readonly string[]) =>
  widestText(words, "badge", 6.6) + 14 + 20;

/** `1.81Gi` (6 glyphs at 7.2px) and a cell's padding; the bar beside a limit is the part that goes first. */
export const METRIC_CELL_PX = Math.ceil(6 * 7.2 + 20);

/** A metric cell, or the words it says when there is no value, whichever is wider. */
export const metricCellFloor = (t: Translate) =>
  Math.max(
    METRIC_CELL_PX,
    widestText(
      [t("cluster", "metricNoSample"), t("cluster", "metricNotAvailable")],
      "sans",
      7.2
    ) + 20
  );

/** "59 мин" and "999 д." are the widest ages, 41px of 12px Inter, and a cell's 20px of padding. */
export const AGE_CELL_PX = 62;

/**
 * The name cell.
 *
 * `showKind` is off because the column header already says the kind: repeating
 * it in every row is the noise the coloured reference exists to remove.
 */
export function createNameColumn<
  Row extends { name: string; namespace?: string | null },
>(kind: ResourceKind): ColumnDef<Row> {
  return {
    size: 320,
    accessorKey: "name",
    meta: { floor: nameCellPx },
    header: columnHeader("columns", "name"),
    cell: ({ row }) => (
      <span className="group/name inline-flex min-w-0 max-w-full items-center gap-1">
        <ResourceRef
          kind={kind}
          name={row.original.name}
          namespace={row.original.namespace}
          showKind={false}
        />
        <CopyName name={row.original.name} />
      </span>
    ),
  };
}

/**
 * Creates a namespace column
 */
export function createNamespaceColumn<
  Row extends { namespace: string },
>(): ColumnDef<Row> {
  return {
    size: 190,
    accessorKey: "namespace",
    header: columnHeader("columns", "namespace"),
    meta: { floor: NAMESPACE_CELL_PX },
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">{row.original.namespace}</span>
    ),
  };
}

/** The distance from now, so the youngest object sorts first and one with no stamp sorts nowhere. */
export function ageOrder(createdAt: string | null | undefined) {
  const at = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isNaN(at) ? undefined : -at;
}

export const AGE_LABEL = { section: "columns", key: "age" } as const;

/**
 * Creates an age column from created_at timestamp
 * Uses RealtimeAge for auto-updating display
 */
export function createAgeColumn<Row extends WithCreatedAt>(): ColumnDef<Row> {
  return {
    size: 80,
    id: "age",
    accessorFn: (row) => ageOrder(row.createdAt),
    sortUndefined: "last",
    sortDescFirst: false,
    enableGlobalFilter: false,
    meta: { floor: AGE_CELL_PX, label: AGE_LABEL },
    header: AgeHeader,
    cell: ({ row }) => (
      <span className="text-fg-fnt">
        <RealtimeAge timestamp={row.original.createdAt} />
      </span>
    ),
  };
}

/**
 * Creates a CPU usage column: the number with a dimmed unit, plus an
 * inline bar when the container declares a limit.
 */
export function createCpuColumn<
  Row extends WithCpuUsage & Partial<WithCpuLimits>,
>(): ColumnDef<Row> {
  return {
    size: 90,
    id: "cpu",
    header: columnHeader("columns", "cpu"),
    meta: {
      floor: metricCellFloor,
      share: (row: Row, t) =>
        typeof row.cpuMillicores === "number"
          ? formatUsage(row.cpuMillicores, "cpu")
          : notMeasured(t),
    },
    cell: ({ row }) => {
      const used = row.original.cpuMillicores ?? null;
      const request = row.original.cpuRequests
        ? parseCPU(row.original.cpuRequests)
        : null;
      const limit = row.original.cpuLimits
        ? parseCPU(row.original.cpuLimits)
        : null;
      return (
        <MetricValue used={used} request={request} limit={limit} type="cpu" />
      );
    },
  };
}

/**
 * Creates a Memory usage column: the number with a dimmed unit, plus an
 * inline bar when the container declares a limit.
 */
export function createMemoryColumn<
  Row extends WithMemoryUsage & Partial<WithMemoryLimits>,
>(): ColumnDef<Row> {
  return {
    size: 100,
    id: "memory",
    header: columnHeader("columns", "memory"),
    meta: {
      floor: metricCellFloor,
      share: (row: Row, t) =>
        typeof row.memoryBytes === "number"
          ? formatUsage(row.memoryBytes, "memory")
          : notMeasured(t),
    },
    cell: ({ row }) => {
      const used = row.original.memoryBytes ?? null;
      const request = row.original.memoryRequests
        ? parseMemory(row.original.memoryRequests)
        : null;
      const limit = row.original.memoryLimits
        ? parseMemory(row.original.memoryLimits)
        : null;
      return (
        <MetricValue
          used={used}
          request={request}
          limit={limit}
          type="memory"
        />
      );
    },
  };
}

/** Kubernetes prints the short form; the long one is what people mean. */
const ACCESS_MODE_NAME: Record<string, string> = {
  RWO: "ReadWriteOnce",
  ROX: "ReadOnlyMany",
  RWX: "ReadWriteMany",
  RWOP: "ReadWriteOncePod",
};

/**
 * Access modes, as text.
 *
 * A mode is a fixed property of the volume, not a state it is in, so it gets
 * no pill — the abbreviations are already the shortest form there is.
 */
export function createAccessModesColumn<
  Row extends { accessModes: string[] },
>(): ColumnDef<Row> {
  return {
    size: 130,
    accessorKey: "accessModes",
    header: columnHeader("columns", "accessModes"),
    cell: ({ row }) => {
      const modes = row.original.accessModes;
      if (modes.length === 0) return <None />;
      return (
        <Tooltip>
          <TooltipTrigger className="font-mono text-fg-mid">
            {modes.join(" ")}
          </TooltipTrigger>
          <TooltipContent>
            {modes.map((mode) => (
              <div key={mode} className="text-xs">
                {ACCESS_MODE_NAME[mode] ?? mode}
              </div>
            ))}
          </TooltipContent>
        </Tooltip>
      );
    },
  };
}

/** Declared storage size, with the unit dimmed like every other quantity. */
export function createCapacityColumn<
  Row extends { capacity?: string | null },
>(): ColumnDef<Row> {
  return {
    size: 100,
    accessorKey: "capacity",
    header: columnHeader("columns", "capacity"),
    meta: {
      share: (row: Row) =>
        row.capacity ? declaredQuantity("storage", row.capacity) : null,
    },
    cell: ({ row }) =>
      row.original.capacity ? (
        <UnitValue value={declaredQuantity("storage", row.original.capacity)} />
      ) : (
        <None />
      ),
  };
}

/**
 * Creates a replicas column (ready/desired)
 */
export function createReplicasColumn<
  Row extends { replicas: { ready: number; desired: number } },
>(): ColumnDef<Row> {
  return {
    size: 100,
    id: "replicas",
    header: columnHeader("columns", "replicas"),
    meta: {
      share: (row: Row) => ({
        text: `${row.replicas.ready}/${row.replicas.desired}`,
        mono: true,
        role: row.replicas.ready === row.replicas.desired ? undefined : "warn",
      }),
    },
    cell: ({ row }) => {
      const { ready, desired } = row.original.replicas;
      const isHealthy = ready === desired;
      return (
        <span
          className={cn("font-mono", isHealthy ? "text-fg-mid" : "text-warn")}
        >
          {ready}/{desired}
        </span>
      );
    },
  };
}

/** Data keys for ConfigMaps/Secrets. Identifiers, so mono and unboxed. */
export function createDataKeysColumn<
  Row extends { dataKeys?: string[] },
>(options?: { maxDisplay?: number }): ColumnDef<Row> {
  const maxDisplay = options?.maxDisplay ?? 3;
  return {
    size: 160,
    id: "dataKeys",
    header: columnHeader("columns", "keys"),
    meta: {
      share: (row: Row, t) => ({
        text: (row.dataKeys ?? []).join(", ") || t("empty", "noneLower"),
        mono: true,
      }),
    },
    cell: ({ row }) => {
      const keys = row.original.dataKeys ?? [];
      if (keys.length === 0) return <None />;
      return (
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
          {keys.slice(0, maxDisplay).map((key) => (
            <span key={key} className="font-mono text-fg-mut">
              {key}
            </span>
          ))}
          {keys.length > maxDisplay && (
            <span className="text-fg-fnt">
              <T
                section="count"
                k="plusMore"
                values={{ n: keys.length - maxDisplay }}
              />
            </span>
          )}
        </span>
      );
    },
  };
}
