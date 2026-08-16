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

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

export function usePrefetchCoreLists(): void {
  const isConnected = useClusterStore((state) => state.isConnected);
  const currentNamespace = useClusterStore((state) => state.currentNamespace);
  const context = useClusterStore((state) => state.currentContext);
  const queryClient = useQueryClient();
  const warmed = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected || context === null) return;
    const scope = `${context}/${currentNamespace || "all"}`;
    if (warmed.current === scope) return;
    warmed.current = scope;

    // Everything asked before this connection stood was answered by nothing
    // — a restored route fires its list the moment it mounts, caches the
    // error, and sat on "No cluster connected" over a connected cluster.
    // A connection landing is the one moment every cached answer is stale.
    void queryClient.invalidateQueries();

    const namespace = currentNamespace || null;
    const base = { labelSelector: null, fieldSelector: null, limit: null };

    void queryClient.prefetchQuery({
      queryKey: queryKeys.pods(namespace),
      queryFn: () =>
        commands.listPods({
          namespace,
          statusFilter: null,
          selector: null,
          nodeName: null,
          ...base,
        }),
      staleTime: STALE_TIMES.resourceList,
    });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.resources(ResourceType.Deployment, namespace),
      queryFn: () => commands.listDeployments({ namespace, ...base }),
      staleTime: STALE_TIMES.resourceList,
    });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.resources(ResourceType.Service, namespace),
      queryFn: () =>
        commands.listServices({ namespace, serviceType: null, ...base }),
      staleTime: STALE_TIMES.resourceList,
    });
  }, [isConnected, context, currentNamespace, queryClient]);
}
