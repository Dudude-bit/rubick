import type { ResourceCounts } from "@/generated/types";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import { useQuery } from "@tanstack/react-query";

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

/** The count the sidebar holds for this list's kind, read from the answer it keeps and never asked for here. */
export function useKnownCount(kind: ResourceKind | null | undefined) {
  const context = useClusterStore((s) => s.currentContext);
  const scope = useClusterStore((s) => s.namespaceScope);
  const key = kind ? COUNT_KEY[kind] : undefined;
  const { data } = useQuery({
    queryKey: queryKeys.clusterOverview(context, scope),
    queryFn: () => readOverview(scope),
    enabled: false,
    select: (overview) => (key ? overview.counts[key] : null),
  });
  return data ?? null;
}
