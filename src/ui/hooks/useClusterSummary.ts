import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useClusterOverview } from "@/hooks/useClusterOverview";
import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";

export interface NamespaceScope {
  name: string;
  /** `null` when the cluster-wide overview was refused or failed — the count
   *  is unknown, not zero. */
  podCount: number | null;
  /** Problems the backend attributed to this namespace, counted before its
   *  list was capped. `null` when the overview could not be read. */
  problemCount: number | null;
}

/** Whether the namespace list was read, and if not, why not. */
export type NamespaceListState = "pending" | "listed" | "refused" | "failed";

export interface ClusterSummary {
  /** `null` when the cluster-wide overview was refused or failed. The chrome
   *  shows "—", not "0", so a token without cluster read rights is never told
   *  its cluster is empty and healthy. */
  podCount: number | null;
  namespaces: NamespaceScope[];
  /** A refused list is not an empty cluster: the picker then takes a name. */
  namespaceList: NamespaceListState;
  isLoading: boolean;
}

/** The cluster's namespaces, and whether the list could be read at all. */
export function useNamespaceList() {
  const isConnected = useClusterStore((s) => s.isConnected);
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.namespaces(),
    queryFn: () => commands.listNamespaces(),
    enabled: isConnected,
    staleTime: STALE_TIMES.slow,
    placeholderData: keepPreviousData,
  });
  const state: NamespaceListState = data
    ? "listed"
    : error
      ? isRefusal(error)
        ? "refused"
        : "failed"
      : "pending";
  return { data, state, isLoading };
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
const WHOLE_CLUSTER: readonly string[] = [];

export function useClusterSummary(): ClusterSummary {
  const { data: overview, isLoading: overviewLoading } =
    useClusterOverview(WHOLE_CLUSTER);

  const {
    data: namespaceInfos,
    state: namespaceList,
    isLoading: namespacesLoading,
  } = useNamespaceList();

  return useMemo(() => {
    // The overview carries the counts; when it was refused or failed there is
    // no count to state, and a `0` there would tell a namespace-scoped user
    // their cluster is empty and healthy. `known` is what keeps that honest.
    const known = overview !== undefined;
    // Counted in Rust before the problem list is cut to fifty; counting the
    // list here read "0" for any namespace whose problems the cut dropped.
    const loads = new Map(
      (overview?.namespaces ?? []).map((ns) => [ns.name, ns])
    );

    // listNamespaces is the authority on what exists — the overview only
    // reports namespaces that hold pods. It can still fail on a token
    // without cluster-wide list rights, hence the fallback.
    const names =
      namespaceInfos?.map((ns) => ns.name) ?? [...loads.keys()].sort();

    const namespaces = names
      .map((name) => ({
        name,
        podCount: known ? (loads.get(name)?.podCount ?? 0) : null,
        problemCount: known ? (loads.get(name)?.problemCount ?? 0) : null,
      }))
      .sort(
        (a, b) =>
          (b.problemCount ?? 0) - (a.problemCount ?? 0) ||
          (b.podCount ?? 0) - (a.podCount ?? 0) ||
          a.name.localeCompare(b.name)
      );

    return {
      podCount: overview ? overview.counts.pods : null,
      namespaces,
      namespaceList,
      isLoading: overviewLoading || namespacesLoading,
    };
  }, [
    overview,
    namespaceInfos,
    namespaceList,
    overviewLoading,
    namespacesLoading,
  ]);
}
