import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Crosshair } from "lucide-react";

import { ResourceList } from "./ResourceList";
import { ResourceRef } from "./ResourceRef";
import { StatusBadge } from "@/components/ui/status-badge";
import { RealtimeAge } from "@/components/ui/realtime";
import { useClusterSummary } from "@/hooks/useClusterSummary";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceRowId } from "@/lib/table-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { NamespaceInfo } from "@/generated/types";

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// eslint-disable-next-line react-refresh/only-export-components
export const columns = (
  currentNamespace: string,
  podCounts: Map<string, number>
): ColumnDef<NamespaceInfo>[] => [
  {
    // Four columns share this table, so the name takes the room the others
    // do not need rather than a name column's usual share.
    size: 420,
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <span className="flex items-baseline gap-2">
        <ResourceRef
          kind={ResourceType.Namespace}
          name={row.original.name}
          showKind={false}
        />
        {row.original.name === currentNamespace && (
          <span className="text-[11px] text-fg-fnt">current scope</span>
        )}
      </span>
    ),
  },
  {
    size: 120,
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} showDot />,
  },
  {
    size: 80,
    id: "pods",
    header: "Pods",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">
        {podCounts.get(row.original.name) ?? 0}
      </span>
    ),
  },
  {
    size: 80,
    accessorKey: "createdAt",
    header: "Age",
    cell: ({ row }) => <RealtimeAge timestamp={row.original.createdAt} />,
  },
];

/**
 * Namespaces have no detail page and no delete action here — deleting one
 * takes everything inside it with it, which is not a hover-target decision.
 * The row's useful verb is "point this window at it", so that is the action.
 */
export function NamespaceList() {
  const switchNamespace = useClusterStore((s) => s.switchNamespace);
  const currentNamespace = useClusterStore((s) => s.currentNamespace);
  const { namespaces } = useClusterSummary();

  const podCounts = useMemo(
    () => new Map(namespaces.map((ns) => [ns.name, ns.podCount])),
    [namespaces]
  );

  const namespaceColumns = useMemo(
    () => columns(currentNamespace, podCounts),
    [currentNamespace, podCounts]
  );

  return (
    <ResourceList<NamespaceInfo>
      title="Namespaces"
      searchKey="name"
      queryKey={queryKeys.resources(ResourceType.Namespace, null)}
      queryFn={() => commands.listNamespaces()}
      staleTime={STALE_TIMES.slow}
      getRowId={getResourceRowId}
      columns={namespaceColumns}
      emptyStateLabel="Namespaces"
      quickActions={[
        {
          icon: Crosshair,
          label: "Scope this window to it",
          onClick: (item) => switchNamespace(item.name),
        },
      ]}
    />
  );
}
