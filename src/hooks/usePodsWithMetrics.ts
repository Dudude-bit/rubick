import { useCallback, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useToast } from "@/components/ui/use-toast";
import { normalizeTauriError } from "@/lib/error-utils";
import { useMetrics } from "@/hooks/useMetrics";
import { mergePodsWithMetrics, type PodWithMetrics } from "@/lib/metrics";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { withNodeSilence, type WithNodeSilence } from "@/lib/node-reporting";
import { queryKeys } from "@/lib/query-keys";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import type { PodInfo } from "@/generated/types";

export type { PodWithMetrics } from "@/lib/metrics";

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
  const { isConnected, currentNamespace } = useClusterStore();
  const enabled = isConnected && options?.enabled !== false;

  // Fetch pods - cached by TanStack Query. Real-time updates after
  // the initial fetch arrive through `useResourceWatch` below.
  // Polling falls back on if the watcher reports a sustained failure
  // (e.g. RBAC `watch` denial); see handleWatchError below.
  const queryKey = useMemo(
    () => queryKeys.pods(currentNamespace),
    [currentNamespace]
  );

  const { toast } = useToast();
  const [watchFailed, setWatchFailed] = useState(false);
  const handleWatchError = useCallback(
    (err: string) => {
      if (watchFailed) return;
      setWatchFailed(true);
      toast({
        title: "Real-time updates unavailable",
        description: `Pods: falling back to periodic refresh. ${err}`,
      });
    },
    [toast, watchFailed]
  );

  const {
    data: pods = [],
    isLoading: isLoadingPods,
    error: podsError,
    dataUpdatedAt,
  } = useLiveQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await commands.listPods({
          namespace: currentNamespace || null,
          labelSelector: null,
          fieldSelector: null,
          limit: null,
          statusFilter: null,
          selector: null,
          nodeName: null,
        });
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: watchFailed ? "resourceList" : false,
  });

  const subscribePods = useCallback(
    () => commands.subscribePodWatch(currentNamespace || null),
    [currentNamespace]
  );
  const { resyncing } = useResourceWatch<PodInfo>({
    enabled,
    subscribe: subscribePods,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const { podMetrics, podStatus } = useMetrics({
    namespace: currentNamespace || null,
    enabled,
    includeNodes: false,
  });

  // Which nodes stopped reporting. A pod on one of them is describing a
  // moment that has passed, and nothing in the pod object says so.
  const silent = useSilentNodes(enabled);

  // Merge pods with their metrics - memoized for performance
  const podsWithMetrics = useMemo<WithNodeSilence<PodWithMetrics>[]>(() => {
    return withNodeSilence(mergePodsWithMetrics(pods, podMetrics), silent);
  }, [pods, podMetrics, silent]);

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
    dataUpdatedAt,
    /** The pod watch is subscribed and has not fallen back to polling. */
    watchLive: !watchFailed,
    /** It is re-listing: the pods here are the ones from before it started. */
    resyncing,
  };
}
