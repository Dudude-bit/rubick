import type { QueryClient } from "@tanstack/react-query";
import type { ResourceCounts, Scoped } from "@/generated/types";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { readOverview } from "@/hooks/useClusterOverview";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";

const COUNT_KEY: Partial<Record<ResourceKind, keyof ResourceCounts>> = {
  [ResourceType.Event]: "events",
  [ResourceType.Pod]: "pods",
  [ResourceType.Deployment]: "deployments",
  [ResourceType.StatefulSet]: "statefulSets",
  [ResourceType.DaemonSet]: "daemonSets",
  [ResourceType.Job]: "jobs",
  [ResourceType.CronJob]: "cronJobs",
  [ResourceType.Node]: "nodes",
  [ResourceType.Namespace]: "namespaces",
  [ResourceType.Service]: "services",
  [ResourceType.Endpoints]: "endpoints",
  [ResourceType.Ingress]: "ingresses",
  [ResourceType.NetworkPolicy]: "networkPolicies",
  [ResourceType.PersistentVolumeClaim]: "persistentVolumeClaims",
  [ResourceType.ConfigMap]: "configMaps",
  [ResourceType.Secret]: "secrets",
};

/** The row count of the newest list of this kind the cache holds, in whatever scope it was read. */
function lastAnsweredCount(
  queryClient: QueryClient,
  kind: ResourceKind | null | undefined
): number | null {
  if (!kind) return null;
  let newest = 0;
  let count: number | null = null;
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.lists(kind) })) {
    const rows = (query.state.data as Scoped<unknown> | undefined)?.rows;
    if (Array.isArray(rows) && query.state.dataUpdatedAt > newest) {
      newest = query.state.dataUpdatedAt;
      count = rows.length;
    }
  }
  return count;
}

/** The count the sidebar holds for this list's kind, else the last list of it that was read; never asked for here. */
export function useKnownCount(kind: ResourceKind | null | undefined) {
  const queryClient = useQueryClient();
  const context = useClusterStore((s) => s.currentContext);
  const scope = useClusterStore((s) => s.namespaceScope);
  const key = kind ? COUNT_KEY[kind] : undefined;
  const { data } = useQuery({
    queryKey: queryKeys.clusterOverview(context, scope),
    queryFn: () => readOverview(scope),
    enabled: false,
    select: (overview) => (key ? overview.counts[key] : null),
  });
  return data ?? lastAnsweredCount(queryClient, kind);
}

/**
 * When the sidebar's count of this kind in the window's scope last answered,
 * or `null` where it has not: a read of the same list that came back.
 */
export function useCountedAt(kind: ResourceKind | null | undefined) {
  const context = useClusterStore((s) => s.currentContext);
  const scope = useClusterStore((s) => s.namespaceScope);
  const key = kind ? COUNT_KEY[kind] : undefined;
  const { data: counted, dataUpdatedAt } = useQuery({
    queryKey: queryKeys.clusterOverview(context, scope),
    queryFn: () => readOverview(scope),
    enabled: false,
    select: (overview) => key !== undefined && overview.counts[key] !== null,
  });
  return counted ? dataUpdatedAt : null;
}
