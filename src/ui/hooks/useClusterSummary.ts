import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAttention } from "@/hooks/useAttention";
import {
  useClusterOverview,
  useWholeClusterRefused,
} from "@/hooks/useClusterOverview";
import { namespaceAttention, type NamespaceAttention } from "@/lib/attention";
import { commands } from "@/lib/commands";
import { isRefusal } from "@/lib/error-utils";
import { whole } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { useRightsAsked } from "@/lib/refusals";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { ClusterOverview } from "@/generated/types";

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

/**
 * The cluster's namespaces, and whether the list can be read now: the
 * Namespaces page's own entry, so the two never disagree, its watch keeps
 * both current, and its latest read decides. Rights change, so when the
 * reader says they may have, the list is asked again.
 */
export function useNamespaceList() {
  const isConnected = useClusterStore((s) => s.isConnected);
  const rightsAsked = useRightsAsked();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: queryKeys.resources(ResourceType.Namespace, null),
    queryFn: () => commands.listNamespaces().then(whole),
    enabled: isConnected,
    staleTime: STALE_TIMES.slow,
  });
  const asked = useRef(rightsAsked);
  useEffect(() => {
    if (asked.current === rightsAsked) return;
    asked.current = rightsAsked;
    void refetch({ cancelRefetch: false });
  }, [rightsAsked, refetch]);
  const state: NamespaceListState = error
    ? isRefusal(error)
      ? "refused"
      : "failed"
    : data
      ? "listed"
      : "pending";
  // Names a refusal took back are not offered; a failed read keeps its last.
  return {
    data: state === "refused" ? undefined : data?.rows,
    state,
    isLoading,
  };
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
 * the namespace list did; the window's own namespaces are counted from its
 * own overview instead. `problems` asks for Needs attention as well, which
 * reads four more lists across the cluster: only the picker shows it.
 */
const WHOLE_CLUSTER: readonly string[] = [];

/** One namespace's pods in an overview of several, `null` where they were not read: one refused leaves the others counted. */
const podsReadIn = (overview: ClusterOverview, name: string) =>
  overview.unread.some(
    (entry) =>
      entry.kind === "Pod" &&
      (entry.namespace === null || entry.namespace === name)
  )
    ? null
    : (overview.namespaces.find((ns) => ns.name === name)?.podCount ?? 0);

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
  const ownScope = refused && windowScope.length > 0 ? windowScope : null;
  const { data: own } = useClusterOverview(
    ownScope ?? WHOLE_CLUSTER,
    enabled && ownScope !== null
  );
  const wholeAttention = useAttention({
    scope: WHOLE_CLUSTER,
    enabled: problems && enabled && namespaceList !== "pending" && !refused,
  });
  const ownAttention = useAttention({
    enabled: problems && enabled && ownScope !== null,
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
    if (!known && ownScope && own)
      for (const name of ownScope) {
        const count =
          ownScope.length === 1 ? own.counts.pods : podsReadIn(own, name);
        if (count != null) pods.set(name, count);
      }
    // The Overview's own count, so the picker never says a third number.
    const problemsOf = (name: string): NamespaceAttention | null => {
      if (known)
        return wholeAttention && namespaceAttention(wholeAttention, name);
      if (!ownScope?.includes(name) || !ownAttention) return null;
      if (ownScope.length > 1) return namespaceAttention(ownAttention, name);
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
    ownScope,
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
