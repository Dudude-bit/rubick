import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  useClusterOverview,
  useWholeClusterRefused,
} from "@/hooks/useClusterOverview";
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
  /** The whole cluster's counts were refused on this connection, and are not asked again. */
  refused: boolean;
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
 * `enabled` is whether anyone is reading the counts: the picker is mounted
 * on every screen, and while it was shut it asked a namespace-only token
 * for the whole cluster every ten seconds, and was refused every time.
 * Nor is the whole cluster asked once it refused this connection, or once
 * the namespace list did; the window's own namespace is counted from its
 * own overview instead.
 */
const WHOLE_CLUSTER: readonly string[] = [];

export function useClusterSummary(enabled = true): ClusterSummary {
  const {
    data: namespaceInfos,
    state: namespaceList,
    isLoading: namespacesLoading,
  } = useNamespaceList();
  const refused = useWholeClusterRefused() || namespaceList === "refused";

  const { data: whole, isLoading: overviewLoading } = useClusterOverview(
    WHOLE_CLUSTER,
    enabled && namespaceList !== "pending" && !refused
  );
  const overview = refused ? undefined : whole;

  const windowScope = useClusterStore((s) => s.namespaceScope);
  const alone = refused && windowScope.length === 1 ? windowScope : null;
  const { data: own } = useClusterOverview(
    alone ?? WHOLE_CLUSTER,
    enabled && alone !== null
  );

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
    const counted = new Map(loads);
    if (!known && alone && own?.counts.pods != null)
      counted.set(alone[0], {
        name: alone[0],
        podCount: own.counts.pods,
        problemCount: own.problems.length + own.problemsTruncated,
      });

    // listNamespaces is the authority on what exists — the overview only
    // reports namespaces that hold pods. It can still fail on a token
    // without cluster-wide list rights, hence the fallback.
    const names =
      namespaceInfos?.map((ns) => ns.name) ?? [...loads.keys()].sort();

    const namespaces = names
      .map((name) => ({
        name,
        podCount: counted.get(name)?.podCount ?? (known ? 0 : null),
        problemCount: counted.get(name)?.problemCount ?? (known ? 0 : null),
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
      refused,
      isLoading: overviewLoading || namespacesLoading,
    };
  }, [
    overview,
    alone,
    own,
    namespaceInfos,
    namespaceList,
    refused,
    overviewLoading,
    namespacesLoading,
  ]);
}
