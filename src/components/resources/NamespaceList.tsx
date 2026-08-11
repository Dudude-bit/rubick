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

  const columns: ColumnDef<NamespaceInfo>[] = useMemo(
    () => [
      {
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
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} showDot />,
      },
      {
        id: "pods",
        header: "Pods",
        cell: ({ row }) => (
          <span className="font-mono text-fg-mut">
            {podCounts.get(row.original.name) ?? 0}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Age",
        cell: ({ row }) => <RealtimeAge timestamp={row.original.createdAt} />,
      },
    ],
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
      columns={columns}
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
