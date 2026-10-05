import { useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type {
  PodMetricsResponse,
  NodeMetricsResponse,
  UnreadNamespace,
} from "@/generated/types";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { isUnserved } from "@/lib/metrics-absence";
import { queryKeys } from "@/lib/query-keys";
import { scopeCacheKey, wireScope } from "@/lib/namespace-scope";
import { useLiveQuery, type LiveQueryOptions } from "@/hooks/useLiveQuery";

const NOTHING_UNREAD: UnreadNamespace[] = [];

type MetricsQueryOptions<T> = Omit<
  LiveQueryOptions<T, Error, T, string[]>,
  "queryKey" | "queryFn"
>;

export interface UseMetricsOptions {
  namespace?: string | null;
  /** A selection of namespaces, read one at a time; wins over `namespace`. */
  scope?: readonly string[];
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

  const scope = options?.scope;
  const [podsUnserved, setPodsUnserved] = useState(false);
  const [nodesUnserved, setNodesUnserved] = useState(false);
  const podMetricsQuery = useLiveQuery({
    queryKey: queryKeys.metrics.pods(
      scope ? scopeCacheKey(scope) : options?.namespace
    ),
    queryFn: async () =>
      scope
        ? await commands.getPodsMetricsIn(wireScope(scope))
        : await commands.getPodsMetrics(options?.namespace ?? null),
    enabled: enabled && includePods,
    placeholderData: keepPreviousData,
    staleTime: podsUnserved ? REFRESH_INTERVALS.unserved : STALE_TIMES.metrics,
    refresh: podsUnserved ? "unserved" : "metrics",
    ...options?.podQueryOptions,
  });

  const nodeMetricsQuery = useLiveQuery({
    queryKey: queryKeys.metrics.nodes(),
    queryFn: async () => {
      return await commands.getNodesMetrics();
    },
    enabled: enabled && includeNodes,
    placeholderData: keepPreviousData,
    staleTime: nodesUnserved ? REFRESH_INTERVALS.unserved : STALE_TIMES.metrics,
    refresh: nodesUnserved ? "unserved" : "metrics",
    ...options?.nodeQueryOptions,
  });

  // The rate is chosen before the answer it depends on is read, so a changed
  // answer re-renders once with the rate that fits it.
  const podsNow = isUnserved(podMetricsQuery.data?.status);
  const nodesNow = isUnserved(nodeMetricsQuery.data?.status);
  if (podsNow !== podsUnserved) setPodsUnserved(podsNow);
  if (nodesNow !== nodesUnserved) setNodesUnserved(nodesNow);

  return {
    podMetrics: podMetricsQuery.data?.data ?? [],
    podStatus: podMetricsQuery.data?.status ?? null,
    // The last scope's unread namespaces are not this one's.
    podUnread: podMetricsQuery.isPlaceholderData
      ? NOTHING_UNREAD
      : (podMetricsQuery.data?.unread ?? NOTHING_UNREAD),
    refetchPodMetrics: podMetricsQuery.refetch,
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
