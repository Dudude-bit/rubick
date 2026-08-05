/**
 * Column factory for resource tables
 *
 * Provides reusable column definitions to reduce duplication across resource lists.
 */

import { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router-dom";
import { StatusBadge } from "@/components/ui/status-badge";
import { RealtimeAge } from "@/components/ui/realtime";
import { MetricValue, UnitValue } from "@/components/ui/metric-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Eye, Trash2 } from "lucide-react";
import { ActionMenu } from "@/components/ui/action-menu";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { cn } from "@/lib/utils";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/** Resource names are identifiers — monospace so the random suffixes that
 *  distinguish two pods of the same deployment line up column-wise. */
const NAME_CLASS = "font-mono text-info";

// Base resource interface for column constraints
interface BaseResource {
  name: string;
  namespace: string;
}

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

interface WithLabels {
  labels: Record<string, string>;
}

/**
 * Creates a name column with link to detail page
 * @param linkPrefix - URL prefix for the detail page
 * @param options.className - Custom class name for the link/span
 * @param options.disableLink - If true, renders as span instead of link (use with row-level click)
 */
export function createNameColumn<T extends BaseResource>(
  linkPrefix: string,
  options?: { className?: string; disableLink?: boolean }
): ColumnDef<T> {
  return {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) =>
      options?.disableLink ? (
        <span className={options?.className ?? NAME_CLASS}>
          {row.original.name}
        </span>
      ) : (
        <Link
          to={`${linkPrefix}/${row.original.namespace}/${row.original.name}`}
          className={cn(options?.className ?? NAME_CLASS, "hover:underline")}
        >
          {row.original.name}
        </Link>
      ),
  };
}

/**
 * Creates a name column without link (just displays the name)
 */
export function createSimpleNameColumn<
  T extends { name: string },
>(): ColumnDef<T> {
  return {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => <span className={NAME_CLASS}>{row.original.name}</span>,
  };
}

/**
 * Creates a namespace column
 */
export function createNamespaceColumn<
  T extends { namespace: string },
>(): ColumnDef<T> {
  return {
    accessorKey: "namespace",
    header: "Namespace",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">{row.original.namespace}</span>
    ),
  };
}

/**
 * Creates an age column from created_at timestamp
 * Uses RealtimeAge for auto-updating display
 */
export function createAgeColumn<T extends WithCreatedAt>(): ColumnDef<T> {
  return {
    id: "age",
    header: "Age",
    cell: ({ row }) => (
      <span className="text-fg-fnt">
        <RealtimeAge timestamp={row.original.createdAt} />
      </span>
    ),
  };
}

/**
 * Creates a generic time-ago column for any timestamp field
 * Uses RealtimeAge for auto-updating display
 */
export function createTimeAgoColumn<T>(
  accessor: (row: T) => string | null | undefined,
  header: string
): ColumnDef<T> {
  return {
    id: header.toLowerCase().replace(/\s+/g, "-"),
    header,
    cell: ({ row }) => (
      <span className="text-fg-fnt">
        <RealtimeAge timestamp={accessor(row.original)} />
      </span>
    ),
  };
}

/**
 * Creates a CPU usage column: the number with a dimmed unit, plus an
 * inline bar when the container declares a limit.
 */
export function createCpuColumn<
  T extends WithCpuUsage & Partial<WithCpuLimits>,
>(): ColumnDef<T> {
  return {
    id: "cpu",
    header: "CPU",
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
  T extends WithMemoryUsage & Partial<WithMemoryLimits>,
>(): ColumnDef<T> {
  return {
    id: "memory",
    header: "Memory",
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
  T extends { accessModes: string[] },
>(): ColumnDef<T> {
  return {
    accessorKey: "accessModes",
    header: "Access Modes",
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
  T extends { capacity?: string | null },
>(): ColumnDef<T> {
  return {
    accessorKey: "capacity",
    header: "Capacity",
    cell: ({ row }) =>
      row.original.capacity ? (
        <UnitValue value={row.original.capacity} />
      ) : (
        <span className="text-fg-fnt">—</span>
      ),
  };
}

/**
 * Creates a status badge column
 */
export function createStatusColumn<
  T extends { status: { phase: string } | string },
>(_options?: { accessor?: string }): ColumnDef<T> {
  return {
    id: "status",
    header: "Status",
    cell: ({ row }) => {
      const status =
        typeof row.original.status === "string"
          ? row.original.status
          : row.original.status.phase;
      return <StatusBadge status={status} />;
    },
  };
}

/**
 * Creates a replicas column (ready/desired)
 */
export function createReplicasColumn<
  T extends { replicas: { ready: number; desired: number } },
>(): ColumnDef<T> {
  return {
    id: "replicas",
    header: "Replicas",
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

/**
 * Labels, as `key=value` text.
 *
 * A label is arbitrary user data, never a state, so pilling it put an
 * outlined box around every `app=nginx` in the table and made the column
 * heavier than the resource name beside it.
 */
export function createLabelsColumn<T extends WithLabels>(options?: {
  maxDisplay?: number;
}): ColumnDef<T> {
  const maxDisplay = options?.maxDisplay ?? 3;
  return {
    id: "labels",
    header: "Labels",
    cell: ({ row }) => {
      const entries = Object.entries(row.original.labels);
      if (entries.length === 0) return <span className="text-fg-fnt">—</span>;
      return (
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
          {entries.slice(0, maxDisplay).map(([key, value]) => (
            <span key={key} className="font-mono text-fg-mut">
              {key}
              <span className="text-fg-fnt">=</span>
              {value}
            </span>
          ))}
          {entries.length > maxDisplay && (
            <span className="text-fg-fnt">
              +{entries.length - maxDisplay} more
            </span>
          )}
        </span>
      );
    },
  };
}

/** Data keys for ConfigMaps/Secrets. Identifiers, so mono and unboxed. */
export function createDataKeysColumn<
  T extends { dataKeys?: string[] },
>(options?: { maxDisplay?: number }): ColumnDef<T> {
  const maxDisplay = options?.maxDisplay ?? 3;
  return {
    id: "dataKeys",
    header: "Keys",
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

/**
 * Creates a type badge column
 */
export function createTypeBadgeColumn<T extends { type?: string }>(options?: {
  header?: string;
}): ColumnDef<T> {
  return {
    id: "type",
    header: options?.header ?? "Type",
    cell: ({ row }) => (
      <span className="text-fg-mid">{row.original.type ?? "-"}</span>
    ),
  };
}

/**
 * Action menu item definitions for reuse
 */
export interface ActionMenuItem<T> {
  type: "item" | "separator";
  label?: string;
  icon?: React.ReactNode;
  onClick?: (item: T) => void;
  href?: (item: T) => string;
  variant?: "default" | "destructive";
}

/**
 * Creates an actions column with dropdown menu
 */
export function createActionsColumn<T extends BaseResource>(
  actions:
    | ActionMenuItem<T>[]
    | ((setDeleteTarget: (item: T) => void) => ActionMenuItem<T>[]),
  setDeleteTarget?: (item: T) => void
): ColumnDef<T> {
  return {
    id: "actions",
    cell: ({ row }) => {
      const resolvedActions =
        typeof actions === "function"
          ? actions(setDeleteTarget ?? (() => {}))
          : actions;

      return (
        <ActionMenu>
          {resolvedActions.map((action, index) => {
            if (action.type === "separator") {
              return <DropdownMenuSeparator key={index} />;
            }

            if (action.href) {
              return (
                <DropdownMenuItem key={index} asChild>
                  <Link to={action.href(row.original)}>
                    {action.icon}
                    {action.label}
                  </Link>
                </DropdownMenuItem>
              );
            }

            return (
              <DropdownMenuItem
                key={index}
                className={
                  action.variant === "destructive" ? "text-err" : undefined
                }
                onClick={() => action.onClick?.(row.original)}
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            );
          })}
        </ActionMenu>
      );
    },
  };
}

/**
 * Creates standard view/delete actions
 */
export function createStandardActions<T extends BaseResource>(
  linkPrefix: string,
  setDeleteTarget: (item: T) => void
): ActionMenuItem<T>[] {
  return [
    {
      type: "item",
      label: "View Details",
      icon: <Eye className="mr-2 h-4 w-4" />,
      href: (item) => `${linkPrefix}/${item.namespace}/${item.name}`,
    },
    { type: "separator" },
    {
      type: "item",
      label: "Delete",
      icon: <Trash2 className="mr-2 h-4 w-4" />,
      onClick: setDeleteTarget,
      variant: "destructive",
    },
  ];
}

/**
 * Builds a complete column set for a resource list
 */
export function buildResourceColumns<T extends BaseResource & WithCreatedAt>(
  config: {
    linkPrefix: string;
    includeNamespace?: boolean;
    includeCpu?: boolean;
    includeMemory?: boolean;
    customColumns?: ColumnDef<T>[];
    actions?: (setDeleteTarget: (item: T) => void) => ActionMenuItem<T>[];
  },
  setDeleteTarget?: (item: T) => void
): ColumnDef<T>[] {
  const columns: ColumnDef<T>[] = [createNameColumn<T>(config.linkPrefix)];

  if (config.includeNamespace !== false) {
    columns.push(createNamespaceColumn<T>());
  }

  if (config.includeCpu) {
    columns.push(createCpuColumn<T & WithCpuUsage>() as ColumnDef<T>);
  }

  if (config.includeMemory) {
    columns.push(createMemoryColumn<T & WithMemoryUsage>() as ColumnDef<T>);
  }

  if (config.customColumns) {
    columns.push(...config.customColumns);
  }

  columns.push(createAgeColumn<T>());

  if (config.actions && setDeleteTarget) {
    columns.push(createActionsColumn<T>(config.actions, setDeleteTarget));
  }

  return columns;
}
