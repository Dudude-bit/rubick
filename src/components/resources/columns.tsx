/**
 * Column factory for resource tables
 *
 * Provides reusable column definitions to reduce duplication across resource lists.
 */

import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { RealtimeAge } from "@/components/ui/realtime";
import { MetricValue, UnitValue } from "@/components/ui/metric-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { cn } from "@/lib/utils";
import type { ResourceKind } from "@/lib/resource-registry";
import { ResourceRef } from "./ResourceRef";

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
    header: () => <T section="columns" k="name" />,
    cell: ({ row }) => (
      <ResourceRef
        kind={kind}
        name={row.original.name}
        namespace={row.original.namespace}
        showKind={false}
      />
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
    header: () => <T section="columns" k="namespace" />,
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">{row.original.namespace}</span>
    ),
  };
}

/**
 * Creates an age column from created_at timestamp
 * Uses RealtimeAge for auto-updating display
 */
export function createAgeColumn<Row extends WithCreatedAt>(): ColumnDef<Row> {
  return {
    size: 80,
    id: "age",
    header: () => <T section="columns" k="age" />,
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
    header: () => <T section="columns" k="cpu" />,
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
    header: () => <T section="columns" k="memory" />,
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
    header: () => <T section="columns" k="accessModes" />,
    cell: ({ row }) => {
      const modes = row.original.accessModes;
      if (modes.length === 0) return <span className="text-fg-fnt">—</span>;
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
    header: () => <T section="columns" k="capacity" />,
    cell: ({ row }) =>
      row.original.capacity ? (
        <UnitValue value={row.original.capacity} />
      ) : (
        <span className="text-fg-fnt">—</span>
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
    header: () => <T section="columns" k="replicas" />,
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
    header: () => <T section="columns" k="keys" />,
    cell: ({ row }) => {
      const keys = row.original.dataKeys ?? [];
      if (keys.length === 0) return <span className="text-fg-fnt">—</span>;
      return (
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
          {keys.slice(0, maxDisplay).map((key) => (
            <span key={key} className="font-mono text-fg-mut">
              {key}
            </span>
          ))}
          {keys.length > maxDisplay && (
            <span className="text-fg-fnt">
              +{keys.length - maxDisplay} more
            </span>
          )}
        </span>
      );
    },
  };
}
