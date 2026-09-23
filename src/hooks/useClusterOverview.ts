import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { ofSameCluster } from "@/lib/previous-answer";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useClusterStore } from "@/stores/clusterStore";
import type { ClusterOverview } from "@/generated/types";

/**
 * One overview for `scope`, as the store spells it: empty is the whole
 * cluster. The backend adds several namespaces up itself, reading what is
 * the cluster's once, and refuses an empty list rather than widening it, so
 * "every namespace" is the one value sent as `null`.
 */
export async function readOverview(
  scope: readonly string[]
): Promise<ClusterOverview> {
  try {
    return await commands.getClusterOverview(
      scope.length > 0 ? [...scope] : null
    );
  } catch (err) {
    throw new Error(normalizeTauriError(err), { cause: err });
  }
}

/**
 * The cluster overview query, shared by everything that reads it.
 *
 * The scope is the cache key, so the sidebar counts, the overview page and
 * the window chrome all read one response per scope rather than issuing the
 * same request three times every ten seconds.
 *
 * `scope` is the namespaces to ask about, empty for the whole cluster. It is
 * a scope somebody names, not the window's — the namespace picker wants every
 * namespace's pod count however narrowly the window is scoped, which is why
 * this hook does not read the selection itself. {@link useScopedOverview} is
 * the one that follows it.
 */
export function useClusterOverview(scope: readonly string[]) {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  return useLiveQuery({
    queryKey: queryKeys.clusterOverview(currentContext, scope),
    queryFn: () => readOverview(scope),
    enabled: isConnected,
    staleTime: STALE_TIMES.overview,
    // Previous, but only of this cluster: `keepPreviousData` answered the
    // new context's key with the old context's totals, which is how the rail
    // kept `Pods 51` beside a cluster that refuses to list pods. And not
    // into a scope of several namespaces: those are the old selection's
    // totals under the new selection's label, and the skeleton is one read
    // away.
    placeholderData:
      scope.length > 1
        ? undefined
        : ofSameCluster<ClusterOverview>(currentContext),
    refresh: "overview",
  });
}

/**
 * The overview of what this window is looking at: one request whatever the
 * scope, answered from the backend's watch-fed stores when they are healthy
 * (`src-tauri/src/overview/mod.rs`) and by listing when they are not. The
 * answer says which in `servedFrom`.
 */
export function useScopedOverview() {
  return useClusterOverview(useClusterStore((s) => s.namespaceScope));
}
