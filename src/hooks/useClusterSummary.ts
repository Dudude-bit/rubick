import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useClusterOverview } from "@/hooks/useClusterOverview";
import { commands } from "@/lib/commands";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";

export interface NamespaceScope {
  name: string;
  podCount: number;
  /** Problems the backend attributed to this namespace, cluster-wide. */
  problemCount: number;
}

export interface ClusterSummary {
  podCount: number;
  problemCount: number;
  /** Problems the backend dropped from its ranked list, if any. */
  problemsTruncated: number;
  namespaces: NamespaceScope[];
  isLoading: boolean;
}

/**
 * Cluster-wide counts for the window chrome — the namespace picker and
 * the status bar.
 *
 * Deliberately unscoped: the picker exists to leave the current
 * namespace, so counting only inside it would show every other row as
 * empty. The query key matches the overview page's key when the window
 * is already on "all namespaces", so the common case costs one request.
 */
export function useClusterSummary(): ClusterSummary {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  const { data: overview, isLoading: overviewLoading } =
    useClusterOverview(null);

  const { data: namespaceInfos, isLoading: namespacesLoading } = useQuery({
    queryKey: ["namespaces", currentContext],
    queryFn: () => commands.listNamespaces(),
    enabled: isConnected,
    staleTime: STALE_TIMES.slow,
    placeholderData: keepPreviousData,
  });

  return useMemo(() => {
    const pods = new Map(
      (overview?.namespaces ?? []).map((ns) => [ns.name, ns.podCount])
    );
    const problems = new Map<string, number>();
    for (const problem of overview?.problems ?? []) {
      if (!problem.namespace) continue;
      problems.set(
        problem.namespace,
        (problems.get(problem.namespace) ?? 0) + 1
      );
    }

    // listNamespaces is the authority on what exists — the overview only
    // reports namespaces that hold pods. It can still fail on a token
    // without cluster-wide list rights, hence the fallback.
    const names =
      namespaceInfos?.map((ns) => ns.name) ?? [...pods.keys()].sort();

    const namespaces = names
      .map((name) => ({
        name,
        podCount: pods.get(name) ?? 0,
        problemCount: problems.get(name) ?? 0,
      }))
      .sort(
        (a, b) =>
          b.problemCount - a.problemCount ||
          b.podCount - a.podCount ||
          a.name.localeCompare(b.name)
      );

    return {
      podCount: overview?.counts.pods ?? 0,
      problemCount: overview?.problems.length ?? 0,
      problemsTruncated: overview?.problemsTruncated ?? 0,
      namespaces,
      isLoading: overviewLoading || namespacesLoading,
    };
  }, [overview, namespaceInfos, overviewLoading, namespacesLoading]);
}
