import { keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type {
  PodMetricsResponse,
  NodeMetricsResponse,
} from "@/generated/types";
import { STALE_TIMES } from "@/lib/refresh";
import { queryKeys } from "@/lib/query-keys";
import { useLiveQuery, type LiveQueryOptions } from "@/hooks/useLiveQuery";

type MetricsQueryOptions<T> = Omit<
  LiveQueryOptions<T, Error, T, string[]>,
  "queryKey" | "queryFn"
>;

export interface UseMetricsOptions {
  namespace?: string | null;
  enabled?: boolean;
  includePods?: boolean;
  includeNodes?: boolean;
  podQueryOptions?: MetricsQueryOptions<PodMetricsResponse>;
  nodeQueryOptions?: MetricsQueryOptions<NodeMetricsResponse>;
}

export function useMetrics(options?: UseMetricsOptions) {
  const enabled = options?.enabled ?? true;
  const includePods = options?.includePods ?? true;
  const includeNodes = options?.includeNodes ?? true;

  const podMetricsQuery = useLiveQuery({
    queryKey: queryKeys.metrics.pods(options?.namespace),
    queryFn: async () => {
      return await commands.getPodsMetrics(options?.namespace ?? null);
    },
    enabled: enabled && includePods,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.metrics,
    refresh: "metrics",
    ...options?.podQueryOptions,
  });

  const nodeMetricsQuery = useLiveQuery({
    queryKey: queryKeys.metrics.nodes(),
    queryFn: async () => {
      return await commands.getNodesMetrics();
    },
    enabled: enabled && includeNodes,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.metrics,
    refresh: "metrics",
    ...options?.nodeQueryOptions,
  });

  return {
    podMetrics: podMetricsQuery.data?.data ?? [],
    podStatus: podMetricsQuery.data?.status ?? null,
    nodeMetrics: nodeMetricsQuery.data?.data ?? [],
    nodeStatus: nodeMetricsQuery.data?.status ?? null,
    // When the cluster last answered. The usage history stamps its samples
    // with this rather than with `Date.now()`, so one poll reaching several
    // readers is recognised as one reading instead of several.
    podSampledAt: podMetricsQuery.dataUpdatedAt,
    nodeSampledAt: nodeMetricsQuery.dataUpdatedAt,
    podFreshness: podMetricsQuery.freshness,
    nodeFreshness: nodeMetricsQuery.freshness,
    podMetricsQuery,
    nodeMetricsQuery,
    // Combined loading states for easier consumption
    isLoading: podMetricsQuery.isLoading || nodeMetricsQuery.isLoading,
    isFetching: podMetricsQuery.isFetching || nodeMetricsQuery.isFetching,
    isError: podMetricsQuery.isError || nodeMetricsQuery.isError,
  };
}
