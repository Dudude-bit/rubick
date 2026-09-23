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
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Trash2, Eye } from "lucide-react";
import type { ColumnDef } from "@/components/ui/table-features";

import { ResourceList } from "./ResourceList";
import { deliveryScopeOf } from "@/lib/delivery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { listAcrossScope, scopeCacheKey } from "@/lib/namespace-scope";
import { useResourceList } from "@/hooks/useResource";
import { usePodsWithMetrics } from "@/hooks/usePodsWithMetrics";
import {
  attachAggregatedPodMetrics,
  type PodMatcher,
  type ResourceMetrics,
} from "@/lib/metrics";
import { MetricsStatusBanner } from "@/components/metrics";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { getResourceRowId } from "@/lib/table-utils";
import { toPlural, type ResourceKind } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useT } from "@/i18n/useT";

type Workload = { name: string; namespace: string };

export interface WorkloadListPageConfig<T extends Workload> {
  /** Kubernetes resource type — used for query keys + detail URLs. */
  resourceType: ResourceKind;
  /** Page title (also default empty-state label). */
  title: string;
  /** Fetch the workload list (without metrics). */
  fetchList: (params: { namespace: string | null }) => Promise<T[]>;
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
  /** Extra quick actions (e.g. Scale, Restart for Deployment). */
  extraActions?: (deps: {
    navigate: NavigateFunction;
  }) => QuickAction<T & ResourceMetrics>[];
  /** Override the empty-state label (defaults to plural of `resourceType`). */
  emptyStateLabel?: string;
  /**
   * Optional watch subscription factory. When supplied, the page
   * disables polling on the workload list query and updates its
   * cache via real-time `resource-event` Tauri events instead.
   * Pod metrics on the side keep their own usePodsWithMetrics path.
   */
  watch?: (params: { namespace: string | null }) => Promise<string>;
}

export function createWorkloadListPage<T extends Workload>(
  config: WorkloadListPageConfig<T>
) {
  const ListPage = function WorkloadListPage() {
    const t = useT();
    const scope = useNamespaceScope();
    const navigate = useNavigate();

    // Read for the aggregated CPU and memory columns only. The workloads are
    // this page's subject and do not wait on them — see `usePodsWithMetrics`.
    const { data: pods, podStatus } = usePodsWithMetrics();

    // Several namespaces are read one apiece and polled; a watch covers none
    // or one. See `listAcrossScope` / createResourceListPage.
    const watchNamespace = scope.scope.length === 1 ? scope.scope[0] : null;
    const cacheKey = scopeCacheKey(scope.scope);
    const watchFactory = config.watch;
    const watchEnabled = !!watchFactory && !scope.several;

    const queryKey = useMemo(
      () => queryKeys.resources(config.resourceType, cacheKey),
      [cacheKey]
    );
    const subscribe = useCallback(
      () => watchFactory!({ namespace: watchNamespace }),
      [watchFactory, watchNamespace]
    );

    const { live, refresh, resyncing } = useWatchedList<T>({
      enabled: watchEnabled,
      subscribe,
      queryKey,
      reportFailure: config.title,
    });

    const listQuery = useResourceList(
      queryKey,
      listAcrossScope(scope.scope, (namespace) =>
        config.fetchList({ namespace })
      ),
      { refresh }
    );

    const dataWithMetrics = useMemo(
      () =>
        attachAggregatedPodMetrics<T>(
          listQuery.data ?? [],
          pods,
          config.matchPods
        ),
      [listQuery.data, pods]
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
            onClick: (item) =>
              navigate(
                getResourceDetailUrl(
                  config.resourceType,
                  item.name,
                  item.namespace
                )
              ),
          },
          ...(config.extraActions?.({ navigate }) ?? []),
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
      <ResourceList<T & ResourceMetrics>
        title={config.title}
        data={dataWithMetrics}
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
          podStatus?.status !== "available" ? (
            <MetricsStatusBanner status={podStatus} />
          ) : null
        }
        getRowHref={(row) =>
          getResourceDetailUrl(config.resourceType, row.name, row.namespace)
        }
        deleteConfig={{
          mutationFn: async (item) => {
            await config.deleter(item);
          },
          invalidateQueryKeys: [queryKey],
          resourceType: config.resourceType,
        }}
      />
    );
  };
  ListPage.displayName = `${config.resourceType}List`;
  return ListPage;
}
