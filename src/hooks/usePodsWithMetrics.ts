import { useCallback, useMemo } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { normalizeTauriError } from "@/lib/error-utils";
import { useMetrics } from "@/hooks/useMetrics";
import { mergePodsWithMetrics, type PodWithMetrics } from "@/lib/metrics";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { keepWatched, scopeCacheKey } from "@/lib/namespace-scope";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { withNodeSilence, type WithNodeSilence } from "@/lib/node-reporting";
import { queryKeys } from "@/lib/query-keys";
import { useWatchedList } from "@/hooks/useWatchedList";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { listPodRows, type PodRow } from "@/lib/pod-rows";
import type { UnreadNamespace } from "@/generated/types";

export type { PodWithMetrics } from "@/lib/metrics";

const EMPTY_PODS: PodRow[] = [];
const NOTHING_UNREAD: UnreadNamespace[] = [];

interface UsePodsWithMetricsOptions {
  /** Whether the query should be enabled (default: true when connected) */
  enabled?: boolean;
}

/**
 * Centralized hook for fetching pods with their metrics.
 * This hook is shared across components to avoid duplicate queries.
 *
 * TanStack Query handles caching, so multiple components using this hook
 * with the same namespace will share the cached data.
 */
export function usePodsWithMetrics(options?: UsePodsWithMetricsOptions) {
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useNamespaceScope();
  const enabled = isConnected && options?.enabled !== false;

  // The one namespace the metrics call is scoped to; several read it all.
  const metricsNamespace = scope.scope.length === 1 ? scope.scope[0] : null;
  const cacheKey = scopeCacheKey(scope.scope);

  // Fetch pods - cached by TanStack Query. Real-time updates after
  // the initial fetch arrive through `useResourceWatch` below.
  // Polling falls back on if the watcher reports a sustained failure
  // (e.g. RBAC `watch` denial); see handleWatchError below.
  const queryKey = useMemo(() => queryKeys.podRows(cacheKey), [cacheKey]);

  const subscribePods = useCallback(
    () => commands.subscribePodRowWatch(scope.wire),
    [scope.wire]
  );
  const { live, refresh, resyncing } = useWatchedList<PodRow>({
    enabled,
    subscribe: subscribePods,
    queryKey,
    reportFailure: toPlural(ResourceType.Pod),
  });

  const queryClient = useQueryClient();
  const {
    data: answer,
    isPlaceholderData,
    isLoading: isLoadingPods,
    error: podsError,
    dataUpdatedAt,
    freshness,
    refetch,
  } = useLiveQuery({
    queryKey,
    // Rows, streamed in chunks, rather than `listPods` in one answer: the
    // full pod is three kilobytes a row and the table reads a dozen fields.
    // The signal stops a stream the screen has stopped waiting for.
    queryFn: async ({ signal }) => {
      const wire = scope.wire;
      try {
        const read = await listPodRows(wire, signal);
        return live
          ? keepWatched(read, queryClient.getQueryData(queryKey))
          : read;
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh,
  });

  const pods = answer?.rows ?? EMPTY_PODS;
  // The last scope's answer stands in while this one is read, and its unread
  // namespaces are not this scope's.
  const unread = isPlaceholderData
    ? NOTHING_UNREAD
    : (answer?.unread ?? NOTHING_UNREAD);

  const { podMetrics, podStatus } = useMetrics({
    namespace: metricsNamespace,
    enabled,
    includeNodes: false,
  });

  // Which nodes stopped reporting. A pod on one of them is describing a
  // moment that has passed, and nothing in the pod object says so.
  const silent = useSilentNodes(enabled);

  const mergedPods = useMemo(
    () => mergePodsWithMetrics(pods, podMetrics),
    [pods, podMetrics]
  );
  const podsWithMetrics = useMemo<WithNodeSilence<PodWithMetrics>[]>(
    () => withNodeSilence(mergedPods, silent),
    [mergedPods, silent]
  );

  return {
    data: podsWithMetrics,
    pods,
    podMetrics,
    podStatus,
    // The pods, and only the pods. Metrics are an optional column pair on a
    // cluster that may not even run metrics-server, and waiting for them held
    // the whole list behind a skeleton on every cluster that does: the rows
    // arrive, CPU and Memory fill in behind them, and a cluster without the
    // API says so in its own banner instead of stalling the page.
    isLoading: isLoadingPods,
    /** Why there are no pods, when there are none because the read failed. */
    error: podsError,
    /** The namespaces of the scope whose pods could not be read. */
    unread,
    dataUpdatedAt,
    /** The pod watch is subscribed and has not fallen back to polling. */
    watchLive: live,
    /** It is re-listing: the pods here are the ones from before it started. */
    resyncing,
    /** When a read with nothing to show began, for the list to say so. */
    waitingSince: freshness.waitingSince,
    /** Ask again — the list's own Retry, which does not own this read. */
    refetch,
  };
}
