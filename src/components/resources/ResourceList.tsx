import { ReactNode, useMemo, useState } from "react";
import { T } from "@/i18n/T";
import type { ColumnDef, RowData } from "@/components/ui/table-features";
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
import { isRefusal, verbatim } from "@/lib/error-utils";
import {
  isReadDeadline,
  LIST_DEADLINE_SECONDS,
  openNamespacePicker,
  SLOW_READ_MS,
} from "@/lib/read-deadline";
import { useNowSeconds } from "@/hooks/useNow";
import { Button } from "@/components/ui/button";
import { TriangleAlert } from "lucide-react";
import {
  DeliveryColumnCell,
  DeliveryFilterControl,
  DeliveryRowsProvider,
} from "@/components/resources/delivery-column";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useT } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import { keepWatched, noneWhereAnswered, whole } from "@/lib/namespace-scope";
import type { Scoped, UnreadNamespace } from "@/generated/types";
import { UnreadNamespaces } from "@/components/resources/UnreadNamespaces";

const NOTHING_UNREAD: UnreadNamespace[] = [];

/**
 * The column, built once because every list that has one gets exactly this one
 * — and because `flexRender` treats a cell renderer as a React element type.
 * A renderer rebuilt per render remounts its cell on every watch tick; see
 * `RowActions` in `data-table.tsx` for what that cost the row's buttons.
 */
const DELIVERY_COLUMN: ColumnDef<never> = {
  size: 150,
  id: "delivery",
  header: () => <T section="columns" k="delivery" />,
  enableSorting: false,
  cell: ({ row }) => <DeliveryColumnCell row={row.original} />,
};

const deliveryColumn = <Row extends RowData>() =>
  DELIVERY_COLUMN as ColumnDef<Row>;

export interface ResourceDeleteConfig<Row> {
  /** Function to delete a resource */
  mutationFn: (item: Row) => Promise<void>;
  /** Query keys to invalidate after deletion */
  invalidateQueryKeys: string[][];
  /** Resource type name for messages */
  resourceType: string;
}

export interface ResourceListProps<
  Row extends { name: string; namespace?: string | null },
> {
  /** Display title for the resource list */
  title: string;
  /** Optional description below the title */
  description?: string;
  /** Query key for React Query */
  queryKey?: string[];
  /** Function to fetch resources */
  queryFn?: () => Promise<Scoped<Row>>;
  /** Optional data override (skips internal query) */
  data?: Row[];
  /** The namespaces `data` could not be read in, when the rows come from outside. */
  unread?: UnreadNamespace[];
  /** Optional loading state when using data override */
  isLoading?: boolean;
  /**
   * What went wrong reading the list, when the rows come from outside.
   *
   * The one thing a page passing `data` could not previously hand over, and
   * the reason every such page told the reader their scope was empty when the
   * read had in fact failed: `data` is an array either way, so a failed list
   * and a genuinely empty one arrived here identical. Follows the same rule as
   * the internal query's error — it only replaces the table when there is
   * nothing left to show.
   */
  error?: Error | null;
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
  /**
   * When the read that has nothing to show yet began, for a caller that owns
   * the read. A list handed its rows as `data` disables the query inside
   * here, so the wait is not visible from in here at all — and those are
   * the pods, the workloads and the CRDs, the lists long enough to need the
   * sentence in the first place.
   */
  waitingSince?: number | null;
  /** Re-run the read, for a list whose read this component does not own. */
  onRetry?: () => void;
  /**
   * Whether picking one namespace would make this read shorter. False for a
   * cluster-scoped kind, where the picker cannot change the answer and
   * offering it is a remedy that does nothing.
   */
  narrowingHelps?: boolean;
  /** Table column definitions - can use setDeleteTarget from useResourceListDelete hook */
  columns:
    | ColumnDef<Row>[]
    | ((setDeleteTarget: (item: Row) => void) => ColumnDef<Row>[]);
  /** Label for empty state (e.g., "pods", "services") */
  emptyStateLabel: string;
  /**
   * What the dragged column widths are filed under, where the row label is
   * not specific enough. Two CRDs can share a plural — `certificates` is
   * both cert-manager's and Knative's — and their columns are built from
   * each CRD's own printer columns, so one list's widths would be applied to
   * an unrelated one.
   */
  widthsKey?: string;
  /** Overrides the table's message for "the scope genuinely has none of
   *  these". Worth setting wherever the generic sentence would leave the
   *  reader unsure whether the kind exists at all. */
  emptyMessage?: string;
  /** Delete configuration */
  deleteConfig?: ResourceDeleteConfig<Row>;
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
  /** Optional search input placeholder */
  searchPlaceholder?: string;
  /** Generate navigation URL for row click */
  getRowHref?: (row: Row) => string;
  /** Quick actions shown on row hover */
  quickActions?:
    | QuickAction<Row>[]
    | ((setDeleteTarget: (item: Row) => void) => QuickAction<Row>[]);
  /** Function to get unique row ID (for stable keys during data updates) */
  getRowId?: (row: Row, index: number) => string;
  /**
   * A grouping the kind knows better than its namespace — node pools, so far.
   * Namespaces are the default because they are the one key every namespaced
   * kind carries.
   */
  grouping?: RowGrouping<Row> | null;
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
  /**
   * The rows handed in are the last scope's answer, standing in while this
   * one is read: not this scope's total, and its unread are not this scope's.
   */
  placeholder?: boolean;
}

export function ResourceList<
  Row extends { name: string; namespace?: string | null },
>({
  title,
  description,
  queryKey,
  queryFn,
  data,
  unread: externalUnread,
  isLoading,
  error: externalError,
  dataUpdatedAt: externalDataUpdatedAt,
  live,
  resyncing,
  slowed: externalSlowed,
  waitingSince: externalWaitingSince,
  narrowingHelps = true,
  onRetry,
  columns,
  emptyStateLabel,
  widthsKey,
  emptyMessage,
  deleteConfig,
  staleTime,
  refresh,
  headerActions,
  headerContent,
  embedded = false,
  searchPlaceholder,
  getRowHref,
  quickActions,
  getRowId,
  grouping,
  delivery,
  placeholder: externalPlaceholder = false,
}: ResourceListProps<Row>) {
  const t = useT();
  const { isConnected } = useClusterStore();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);

  const shouldUseQuery = data === undefined && !!queryKey && !!queryFn;
  const queryResult = useResource(
    (queryKey ?? ["resource-list"]) as string[],
    queryFn
      ? live && queryKey
        ? async () =>
            keepWatched(
              await queryFn(),
              queryClient.getQueryData<Scoped<Row>>(queryKey)
            )
        : queryFn
      : async () => whole<Row>([]),
    {
      enabled: shouldUseQuery,
      staleTime: staleTime ?? STALE_TIMES.resourceList,
      ...(refresh !== undefined ? { refresh } : {}),
    }
  );

  // The answer is already the selection's; narrowing guards a caller whose
  // `data` is wider than it.
  const scope = useNamespaceScope();
  const resources = useMemo(
    () => scope.narrow(data ?? queryResult.data?.rows ?? []),
    [data, queryResult.data, scope]
  );
  // The last scope's answer, held while this one is read: its unread
  // namespaces are not this scope's, and its rows are not this scope's total.
  const placeholder =
    data === undefined ? queryResult.isPlaceholderData : externalPlaceholder;
  const unread = placeholder
    ? NOTHING_UNREAD
    : ((data === undefined ? queryResult.data?.unread : externalUnread) ??
      NOTHING_UNREAD);
  const loading = isLoading ?? queryResult.isLoading;
  // Read at last. A failed list used to render `resources = []` with
  // `isLoading` already false, so the table printed "No resources of this type
  // in the current scope" — a cluster that could not be read and one that is
  // genuinely empty looked identical, and an expired token said every list in
  // the app was empty. The error only replaces the table when there is nothing
  // to show: a refetch that fails keeps the rows it already had, the same rule
  // a resync follows.
  const failed =
    (data === undefined ? queryResult.error : externalError) ?? null;
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
          namespace: (row as Row).namespace ?? null,
          name: (row as Row).name,
        })
      : [];
  const showDelivery = !!delivery && deliveries.available;
  const rows = showDelivery
    ? resources.filter((row) =>
        matchesDeliveryFilter(deliveryFilter, deliveriesOf(row))
      )
    : resources;

  const deleteMutation = useMutation({
    mutationFn: async (item: Row) => {
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
          title: t("action", "kindDeleted", {
            kind: deleteConfig.resourceType,
          }),
          description: t("action", "kindDeletedDetail", {
            kind: deleteConfig.resourceType,
            name: item.name,
          }),
        });
      }
      setDeleteTarget(null);
    },
    onError: (error, item) => {
      toast({
        title: t("action", "error"),
        description: t("action", "deleteFailed", {
          kind:
            deleteConfig?.resourceType?.toLowerCase() ??
            t("action", "resourceNoun"),
          name: item.name,
          error: errorToShow(error),
        }),
        variant: "destructive",
      });
      setDeleteTarget(null);
    },
  });

  // Both memoised, and both had to be: a fresh array on every render rebuilds
  // TanStack's whole column model on every watch tick, and the table re-reads
  // itself every two seconds. `setDeleteTarget` is a setState and holds still,
  // so the only thing either depends on is what the page passed in.
  //
  // Second from the end, so Delivery lands where the other qualifiers already
  // sit and never displaces Age from the right edge of the table.
  const resolvedColumns = useMemo(() => {
    const base =
      typeof columns === "function"
        ? columns(setDeleteTarget as (item: Row) => void)
        : columns;
    return showDelivery
      ? [...base.slice(0, -1), deliveryColumn<Row>(), ...base.slice(-1)]
      : base;
  }, [columns, showDelivery]);

  const resolvedQuickActions = useMemo(
    () =>
      typeof quickActions === "function"
        ? quickActions(setDeleteTarget as (item: Row) => void)
        : quickActions,
    [quickActions]
  );

  // A resync with nothing to show is still loading; a resync with rows keeps
  // them, and says so above rather than wearing "live" over them.
  const showSkeleton =
    (loading || resyncing) && resources.length === 0 && !failed;
  // How long the skeleton has been one. A clock that only runs while there
  // is a skeleton to time: a list with rows on it is never woken by this.
  const now = useNowSeconds(showSkeleton);
  const waitingSince =
    externalWaitingSince !== undefined
      ? externalWaitingSince
      : queryResult.freshness.waitingSince;
  const waitedMs =
    showSkeleton && waitingSince !== null ? now - waitingSince : 0;
  const slow = waitedMs >= SLOW_READ_MS;
  const ranOutOfTime = failed !== null && isReadDeadline(failed);
  // Rows that are not the scope's whole: a namespace unread, a read cut
  // short, or the last scope's answer still standing in.
  const partial = ranOutOfTime || unread.length > 0 || placeholder;

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={emptyStateLabel} />;
  }
  const content = (
    <>
      {!embedded && (
        <ResourceListHeader
          title={title}
          // Nothing rather than zero when the read did not finish: a count
          // derived from a source the app has just said it could not read
          // is a number about nothing, printed directly above the sentence
          // admitting as much. A namespace unread leaves it no total either.
          count={partial ? undefined : resources.length}
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
      <UnreadNamespaces
        unread={unread}
        label={emptyStateLabel.toLowerCase()}
        // Not the placeholder query's refetch when the rows come from outside:
        // that asks again under a key the page never reads.
        onRetry={
          onRetry ??
          (data === undefined ? () => void queryResult.refetch() : undefined)
        }
      />
      {showDelivery && (
        <DeliveryFilterControl
          value={deliveryFilter}
          onChange={setDeliveryFilter}
          deliveries={resources.map(deliveriesOf)}
        />
      )}
      {slow && (
        <div
          role="status"
          data-testid="slow-read"
          className="mb-2 rounded border border-hair border-l-2 border-l-warn px-3 py-2 text-xs"
        >
          <p className="flex items-baseline gap-2 text-fg">
            <span>
              {t("empty", "stillReading", {
                label: emptyStateLabel.toLowerCase(),
                scope: scope.inWords,
              })}
            </span>
            <span className="font-mono tabular-nums text-warn">
              {t("count", "secondsShort", {
                n: Math.round(waitedMs / 1000),
              })}
            </span>
          </p>
          {narrowingHelps && (scope.isAll || scope.several) && (
            <>
              <p className="mt-0.5 text-fg-mut">
                {t("empty", "narrowerIsFaster")}
              </p>
              <div className="mt-1.5 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openNamespacePicker}
                >
                  {t("action", "pickOneNamespace")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {failed && resources.length === 0 && ranOutOfTime ? (
        <div
          role="status"
          data-testid="read-deadline"
          className="max-w-[68ch] py-6"
        >
          <p className="flex items-start gap-2 text-xs text-fg">
            <TriangleAlert
              className="mt-0.5 h-3.5 w-3.5 flex-none text-warn"
              aria-hidden="true"
            />
            <span>
              {t("empty", "readDeadline", {
                label: emptyStateLabel.toLowerCase(),
                scope: scope.inWords,
                seconds: LIST_DEADLINE_SECONDS,
              })}
            </span>
          </p>
          {/* Not a fault to retry into: a deadline on a big cluster is the
              cluster being big, so the narrower question comes first. */}
          <p className="mt-1 pl-[22px] text-xs text-fg-mut">
            {t("empty", "readDeadlineHint")}
          </p>
          {/* No mono line here. In the branch below it carries the
              cluster's own words, which is why it is there; this message is
              ours, already said above in the reader's language, and the
              `READ_DEADLINE:` marker in front of it is a wire format. */}
          <div className="mt-2 flex gap-2 pl-[22px]">
            {narrowingHelps && (scope.isAll || scope.several) && (
              <Button size="sm" variant="outline" onClick={openNamespacePicker}>
                {t("action", "pickOneNamespace")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              // The caller's, where it owns the read: refetching the
              // placeholder query here would write `[]` under a key the
              // page never reads and leave the real list exactly as it was.
              onClick={() => (onRetry ? onRetry() : void queryResult.refetch())}
            >
              {t("action", "retry")}
            </Button>
          </div>
        </div>
      ) : failed && resources.length === 0 ? (
        <div className="max-w-[68ch] py-8">
          <p className="text-xs text-err">
            {/* A refusal is not a failure, and saying "could not read" about
                one invites a retry that will be refused the same way. */}
            {isRefusal(failed)
              ? t("nav", "noListAccess")
              : t("empty", "couldNotReadInScope", { label: emptyStateLabel })}
          </p>
          <p className="mt-1.5 select-text wrap-break-word font-mono text-[11px] text-fg-fnt">
            {verbatim(failed.message)}
          </p>
        </div>
      ) : (
        <DataTable
          columns={resolvedColumns}
          data={rows}
          // Embedded, the surrounding flow owns the scroll and there is no
          // height to take; on its own page the table is the page.
          fill={!embedded}
          isLoading={showSkeleton}
          searchParam={embedded ? undefined : "q"}
          searchPlaceholder={searchPlaceholder}
          getRowHref={getRowHref}
          quickActions={resolvedQuickActions}
          getRowId={getRowId}
          grouping={grouping ?? byNamespace(emptyStateLabel.toLowerCase())}
          rowLabel={emptyStateLabel.toLowerCase()}
          partial={partial}
          widthsKey={widthsKey}
          // "None in the scope" is a claim about the namespaces that did not
          // answer too; with any unread, it names the ones that did.
          emptyMessage={
            unread.length > 0
              ? noneWhereAnswered(
                  t,
                  emptyStateLabel.toLowerCase(),
                  scope.scope,
                  unread
                )
              : emptyMessage
          }
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
          title={t("action", "deleteKindQuestion", {
            kind: deleteConfig.resourceType.toLowerCase(),
          })}
          description={
            deleteTarget
              ? deleteTarget.namespace
                ? t("action", "willDeleteInNamespace", {
                    name: deleteTarget.name,
                    namespace: deleteTarget.namespace,
                  })
                : t("action", "willDelete", { name: deleteTarget.name })
              : undefined
          }
          confirmLabel={t("action", "delete")}
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

  // A column with a height, so the table below the header can take what is
  // left of the window instead of a fixed 600px box with the rest of the pane
  // blank under it.
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 animate-in fade-in duration-200">
      {wrapped}
    </div>
  );
}
