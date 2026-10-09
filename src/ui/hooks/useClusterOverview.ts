import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { listenEvent } from "@/lib/events";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useWindowActivity } from "@/lib/window-activity";
import { normalizeTauriError } from "@/lib/error-utils";
import { ofSameCluster } from "@/lib/previous-answer";
import { queryKeys } from "@/lib/query-keys";
import { useRefusedOn } from "@/lib/refusals";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useClusterStore } from "@/stores/clusterStore";
import type { ClusterOverview } from "@/generated/types";

/**
 * Whether this connection was refused the whole cluster's overview. A
 * reader that only decorates with its counts does not ask again: each ask
 * of a one-namespace token was refused, every ten seconds.
 */
export function useWholeClusterRefused(): boolean {
  const attempt = useClusterStore((s) => s.connectionAttemptId);
  return useRefusedOn(attempt, "getClusterOverview", [null]);
}

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
export function useClusterOverview(scope: readonly string[], enabled = true) {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  return useLiveQuery({
    queryKey: queryKeys.clusterOverview(currentContext, scope),
    queryFn: () => readOverview(scope),
    enabled: isConnected && enabled,
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
    changesAt: (overview) => overview.nextChangeAt,
  });
}

/**
 * The overview of what this window is looking at: one request whatever the
 * scope, answered from the backend's watch-fed stores when they are healthy
 * (`src/tauri/src/overview/mod.rs`) and by listing when they are not. The
 * answer says which in `servedFrom`.
 */
export function useScopedOverview() {
  return useClusterOverview(useClusterStore((s) => s.namespaceScope));
}

/**
 * Whether the overview on screen is read again within a second of a change
 * the backend's watch-fed stores took in its scope, rather than on the
 * ten-second poll alone: Sam's read "41 of 62 pods ready" six seconds after
 * kubectl was back at 40. Only while it is served from those stores, the one
 * read cheap enough to repeat that often, and only while it is seen.
 */
export function useFollowedOverview(
  overview: ClusterOverview | undefined
): boolean {
  const client = useQueryClient();
  const context = useClusterStore((s) => s.currentContext);
  const scope = useClusterStore((s) => s.namespaceScope);
  const surface = useSurfaceVisible();
  const shown = useWindowActivity((s) => s.visible);
  const following =
    surface && shown && !!context && overview?.servedFrom === "watch";
  useEffect(() => {
    if (!following) return;
    const key = queryKeys.clusterOverview(context, scope);
    let left = false;
    let leave: (() => void) | undefined;
    void listenEvent("overview-changed", ({ payload }) => {
      if (payload.context !== context) return;
      const inScope =
        scope.length === 0 ||
        payload.cluster ||
        payload.namespaces.some((namespace) => scope.includes(namespace));
      if (inScope)
        void client.invalidateQueries(
          { queryKey: key, exact: true },
          { cancelRefetch: false }
        );
    }).then((unlisten) => {
      if (left) unlisten();
      else leave = unlisten;
    });
    return () => {
      left = true;
      leave?.();
    };
  }, [following, context, scope, client]);
  return following;
}
