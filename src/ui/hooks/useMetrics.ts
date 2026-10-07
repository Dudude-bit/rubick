import { useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type {
  MetricsStatus,
  NodeMetrics,
  PodMetrics,
  PodMetricsResponse,
  NodeMetricsResponse,
  UnreadNamespace,
} from "@/generated/types";
import {
  REFRESH_INTERVALS,
  STALE_TIMES,
  type RefreshRate,
} from "@/lib/refresh";
import { absenceOf, isUnserved } from "@/lib/metrics-absence";
import { queryKeys } from "@/lib/query-keys";
import { scopeCacheKey, wireScope } from "@/lib/namespace-scope";
import { useLiveQuery, type LiveQueryOptions } from "@/hooks/useLiveQuery";

const NOTHING_UNREAD: UnreadNamespace[] = [];
const NO_POD_METRICS: PodMetrics[] = [];
const NO_NODE_METRICS: NodeMetrics[] = [];

/**
 * An error is not a sample, so it is not held to the recording's cadence:
 * a cluster answering 502 was asked every two seconds for as long as it was down.
 */
function rateFor(status: MetricsStatus | null | undefined): RefreshRate {
  if (isUnserved(status)) return "unserved";
  return absenceOf(status) === "error" ? "metricsFailing" : "metrics";
}

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

/**
 * Read off the cached answer, not off this mount's state: a page opened on an
 * unserved answer already in the cache must not ask for it again.
 */
const staleFor = (query: {
  state: { data?: { status: MetricsStatus | null } };
}) =>
  isUnserved(query.state.data?.status)
    ? REFRESH_INTERVALS.unserved
    : STALE_TIMES.metrics;

export function useMetrics(options?: UseMetricsOptions) {
  const enabled = options?.enabled ?? true;
  const includePods = options?.includePods ?? true;
  const includeNodes = options?.includeNodes ?? true;

  const scope = options?.scope;
  const [podsRate, setPodsRate] = useState<RefreshRate>("metrics");
  const [nodesRate, setNodesRate] = useState<RefreshRate>("metrics");
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
    staleTime: staleFor,
    refresh: podsRate,
    ...options?.podQueryOptions,
  });

  const nodeMetricsQuery = useLiveQuery({
    queryKey: queryKeys.metrics.nodes(),
    queryFn: async () => {
      return await commands.getNodesMetrics();
    },
    enabled: enabled && includeNodes,
    placeholderData: keepPreviousData,
    staleTime: staleFor,
    refresh: nodesRate,
    ...options?.nodeQueryOptions,
  });

  // The rate is chosen before the answer it depends on is read, so a changed
  // answer re-renders once with the rate that fits it.
  const podsNow = rateFor(podMetricsQuery.data?.status);
  const nodesNow = rateFor(nodeMetricsQuery.data?.status);
  if (podsNow !== podsRate) setPodsRate(podsNow);
  if (nodesNow !== nodesRate) setNodesRate(nodesNow);

  return {
    podMetrics: podMetricsQuery.data?.data ?? NO_POD_METRICS,
    podStatus: podMetricsQuery.data?.status ?? null,
    // The last scope's unread namespaces are not this one's.
    podUnread: podMetricsQuery.isPlaceholderData
      ? NOTHING_UNREAD
      : (podMetricsQuery.data?.unread ?? NOTHING_UNREAD),
    refetchPodMetrics: podMetricsQuery.refetch,
    nodeMetrics: nodeMetricsQuery.data?.data ?? NO_NODE_METRICS,
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
  };
}
