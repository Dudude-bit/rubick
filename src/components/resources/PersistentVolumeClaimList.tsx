import { useCallback, useMemo, useState } from "react";
import { T } from "@/i18n/T";
import { useNavigate } from "react-router-dom";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ColumnDef } from "@/components/ui/table-features";
import { Eye, Trash2 } from "lucide-react";
import { ResourceList } from "@/components/resources/ResourceList";
import { StorageClassRef } from "./storage-refs";
import {
  createAccessModesColumn,
  createCapacityColumn,
  createNameColumn,
  createNamespaceColumn,
} from "./columns";
import { ResourceRef } from "./ResourceRef";
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
import { useT } from "@/i18n/useT";

// Exported for `column-widths.test.ts`, at the cost of this file's fast
// refresh: a save remounts the page instead of hot-swapping it.
// eslint-disable-next-line react-refresh/only-export-components
export const columns: ColumnDef<PersistentVolumeClaimInfo>[] = [
  createNameColumn<PersistentVolumeClaimInfo>(
    ResourceType.PersistentVolumeClaim
  ),
  createNamespaceColumn<PersistentVolumeClaimInfo>(),
  {
    size: 110,
    accessorKey: "status",
    header: () => <T section="columns" k="status" />,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    // A generated PV name — `pvc-3f2c1e0a-…` — is as long as the claim's own.
    size: 300,
    accessorKey: "volume",
    header: () => <T section="columns" k="volume" />,
    cell: ({ row }) =>
      row.original.volume ? (
        <ResourceRef
          kind={ResourceType.PersistentVolume}
          name={row.original.volume}
          showKind={false}
        />
      ) : (
        <span className="text-fg-fnt">—</span>
      ),
  },
  createCapacityColumn<PersistentVolumeClaimInfo>(),
  createAccessModesColumn<PersistentVolumeClaimInfo>(),
  {
    size: 160,
    accessorKey: "storageClass",
    header: () => <T section="columns" k="storageClass" />,
    cell: ({ row }) => (
      <StorageClassRef name={row.original.storageClass} fallback="default" />
    ),
  },
  {
    size: 80,
    accessorKey: "age",
    header: () => <T section="columns" k="age" />,
  },
];

export function PersistentVolumeClaimList() {
  const t = useT();
  const { currentNamespace } = useClusterStore();
  const scope = useNamespaceScope();
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
        title: t("action", "realtimeUnavailable"),
        description: t("action", "fallingBackToPolling", {
          title: "Persistent Volume Claims",
          error: err,
        }),
      });
    },
    [t, toast, watchFailed]
  );
  const { resyncing } = useResourceWatch<PersistentVolumeClaimInfo>({
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
        label: t("action", "viewDetails"),
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
        label: t("action", "delete"),
        onClick: (item) => setDeleteTarget(item),
        variant: "destructive",
      },
    ],
    [navigate, t]
  );

  return (
    <ResourceList<PersistentVolumeClaimInfo>
      title="Persistent Volume Claims"
      description={t("empty", "pvcListDescription", {
        scope: scope.inWords,
      })}
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
      refresh={watchFailed ? undefined : false}
      live={!watchFailed}
      resyncing={resyncing}
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
