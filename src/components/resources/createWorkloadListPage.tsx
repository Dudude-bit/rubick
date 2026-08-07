/**
 * Workload list page factory.
 *
 * Workload list pages (Deployment, StatefulSet, DaemonSet, Job, CronJob)
 * share an extra layer over `createResourceListPage`: each fetches its own
 * resource list AND `usePodsWithMetrics`, then aggregates pod-level CPU /
 * memory up to the workload row via a per-resource `matchPods` function.
 *
 * `createWorkloadListPage` collapses that boilerplate. PodList is NOT
 * built on this — pods are themselves the metrics-bearing rows, so they
 * use `usePodsWithMetrics` directly without aggregation.
 *
 * Example:
 * ```tsx
 * export const DeploymentList = createWorkloadListPage<DeploymentInfo>({
 *   resourceType: ResourceType.Deployment,
 *   title: "Deployments",
 *   fetchList: ({ namespace }) =>
 *     commands.listDeployments({ namespace, ... }),
 *   matchPods: matchDeploymentPods,
 *   deleter: (item) => commands.deleteDeployment(item.name, item.namespace),
 *   columns: () => [...],
 *   extraActions: ({ navigate }) => [
 *     { icon: Scale, label: "Scale", onClick: ... },
 *   ],
 * });
 * ```
 */

import { useCallback, useMemo, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Trash2, Eye } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { ResourceList } from "./ResourceList";
import { useClusterStore } from "@/stores/clusterStore";
import { useResourceList } from "@/hooks/useResource";
import { usePodsWithMetrics } from "@/hooks/usePodsWithMetrics";
import {
  attachAggregatedPodMetrics,
  type ResourceMetrics,
} from "@/lib/metrics";
import { MetricsStatusBanner } from "@/components/metrics";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { getResourceRowId } from "@/lib/table-utils";
import { toPlural, type ResourceKind } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useToast } from "@/components/ui/use-toast";
import type { PodInfo } from "@/generated/types";

type Workload = { name: string; namespace: string };

export interface WorkloadListPageConfig<T extends Workload> {
  /** Kubernetes resource type — used for query keys + detail URLs. */
  resourceType: ResourceKind;
  /** Page title (also default empty-state label). */
  title: string;
  /** Fetch the workload list (without metrics). */
  fetchList: (params: { namespace: string | null }) => Promise<T[]>;
  /**
   * Predicate: does this pod belong to this workload? Used to aggregate
   * pod CPU/memory up to the workload row.
   */
  matchPods: (workload: T, pod: PodInfo) => boolean;
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
    const currentNamespace = useClusterStore((s) => s.currentNamespace);
    const navigate = useNavigate();

    const {
      data: pods,
      podStatus,
      isLoading: isLoadingPods,
    } = usePodsWithMetrics();

    const queryKey = useMemo(
      () => queryKeys.resources(config.resourceType, currentNamespace),
      [currentNamespace]
    );
    const watchFactory = config.watch;
    const subscribe = useCallback(
      () => watchFactory!({ namespace: currentNamespace || null }),
      [watchFactory, currentNamespace]
    );

    // See createResourceListPage for the watch-failure rationale.
    // Same fallback pattern: toast once, flip state, let useResourceList
    // resume polling.
    const { toast } = useToast();
    const [watchFailed, setWatchFailed] = useState(false);
    const handleWatchError = useCallback(
      (err: string) => {
        if (watchFailed) return;
        setWatchFailed(true);
        toast({
          title: "Real-time updates unavailable",
          description: `${config.title}: falling back to periodic refresh. ${err}`,
        });
      },
      [toast, watchFailed]
    );

    const listQuery = useResourceList(
      queryKey,
      () => config.fetchList({ namespace: currentNamespace || null }),
      watchFactory && !watchFailed ? { refetchInterval: false } : undefined
    );

    useResourceWatch<T>({
      enabled: !!watchFactory,
      subscribe,
      queryKey,
      onError: handleWatchError,
      onRecovered: useCallback(() => setWatchFailed(false), []),
    });

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
            label: "View Details",
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
        <ResourceList<T & ResourceMetrics>
          title={config.title}
          data={dataWithMetrics}
          isLoading={listQuery.isLoading || isLoadingPods}
          dataUpdatedAt={listQuery.dataUpdatedAt}
          live={!!watchFactory && !watchFailed}
          getRowId={getResourceRowId}
          columns={columns}
          quickActions={quickActions}
          emptyStateLabel={
            config.emptyStateLabel ?? toPlural(config.resourceType)
          }
          getRowHref={(row) =>
            getResourceDetailUrl(config.resourceType, row.name, row.namespace)
          }
          deleteConfig={{
            mutationFn: async (item) => {
              await config.deleter(item);
            },
            invalidateQueryKeys: [
              queryKeys.resources(config.resourceType, currentNamespace),
            ],
            resourceType: config.resourceType,
          }}
        />
      </div>
    );
  };
  ListPage.displayName = `${config.resourceType}List`;
  return ListPage;
}
