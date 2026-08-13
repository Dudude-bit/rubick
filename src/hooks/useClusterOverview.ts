import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { mergeOverviews } from "@/lib/overview-merge";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQueries, useLiveQuery } from "@/hooks/useLiveQuery";
import { useClusterStore } from "@/stores/clusterStore";
import type { ClusterOverview } from "@/generated/types";

const read = async (namespace: string | null) => {
  try {
    return await commands.getClusterOverview(namespace || null);
  } catch (err) {
    throw new Error(normalizeTauriError(err), { cause: err });
  }
};

/**
 * The cluster overview query, shared by everything that reads it.
 *
 * The scope is the cache key, so the sidebar counts, the overview page and
 * the window chrome all read one response per scope rather than issuing the
 * same request three times every two seconds.
 *
 * `namespace` is the scope to ask for: `null` means the whole cluster. It is
 * a scope somebody names, not the window's — the namespace picker wants every
 * namespace's pod count however narrowly the window is scoped, which is why
 * this hook does not read the selection itself. {@link useScopedOverview} is
 * the one that follows it.
 *
 * `enabled` is for a caller that has to keep the hook mounted while this is
 * not the question it is asking. This is the most expensive query in the app
 * and an idle subscription to it is not free, however cheap a cache hit looks
 * from here.
 */
export function useClusterOverview(namespace: string | null, enabled = true) {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  return useLiveQuery({
    queryKey: ["cluster-overview", currentContext, namespace ?? ""],
    queryFn: () => read(namespace),
    enabled: isConnected && enabled,
    staleTime: STALE_TIMES.overview,
    placeholderData: keepPreviousData,
    refresh: "overview",
  });
}

export interface ScopedOverview {
  data: ClusterOverview | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * The overview of what this window is looking at.
 *
 * One namespace or the whole cluster is one request, exactly as it always
 * was. Several namespaces is one request each, added up here — unlike the
 * lists, which are narrowed on this side from a single cluster-wide read,
 * these numbers arrive pre-aggregated and cannot be taken apart again. A
 * cluster-wide `47 pods` under a two-namespace label would be the rail
 * stating something it cannot back.
 *
 * Those reads are *not* cheaper than the cluster-wide one, and nothing is
 * replaced by them. A namespaced overview is sixteen requests against the
 * cluster-wide fifteen, and one of the sixteen is a full cluster pod LIST —
 * the scheduler panel divides requests by every node's allocatable, so it is
 * cluster-wide by definition (`get_cluster_overview` in
 * `src-tauri/src/commands/overview.rs`). Meanwhile the namespace picker keeps
 * asking for the cluster-wide one beside them, because it exists to show the
 * namespaces the window is *not* on. So a scope of four costs about 480
 * requests a minute against 186 for a scope of one, and that arithmetic is
 * what `SCOPE_LIMIT` bounds; the store is where it is enforced.
 *
 * The saving that remains is between windows: the entries are keyed by
 * namespace, so a scope of `prod` and one of `prod, staging` make one `prod`
 * request between them.
 */
export function useScopedOverview(): ScopedOverview {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useClusterStore((s) => s.namespaceScope);
  const several = scope.length > 1;

  // Held mounted but switched off while the fan-out below is the answer.
  // Subscribed to a cache key somebody else is filling, it looks free and is
  // not: the day that other reader unmounts, this quietly adds a whole
  // cluster-wide overview to a query that is already several.
  const single = useClusterOverview(
    several ? null : (scope[0] ?? null),
    !several
  );

  const parts = useLiveQueries<ClusterOverview>({
    refresh: "overview",
    // No `placeholderData: keepPreviousData` here, and it is not an omission.
    // `useQueries` matches observers by query hash, so the namespace the
    // reader has just added gets a brand-new `QueryObserver`, and
    // `keepPreviousData` resolves through a field that observer owns and has
    // never filled: the option is inert in a fan-out, and the part that made
    // the scope change is the one part with no previous answer to keep.
    // Holding the previous *join* instead would be worse than the skeleton it
    // saves — those are the old selection's totals under the new selection's
    // label, which is the one thing `lib/namespace-scope.ts` exists to stop.
    // A poll, where the question is unchanged, keeps every part's data and
    // never reaches the skeleton at all.
    queries: (several ? scope : []).map((name) => ({
      queryKey: ["cluster-overview", currentContext, name],
      queryFn: () => read(name),
      enabled: isConnected,
      staleTime: STALE_TIMES.overview,
    })),
  });

  const { data: answers } = parts;
  const merged = useMemo(() => {
    const answered = answers.filter((part) => part !== undefined);
    // Every namespace or none: a total missing one of its three parts is not
    // a total, and the loading state is the honest thing to show until it is.
    return answered.length > 0 && answered.length === answers.length
      ? mergeOverviews(answered)
      : undefined;
  }, [answers]);

  if (!several) {
    return {
      data: single.data,
      isLoading: single.isLoading,
      error: single.error,
      refetch: () => void single.refetch(),
    };
  }

  return {
    data: merged,
    isLoading: parts.isLoading,
    error: parts.error,
    refetch: parts.refetch,
  };
}
