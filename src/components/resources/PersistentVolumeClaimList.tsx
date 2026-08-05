import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { ColumnDef } from "@tanstack/react-table";
import { Eye, Trash2 } from "lucide-react";
import { ResourceList } from "@/components/resources/ResourceList";
import {
  createAccessModesColumn,
  createCapacityColumn,
  createNamespaceColumn,
} from "./columns";
import type { QuickAction } from "@/components/ui/quick-actions";
import { commands } from "@/lib/commands";
import type { PersistentVolumeClaimInfo } from "@/generated/types";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useToast } from "@/components/ui/use-toast";

const columns: ColumnDef<PersistentVolumeClaimInfo>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        to={getResourceDetailUrl(
          ResourceType.PersistentVolumeClaim,
          row.original.name,
          row.original.namespace
        )}
        className="font-mono text-info hover:underline"
      >
        {row.original.name}
      </Link>
    ),
  },
  createNamespaceColumn<PersistentVolumeClaimInfo>(),
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "volume",
    header: "Volume",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mut">
        {row.original.volume || "—"}
      </span>
    ),
  },
  createCapacityColumn<PersistentVolumeClaimInfo>(),
  createAccessModesColumn<PersistentVolumeClaimInfo>(),
  {
    accessorKey: "storageClass",
    header: "Storage Class",
    cell: ({ row }) => (
      <span className="text-fg-mut">
        {row.original.storageClass || "default"}
      </span>
    ),
  },
  {
    accessorKey: "age",
    header: "Age",
  },
];

export function PersistentVolumeClaimList() {
  const { currentNamespace } = useClusterStore();
  const navigate = useNavigate();

  const queryKey = useMemo(
    () =>
      queryKeys.resources(ResourceType.PersistentVolumeClaim, currentNamespace),
    [currentNamespace]
  );
  const subscribe = useCallback(
    () => commands.subscribePvcWatch(currentNamespace || null),
    [currentNamespace]
  );

  const { toast } = useToast();
  const [watchFailed, setWatchFailed] = useState(false);
  const handleWatchError = useCallback(
    (err: string) => {
      if (watchFailed) return;
      setWatchFailed(true);
      toast({
        title: "Real-time updates unavailable",
        description: `Persistent Volume Claims: falling back to periodic refresh. ${err}`,
      });
    },
    [toast, watchFailed]
  );
  useResourceWatch<PersistentVolumeClaimInfo>({
    enabled: true,
    subscribe,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const quickActions = useMemo<
    (
      setDeleteTarget: (item: PersistentVolumeClaimInfo) => void
    ) => QuickAction<PersistentVolumeClaimInfo>[]
  >(
    () => (setDeleteTarget) => [
      {
        icon: Eye,
        label: "View Details",
        onClick: (item) =>
          navigate(
            getResourceDetailUrl(
              ResourceType.PersistentVolumeClaim,
              item.name,
              item.namespace
            )
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
    <ResourceList<PersistentVolumeClaimInfo>
      title="Persistent Volume Claims"
      description={`Requests for storage by pods in ${currentNamespace || "all namespaces"}`}
      queryKey={queryKeys.resources(
        ResourceType.PersistentVolumeClaim,
        currentNamespace
      )}
      getRowId={getResourceRowId}
      queryFn={() =>
        commands.listPersistentVolumeClaims({
          namespace: currentNamespace || null,
          labelSelector: null,
          fieldSelector: null,
          limit: null,
        })
      }
      columns={columns}
      quickActions={quickActions}
      emptyStateLabel={toPlural(ResourceType.PersistentVolumeClaim)}
      deleteConfig={{
        mutationFn: (item) =>
          commands.deletePersistentVolumeClaim(
            item.name,
            item.namespace ?? null
          ),
        invalidateQueryKeys: [
          queryKeys.resources(
            ResourceType.PersistentVolumeClaim,
            currentNamespace
          ),
        ],
        resourceType: ResourceType.PersistentVolumeClaim,
      }}
      staleTime={STALE_TIMES.resourceList}
      refetchInterval={watchFailed ? undefined : false}
      searchKey="name"
      getRowHref={(row) =>
        getResourceDetailUrl(
          ResourceType.PersistentVolumeClaim,
          row.name,
          row.namespace
        )
      }
    />
  );
}
