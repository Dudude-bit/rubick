import { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { Eye, Trash2, Terminal, FileText } from "lucide-react";
import { useMemo } from "react";
import {
  usePodsWithMetrics,
  type PodWithMetrics,
} from "@/hooks/usePodsWithMetrics";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
} from "./columns";
import type { ContainerInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceList } from "./ResourceList";
import { ResourceRef } from "./ResourceRef";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { MetricsStatusBanner } from "@/components/metrics";
import { getResourceRowId } from "@/lib/table-utils";
import type { QuickAction } from "@/components/ui/quick-actions";

// Helper to format ready containers count
function formatReady(containers: ContainerInfo[]): string {
  const ready = containers.filter((c) => c.ready).length;
  return `${ready}/${containers.length}`;
}

export function PodList() {
  const navigate = useNavigate();
  const {
    data: podsWithMetrics,
    podStatus,
    isLoading,
    dataUpdatedAt,
  } = usePodsWithMetrics();

  const columns = useMemo<ColumnDef<PodWithMetrics>[]>(
    () => [
      createNameColumn<PodWithMetrics>(ResourceType.Pod),
      createNamespaceColumn<PodWithMetrics>(),
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status.phase} />,
      },
      createCpuColumn<PodWithMetrics>(),
      createMemoryColumn<PodWithMetrics>(),
      {
        id: "ready",
        header: "Ready",
        cell: ({ row }) => (
          <span className="font-mono text-fg-mid">
            {formatReady(row.original.containers)}
          </span>
        ),
      },
      {
        id: "restarts",
        header: "Restarts",
        cell: ({ row }) => (
          <span
            className={
              row.original.restartCount > 5
                ? "font-mono text-warn"
                : "font-mono text-fg-mut"
            }
          >
            {row.original.restartCount}
          </span>
        ),
      },
      {
        id: "node",
        header: "Node",
        cell: ({ row }) =>
          row.original.nodeName ? (
            <ResourceRef
              kind={ResourceType.Node}
              name={row.original.nodeName}
              showKind={false}
            />
          ) : (
            <span className="text-fg-fnt">-</span>
          ),
      },
      {
        id: "ip",
        header: "IP",
        cell: ({ row }) =>
          row.original.podIp ? (
            <span className="font-mono text-fg-mut">{row.original.podIp}</span>
          ) : (
            <span className="text-fg-fnt">-</span>
          ),
      },
      createAgeColumn<PodWithMetrics>(),
    ],
    []
  );

  const quickActions = useMemo<
    (
      setDeleteTarget: (item: PodWithMetrics) => void
    ) => QuickAction<PodWithMetrics>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: "View Details",
        onClick: (item) =>
          navigate(
            getResourceDetailUrl(ResourceType.Pod, item.name, item.namespace)
          ),
      },
      {
        icon: FileText,
        label: "View Logs",
        onClick: (item) =>
          navigate(
            `${getResourceDetailUrl(ResourceType.Pod, item.name, item.namespace)}?tab=logs`
          ),
      },
      {
        icon: Terminal,
        label: "Shell",
        onClick: (item) =>
          navigate(
            `${getResourceDetailUrl(ResourceType.Pod, item.name, item.namespace)}?tab=terminal`
          ),
      },
      {
        icon: Trash2,
        label: "Delete",
        onClick: (item) => setDeleteTarget(item),
        variant: "destructive",
      },
    ],
    [navigate]
  );

  return (
    <div className="space-y-4">
      {podStatus?.status !== "available" && (
        <MetricsStatusBanner status={podStatus} />
      )}
      <ResourceList<PodWithMetrics>
        title="Pods"
        data={podsWithMetrics}
        isLoading={isLoading}
        dataUpdatedAt={dataUpdatedAt}
        getRowId={getResourceRowId}
        columns={columns}
        quickActions={quickActions}
        emptyStateLabel={toPlural(ResourceType.Pod)}
        getRowHref={(row) =>
          getResourceDetailUrl(ResourceType.Pod, row.name, row.namespace)
        }
        deleteConfig={{
          mutationFn: (item) =>
            commands.deletePod(item.name, item.namespace, false),
          invalidateQueryKeys: [queryKeys.pods()],
          resourceType: ResourceType.Pod,
        }}
      />
    </div>
  );
}
