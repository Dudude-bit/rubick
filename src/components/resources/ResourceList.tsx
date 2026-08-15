import { ReactNode, useMemo, useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { DataTable } from "@/components/ui/data-table";
import { byNamespace, type RowGrouping } from "@/components/ui/row-grouping";
import { useToast } from "@/components/ui/use-toast";
import { ResourceListHeader } from "@/components/resources/ResourceListHeader";
import { useResource } from "@/hooks/useResource";
import { useDeliveries } from "@/hooks/useDelivery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import {
  deliveryOf,
  matchesDeliveryFilter,
  type DeliveryFilter,
} from "@/lib/delivery";
import { STALE_TIMES, type RefreshRate } from "@/lib/refresh";
import { verbatim } from "@/lib/error-utils";
import {
  DeliveryColumnCell,
  DeliveryFilterControl,
  DeliveryRowsProvider,
} from "@/components/resources/delivery-column";
import type { QuickAction } from "@/components/ui/quick-actions";

/**
 * The column, built here because it is not a component and every list that
 * has one gets exactly this one.
 */
function deliveryColumn<T>(): ColumnDef<T> {
  return {
    size: 150,
    id: "delivery",
    header: "Delivery",
    enableSorting: false,
    cell: ({ row }) => <DeliveryColumnCell row={row.original} />,
  };
}

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
  /**
   * The watch is re-listing, and the rows on screen predate it.
   *
   * A resync used to be invisible: the cache was cleared before the burst, so
   * a healthy cluster rendered "no resources of this type in the current
   * scope" for the length of it. The rows are kept now, which makes the
   * opposite claim the risk — `live` over data that is a moment old — so the
   * surface says which it is instead.
   */
  resyncing?: boolean;
  /** Polled, and backed off past its rate because nothing is changing. */
  slowed?: boolean;
  /** Table column definitions - can use setDeleteTarget from useResourceListDelete hook */
  columns:
    | ColumnDef<T>[]
    | ((setDeleteTarget: (item: T) => void) => ColumnDef<T>[]);
  /** Label for empty state (e.g., "pods", "services") */
  emptyStateLabel: string;
  /** Overrides the table's message for "the scope genuinely has none of
   *  these". Worth setting wherever the generic sentence would leave the
   *  reader unsure whether the kind exists at all. */
  emptyMessage?: string;
  /** Delete configuration */
  deleteConfig?: ResourceDeleteConfig<T>;
  /** Optional stale time override (default: 5000ms) */
  staleTime?: number;
  /** Which rate the list re-reads at, or `false` where a watch feeds it. */
  refresh?: RefreshRate | false;
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
  /**
   * A grouping the kind knows better than its namespace — node pools, so far.
   * Namespaces are the default because they are the one key every namespaced
   * kind carries.
   */
  grouping?: RowGrouping<T> | null;
  /**
   * The kind these rows are, for the `Delivery` column and its filter.
   *
   * Set on the lists whose rows are objects somebody *writes* — a Deployment,
   * a Service, a ConfigMap. Deliberately unset on the lists the cluster itself
   * fills: a Pod is made by its controller and a ReplicaSet by its Deployment,
   * so `not delivered` would be true of every row and would therefore say
   * nothing at all.
   *
   * Costs one read of the delivery owners for the whole page and none at all
   * when the cluster has no delivery controller, or when no row carries a
   * delivery label.
   */
  delivery?: { group: string; kind: string } | null;
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
  resyncing,
  slowed: externalSlowed,
  columns,
  emptyStateLabel,
  emptyMessage,
  deleteConfig,
  staleTime,
  refresh,
  headerActions,
  headerContent,
  embedded = false,
  searchKey,
  searchPlaceholder,
  getRowHref,
  quickActions,
  getRowId,
  grouping,
  delivery,
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
      ...(refresh !== undefined ? { refresh } : {}),
    }
  );

  // Narrowed here rather than in the fetch, and that is the whole reason a
  // multi-namespace scope costs one request instead of one per namespace: the
  // cache entry stays the unfiltered cluster-wide answer under the key the
  // watch stream writes to, and the selection only decides what this table
  // draws from it. A scope of one or none is already narrowed by the request
  // and passes straight through.
  const scope = useNamespaceScope();
  const resources = useMemo(
    () => scope.narrow(data ?? queryResult.data ?? []),
    [data, queryResult.data, scope]
  );
  const loading = isLoading ?? queryResult.isLoading;
  // Read at last. A failed list used to render `resources = []` with
  // `isLoading` already false, so the table printed "No resources of this type
  // in the current scope" — a cluster that could not be read and one that is
  // genuinely empty looked identical, and an expired token said every list in
  // the app was empty. The error only replaces the table when there is nothing
  // to show: a refetch that fails keeps the rows it already had, the same rule
  // a resync follows.
  const failed = data === undefined ? queryResult.error : null;
  const dataUpdatedAt = externalDataUpdatedAt ?? queryResult.dataUpdatedAt;

  const [deliveryFilter, setDeliveryFilter] = useState<DeliveryFilter>("all");
  const queries = useMemo(
    () =>
      delivery
        ? resources.flatMap((row) => {
            const query = deliveryOf(delivery.group, delivery.kind, row);
            return query ? [query] : [];
          })
        : [],
    [delivery, resources]
  );
  const deliveries = useDeliveries(queries);
  const deliveriesOf = (row: unknown) =>
    delivery
      ? deliveries.of({
          group: delivery.group,
          kind: delivery.kind,
          namespace: (row as T).namespace ?? null,
          name: (row as T).name,
        })
      : [];
  const showDelivery = !!delivery && deliveries.available;
  const rows = showDelivery
    ? resources.filter((row) =>
        matchesDeliveryFilter(deliveryFilter, deliveriesOf(row))
      )
    : resources;

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
  const baseColumns =
    typeof columns === "function"
      ? columns(setDeleteTarget as (item: T) => void)
      : columns;
  // Second from the end, so it lands where the other qualifiers already sit
  // and never displaces Age from the right edge of the table.
  const resolvedColumns = showDelivery
    ? [
        ...baseColumns.slice(0, -1),
        deliveryColumn<T>(),
        ...baseColumns.slice(-1),
      ]
    : baseColumns;

  // Resolve quick actions - can be a function that receives setDeleteTarget
  const resolvedQuickActions =
    typeof quickActions === "function"
      ? quickActions(setDeleteTarget as (item: T) => void)
      : quickActions;

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={emptyStateLabel} />;
  }

  // A resync with nothing to show is still loading; a resync with rows keeps
  // them, and says so above rather than wearing "live" over them.
  const showSkeleton =
    (loading || resyncing) && resources.length === 0 && !failed;
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
          // A resync is not live: the rows below it are the ones from before
          // the watch started re-listing, and the badge is the only thing that
          // would otherwise still claim they are current.
          live={live && !resyncing}
          slowed={externalSlowed ?? (!live && queryResult.freshness.slowed)}
        />
      )}
      {headerContent}
      {showDelivery && (
        <DeliveryFilterControl
          value={deliveryFilter}
          onChange={setDeliveryFilter}
          deliveries={resources.map(deliveriesOf)}
        />
      )}
      {failed && resources.length === 0 ? (
        <div className="max-w-[68ch] py-8">
          <p className="text-xs text-err">
            Could not read {emptyStateLabel} in this scope.
          </p>
          <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
            {verbatim(failed.message)}
          </p>
        </div>
      ) : (
        <DataTable
          columns={resolvedColumns}
          data={rows}
          isLoading={showSkeleton}
          searchKey={searchKey}
          searchPlaceholder={searchPlaceholder}
          getRowHref={getRowHref}
          quickActions={resolvedQuickActions}
          getRowId={getRowId}
          grouping={grouping ?? byNamespace(emptyStateLabel.toLowerCase())}
          rowLabel={emptyStateLabel.toLowerCase()}
          emptyMessage={emptyMessage}
        />
      )}
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

  const wrapped = showDelivery ? (
    <DeliveryRowsProvider of={deliveriesOf}>{content}</DeliveryRowsProvider>
  ) : (
    content
  );

  if (embedded) {
    return wrapped;
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">{wrapped}</div>
  );
}
