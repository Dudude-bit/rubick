/**
 * The nodes nothing is heard from, for marking the pods that sit on them.
 *
 * Fails soft on purpose. Listing nodes is a cluster-scoped read, and plenty of
 * people hold namespace-scoped credentials that cannot do it. On a 403 this
 * returns no silences rather than an error: the pod list is the caller's
 * subject, and refusing to draw it because a *supplementary* read was denied
 * would trade a missing annotation for a missing screen.
 *
 * The cost is one node list, shared by every surface that asks — a cluster has
 * tens of nodes where it has thousands of pods, and TanStack caches it under
 * one key regardless of how many lists mount.
 */
import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { silentNodes, type NodeSilence } from "@/lib/node-reporting";

const NONE: Map<string, NodeSilence> = new Map();

export function useSilentNodes(enabled: boolean): Map<string, NodeSilence> {
  const { data } = useLiveQuery({
    queryKey: queryKeys.silentNodes(),
    // A node going quiet is exactly the event this exists to catch, so it is
    // polled rather than read once — at the slow rate, because the window it
    // matters in is minutes long, not seconds.
    refresh: "slow",
    staleTime: STALE_TIMES.slow,
    placeholderData: keepPreviousData,
    enabled,
    queryFn: async () => {
      try {
        return silentNodes(await commands.listNodes(null));
      } catch {
        // Denied, or the cluster went away mid-flight. Either way there is
        // nothing to say about anyone's node, which is not the same as
        // saying every node is fine — no mark is drawn at all.
        return NONE;
      }
    },
  });

  return useMemo(() => data ?? NONE, [data]);
}
