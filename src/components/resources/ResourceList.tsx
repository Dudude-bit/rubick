import { ReactNode, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { DataTable } from "@/components/ui/data-table";
import { useToast } from "@/components/ui/use-toast";
import { ResourceListHeader } from "@/components/resources/ResourceListHeader";
import { useResource } from "@/hooks/useResource";
import { useClusterStore } from "@/stores/clusterStore";
import { STALE_TIMES } from "@/lib/refresh";
import type { QuickAction } from "@/components/ui/quick-actions";

export interface ResourceDeleteConfig<T> {
  /** Function to delete a resource */
  mutationFn: (item: T) => Promise<void>;
  /** Query keys to invalidate after deletion */
  invalidateQueryKeys: string[][];
  /** Resource type name for messages */
  resourceType: string;
}

export interface ResourceListProps<
  T extends { name: string; namespace?: string | null },
> {
  /** Display title for the resource list */
  title: string | ((count: number) => string);
  /** Optional description below the title */
  description?: string;
  /** Query key for React Query */
  queryKey?: string[];
  /** Function to fetch resources */
  queryFn?: () => Promise<T[]>;
  /** Optional data override (skips internal query) */
  data?: T[];
  /** Optional loading state when using data override */
  isLoading?: boolean;
  /** Optional dataUpdatedAt when using data override (for the freshness reading) */
  dataUpdatedAt?: number;
  /** A watch stream feeds this list and has not failed. */
  live?: boolean;
  /** Table column definitions - can use setDeleteTarget from useResourceListDelete hook */
  columns:
    | ColumnDef<T>[]
    | ((setDeleteTarget: (item: T) => void) => ColumnDef<T>[]);
  /** Label for empty state (e.g., "pods", "services") */
  emptyStateLabel: string;
  /** Delete configuration */
  deleteConfig?: ResourceDeleteConfig<T>;
  /** Optional stale time override (default: 5000ms) */
  staleTime?: number;
  /** Optional refetch interval (default: undefined - no auto refetch) */
  refetchInterval?: number | false;
  /** Optional custom header actions */
  headerActions?: ReactNode;
  /** Optional content rendered between header and table */
  headerContent?: ReactNode;
  /** Render without header wrapper for embedded list views */
  embedded?: boolean;
  /** Optional column to target for search */
  searchKey?: string;
  /** Optional search input placeholder */
  searchPlaceholder?: string;
  /** Generate navigation URL for row click */
  getRowHref?: (row: T) => string;
  /** Quick actions shown on row hover */
  quickActions?:
    | QuickAction<T>[]
    | ((setDeleteTarget: (item: T) => void) => QuickAction<T>[]);
  /** Function to get unique row ID (for stable keys during data updates) */
  getRowId?: (row: T, index: number) => string;
}

export function ResourceList<
  T extends { name: string; namespace?: string | null },
>({
  title,
  description,
  queryKey,
  queryFn,
  data,
  isLoading,
  dataUpdatedAt: externalDataUpdatedAt,
  live,
  columns,
  emptyStateLabel,
  deleteConfig,
  staleTime,
  refetchInterval,
  headerActions,
  headerContent,
  embedded = false,
  searchKey,
  searchPlaceholder,
  getRowHref,
  quickActions,
  getRowId,
}: ResourceListProps<T>) {
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<T | null>(null);

  const shouldUseQuery = data === undefined && !!queryKey && !!queryFn;
  const queryResult = useResource(
    (queryKey ?? ["resource-list"]) as string[],
    (queryFn ?? (async () => [] as T[])) as () => Promise<T[]>,
    {
      enabled: shouldUseQuery,
      staleTime: staleTime ?? STALE_TIMES.resourceList,
      ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    }
  );

  const resources = data ?? queryResult.data ?? [];
  const loading = isLoading ?? queryResult.isLoading;
  const dataUpdatedAt = externalDataUpdatedAt ?? queryResult.dataUpdatedAt;

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (item: T) => {
      if (deleteConfig) {
        await deleteConfig.mutationFn(item);
      }
    },
    onSuccess: (_, item) => {
      if (deleteConfig) {
        deleteConfig.invalidateQueryKeys.forEach((key) => {
          queryClient.invalidateQueries({ queryKey: key });
        });
        toast({
          title: `${deleteConfig.resourceType} deleted`,
          description: `${deleteConfig.resourceType} ${item.name} has been deleted.`,
        });
      }
      setDeleteTarget(null);
    },
    onError: (error, item) => {
      toast({
        title: "Error",
        description: `Failed to delete ${deleteConfig?.resourceType?.toLowerCase() ?? "resource"} ${item.name}: ${error}`,
        variant: "destructive",
      });
      setDeleteTarget(null);
    },
  });

  // Resolve columns - can be a function that receives setDeleteTarget
  const resolvedColumns =
    typeof columns === "function"
      ? columns(setDeleteTarget as (item: T) => void)
      : columns;

  // Resolve quick actions - can be a function that receives setDeleteTarget
  const resolvedQuickActions =
    typeof quickActions === "function"
      ? quickActions(setDeleteTarget as (item: T) => void)
      : quickActions;

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={emptyStateLabel} />;
  }

  const showSkeleton = loading && resources.length === 0;
  const resolvedTitle =
    typeof title === "function" ? title(resources.length) : title;

  const content = (
    <>
      {!embedded && (
        <ResourceListHeader
          title={resolvedTitle}
          count={resources.length}
          description={description}
          actions={headerActions}
          dataUpdatedAt={dataUpdatedAt}
          live={live}
        />
      )}
      {headerContent}
      <DataTable
        columns={resolvedColumns}
        data={resources}
        isLoading={showSkeleton}
        searchKey={searchKey}
        searchPlaceholder={searchPlaceholder}
        getRowHref={getRowHref}
        quickActions={resolvedQuickActions}
        getRowId={getRowId}
        groupByNamespace
        rowLabel={emptyStateLabel.toLowerCase()}
      />
      {deleteConfig && (
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteTarget(null);
            }
          }}
          title={`Delete ${deleteConfig.resourceType.toLowerCase()}?`}
          description={
            deleteTarget
              ? `This will delete ${deleteTarget.name}${deleteTarget.namespace ? ` in ${deleteTarget.namespace}` : ""}.`
              : undefined
          }
          confirmLabel="Delete"
          confirmVariant="destructive"
          confirmDisabled={deleteMutation.isPending}
          onConfirm={() => {
            if (deleteTarget) {
              deleteMutation.mutate(deleteTarget);
            }
          }}
        />
      )}
    </>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">{content}</div>
  );
}
