/**
 * Workload list page factory.
 *
 * A workload list (Deployment, StatefulSet, DaemonSet, Job, CronJob) adds one
 * layer over `createResourceListPage`: it fetches its own resource list AND
 * `usePodsWithMetrics`, then aggregates pod-level CPU / memory up to the
 * workload row via a per-resource `matchPods`. This collapses that
 * boilerplate.
 *
 * PodList is NOT built on this — pods are themselves the metrics-bearing
 * rows, so they use `usePodsWithMetrics` directly without aggregation.
 */

import { useCallback, useMemo } from "react";
import { MetricsAbsenceContext, absenceOf } from "@/lib/metrics-absence";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, Eye } from "lucide-react";
import type { ColumnDef } from "@/components/ui/table-features";

import { ResourceList } from "../../-list/ResourceList";
import { deliveryScopeOf } from "@/lib/delivery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { keepWatched, scopeCacheKey } from "@/lib/namespace-scope";
import type { Scoped } from "@/generated/types";
import { useResourceList } from "@/hooks/useResource";
import { usePodsWithMetrics } from "@/hooks/usePodsWithMetrics";
import {
  attachAggregatedPodMetrics,
  type PodMatcher,
  type ResourceMetrics,
} from "@/lib/metrics";
import { MetricsStatusBanner } from "../../-metrics";
import { queryKeys } from "@/lib/query-keys";
import { hrefOf, objectLink } from "@/lib/links";
import { getResourceRowId } from "@/lib/table-utils";
import { toPlural, type ResourceKind } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useLastPassed } from "@/hooks/useNow";
import { useT } from "@/i18n/useT";
import type { Rollout } from "@/generated/types";
import { rowsWithStarts, startsOf } from "@/lib/workload-status";

type Workload = { name: string; namespace: string };

export interface WorkloadListPageConfig<T extends Workload> {
  /** Kubernetes resource type — used for query keys + detail URLs. */
  resourceType: ResourceKind;
  /** Page title (also default empty-state label). */
  title: string;
  /** Read the workload list (without metrics) across the selection. */
  fetchList: (params: { scope: string[] | null }) => Promise<Scoped<T>>;
  /**
   * Which pods belong to a workload of this kind, used to aggregate pod
   * CPU/memory up to the workload row. One of the `match*Pods` matchers
   * in `@/lib/metrics`.
   */
  matchPods: PodMatcher;
  /** Delete this workload. */
  deleter: (item: T) => Promise<unknown>;
  /** Build columns. T includes the attached `cpuMillicores` and `memoryBytes`. */
  columns: () => ColumnDef<T & ResourceMetrics>[];
  /** Override the empty-state label (defaults to plural of `resourceType`). */
  emptyStateLabel?: string;
  /**
   * Optional watch subscription factory. When supplied, the page
   * disables polling on the workload list query and updates its
   * cache via real-time `resource-event` Tauri events instead.
   * Pod metrics on the side keep their own usePodsWithMetrics path.
   */
  watch?: (params: { scope: string[] | null }) => Promise<string>;
  /**
   * A Deployment's, a StatefulSet's and a DaemonSet's verdict is finished by
   * their pods, as on their pages: the counts alone call a scale whose pod is
   * starting short.
   */
  rolloutFromPods?: T extends { rollout: Rollout } ? true : never;
}

export function createWorkloadListPage<T extends Workload>(
  config: WorkloadListPageConfig<T>
) {
  const linkOf = (row: Workload) =>
    objectLink({
      kind: config.resourceType,
      name: row.name,
      namespace: row.namespace,
    })!;
  const detail = queryKeys.rowDetail(config.resourceType);

  const ListPage = function WorkloadListPage() {
    const t = useT();
    const scope = useNamespaceScope();
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    // Read for the aggregated CPU and memory columns only. The workloads are
    // this page's subject and do not wait on them — see `usePodsWithMetrics`.
    const {
      data: pods,
      read: podsRead,
      unread: podsUnread,
      podStatus,
      podUnread,
      refetchPodMetrics,
    } = usePodsWithMetrics();

    const cacheKey = scopeCacheKey(scope.scope);
    const watchFactory = config.watch;

    const queryKey = useMemo(
      () => queryKeys.resources(config.resourceType, cacheKey),
      [cacheKey]
    );
    const subscribe = useCallback(
      () => watchFactory!({ scope: scope.wire }),
      [watchFactory, scope.wire]
    );

    const { live, refresh, resyncing } = useWatchedList<T>({
      enabled: !!watchFactory,
      subscribe,
      queryKey,
      detail,
      reportFailure: config.title,
    });

    // Under a live watch, a namespace this read missed keeps the rows the
    // watch holds current, as `ResourceList` does for the lists it reads.
    const listQuery = useResourceList(
      queryKey,
      async () => {
        const answer = await config.fetchList({ scope: scope.wire });
        return live
          ? keepWatched(answer, queryClient.getQueryData<Scoped<T>>(queryKey))
          : answer;
      },
      { refresh }
    );

    const starts = useMemo(
      () =>
        config.rolloutFromPods && podsRead ? startsOf(pods, podsUnread) : null,
      [pods, podsRead, podsUnread]
    );
    const ranOut = useLastPassed(starts?.deadlines ?? []);
    const rows = useMemo(() => {
      const read = listQuery.data?.rows ?? [];
      return config.rolloutFromPods
        ? (rowsWithStarts(
            config.resourceType,
            read as Array<T & { rollout: Rollout }>,
            starts,
            ranOut
          ) as T[])
        : read;
    }, [listQuery.data, starts, ranOut]);

    const dataWithMetrics = useMemo(
      () => attachAggregatedPodMetrics<T>(rows, pods, config.matchPods),
      [rows, pods]
    );

    const columns = useMemo(() => config.columns(), []);

    const quickActions = useMemo(
      () =>
        (
          setDeleteTarget: (item: T & ResourceMetrics) => void
        ): QuickAction<T & ResourceMetrics>[] => [
          {
            icon: Eye,
            label: t("action", "viewDetails"),
            onClick: (item) => navigate(linkOf(item)),
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

    const list = (
      <ResourceList<T & ResourceMetrics>
        title={config.title}
        data={dataWithMetrics}
        unread={listQuery.data?.unread}
        placeholder={listQuery.isPlaceholderData}
        onRetry={() => void listQuery.refetch()}
        // A resync holds the rows it has until the new state is complete, so
        // there is normally something to show. With nothing to show, "still
        // finding out" is the skeleton — the empty state would be claiming the
        // scope holds none of these while the answer is still arriving.
        isLoading={
          listQuery.isLoading || (resyncing && dataWithMetrics.length === 0)
        }
        error={listQuery.error}
        dataUpdatedAt={listQuery.dataUpdatedAt}
        live={live}
        slowed={listQuery.freshness.slowed}
        waitingSince={listQuery.freshness.waitingSince}
        getRowId={getResourceRowId}
        delivery={deliveryScopeOf(config.resourceType)}
        columns={columns}
        quickActions={quickActions}
        emptyStateLabel={
          config.emptyStateLabel ?? toPlural(config.resourceType)
        }
        // Inside the list, as the Nodes page has it — see `PodList`.
        headerContent={
          <MetricsStatusBanner
            status={podStatus}
            unread={podUnread}
            onRetry={() => void refetchPodMetrics()}
          />
        }
        getRowHref={(row) => hrefOf(linkOf(row))}
        deleteConfig={{
          mutationFn: async (item) => {
            await config.deleter(item);
          },
          invalidateQueryKeys: [queryKey],
          resourceType: config.resourceType,
        }}
      />
    );
    return (
      <MetricsAbsenceContext.Provider value={absenceOf(podStatus)}>
        {list}
      </MetricsAbsenceContext.Provider>
    );
  };
  ListPage.displayName = `${config.resourceType}List`;
  return ListPage;
}
