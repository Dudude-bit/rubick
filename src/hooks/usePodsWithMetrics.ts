import { useT } from "@/i18n/useT";
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
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { listAcrossScope, scopeCacheKey } from "@/lib/namespace-scope";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { withNodeSilence, type WithNodeSilence } from "@/lib/node-reporting";
import { queryKeys } from "@/lib/query-keys";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { listPodRows, type PodRow } from "@/lib/pod-rows";

export type { PodWithMetrics } from "@/lib/metrics";

const EMPTY_PODS: PodRow[] = [];

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
  const t = useT();
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useNamespaceScope();
  const enabled = isConnected && options?.enabled !== false;

  // The one namespace a watch or metrics call is scoped to. Several is read
  // per namespace and polled instead — a cluster-wide LIST needs rights a
  // namespace-scoped user may not have. See `listAcrossScope`.
  const watchNamespace = scope.scope.length === 1 ? scope.scope[0] : null;
  const cacheKey = scopeCacheKey(scope.scope);

  // Fetch pods - cached by TanStack Query. Real-time updates after
  // the initial fetch arrive through `useResourceWatch` below.
  // Polling falls back on if the watcher reports a sustained failure
  // (e.g. RBAC `watch` denial); see handleWatchError below.
  const queryKey = useMemo(() => queryKeys.podRows(cacheKey), [cacheKey]);

  const { toast } = useToast();
  const [watchFailed, setWatchFailed] = useState(false);
  const handleWatchError = useCallback(
    (err: string) => {
      if (watchFailed) return;
      setWatchFailed(true);
      toast({
        title: t("action", "realtimeUnavailable"),
        description: t("action", "fallingBackToPolling", {
          title: "Pods",
          error: err,
        }),
      });
    },
    [toast, watchFailed, t]
  );

  const {
    data: pods = EMPTY_PODS,
    isLoading: isLoadingPods,
    error: podsError,
    dataUpdatedAt,
  } = useLiveQuery({
    queryKey,
    // Rows, streamed in chunks, rather than `listPods` in one answer: the
    // full pod is three kilobytes a row and the table reads a dozen fields.
    // The signal stops a stream the screen has stopped waiting for.
    queryFn: ({ signal }) =>
      listAcrossScope(scope.scope, async (namespace) => {
        try {
          return await listPodRows(namespace, signal);
        } catch (err) {
          throw new Error(normalizeTauriError(err), { cause: err });
        }
      })(),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    // A watch covers none or one; several is polled (the watch is off below).
    refresh: watchFailed || scope.several ? "resourceList" : false,
  });

  const subscribePods = useCallback(
    () => commands.subscribePodRowWatch(watchNamespace),
    [watchNamespace]
  );
  const { resyncing } = useResourceWatch<PodRow>({
    enabled: enabled && !scope.several,
    subscribe: subscribePods,
    queryKey,
    onError: handleWatchError,
    onRecovered: useCallback(() => setWatchFailed(false), []),
  });

  const { podMetrics, podStatus } = useMetrics({
    namespace: watchNamespace,
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
    dataUpdatedAt,
    /** The pod watch is subscribed and has not fallen back to polling. */
    watchLive: !watchFailed,
    /** It is re-listing: the pods here are the ones from before it started. */
    resyncing,
  };
}
