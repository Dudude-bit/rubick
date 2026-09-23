/**
 * Warm the lists every session opens, the moment there is a cluster.
 *
 * Loading is lazy per page, and the first thing anybody does after
 * connecting is open one of the same three screens — which then spends its
 * first second asking a question the app could already have answered. This
 * prefetches into the exact keys those pages read, so they open from cache
 * and revalidate behind the rows; the watches keep the answer warm from
 * there. Once per cluster and namespace scope, not per visit.
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { readOverview } from "@/hooks/useClusterOverview";
import { commands } from "@/lib/commands";
import { listPodRows } from "@/lib/pod-rows";
import { scopeCacheKey, wireScope } from "@/lib/namespace-scope";
import { EVERY_NAMESPACE, queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

export function usePrefetchCoreLists(): void {
  const isConnected = useClusterStore((state) => state.isConnected);
  // The selection, not `currentNamespace`: several namespaces have no wire
  // value, and warming the whole cluster's lists for them read keys no page
  // was on — lists a namespace-scoped token is refused besides.
  const namespaceScope = useClusterStore((state) => state.namespaceScope);
  const context = useClusterStore((state) => state.currentContext);
  const queryClient = useQueryClient();
  const warmed = useRef<string | null>(null);
  const lastContext = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected || context === null) {
      // Between sessions the ref forgets: the next landing must flush and
      // warm again even for the same cluster and scope, because everything
      // asked while disconnected — a probe, a list, a count — was answered
      // by nothing, and "once per scope" kept those answers on screen over
      // the reconnected session.
      warmed.current = null;
      return;
    }
    const key = scopeCacheKey(namespaceScope);
    const scope = `${context}/${key ?? EVERY_NAMESPACE}`;
    if (warmed.current === scope) return;
    warmed.current = scope;

    const switched =
      lastContext.current !== null && lastContext.current !== context;
    lastContext.current = context;

    if (switched) {
      // A resource key does not carry the context — `["pods","default"]` is
      // the same entry in every cluster — so an invalidation leaves the
      // cluster just left on screen until the refetch answers, and where the
      // new one refuses the read it never answers. Same trade as
      // `useScopeTabs` makes for a parked tab.
      queryClient.removeQueries();
    } else {
      // Everything asked before this connection stood was answered by
      // nothing — a restored route fires its list the moment it mounts,
      // caches the error, and sat on "No cluster connected" over a
      // connected cluster. A connection landing is the one moment every
      // cached answer is stale.
      void queryClient.invalidateQueries();
    }

    const wire = wireScope(namespaceScope);

    // The landing page's own read, and the most expensive one in the app —
    // it was the only first-screen query NOT warmed here, so Overview spent
    // its first second asking what the connect beat could already have
    // started. Same key as `useClusterOverview`, so the page mounts onto an
    // answer already in flight.
    void queryClient.prefetchQuery({
      queryKey: queryKeys.clusterOverview(context, namespaceScope),
      queryFn: () => readOverview(namespaceScope),
      staleTime: STALE_TIMES.overview,
    });

    void queryClient.prefetchQuery({
      queryKey: queryKeys.podRows(key),
      queryFn: ({ signal }) => listPodRows(wire, signal),
      staleTime: STALE_TIMES.resourceList,
    });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.resources(ResourceType.Deployment, key),
      queryFn: () => commands.listDeploymentsIn(wire),
      staleTime: STALE_TIMES.resourceList,
    });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.resources(ResourceType.Service, key),
      queryFn: () => commands.listServicesIn(wire),
      staleTime: STALE_TIMES.resourceList,
    });
  }, [isConnected, context, namespaceScope, queryClient]);
}
