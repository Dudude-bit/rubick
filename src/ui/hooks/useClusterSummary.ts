import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useAttention } from "@/hooks/useAttention";
import {
  useClusterOverview,
  useWholeClusterRefused,
} from "@/hooks/useClusterOverview";
import { namespaceAttention, type NamespaceAttention } from "@/lib/attention";
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
  /** What this namespace's Overview counts under Needs attention. `null`
   *  when it was not asked, or could not be read. */
  problems: NamespaceAttention | null;
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
 * own overview instead. `problems` asks for Needs attention as well, which
 * reads four more lists across the cluster: only the picker shows it.
 */
const WHOLE_CLUSTER: readonly string[] = [];

export function useClusterSummary({
  enabled = true,
  problems = false,
}: { enabled?: boolean; problems?: boolean } = {}): ClusterSummary {
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
  const wholeAttention = useAttention({
    scope: WHOLE_CLUSTER,
    enabled: problems && enabled && namespaceList !== "pending" && !refused,
  });
  const ownAttention = useAttention({
    enabled: problems && enabled && alone !== null,
  });

  return useMemo(() => {
    // The overview carries the counts; when it was refused or failed there is
    // no count to state, and a `0` there would tell a namespace-scoped user
    // their cluster is empty and healthy. `known` is what keeps that honest.
    const known = overview !== undefined;
    // An answer whose pods were refused somewhere has no breakdown to read.
    const podsKnown = known && overview.counts.pods !== null;
    const pods = new Map(
      (podsKnown ? overview.namespaces : []).map((ns) => [ns.name, ns.podCount])
    );
    if (!known && alone && own?.counts.pods != null)
      pods.set(alone[0], own.counts.pods);
    // The Overview's own count, so the picker never says a third number.
    const problemsOf = (name: string): NamespaceAttention | null => {
      if (known)
        return wholeAttention && namespaceAttention(wholeAttention, name);
      if (alone?.[0] !== name || !ownAttention) return null;
      const { total, complete, worst } = ownAttention;
      return { total, complete, worst };
    };

    // listNamespaces is the authority on what exists — the overview only
    // reports namespaces that hold pods. It can still fail on a token
    // without cluster-wide list rights, hence the fallback.
    const names =
      namespaceInfos?.map((ns) => ns.name) ?? [...pods.keys()].sort();

    const namespaces = names
      .map((name) => ({
        name,
        podCount: pods.get(name) ?? (podsKnown ? 0 : null),
        problems: problemsOf(name),
      }))
      .sort(
        (a, b) =>
          (b.problems?.total ?? 0) - (a.problems?.total ?? 0) ||
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
    wholeAttention,
    ownAttention,
    namespaceInfos,
    namespaceList,
    refused,
    overviewLoading,
    namespacesLoading,
  ]);
}
