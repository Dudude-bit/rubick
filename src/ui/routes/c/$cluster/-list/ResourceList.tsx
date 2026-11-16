import { cn } from "@/lib/utils";
import { ReactNode, useMemo, useState } from "react";
import type { ColumnDef } from "@/components/ui/table-features";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConnectClusterEmptyState } from "@/components/ui/connect-cluster-empty-state";
import { DataTable } from "@/components/ui/data-table";
import { byNamespace, type RowGrouping } from "@/components/ui/row-grouping";
import { useToast } from "@/components/ui/use-toast";
import { ResourceListHeader } from "./ResourceListHeader";
import { useCountedAt, useKnownCount } from "./known-count";
import { useOverviewUnreadOf } from "./overview-unread";
import { Unknown } from "@/components/ui/unknown";
import { useResource } from "@/hooks/useResource";
import { useDeliveries } from "../-delivery/useDelivery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useScopeMissing } from "@/hooks/useScopeMissing";
import { listWords } from "@/i18n/say";
import { useClusterStore } from "@/stores/clusterStore";
import {
  DELIVERY_FILTER_LABEL,
  deliveryOf,
  matchesDeliveryFilter,
  type DeliveryFilter,
} from "@/lib/delivery";
import { STALE_TIMES, type RefreshRate } from "@/lib/refresh";
import { isRefusal, verbatim } from "@/lib/error-utils";
import { askedAgainFirst, useRefusedAt } from "@/lib/refusals";
import {
  isReadDeadline,
  LIST_DEADLINE_SECONDS,
  NOTICE_READ_MS,
  openNamespacePicker,
  SLOW_READ_MS,
} from "@/lib/read-deadline";
import { useLastPassed, useNowSeconds } from "@/hooks/useNow";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ReadAgain } from "@/components/ui/read-again";
import { TriangleAlert } from "lucide-react";
import { ShareScreenAction } from "@/components/share/ShareAction";
import { useShareSection } from "@/components/share/screen-share";
import { NO_TABLE, tableSection } from "@/components/share/table-share";
import {
  kindNoun,
  listQueryFor,
  narrowingHelps as narrowsByKind,
  type KindNoun,
  type ResourceKind,
} from "@/lib/resource-registry";
import {
  DeliveryFilterControl,
  DeliveryRowsProvider,
} from "../-delivery/delivery-column";
import { deliveryColumn } from "./delivery-list-column";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useT } from "@/i18n/useT";
import { toastWriteError } from "@/lib/toast-error";
import {
  keepWatched,
  scopeOfList,
  noneWhereAnswered,
  unreadNamespaceWords,
  whole,
} from "@/lib/namespace-scope";
import type { ListQuery, Scoped, UnreadNamespace } from "@/generated/types";
import { UnreadNamespaces } from "./UnreadNamespaces";
import { ListedHere } from "./ListedHere";
import { NamedRowsBanner } from "./NamedRows";
import { useNamedRows } from "./useNamedRows";
import { useSetSearch } from "@/hooks/useSearchParam";
import { rowName } from "@/lib/links";
import { StaleRows } from "@/components/ui/stale-rows";
import { HeldWhilePointed } from "@/components/ui/held-while-pointed";
import { AskedAgain, RefusalWayOut, UnreadList } from "./UnreadList";
import { metricsAbsent, recheckMetrics } from "../-metrics";
import {
  LIST_NOTICE_WIDTH,
  ListEmpty,
  ListNoticeRetries,
  ListUnread,
} from "./list-unread";
import { useListRefusal } from "./useListRefusal";
import { useRowDenial } from "@/lib/access";
import { Reading } from "@/components/ui/states";
import { HeldLines } from "./HeldLines";
import { KindAbout } from "@/components/object/KindAbout";
import { useRowMenu } from "./useRowMenu";
import { useRecheckRefusal } from "./useRecheckRefusal";
import { deleteCommandFor } from "../-peek/peek-actions";
import type { PeekTarget } from "@/hooks/usePeek";

const NOTHING_UNREAD: UnreadNamespace[] = [];
const NO_ROWS: never[] = [];

/** What a skeleton draws for a list whose length nothing has told us: the fewest rows that still read as a table. */
const UNKNOWN_COUNT_ROWS = 3;

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
  /**
   * The registry's kind these rows are, or `null` for any other. Said, not
   * guessed from a label: Knative's `services` share the plural, and a list
   * that read the label as `Service` deleted core Services from its rows.
   */
  kind: ResourceKind | null;
  /** Below the title; a typed kind says what it is without being asked. */
  description?: ReactNode;
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
  onRetry?: () => unknown;
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
  /** The kind the footer counts, for a kind the registry does not hold. */
  noun?: KindNoun;
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
  /**
   * How the caller narrowed the rows it hands in, in the words of the
   * notice it draws for that: the shared file's reader sees no notice.
   */
  narrowed?: string | null;
  /** Render without header wrapper for embedded list views */
  embedded?: boolean;
  /** Optional search input placeholder */
  searchPlaceholder?: string;
  /** Generate navigation URL for row click */
  getRowHref?: (row: Row) => string;
  /** The peek a row opens, for a kind its address cannot name: one outside the registry. */
  getRowPeek?: (row: Row) => PeekTarget | null;
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
  /** The rows are the first of a longer list the server has more of. */
  more?: boolean;
  /** What the authorizer is asked about this list, for a kind the registry does not hold. */
  listQuery?: ListQuery;
}

/** The sentences about reading a list, naming the scope only for a kind that has one. */
function useListReadWords(
  namespaced: boolean,
  label: string,
  emptyLabel: string,
  scope: string
) {
  const t = useT();
  const seconds = LIST_DEADLINE_SECONDS;
  return namespaced
    ? {
        stillReading: t("empty", "stillReading", { label, scope }),
        readDeadline: t("empty", "readDeadline", { label, scope, seconds }),
        couldNotRead: t("empty", "couldNotReadInScope", { label: emptyLabel }),
      }
    : {
        stillReading: t("empty", "stillReadingCluster", { label }),
        readDeadline: t("empty", "readDeadlineCluster", { label, seconds }),
        couldNotRead: t("empty", "couldNotReadCluster", { label: emptyLabel }),
      };
}

export function ResourceList<
  Row extends { name: string; namespace?: string | null },
>({
  title,
  kind: listKind,
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
  narrowingHelps: narrowingHelpsProp,
  onRetry,
  columns,
  emptyStateLabel,
  noun,
  widthsKey,
  emptyMessage,
  deleteConfig,
  staleTime,
  refresh,
  headerActions,
  headerContent,
  narrowed = null,
  embedded = false,
  searchPlaceholder,
  getRowHref,
  getRowPeek,
  quickActions,
  getRowId,
  grouping,
  delivery,
  placeholder: externalPlaceholder = false,
  more = false,
  listQuery,
}: ResourceListProps<Row>) {
  const t = useT();
  const { isConnected } = useClusterStore();
  const namespaceScope = useClusterStore((state) => state.namespaceScope);
  const narrowingHelps =
    narrowingHelpsProp ?? (listKind ? narrowsByKind(listKind) : true);
  const counted = useMemo(
    () => noun ?? kindNoun(emptyStateLabel),
    [noun, emptyStateLabel]
  );
  const namespaceGroups = useMemo(() => byNamespace<Row>(counted), [counted]);
  const knownCount = useKnownCount(listKind);
  const screen = useMemo(
    () => ({
      title,
      kind: listKind,
      scope: scopeOfList(namespaceScope, listKind),
    }),
    [title, listKind, namespaceScope]
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [matched, setMatched] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const rowMenu = useRowMenu<Row>({ kind: listKind, getRowHref, getRowPeek });
  // Where the row menu can delete this kind, a row's Delete button asks
  // through it: one dialog, with what replaces the object and what goes too.
  const requestDelete =
    listKind && deleteCommandFor(listKind)
      ? rowMenu.askDelete
      : setDeleteTarget;

  const shouldUseQuery = data === undefined && !!queryKey && !!queryFn;
  // A visit asks a refused list once more, so the age it shows is this
  // visit's; the polls after it are answered by the kept refusal.
  const [visit] = useState(askedAgainFirst);
  const read = queryFn && (() => visit(queryFn));
  const queryResult = useResource(
    (queryKey ?? ["resource-list"]) as string[],
    read
      ? live && queryKey
        ? async () =>
            keepWatched(
              await read(),
              queryClient.getQueryData<Scoped<Row>>(queryKey)
            )
        : read
      : async () => whole<Row>([]),
    {
      enabled: shouldUseQuery,
      staleTime: staleTime ?? STALE_TIMES.resourceList,
      ...(refresh !== undefined ? { refresh } : {}),
    }
  );

  // Read at last. A failed list used to render `resources = []` with
  // `isLoading` already false, so the table printed "No resources of this type
  // in the current scope": a cluster that could not be read and one that is
  // genuinely empty looked identical, and an expired token said every list in
  // the app was empty. The error only replaces the table when there is nothing
  // to show: a refetch that fails keeps the rows it already had, the same rule
  // a resync follows.
  // Asked of the query, not of `data`: rows from outside are undefined
  // exactly when their read failed, and that error is the caller's.
  const lastFailed =
    (shouldUseQuery ? queryResult.error : externalError) ?? null;
  const lastRefused = lastFailed !== null && isRefusal(lastFailed);
  const keptAt = useRefusedAt(lastRefused ? lastFailed : null);
  // The kept refusal is let go while a visit asks again; the query still
  // knows when the cluster said it, and the screen says how long ago.
  const refusalAt = !lastRefused
    ? null
    : (keptAt ??
      (shouldUseQuery && queryResult.errorUpdatedAt > 0
        ? queryResult.errorUpdatedAt
        : null));
  // Asked of the cluster, not answered by the kept refusal as a poll is.
  const askingAgain =
    refusalAt !== null && keptAt === null && queryResult.isFetching;
  const countedAt = useCountedAt(listKind);
  // The sidebar read this list since it was refused: while it is asked again,
  // the old refusal is not drawn as this visit's answer.
  const outlived =
    askingAgain &&
    refusalAt !== null &&
    countedAt !== null &&
    countedAt > refusalAt;
  const failed = outlived ? null : lastFailed;
  const refused = failed !== null && isRefusal(failed);
  const refusedAt = refused ? refusalAt : null;
  useRecheckRefusal(refused ? keptAt : null, () =>
    onRetry ? onRetry() : data === undefined && queryResult.refetch()
  );

  // The answer is already the selection's; narrowing guards a caller whose
  // `data` is wider than it.
  const scope = useNamespaceScope();
  const namespacedKind = listKind ? listQueryFor(listKind).namespaced : true;
  const scopeMissing = useScopeMissing();
  // Not a quiet namespace: a list of one the cluster does not have read
  // nothing, and its empty sentence and count would say there is none.
  const scopeGone = !embedded && narrowingHelps && scopeMissing.whole;
  // The last scope's answer, held while this one is read: its unread
  // namespaces are not this scope's, and its rows are not this scope's total.
  const placeholder = shouldUseQuery
    ? queryResult.isPlaceholderData
    : externalPlaceholder;
  // A refused re-read keeps the rows it had, said below to be from before it.
  const resources = useMemo(() => {
    if (outlived) return NO_ROWS;
    const rows = data ?? queryResult.data?.rows ?? [];
    // A row the last scope read stands in only where this scope reaches it.
    return placeholder
      ? rows.filter((row) => scope.matches(row.namespace))
      : scope.narrow(rows);
  }, [outlived, data, queryResult.data, scope, placeholder]);
  const unread = placeholder
    ? NOTHING_UNREAD
    : ((shouldUseQuery ? queryResult.data?.unread : externalUnread) ??
      NOTHING_UNREAD);
  const loading = (isLoading ?? queryResult.isLoading) || outlived;
  const dataUpdatedAt = outlived
    ? 0
    : (externalDataUpdatedAt ?? queryResult.dataUpdatedAt);
  // Every list, whatever feeds it: rows a failed read kept are said to be old.
  const stale = failed !== null && resources.length > 0;
  // Refused while its watch still streams: the rows are the watch's, as Pods keep them.
  const watchHolds = stale && refused && !!live && !resyncing;
  const freshList = useOverviewUnreadOf(listKind);
  const warm =
    !!live && !resyncing && !refused && failed === null && !!freshList.unread;
  const warmRefusedAt =
    warm && freshList.unread && isRefusal(freshList.unread) && freshList.since
      ? freshList.since
      : undefined;

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
  const showDelivery =
    !!delivery &&
    deliveries.available &&
    (deliveries.isPending ||
      deliveries.error !== null ||
      deliveryFilter !== "all" ||
      resources.some((row) => deliveriesOf(row).length > 0));
  const deliveryKnown =
    deliveries.error !== null ||
    deliveryFilter !== "all" ||
    resources.some((row) => deliveriesOf(row).length > 0);
  const delivered = showDelivery
    ? resources.filter((row) =>
        matchesDeliveryFilter(deliveryFilter, deliveriesOf(row))
      )
    : resources;
  const named = useNamedRows();
  const setSearch = useSetSearch();
  const rows = useMemo(
    () =>
      named ? delivered.filter((row) => named.has(rowName(row))) : delivered,
    [named, delivered]
  );
  // Counted before the Delivery filter: a named row it hides is in the list.
  const namedFound = useMemo(
    () =>
      named ? resources.filter((row) => named.has(rowName(row))).length : 0,
    [named, resources]
  );

  const filteredToNone =
    resources.length > 0 &&
    rows.length === 0 &&
    (!!named || (showDelivery && deliveryFilter !== "all"));

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
    onError: (error, item) =>
      toastWriteError(
        t("action", "deleteFailed", {
          kind: deleteConfig?.resourceType ?? t("action", "resourceNoun"),
          name: item.name,
        }),
        error
      ),
  });
  const deleting = deleteMutation.isPending ? deleteMutation.variables : null;

  // Both memoised, and both had to be: a fresh array on every render rebuilds
  // TanStack's whole column model on every watch tick, and the table re-reads
  // itself every two seconds. `requestDelete` holds still,
  // so the only thing either depends on is what the page passed in.
  //
  // Second from the end, so Delivery lands where the other qualifiers already
  // sit and never displaces Age from the right edge of the table.
  const resolvedColumns = useMemo(() => {
    const base =
      typeof columns === "function" ? columns(requestDelete) : columns;
    return showDelivery
      ? [...base.slice(0, -1), deliveryColumn<Row>(), ...base.slice(-1)]
      : base;
  }, [columns, showDelivery, requestDelete]);

  const listed = listQuery ?? (listKind ? listQueryFor(listKind) : null);
  const deleteDenial = useRowDenial(listed, "delete");
  const deleteLabel = t("action", "delete");
  const resolvedQuickActions = useMemo(
    () =>
      (typeof quickActions === "function"
        ? quickActions(requestDelete)
        : quickActions
      )?.map((action) =>
        action.variant === "destructive" && action.label === deleteLabel
          ? {
              ...action,
              reason: deleteDenial,
              pending: (item: Row) => item === deleting,
            }
          : action
      ),
    [quickActions, requestDelete, deleteLabel, deleteDenial, deleting]
  );

  // A resync with nothing to show is still loading; a resync with rows keeps
  // them, and says so above rather than wearing "live" over them.
  const waiting =
    (loading || resyncing || placeholder) && resources.length === 0 && !failed;
  const [lastFailure, setLastFailure] = useState<Error | null>(null);
  if (failed && lastFailure !== failed) setLastFailure(failed);
  if (!failed && lastFailure && (!waiting || outlived)) setLastFailure(null);
  const unreadError = failed ?? (waiting ? lastFailure : null);
  const showSkeleton = waiting && !unreadError;
  const retry =
    onRetry ?? (data === undefined ? () => queryResult.refetch() : undefined);
  const retryWithMetrics = (read: () => unknown) =>
    Promise.all([
      read(),
      metricsAbsent(queryClient) ? recheckMetrics(queryClient) : null,
    ]);
  const watchNotice = watchHolds
    ? { error: failed, retry: retry && (() => retryWithMetrics(retry)) }
    : warm && freshList.unread
      ? {
          error: Object.assign(new Error(freshList.unread.message), {
            code: freshList.unread.code,
          }),
          retry: () => retryWithMetrics(freshList.retry),
        }
      : null;
  // How long the skeleton has been one. A clock that only runs while there
  // is a skeleton to time: a list with rows on it is never woken by this.
  const now = useNowSeconds(showSkeleton);
  const [skeletonSince, setSkeletonSince] = useState<number | null>(null);
  if (showSkeleton !== (skeletonSince !== null))
    setSkeletonSince(showSkeleton ? now : null);
  const waitingSince =
    (externalWaitingSince !== undefined
      ? externalWaitingSince
      : queryResult.freshness.waitingSince) ?? skeletonSince;
  const waitedMs =
    showSkeleton && waitingSince !== null ? now - waitingSince : 0;
  // Timed to the deadline itself: the one-second clock above lands them up to a second late.
  const deadlines =
    showSkeleton && waitingSince !== null
      ? [waitingSince + NOTICE_READ_MS, waitingSince + SLOW_READ_MS]
      : [];
  const passed = useLastPassed(deadlines);
  const noticed = deadlines.length > 0 && passed >= deadlines[0];
  const slow = deadlines.length > 0 && passed >= deadlines[1];
  const ranOutOfTime = failed !== null && isReadDeadline(failed);
  // Rows that are not the scope's whole: a namespace unread, a read cut
  // short, or the last scope's answer still standing in.
  const partial = ranOutOfTime || unread.length > 0 || placeholder || more;
  const nothingRead =
    resources.length === 0 &&
    (failed !== null ||
      loading ||
      placeholder ||
      !!resyncing ||
      (shouldUseQuery ? queryResult.data === undefined : data === undefined));

  // Refused across the whole cluster is not refused everywhere: a namespace
  // the reader has may still list it, and saying "no permission" hides that.
  const refusal = useListRefusal(failed, narrowingHelps && scope.isAll, listed);
  const refusalWords = refusal.words;

  // What the file says about the read, in the words the screen uses: a list
  // nobody could read, or read only part of, is not an empty or a whole one.
  const label = emptyStateLabel.toLowerCase();
  const readWords = useListReadWords(
    namespacedKind,
    label,
    emptyStateLabel,
    scope.inWords
  );
  const failedWords = failed
    ? ranOutOfTime
      ? readWords.readDeadline
      : `${
          isRefusal(failed) ? refusalWords : readWords.couldNotRead
        } (${verbatim(failed.message)})`
    : null;
  const listUnread =
    failedWords && resources.length === 0
      ? failedWords
      : showSkeleton
        ? t("share", "stillReading")
        : null;
  const listPartial = !partial
    ? null
    : [
        ...unreadNamespaceWords(t, label, unread),
        ...(more
          ? [t("empty", "printedMore", { count: resources.length })]
          : []),
      ].join(" ") ||
      (failedWords ?? t("share", "stillReading"));
  // Every way the rows were narrowed that is not the search box: the screen
  // says each above the table, and the file's reader sees only the rows.
  const listNarrowed =
    [
      narrowed,
      named ? t("readings", "namedRowsOnly", { n: named.size }) : null,
      showDelivery && deliveryFilter !== "all"
        ? t("share", "listDelivery", {
            filter: t("action", DELIVERY_FILTER_LABEL[deliveryFilter]),
          })
        : null,
    ]
      .filter(Boolean)
      .join(" ") || null;
  const share = useMemo(
    () => ({
      title,
      kind: listKind,
      unread: listUnread,
      partial: listPartial,
      narrowed: listNarrowed,
    }),
    [title, listKind, listUnread, listPartial, listNarrowed]
  );
  // The table registers itself; a read that failed with nothing to show has
  // no table, and still has to reach the file.
  useShareSection(
    !embedded && listUnread && failedWords ? "table-unread" : null,
    () => tableSection(NO_TABLE, share, t)
  );

  const [noticesWaiting, setNoticesWaiting] = useState(false);
  const noticesSignature = [
    stale,
    warm && freshList.unread?.message,
    !!unreadError,
    unread.map((namespace) => namespace.namespace).join(","),
  ].join("|");

  if (!isConnected) {
    return <ConnectClusterEmptyState resourceLabel={emptyStateLabel} />;
  }
  const about = description ?? (listKind && <KindAbout kind={listKind} />);
  const wholeUnread =
    !!unreadError && resources.length === 0 && !(failed && ranOutOfTime);
  const deadlineShown =
    failed !== null && resources.length === 0 && ranOutOfTime;
  const aboutBelowAlert = wholeUnread || deadlineShown;
  const aboutLine = about && (
    <p className="mb-2 text-xs text-fg-mut">
      <HeldLines>{about}</HeldLines>
    </p>
  );
  const content = (
    <>
      {!embedded && (
        <ResourceListHeader
          title={title}
          // Nothing rather than zero when the read did not finish: a count
          // derived from a source the app has just said it could not read
          // is a number about nothing, printed directly above the sentence
          // admitting as much. A namespace unread leaves it no total either.
          count={
            partial || nothingRead || scopeGone
              ? undefined
              : matched !== null && matched < rows.length
                ? t("readings", "shownOfTotal", {
                    shown: matched,
                    total: resources.length,
                  })
                : showDelivery && deliveryFilter !== "all"
                  ? t("readings", "shownOfTotal", {
                      shown: delivered.length,
                      total: resources.length,
                    })
                  : resources.length
          }
          countPending={showSkeleton}
          actions={
            <>
              {headerActions}
              <ShareScreenAction screen={screen} />
            </>
          }
          dataUpdatedAt={dataUpdatedAt}
          // A resync is not live: the rows below it are the ones from before
          // the watch started re-listing, and the badge is the only thing that
          // would otherwise still claim they are current.
          live={live && !resyncing && !refused}
          slowed={externalSlowed ?? (!live && queryResult.freshness.slowed)}
          stale={stale || warm || (failed !== null && !isRefusal(failed))}
          slowRead={!live && queryResult.freshness.slowRead}
          refusedAt={refused ? refusedAt : warmRefusedAt}
          held={noticesWaiting}
        />
      )}
      {!embedded && <ListedHere kind={listKind} />}
      {!embedded && named && !loading && (
        <NamedRowsBanner
          named={named}
          found={namedFound}
          whole={failed === null && !partial}
        />
      )}
      <HeldWhilePointed
        signature={noticesSignature}
        onWaiting={setNoticesWaiting}
      >
        <ListNoticeRetries.Provider
          value={(stale && !!retry) || (warm && !!freshList.unread)}
        >
          <ListUnread.Provider value={!!unreadError && resources.length === 0}>
            <ListEmpty.Provider value={resources.length === 0 && !nothingRead}>
              {headerContent}
            </ListEmpty.Provider>
          </ListUnread.Provider>
        </ListNoticeRetries.Provider>
        {stale && !watchHolds && (
          <StaleRows
            compact={false}
            className={cn("mb-2", LIST_NOTICE_WIDTH)}
            label={emptyStateLabel.toLowerCase()}
            since={dataUpdatedAt}
            error={failed}
            onRetry={retry && (() => retryWithMetrics(retry))}
          />
        )}
        {watchNotice && (
          <Unknown
            className={cn("mb-2", LIST_NOTICE_WIDTH)}
            question={t("empty", "watchLiveListFailing", {
              label: emptyStateLabel.toLowerCase(),
            })}
            error={watchNotice.error}
            onRetry={watchNotice.retry}
          />
        )}
        {stale && refused && askingAgain && refusedAt !== null && (
          <div className={cn("-mt-1 mb-2", LIST_NOTICE_WIDTH)}>
            <AskedAgain since={refusedAt} />
          </div>
        )}
        <UnreadNamespaces
          unread={unread}
          label={emptyStateLabel.toLowerCase()}
          // Not the placeholder query's refetch when the rows come from outside:
          // that asks again under a key the page never reads.
          onRetry={retry}
        />
      </HeldWhilePointed>
      {!embedded && !aboutBelowAlert && aboutLine}
      {showDelivery && !showSkeleton && deliveryKnown && (
        <DeliveryFilterControl
          value={deliveryFilter}
          onChange={setDeliveryFilter}
          deliveries={resources.map(deliveriesOf)}
        />
      )}
      {showSkeleton && !slow && (
        <div data-testid="reading-list" className="relative h-0">
          {noticed && (
            <div className="absolute left-44 top-0 flex h-7 items-center">
              <Reading>{readWords.stillReading}</Reading>
            </div>
          )}
        </div>
      )}
      {slow && (
        <Alert
          variant="warn"
          role="status"
          data-testid="slow-read"
          className={cn("mb-2", LIST_NOTICE_WIDTH)}
        >
          <p className="flex items-baseline gap-2 text-fg">
            <span>{readWords.stillReading}</span>
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
        </Alert>
      )}
      {deadlineShown ? (
        <>
          <Alert
            variant="warn"
            role="status"
            data-testid="read-deadline"
            className={LIST_NOTICE_WIDTH}
          >
            <TriangleAlert aria-hidden="true" />
            <p className="text-fg">
              <span>{failedWords}</span>
            </p>
            {/* Not a fault to retry into: a deadline on a big cluster is the
              cluster being big, so the narrower question comes first. */}
            <p className="mt-1 text-fg-mut">{t("empty", "readDeadlineHint")}</p>
            {/* No mono line here. In the branch below it carries the
              cluster's own words, which is why it is there; this message is
              ours, already said above in the reader's language, and the
              `READ_DEADLINE:` marker in front of it is a wire format. */}
            <div className="mt-2 flex gap-2">
              {narrowingHelps && (scope.isAll || scope.several) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openNamespacePicker}
                >
                  {t("action", "pickOneNamespace")}
                </Button>
              )}
              <ReadAgain
                error={failed}
                // The caller's, where it owns the read: refetching the
                // placeholder query here would write `[]` under a key the
                // page never reads and leave the real list exactly as it was.
                onRetry={() => (onRetry ? onRetry() : queryResult.refetch())}
              />
            </div>
          </Alert>
          {!embedded && aboutLine}
        </>
      ) : unreadError && resources.length === 0 ? (
        <>
          <UnreadList
            error={unreadError}
            // A refusal is not a failure, and saying "could not read" about
            // one invites a retry that will be refused the same way.
            words={
              isRefusal(unreadError) ? refusalWords : readWords.couldNotRead
            }
            onRetry={retry}
            askedAgainAfter={refused && askingAgain ? refusedAt : null}
          >
            <RefusalWayOut refusal={refusal} />
          </UnreadList>
          {!embedded && aboutLine}
        </>
      ) : (
        <DataTable
          columns={resolvedColumns}
          data={rows}
          // Embedded, the surrounding flow owns the scroll and there is no
          // height to take; on its own page the table is the page.
          fill={!embedded}
          pageKeys={!embedded}
          onRowMenu={rowMenu.open}
          isLoading={showSkeleton}
          onMatched={setMatched}
          loadingRows={knownCount ?? UNKNOWN_COUNT_ROWS}
          loadingGrouped={
            grouping === undefined
              ? !!listKind &&
                listQueryFor(listKind).namespaced &&
                namespaceScope.length !== 1 &&
                (knownCount ?? 0) >= 6
              : false
          }
          searchParam={embedded ? undefined : "q"}
          searchPlaceholder={searchPlaceholder}
          getRowHref={getRowHref}
          getRowPeek={getRowPeek}
          quickActions={resolvedQuickActions}
          getRowId={getRowId}
          grouping={grouping ?? namespaceGroups}
          rowLabel={emptyStateLabel.toLowerCase()}
          rowNoun={counted}
          partial={partial}
          partialWhy={
            unread.length > 0 || more
              ? undefined
              : placeholder
                ? "previousScope"
                : ranOutOfTime
                  ? "deadline"
                  : undefined
          }
          more={more}
          widthsKey={widthsKey}
          share={embedded ? undefined : share}
          // "None in the scope" is a claim about the namespaces that did not
          // answer too; with any unread, it names the ones that did.
          emptyMessage={
            scopeGone
              ? t("cluster", "scopeMissingTitle", {
                  n: scopeMissing.missing.length,
                  names: listWords(scopeMissing.missing, t),
                })
              : filteredToNone
                ? !named && showDelivery
                  ? t("empty", "deliveryFilterMatchesNothing", {
                      filter: t(
                        "action",
                        DELIVERY_FILTER_LABEL[deliveryFilter]
                      ),
                    })
                  : t("empty", "filtersMatchNothing")
                : unread.length > 0
                  ? noneWhereAnswered(
                      t,
                      emptyStateLabel.toLowerCase(),
                      scope.scope,
                      unread
                    )
                  : (emptyMessage ??
                    (namespacedKind
                      ? undefined
                      : t("empty", "noneInCluster", { label })))
          }
          emptyAction={
            filteredToNone && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setDeliveryFilter("all");
                  if (named) setSearch({ names: undefined });
                }}
              >
                {t("empty", "clearFilters")}
              </Button>
            )
          }
        />
      )}
      {rowMenu.element(resolvedQuickActions ?? [])}
      {deleteConfig && (
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteTarget(null);
            }
          }}
          title={t("action", "deleteKindQuestion", {
            kind: deleteConfig.resourceType,
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
          onConfirm={() =>
            deleteTarget && deleteMutation.mutateAsync(deleteTarget)
          }
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
  return <div className="flex h-full min-h-0 flex-col gap-4">{wrapped}</div>;
}
