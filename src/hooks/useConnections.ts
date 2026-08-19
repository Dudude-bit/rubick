/**
 * One request for a whole neighbourhood, shared by the two surfaces that
 * read it.
 *
 * The chain sits on the Overview and the groups sit behind a tab, and both
 * want the same answer. One query key means the page asks once whichever the
 * reader opens first, and switching tabs costs nothing.
 */

import { keepPreviousData } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { STALE_TIMES } from "@/lib/refresh";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { ResourceConnections } from "@/generated/types";

export type ConnectionsQuery = ReturnType<typeof useConnections>;

export function useConnections(
  kind: string,
  name: string | undefined,
  namespace: string | null | undefined,
  /**
   * Held back until the answer is wanted.
   *
   * The peek needs the governing edges only once somebody presses Scale, and
   * a neighbourhood read on every row a reader arrows past would be six lists
   * per keystroke. The query key is unchanged, so a page that has already
   * asked answers the peek from the cache.
   */
  enabled = true
) {
  // The cluster's cached Gateway API scan rides along so the backend can
  // draw route hops without a CRD list of its own. It joins the query key:
  // a chain answered before the scan landed must not stay cached as the
  // whole answer once the cluster turns out to speak Gateway API.
  const gateway = useGatewayApi().data ?? null;
  return useLiveQuery<ResourceConnections>({
    queryKey: [
      "connections",
      kind,
      namespace ?? null,
      name,
      gateway?.installed ? gateway.kinds.map((k) => k.readVersion) : null,
    ],
    queryFn: () =>
      commands.getResourceConnections(kind, name!, namespace ?? null, gateway),
    enabled: enabled && !!name,
    // A pod going ready is the fact this view exists to show, so it follows
    // the list pages rather than sitting on a stale answer.
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceDetail,
    refresh: "slow",
    retry: false,
  });
}
