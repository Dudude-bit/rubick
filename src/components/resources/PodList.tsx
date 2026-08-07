import { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router-dom";
import { Eye, Trash2, Terminal, FileText } from "lucide-react";
import { useMemo } from "react";
import {
  usePodsWithMetrics,
  type PodWithMetrics,
} from "@/hooks/usePodsWithMetrics";
import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableAddress } from "@/components/ui/copyable-value";
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
import { formatAge } from "@/lib/utils";
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
    watchLive,
  } = usePodsWithMetrics();

  const columns = useMemo<ColumnDef<PodWithMetrics>[]>(
    () => [
      createNameColumn<PodWithMetrics>(ResourceType.Pod),
      createNamespaceColumn<PodWithMetrics>(),
      {
        id: "status",
        header: "Status",
        // The derived status, not the phase: a pod that has crashed 653
        // times is in phase `Running` and nobody means that by "how is
        // it". The phase rides along in the tooltip so it is not lost.
        cell: ({ row }) => (
          <StatusBadge
            status={row.original.status.display}
            title={`Phase ${row.original.status.phase}`}
          />
        ),
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
        // kubectl prints the count with the age of the last one, and it is
        // the half that carries the news: 653 an hour ago and 653 last
        // week are the same number and not the same pod.
        cell: ({ row }) => (
          <span
            className={
              row.original.restartCount > 5
                ? "font-mono text-warn"
                : "font-mono text-fg-mut"
            }
          >
            {row.original.restartCount}
            {row.original.restartCount > 0 && row.original.lastRestartAt && (
              <span className="text-fg-fnt">
                {" "}
                ({formatAge(row.original.lastRestartAt)} ago)
              </span>
            )}
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
        cell: ({ row }) => (
          <CopyableAddress
            value={row.original.podIp}
            label="Pod IP"
            fallback="-"
            className="text-fg-mut"
          />
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
        live={watchLive}
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
