import { useCallback, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useToast } from "@/components/ui/use-toast";
import { normalizeTauriError } from "@/lib/error-utils";
import { useMetrics } from "@/hooks/useMetrics";
import { mergePodsWithMetrics, type PodWithMetrics } from "@/lib/metrics";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
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
    dataUpdatedAt,
  } = useQuery({
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
    refetchInterval: watchFailed ? REFRESH_INTERVALS.resourceList : false,
    refetchOnWindowFocus: false,
  });

  const subscribePods = useCallback(
    () => commands.subscribePodWatch(currentNamespace || null),
    [currentNamespace]
  );
  useResourceWatch<PodInfo>({
    enabled,
    subscribe: subscribePods,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const {
    podMetrics,
    podStatus,
    podMetricsQuery: { isLoading: isLoadingMetrics },
  } = useMetrics({
    namespace: currentNamespace || null,
    enabled,
    includeNodes: false,
    includeCluster: false,
  });

  // Merge pods with their metrics - memoized for performance
  const podsWithMetrics = useMemo<PodWithMetrics[]>(() => {
    return mergePodsWithMetrics(pods, podMetrics);
  }, [pods, podMetrics]);

  return {
    data: podsWithMetrics,
    pods,
    podMetrics,
    podStatus,
    isLoading: isLoadingPods || isLoadingMetrics,
    dataUpdatedAt,
    /** The pod watch is subscribed and has not fallen back to polling. */
    watchLive: !watchFailed,
  };
}
